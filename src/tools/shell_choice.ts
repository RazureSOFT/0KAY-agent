import { existsSync } from 'node:fs'
import * as path from 'node:path'

// Which shell the `bash` tool actually runs.
//
// It used to be cmd.exe on Windows, with a translation table explaining that
// `ls` means `dir`. That is a workaround for the wrong problem: the model writes
// POSIX, cmd.exe mangles it, and every quoting rule in the answer is different
// from what the user typed. Git for Windows ships a real bash — use it.
//
// Order of preference on win32: an explicit OKAY_SHELL, bash on PATH, the usual
// Git install locations, then cmd.exe. POSIX: bash if it exists, else sh.

export type ShellKind = 'bash' | 'cmd' | 'sh'

export interface ShellChoice {
  kind: ShellKind
  file: string
  args(command: string): string[]
  /** Shown to the model in the tool description, so it writes for this shell. */
  describe(): string
}

const GIT_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
]

function localAppDataGitBash(): string | null {
  const base = process.env.LOCALAPPDATA
  return base ? path.join(base, 'Programs', 'Git', 'bin', 'bash.exe') : null
}

function onPath(binary: string): string | null {
  const extensions = process.platform === 'win32' ? ['.exe', ''] : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, binary + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync,
): ShellChoice {
  const override = (process.env.OKAY_SHELL || '').trim()

  if (platform !== 'win32') {
    const bash = exists('/bin/bash') ? '/bin/bash' : '/bin/sh'
    return {
      kind: bash.endsWith('bash') ? 'bash' : 'sh',
      file: bash,
      args: (command) => ['-c', command],
      describe: () => bash.endsWith('bash') ? 'bash -c' : 'sh -c',
    }
  }

  if (override && exists(override)) {
    return {
      kind: 'bash',
      file: override,
      args: (command) => ['-c', command],
      describe: () => `bash -c (${override})`,
    }
  }

  const candidates = [
    onPath('bash'),
    localAppDataGitBash(),
    ...GIT_BASH_CANDIDATES,
  ].filter(Boolean) as string[]
  const bash = candidates.find((candidate) => exists(candidate))
  if (bash) {
    return {
      kind: 'bash',
      file: bash,
      args: (command) => ['-c', command],
      describe: () => 'bash (Git for Windows): POSIX quoting, $VAR, &&, |, single quotes all behave as on Linux',
    }
  }

  return {
    kind: 'cmd',
    file: 'cmd.exe',
    args: (command) => ['/d', '/s', '/c', command],
    describe: () => 'cmd.exe: use dir/cd/&&, not pwd/ls, and double quotes only',
  }
}

/** One resolution per process; a PATH lookup per command would be silly. */
let cached: ShellChoice | null = null

export function shellChoice(): ShellChoice {
  if (!cached) cached = resolveShell()
  return cached
}

export function resetShellChoice(): void {
  cached = null
}
