import { existsSync } from 'node:fs'
import * as path from 'node:path'
import type { SandboxMode } from './policy.js'

// OS-level confinement for shell commands.
//
// The policy layer decides *whether* a command may run; this decides *what it
// runs inside*. Without this, an approved `bash` call is the user's full
// authority — the policy only catches what it can parse, and it cannot parse
// everything.
//
// Three platforms, three stories:
//   linux   bubblewrap: read-only root, workspace bound writable, private /tmp,
//           optionally no network. This is a real boundary.
//   darwin  sandbox-exec with an SBPL profile: deny file-write*, allow it under
//           the workspace roots. Deprecated by Apple but still enforced.
//   win32   nothing we can reach from Node without native code. We say so
//           instead of pretending: the caller falls back to the policy layer and
//           the task is told it is unconfined.
//
// A backend that is missing is not an error — it is a downgrade, and the note
// travels with the launch so the model can see it.

export type BackendName = 'bwrap' | 'sandbox-exec' | 'none'

export interface LaunchSpec {
  file: string
  args: string[]
  backend: BackendName
  /** What this launch does *not* protect against. Empty means "we think it holds". */
  notes: string[]
}

export interface LaunchInput {
  platform: NodeJS.Platform
  mode: SandboxMode
  workspaceRoots: string[]
  command: string
  cwd: string
  /** Allow network inside the sandbox. Default false for read-only. */
  network?: boolean
  /** Injected in tests; defaults to a PATH lookup. */
  available?: (binary: string) => boolean
}

function onPath(binary: string): boolean {
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  return (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => extensions.some((ext) => existsSync(path.join(dir, binary + ext))))
}

/** Build the argv for one command. Pure: platform and availability are inputs. */
export function buildLaunch(input: LaunchInput): LaunchSpec {
  const available = input.available || onPath
  const unrestricted = input.mode === 'danger-full-access'
  const writable = input.mode !== 'read-only'
  const network = input.network === true

  if (unrestricted) {
    return { file: shellFile(input.platform), args: shellArgs(input.platform, input.command), backend: 'none', notes: ['sandbox disabled: danger-full-access'] }
  }

  if (input.platform === 'linux' && available('bwrap')) {
    const args = [
      '--die-with-parent',
      '--unshare-pid', '--unshare-ipc', '--unshare-uts',
      ...(network ? [] : ['--unshare-net']),
      // Everything readable, nothing writable, then the workspace punched back
      // in as writable. Order matters: the later bind wins.
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
      ...(writable ? input.workspaceRoots.flatMap((root) => ['--bind', root, root]) : []),
      '--chdir', input.cwd,
      '--', '/bin/sh', '-c', input.command,
    ]
    return {
      file: 'bwrap',
      args,
      backend: 'bwrap',
      notes: network ? ['network is available inside the sandbox'] : [],
    }
  }

  if (input.platform === 'darwin' && available('sandbox-exec')) {
    const rules = [
      '(version 1)',
      '(allow default)',
      '(deny file-write*)',
      ...(writable ? input.workspaceRoots.map((root) => `(allow file-write* (subpath ${sbplString(root)}))`) : []),
      // /tmp and the device nodes still need to be writable or nothing runs.
      '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))',
      ...(network ? [] : ['(deny network*)']),
    ]
    return {
      file: 'sandbox-exec',
      args: ['-p', rules.join(''), '/bin/sh', '-c', input.command],
      backend: 'sandbox-exec',
      notes: network ? [] : [],
    }
  }

  // Windows, or a Linux/macOS box without the tool installed. Say it plainly.
  return {
    file: shellFile(input.platform),
    args: shellArgs(input.platform, input.command),
    backend: 'none',
    notes: [
      input.platform === 'win32'
        ? 'no OS sandbox on Windows: writes outside the workspace are only caught by the command classifier'
        : `no sandbox backend found (looked for ${input.platform === 'linux' ? 'bwrap' : 'sandbox-exec'} on PATH)`,
    ],
  }
}

function shellFile(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cmd.exe' : '/bin/sh'
}

function shellArgs(platform: NodeJS.Platform, command: string): string[] {
  return platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]
}

/** SBPL strings are double-quoted; a quote in a path would end the literal. */
function sbplString(value: string): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
