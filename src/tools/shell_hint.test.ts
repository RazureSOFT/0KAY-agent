import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsShellHint, withWindowsShellHint } from './shell_hint.js';

const onWindows = process.platform === 'win32';

test('flags the exact command shape that failed in practice', { skip: !onWindows }, () => {
  const hint = windowsShellHint('cd /d D:\\mio && mkdir -p rev\\loader rev\\fucker 2>nul | tail -20');
  assert.match(hint, /mkdir already creates intermediate directories/);
  assert.match(hint, /tail is not a cmd\.exe command/);
  assert.match(hint, /Get-Content -Tail/);
});

test('flags a leading POSIX command', { skip: !onWindows }, () => {
  assert.match(windowsShellHint('ls -la'), /ls is not a cmd\.exe command/);
  assert.match(windowsShellHint('ls -la'), /use: dir/);
  assert.match(windowsShellHint('grep foo file.txt'), /use: findstr/);
  assert.match(windowsShellHint('which jadx'), /use: where/);
});

test('flags rm -rf with the rmdir equivalent', { skip: !onWindows }, () => {
  assert.match(windowsShellHint('rm -rf build'), /rmdir \/s \/q/);
});

test('stays silent for native cmd.exe commands', { skip: !onWindows }, () => {
  for (const command of [
    'dir',
    'cd /d D:\\mio',
    'mkdir rev',
    'copy a.txt b.txt',
    'move a.txt b.txt',
    'del /f /q a.txt',
    'type a.txt',
    'findstr foo file.txt',
    'where python',
    'tasklist',
    'taskkill /PID 123 /F',
    'ver',
    'set FOO=1',
  ]) {
    assert.equal(windowsShellHint(command), '', `should not flag: ${command}`);
  }
});

test('does not mistake a path or argument for a command', { skip: !onWindows }, () => {
  assert.equal(windowsShellHint('type C:\\tools\\ls.txt'), '');
  assert.equal(windowsShellHint('dir /s /b *grep*'), '');
  assert.equal(windowsShellHint('python -c "print(1)"'), '');
});

test('handles quoted separators', { skip: !onWindows }, () => {
  assert.equal(windowsShellHint('echo "a | b"'), '');
});

test('deduplicates repeated findings', { skip: !onWindows }, () => {
  const hint = windowsShellHint('ls && ls && ls');
  const hits = hint.match(/ls is not a cmd\.exe command/g) ?? [];
  assert.equal(hits.length, 1);
});

test('withWindowsShellHint is a no-op when there is nothing to say', { skip: !onWindows }, () => {
  assert.equal(withWindowsShellHint('dir', 'boom'), 'boom');
});

test('withWindowsShellHint appends to existing stderr', { skip: !onWindows }, () => {
  const out = withWindowsShellHint('ls', "'ls' is not recognized");
  assert.match(out, /not recognized/);
  assert.match(out, /use: dir/);
});

test('withWindowsShellHint fills empty stderr', { skip: !onWindows }, () => {
  assert.match(withWindowsShellHint('ls', ''), /ls is not a cmd\.exe command/);
});

test('is silent on non-Windows', { skip: onWindows }, () => {
  assert.equal(windowsShellHint('ls -la && mkdir -p x | tail -20'), '');
});