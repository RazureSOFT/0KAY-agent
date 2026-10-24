import { mkdir, readFile, writeFile, appendFile } from 'fs/promises';
import * as path from 'path';

export const AGENT_DIR = '.0kay-agent';

const TEMPLATES: Record<string, string> = {
  'memory.md': '# Memory\n\nDurable facts worth remembering across runs. Appended automatically.\n',
  'plan.md': '# Plan\n\nThe checklist for the active task.\n',
  'review.md': '# Review\n\nSelf-review and delivery evidence for completed tasks.\n',
};

export async function ensureAgentWorkspace(cwd: string): Promise<void> {
  if (!cwd) return;
  const dir = path.join(cwd, AGENT_DIR);
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(TEMPLATES)) {
    const file = path.join(dir, name);
    try {
      await readFile(file);
    } catch {
      await writeFile(file, body, 'utf8');
    }
  }
  await ensureGitignored(cwd);
}

async function ensureGitignored(cwd: string): Promise<void> {
  const file = path.join(cwd, '.gitignore');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
  }
  const entries = current.split(/\r?\n/).map((line) => line.trim());
  if (entries.includes(`${AGENT_DIR}/`) || entries.includes(AGENT_DIR)) return;
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(file, `${separator}${AGENT_DIR}/\n`, 'utf8');
}

export async function appendAgentNote(cwd: string, kind: 'memory' | 'plan' | 'review', text: string): Promise<void> {
  if (!cwd || !text.trim()) return;
  await ensureAgentWorkspace(cwd);
  const file = path.join(cwd, AGENT_DIR, `${kind}.md`);
  const stamp = new Date().toISOString();
  await appendFile(file, `\n## ${stamp}\n\n${text.trim()}\n`, 'utf8');
}
