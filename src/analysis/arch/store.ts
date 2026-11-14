// Keep an architecture map on disk, and notice when it stops being true.
//
// An architecture diagram is stale the moment it is written. The interesting
// question is not "what is the architecture" — the extractor answers that any
// time — but "what changed since I last understood it", and that needs the
// previous answer stored next to the previous understanding.
//
// The map lives under the same `.0kay-agent/` directory the workspace already
// owns, in a JSON file. It is written only when asked: a read of the map must
// not rewrite it, or "has this changed" would be a question the reader answers
// by asking.
//
// Drift is reported as a *summary* rather than a diff. "Three modules appeared,
// one dependency disappeared, the rest grew" is what a person acts on; a
// line-by-line diff of two dependency graphs is not read.

import * as fs from 'fs/promises';
import * as path from 'path';
import { AGENT_DIR } from '../../agent/agent_workspace.js';
import type { Architecture } from './extract.js';

export const ARCH_MAP_FILE = 'architecture.json';

export interface StoredArchitecture {
  /** When this snapshot was taken, ms since epoch. */
  at: number;
  /** The workspace this describes, so a moved map is detectable. */
  root: string;
  arch: Architecture;
}

export interface ArchDiff {
  /** Modules present now but not in the previous snapshot. */
  added: string[];
  /** Modules the previous snapshot had and this one does not. */
  removed: string[];
  /** Dependencies that appeared. */
  newEdges: Array<{ from: string; to: string }>;
  /** Dependencies that went away. */
  droppedEdges: Array<{ from: string; to: string }>;
  /** True when nothing structural changed. */
  clean: boolean;
  /** One line a person can act on. */
  summary: string;
}

function mapPath(cwd: string): string {
  return path.join(cwd, AGENT_DIR, ARCH_MAP_FILE);
}

/** Read the stored map, or undefined when there is none or it is unreadable. */
export async function readArchMap(cwd: string): Promise<StoredArchitecture | undefined> {
  try {
    const raw = await fs.readFile(mapPath(cwd), 'utf8');
    const parsed = JSON.parse(raw);
    // A truncated or hand-edited file must read as "no map", not crash the
    // caller: the map is a convenience, and losing it costs one regeneration.
    if (!parsed || typeof parsed !== 'object' || !parsed.arch || !Array.isArray(parsed.arch.modules)) return undefined;
    return parsed as StoredArchitecture;
  } catch {
    return undefined;
  }
}

export async function writeArchMap(cwd: string, arch: Architecture, root: string): Promise<string> {
  const dir = path.join(cwd, AGENT_DIR);
  await fs.mkdir(dir, { recursive: true });
  const file = mapPath(cwd);
  const payload: StoredArchitecture = { at: Date.now(), root, arch };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * What changed between two snapshots.
 *
 * Module-level, not file-level: a file added to an existing module does not
 * change the architecture, and reporting it would bury the module that did
 * appear.
 */
export function diffArchitectures(previous: Architecture, current: Architecture): ArchDiff {
  const before = new Set(previous.modules.map((module) => module.id));
  const after = new Set(current.modules.map((module) => module.id));

  const added = [...after].filter((id) => !before.has(id)).sort();
  const removed = [...before].filter((id) => !after.has(id)).sort();

  const beforeEdges = new Set(previous.edges.map((edge) => edgeKey(edge.from, edge.to)));
  const afterEdges = new Set(current.edges.map((edge) => edgeKey(edge.from, edge.to)));

  const newEdges = [...afterEdges]
    .filter((key) => !beforeEdges.has(key))
    .map((key) => {
      const [from, to] = key.split('\u0000');
      return { from, to };
    })
    .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));

  const droppedEdges = [...beforeEdges]
    .filter((key) => !afterEdges.has(key))
    .map((key) => {
      const [from, to] = key.split('\u0000');
      return { from, to };
    })
    .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));

  const clean = !added.length && !removed.length && !newEdges.length && !droppedEdges.length;
  return { added, removed, newEdges, droppedEdges, clean, summary: summarize(added, removed, newEdges, droppedEdges, clean) };
}

function summarize(
  added: string[],
  removed: string[],
  newEdges: Array<{ from: string; to: string }>,
  droppedEdges: Array<{ from: string; to: string }>,
  clean: boolean,
): string {
  if (clean) return 'The architecture is unchanged since the last snapshot.';
  const parts: string[] = [];
  if (added.length) parts.push(`${added.length} module(s) appeared: ${added.slice(0, 5).join(', ')}${added.length > 5 ? ', …' : ''}`);
  if (removed.length) parts.push(`${removed.length} module(s) are gone: ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? ', …' : ''}`);
  if (newEdges.length) {
    const shown = newEdges.slice(0, 3).map((edge) => `${edge.from} -> ${edge.to}`).join(', ');
    parts.push(`${newEdges.length} new dependency(ies): ${shown}${newEdges.length > 3 ? ', …' : ''}`);
  }
  if (droppedEdges.length) parts.push(`${droppedEdges.length} dependency(ies) removed`);
  return `${parts.join('; ')}.`;
}

/**
 * Modules whose fingerprint changed, keyed by module id.
 *
 * The fingerprint is file count, line count and languages — the things a
 * diagram shows. A module that doubled in size is worth noticing even though its
 * name and its arrows are the same, and a structural diff alone would report
 * "clean".
 */
export function changedModules(previous: Architecture, current: Architecture): string[] {
  const before = new Map(previous.modules.map((module) => [module.id, module]));
  const changed: string[] = [];
  for (const module of current.modules) {
    const old = before.get(module.id);
    if (!old) continue;
    if (old.files !== module.files || old.lines !== module.lines || old.languages.join('/') !== module.languages.join('/')) {
      changed.push(module.id);
    }
  }
  return changed.sort();
}
