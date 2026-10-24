import test from 'node:test'
import assert from 'node:assert/strict'
import { buildLaunch } from './backends.js'

// The argv is the product here: it is what either confines a command or quietly
// does not. Every test asserts the flag that matters, on a platform we are not
// running on — that is the point of injecting platform and availability.

const base = {
  command: 'rm -rf build && npm test',
  cwd: '/home/me/project',
  workspaceRoots: ['/home/me/project'],
}

test('linux uses bwrap, with a read-only root and a writable workspace', () => {
  const spec = buildLaunch({ ...base, platform: 'linux', mode: 'workspace-write', available: () => true })
  assert.equal(spec.backend, 'bwrap')
  assert.equal(spec.file, 'bwrap')
  const joined = spec.args.join(' ')
  assert.match(joined, /--ro-bind \/ \//)
  assert.match(joined, /--bind \/home\/me\/project \/home\/me\/project/)
  // The command must be the last thing, behind --, or bwrap eats the flags.
  assert.deepEqual(spec.args.slice(-4), ['--', '/bin/sh', '-c', base.command])
})

test('read-only mounts nothing writable', () => {
  const spec = buildLaunch({ ...base, platform: 'linux', mode: 'read-only', available: () => true })
  assert.doesNotMatch(spec.args.join(' '), /--bind \/home/)
})

test('network is cut off unless asked for', () => {
  const offline = buildLaunch({ ...base, platform: 'linux', mode: 'workspace-write', available: () => true })
  assert.ok(offline.args.includes('--unshare-net'))
  const online = buildLaunch({ ...base, platform: 'linux', mode: 'workspace-write', network: true, available: () => true })
  assert.ok(!online.args.includes('--unshare-net'))
})

test('macOS uses sandbox-exec and allows writes only under the roots', () => {
  const spec = buildLaunch({ ...base, platform: 'darwin', mode: 'workspace-write', available: () => true })
  assert.equal(spec.backend, 'sandbox-exec')
  const profile = spec.args[1]
  assert.match(profile, /\(deny file-write\*\)/)
  assert.match(profile, /\(allow file-write\* \(subpath "\/home\/me\/project"\)\)/)
})

test('a quote in a workspace path cannot break out of the SBPL string', () => {
  const spec = buildLaunch({
    ...base, platform: 'darwin', mode: 'workspace-write', available: () => true,
    workspaceRoots: ['/tmp/we"ird'],
  })
  assert.match(spec.args[1], /subpath "\/tmp\/we\\"ird"/)
})

test('windows has no backend, and says so instead of pretending', () => {
  const spec = buildLaunch({ ...base, platform: 'win32', mode: 'workspace-write', available: () => true })
  assert.equal(spec.backend, 'none')
  assert.equal(spec.notes.length, 1)
  assert.match(spec.notes[0], /no OS sandbox on Windows/)
  assert.deepEqual(spec.args, ['/d', '/s', '/c', base.command])
})

test('linux without bwrap installed degrades with a note', () => {
  const spec = buildLaunch({ ...base, platform: 'linux', mode: 'workspace-write', available: () => false })
  assert.equal(spec.backend, 'none')
  assert.match(spec.notes[0], /bwrap/)
})

test('danger-full-access runs the command bare', () => {
  const spec = buildLaunch({ ...base, platform: 'linux', mode: 'danger-full-access', available: () => true })
  assert.equal(spec.backend, 'none')
  assert.equal(spec.file, '/bin/sh')
  assert.match(spec.notes[0], /disabled/)
})
