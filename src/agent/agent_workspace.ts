/**
 * Per-workspace agent home: `.0kay-agent/` in the working directory.
 *
 * The agent keeps durable notes next to the code it works on:
 *   .0kay-agent/memory.md  — facts worth remembering across runs
 *   .0kay-agent/plan.md    — the checklist for the active task
 *   .0kay-agent/review.md  — self-review and delivery evidence
 *
 * The folder is git-ignored automatically so these notes never pollute a repo.
 */

import { mkdir, readFile, writeFile, appendFile } from 'fs/promises';
import * as path from 'path';

export const AGENT_DIR = '.0kay-agent';

const TEMPLATES: Record<string, string> = {
  'memory.md': '# Memory\n\nDurable facts worth remembering across runs. Appended automatically.\n',
  'plan.md': '# Plan\n\nThe checklist for the active task.\n',
  'review.md': '# Review\n\nSelf-review and delivery evidence for completed tasks.\n',
};

/** Create `.0kay-agent/` (files + .gitignore entry) if missing. Idempotent. */
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

/** Append `.0kay-agent/` to the workspace `.gitignore` when absent. */
async function ensureGitignored(cwd: string): Promise<void> {
  const file = path.join(cwd, '.gitignore');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // No .gitignore yet — we create one below.
  }
  const entries = current.split(/\r?\n/).map((line) => line.trim());
  if (entries.includes(`${AGENT_DIR}/`) || entries.includes(AGENT_DIR)) return;
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(file, `${separator}${AGENT_DIR}/\n`, 'utf8');
}

/** Append a timestamped note to memory.md / plan.md / review.md. Best-effort. */
export async function appendAgentNote(cwd: string, kind: 'memory' | 'plan' | 'review', text: string): Promise<void> {
  if (!cwd || !text.trim()) return;
  await ensureAgentWorkspace(cwd);
  const file = path.join(cwd, AGENT_DIR, `${kind}.md`);
  const stamp = new Date().toISOString();
  await appendFile(file, `\n## ${stamp}\n\n${text.trim()}\n`, 'utf8');
}
