const UNIX_ONLY: Record<string, string> = {
  ls: 'dir',
  pwd: 'cd (with no argument)',
  cat: 'type',
  rm: 'del (or rmdir /s /q for a directory)',
  cp: 'copy',
  mv: 'move',
  touch: 'type nul > file',
  which: 'where',
  grep: 'findstr',
  head: 'PowerShell: Get-Content -TotalCount N',
  tail: 'PowerShell: Get-Content -Tail N',
  sed: 'no cmd.exe equivalent; use PowerShell or a script',
  awk: 'no cmd.exe equivalent; use PowerShell or a script',
  chmod: 'icacls',
  chown: 'icacls',
  ln: 'mklink',
  sudo: 'open an elevated shell',
  export: 'set',
  uname: 'ver',
  ps: 'tasklist',
  kill: 'taskkill /PID <pid> /F',
  env: 'set',
  xargs: 'no cmd.exe equivalent; use a for loop',
};

function segments(command: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(current); current = ''; i++; continue; }
    if (ch === '|' || ch === ';' || ch === '&') { out.push(current); current = ''; continue; }
    current += ch;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

function firstToken(segment: string): string {
  const match = /^\s*"?([A-Za-z_][\w.-]*)"?/.exec(segment);
  return match ? match[1].toLowerCase() : '';
}

export function windowsShellHint(command: string): string {
  if (process.platform !== 'win32') return '';
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const segment of segments(command)) {
    const token = firstToken(segment);
    if (!token) continue;

    if (token === 'mkdir' && /(^|\s)-p(\s|$)/.test(segment)) {
      const note = 'mkdir already creates intermediate directories on Windows — drop -p';
      if (!seen.has(note)) { seen.add(note); problems.push(note); }
      continue;
    }
    if (token === 'rm' && /(^|\s)-[a-z]*r[a-z]*f|(^|\s)-[a-z]*f[a-z]*r/i.test(segment)) {
      const note = 'rm -rf has no cmd.exe equivalent — use rmdir /s /q <dir> or del /f /q <file>';
      if (!seen.has(note)) { seen.add(note); problems.push(note); }
      continue;
    }

    const equivalent = UNIX_ONLY[token];
    if (!equivalent) continue;
    const note = `${token} is not a cmd.exe command — use: ${equivalent}`;
    if (!seen.has(note)) { seen.add(note); problems.push(note); }
  }

  if (!problems.length) return '';
  return [
    'This shell is Windows cmd.exe, not bash. The command used POSIX syntax:',
    ...problems.map((note) => `  - ${note}`),
    'Rewrite using cmd.exe commands (dir, cd, copy, move, del, type, findstr) and && for sequencing.',
  ].join('\n');
}

export function withWindowsShellHint(command: string, stderr: string): string {
  const hint = windowsShellHint(command);
  if (!hint) return stderr;
  return stderr ? `${stderr}\n\n${hint}` : hint;
}