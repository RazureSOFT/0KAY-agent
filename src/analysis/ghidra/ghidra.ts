import { existsSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Ghidra is a 400MB Java application; rewriting it is not a thing anyone does in
// an afternoon. What *is* worth having is the part an agent actually uses: run
// the headless analyzer on a binary and get back the function list, the strings,
// and a decompilation of one function, as data.
//
// So this is an adapter, and it says so. No Ghidra on the machine means a clear
// "install it or set GHIDRA_HOME", not a fabricated answer.

export interface GhidraInstall {
  home: string
  headless: string
  version: string
}

export interface GhidraFacts {
  functions: Array<{ name: string; entry: string; size: number }>
  strings: string[]
  truncated: boolean
}

export interface GhidraReport extends GhidraFacts {
  binary: string
  elapsedMs: number
  /** The raw tail, for when parsing finds nothing. */
  rawTail: string
}

const MARKER_BEGIN = '0KAY-JSON-BEGIN'
const MARKER_END = '0KAY-JSON-END'

/** Where Ghidra usually lives, plus GHIDRA_HOME. */
export function findGhidra(
  env: Record<string, string | undefined> = process.env,
  exists: (candidate: string) => boolean = existsSync,
): GhidraInstall | null {
  const candidates: string[] = []
  if (env.GHIDRA_HOME) candidates.push(env.GHIDRA_HOME)
  candidates.push(
    'C:\\ghidra',
    'C:\\tools\\ghidra',
    '/opt/ghidra',
    '/usr/share/ghidra',
    '/usr/local/ghidra',
    path.join(os.homedir(), 'ghidra'),
  )
  for (const home of candidates) {
    const headless = process.platform === 'win32'
      ? path.join(home, 'support', 'analyzeHeadless.bat')
      : path.join(home, 'support', 'analyzeHeadless')
    if (exists(headless)) return { home, headless, version: versionOf(home) }
  }
  return null
}

function versionOf(home: string): string {
  const match = /ghidra[_-]?(\d+\.\d+(?:\.\d+)?)/i.exec(path.basename(home))
  return match ? match[1] : 'unknown'
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as any).code) || 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** The post-script that turns a program into JSON. Shipped next to this file. */
export function scriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts')
}

export interface AnalyzeOptions {
  /** Cap the number of functions and strings in the answer. */
  maxFunctions?: number
  maxStrings?: number
  timeoutMs?: number
  /** Injected in tests: replaces the analyzeHeadless invocation. */
  runner?: (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Injected in tests: a temp dir. */
  workDir?: string
}

export async function analyzeBinary(
  install: GhidraInstall,
  binaryPath: string,
  options: AnalyzeOptions = {},
): Promise<GhidraReport> {
  const started = Date.now()
  const workDir = options.workDir || await fs.mkdtemp(path.join(os.tmpdir(), '0kay-ghidra-'))
  const projectDir = path.join(workDir, 'project')
  await fs.mkdir(projectDir, { recursive: true })

  const args = [
    projectDir,
    '0kay',
    '-import', binaryPath,
    '-scriptPath', scriptPath(),
    '-postScript', 'ExportFacts.java',
    '-deleteProject',
  ]

  const runFn = options.runner || run
  const result = await runFn(install.headless, args, options.timeoutMs ?? 300_000)
  const rawTail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-12).join('\n')

  if (result.code !== 0 && !result.stdout.includes(MARKER_BEGIN)) {
    throw new Error(`Ghidra exited ${result.code}: ${rawTail.slice(-400)}`)
  }

  const facts = parseFacts(result.stdout)
  if (!facts) throw new Error(`Ghidra produced no ${MARKER_BEGIN} block. Last output:\n${rawTail.slice(-600)}`)

  const maxFunctions = options.maxFunctions ?? 500
  const maxStrings = options.maxStrings ?? 200
  return {
    binary: binaryPath,
    functions: facts.functions.slice(0, maxFunctions),
    strings: facts.strings.slice(0, maxStrings),
    truncated: facts.functions.length > maxFunctions || facts.strings.length > maxStrings,
    elapsedMs: Date.now() - started,
    rawTail,
  }
}

/** Pull the JSON block out of the analyzer's stdout, ignoring the log around it. */
export function parseFacts(stdout: string): GhidraFacts | null {
  const start = stdout.indexOf(MARKER_BEGIN)
  const end = stdout.indexOf(MARKER_END)
  if (start < 0 || end < start) return null
  const payload = stdout.slice(start + MARKER_BEGIN.length, end).trim()
  try {
    const parsed = JSON.parse(payload)
    return {
      functions: Array.isArray(parsed.functions) ? parsed.functions : [],
      strings: Array.isArray(parsed.strings) ? parsed.strings.map(String) : [],
      truncated: Boolean(parsed.truncated),
    }
  } catch {
    return null
  }
}

const C_BEGIN = '0KAY-C-BEGIN'
const C_END = '0KAY-C-END'

export interface DecompileOptions extends AnalyzeOptions {
  /** Function name or entry address. Empty means the program entry point. */
  symbol?: string
}

export interface Decompilation {
  binary: string
  symbol: string
  code: string
  elapsedMs: number
}

/** Decompile one function to C. The script prints the code between two markers. */
export async function decompileFunction(
  install: GhidraInstall,
  binaryPath: string,
  options: DecompileOptions = {},
): Promise<Decompilation> {
  const started = Date.now()
  const workDir = options.workDir || await fs.mkdtemp(path.join(os.tmpdir(), '0kay-ghidra-dec-'))
  const projectDir = path.join(workDir, 'project')
  await fs.mkdir(projectDir, { recursive: true })

  const args = [
    projectDir,
    '0kay',
    '-import', binaryPath,
    '-scriptPath', scriptPath(),
    '-postScript', 'DecompileFunction.java', options.symbol || '',
    '-deleteProject',
  ]

  const runFn = options.runner || run
  const result = await runFn(install.headless, args, options.timeoutMs ?? 300_000)
  const output = `${result.stdout}
${result.stderr}`

  const failure = /0KAY-ERROR (.+)/.exec(output)
  if (failure) throw new Error(`Ghidra: ${failure[1].trim()}`)

  const start = output.indexOf(C_BEGIN)
  const end = output.indexOf(C_END)
  if (start < 0 || end < start) {
    const tail = output.trim().split('\n').slice(-10).join('\n')
    throw new Error(`Ghidra produced no ${C_BEGIN} block. Last output:\n${tail}`)
  }

  return {
    binary: binaryPath,
    symbol: options.symbol || '(entry)',
    code: output.slice(start + C_BEGIN.length, end).trim(),
    elapsedMs: Date.now() - started,
  }
}

/** What to tell the user when there is no Ghidra, and why it matters. */
export function missingGhidraHint(): string {
  return [
    'Ghidra is not installed, so the headless analyzer is unavailable.',
    'Install it (https://ghidra-sre.org) and set GHIDRA_HOME to the install directory,',
    'or point GHIDRA_HOME at an existing install. Requires a JDK 17+ on PATH.',
    'Until then: `reverse_engineer` still does PE/ELF headers, imports, strings and entropy without it.',
  ].join(' ')
}
