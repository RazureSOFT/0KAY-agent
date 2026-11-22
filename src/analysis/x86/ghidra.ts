/**
 * The external decompiler as an optional second opinion.
 *
 * Everything else in this tree reads the image itself. That is the right default: no
 * install, no JVM, no project directory, and the control flow it recovers is often better —
 * it folds Go's stack-check retry into a comment where the other one prints
 * `while (&local_78 <= *(int **)(unaff_R14 + 0x10)) { morestack_noctxt(); }`, which is not
 * what the code does.
 *
 * What it does better is types. On `internal/abi.BoundsDecode` it produced
 *
 *     void internal_abi_BoundsDecode(int v, internal_abi_BoundsErrorCode code,
 *         bool signed, bool xIsReg, bool yIsReg, int xVal, int yVal)
 *
 * where the built-in path has `long arg0` — because debug information names seven
 * parameters and the reader in this tree only reaches the ones the body reads, and the
 * build kept DWARF for one package tree out of thirty. The answer is not to guess harder;
 * it is to ask the tool that reads the debug information properly, when it is installed.
 *
 * So this is a capability, not a dependency. `available()` says whether the install can be
 * found, `decompile()` returns null rather than throwing when it cannot, and the caller
 * falls back to what it always did.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Where the install is looked for, in order. */
const DEFAULT_ROOTS = [
  'D:/Cache/ghidra',
  'C:/ghidra',
  'C:/Program Files/ghidra',
  '/opt/ghidra',
  '/usr/local/ghidra',
];

/** The script that dumps one function, written next to the project on first use. */
const SCRIPT = `import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import java.io.*;

public class DumpOne extends GhidraScript {
    @Override
    public void run() throws Exception {
        String out = System.getenv().getOrDefault("OKAY_ONE_OUT", "one.c");
        String want = System.getenv().getOrDefault("OKAY_ONE_ADDR", "");
        DecompInterface d = new DecompInterface();
        d.setOptions(new DecompileOptions());
        d.openProgram(currentProgram);
        long target = Long.parseUnsignedLong(want.replace("0x", ""), 16);
        PrintWriter w = new PrintWriter(new OutputStreamWriter(new FileOutputStream(out), "UTF-8"));
        try {
            for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
                if (f.getEntryPoint().getOffset() != target) continue;
                DecompileResults r = d.decompileFunction(f, 120, monitor);
                if (r.decompileCompleted()) w.println(r.getDecompiledFunction().getC());
                else w.println("/* decompile failed: " + r.getErrorMessage() + " */");
                break;
            }
        } finally {
            w.close();
        }
    }
}
`;

export interface GhidraLocation {
  /** The install root, i.e. the directory holding `support/`. */
  root: string;
  /** The headless launcher. */
  launcher: string;
}

