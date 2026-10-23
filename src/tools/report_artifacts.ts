import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Tool, type ToolResult, type ToolContext } from './types.js';
import { success, failure } from './helpers.js';

export interface ArtifactEntry {
  path: string;
  description: string;
}

interface ArtifactInput {
  path?: unknown;
  description?: unknown;
}

/** Human-readable size for the chip label; keeps the list scannable. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Declare the deliverables of a turn.
 *
 * The model is asked to call this before its final answer whenever the turn
 * produced files. The Agent page renders the returned list under the answer, so
 * the user gets a clickable summary instead of hunting through the tool log.
 *
 * Two details matter:
 *   - the paths are resolved against the task cwd, because a model often writes
 *     "report.md" when it means "D:\\work\\report.md";
 *   - a path that does not exist is reported back to the model (and dropped from
 *     the list) rather than silently accepted — a list of lies is worse than no
 *     list, and the model gets a chance to correct itself.
 */
export class ReportArtifactsTool extends Tool {
  get name(): string { return 'report_artifacts'; }

  get description(): string {
    return 'List the files this task produced or modified. Call it once, right before your final answer, whenever the turn created deliverables; the UI shows the list to the user.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['artifacts'],
      properties: {
        artifacts: {
          type: 'array',
          description: 'Every deliverable, in the order the user should read them.',
          items: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string', description: 'Absolute path, or relative to the working directory.' },
              description: { type: 'string', description: 'One line: what this file is. Under 80 characters.' },
            },
          },
        },
        summary: { type: 'string', description: 'Optional one-line summary of the delivery.' },
      },
    };
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    const raw: ArtifactInput[] = Array.isArray(args?.artifacts) ? args.artifacts : [];
    if (!raw.length) return failure('artifacts is required and must be a non-empty array');

    const cwd = context?.cwd || process.cwd();
    const accepted: Array<ArtifactEntry & { bytes: number }> = [];
    const missing: string[] = [];
    const seen = new Set<string>();

    for (const item of raw) {
      const rawPath = typeof item?.path === 'string' ? item.path.trim() : '';
      if (!rawPath) continue;
      const resolved = path.resolve(cwd, rawPath);
      if (seen.has(resolved.toLowerCase())) continue;
      seen.add(resolved.toLowerCase());
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) { missing.push(`${rawPath} (not a file)`); continue; }
        accepted.push({
          path: resolved,
          description: typeof item?.description === 'string' ? item.description.trim() : '',
          bytes: stat.size,
        });
      } catch {
        missing.push(rawPath);
      }
    }

    if (!accepted.length) {
      return failure(`no artifact exists on disk: ${missing.join(', ')}`);
    }

    const lines = accepted.map(item =>
      `${item.path} — ${formatSize(item.bytes)}${item.description ? ` — ${item.description}` : ''}`);
    const note = missing.length ? `\n\nNot found (dropped): ${missing.join(', ')}` : '';
    return success({
      artifacts: accepted,
      summary: typeof args?.summary === 'string' ? args.summary.trim() : '',
      text: `${accepted.length} artifact(s) registered:\n${lines.join('\n')}${note}`,
    });
  }
}