/** Find an install, or null when there is none. */
export async function findGhidra(explicit?: string): Promise<GhidraLocation | null> {
  const candidates = explicit ? [explicit, ...DEFAULT_ROOTS] : DEFAULT_ROOTS;
  for (const dir of candidates) {
    // An install unzips into a directory named for its build, so one level down is normal.
    for (const root of [dir, ...(await subdirectories(dir))]) {
      const launcher = path.join(root, 'support', process.platform === 'win32' ? 'analyzeHeadless.bat' : 'analyzeHeadless');
      try {
        await fs.access(launcher);
        return { root, launcher };
      } catch {
        // next
      }
    }
  }
  return null;
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export interface GhidraOptions {
  location: GhidraLocation;
  /** The binary to analyse. Must already have been imported into the project. */
  binary: string;
  address: number;
  /** Where projects live. One project per binary, named from its path. */
  projectRoot: string;
  /** Give up after this many milliseconds. */
  timeoutMs?: number;
}

/**
 * A project that already holds this binary, under any name.
 *
 * The name a project gets depends on who imported it, so looking only for the one this
 * module would have chosen misses the project an operator already built by hand. Ghidra
 * stores each program in the project's internal database rather than as a file named after
 * the binary, so the only reliable check is a scan of the database directory for the
 * binary's name — a few kilobytes of strings, no JVM needed.
 */
async function findProjectFor(projectRoot: string, binaryName: string, preferred: string): Promise<string | null> {
  const exists = async (dir: string): Promise<boolean> => fs.access(dir).then(() => true).catch(() => false);
  if (await exists(path.join(projectRoot, `${preferred}.rep`))) return preferred;

  let entries: string[] = [];
  try {
    entries = await fs.readdir(projectRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.rep')) continue;
    const name = entry.slice(0, -4);
    if (await projectMentions(path.join(projectRoot, entry), binaryName)) return name;
  }
  return null;
}

/** Whether a project's database mentions a program by this name. */
async function projectMentions(repDir: string, binaryName: string): Promise<boolean> {
  const idata = path.join(repDir, 'idata');
  let buckets: string[] = [];
  try {
    buckets = await fs.readdir(idata);
  } catch {
    return false;
  }
  for (const bucket of buckets.slice(0, 64)) {
    let files: string[] = [];
    try {
      files = await fs.readdir(path.join(idata, bucket));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.prp')) continue;
      try {
        const text = await fs.readFile(path.join(idata, bucket, file), 'utf8');
        if (text.includes(binaryName)) return true;
      } catch {
        // a locked or binary property file is not a reason to stop looking
      }
    }
  }
  return false;
}

/** The project name for a binary. Stable, so a second run reuses the analysis. */
function projectNameFor(binary: string): string {
  const base = path.basename(binary).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `okay_${base}`;
}

/**
 * Decompile one function, importing the binary first if it has not been seen.
 *
 * The import is the expensive part — 710 seconds of auto-analysis for a 24 MB Go binary —
 * and it is skipped on every run after the first because the project is keyed by the
 * binary's name. That is why the result is worth caching to disk rather than recomputing.
 */
export async function decompileWithGhidra(options: GhidraOptions): Promise<string | null> {
  const { location, binary, address } = options;
  const projectRoot = options.projectRoot;
  const project = projectNameFor(binary);
  const scriptDir = path.join(projectRoot, 'scripts');
  const scriptFile = path.join(scriptDir, 'DumpOne.java');
  const outFile = path.join(projectRoot, `${project}-${address.toString(16)}.c`);

  await fs.mkdir(scriptDir, { recursive: true });
  // Rewritten every call: it is 30 lines and a stale copy would be a mystery later.
  await fs.writeFile(scriptFile, SCRIPT, 'utf8');

  // An existing project is reused. Import plus auto-analysis is 710 seconds for a 24 MB
  // Go binary — measured, not estimated — and paying it on every call would make the tool
  // useless. The project is keyed by the binary's name, so a second run finds it.
  const reusable = await findProjectFor(projectRoot, path.basename(binary), project);
  const args = reusable
    ? [projectRoot, reusable, '-process', path.basename(binary), '-noanalysis']
    : [projectRoot, project, '-import', binary, '-processor', 'x86:LE:64:default', '-analysisTimeoutPerFile', '1500'];
  args.push('-scriptPath', scriptDir, '-postScript', 'DumpOne.java');

  const env = {
    ...process.env,
    OKAY_ONE_OUT: outFile,
    OKAY_ONE_ADDR: address.toString(16),
    // The launcher reads this; without it a large binary exhausts the default heap.
    MAXMEM: process.env.MAXMEM ?? '4G',
  };

  try {
    await run(location.launcher, args, {
      env,
      timeout: options.timeoutMs ?? 30 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (error) {
    // A non-zero exit still leaves the output file when the script ran and the analyser
    // complained about something after it. The file is the result; the exit code is not.
    void error;
  }

  try {
    const text = await fs.readFile(outFile, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}