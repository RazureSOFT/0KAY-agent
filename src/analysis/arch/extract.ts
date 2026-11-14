// Read a codebase and derive its architecture.
//
// The diagram tool can draw anything the model describes, but a description of
// a codebase is a summary, and a summary is what the person asking already has.
// What they cannot get by asking is the structure nobody wrote down: which
// directories actually exist, which ones import each other, and which ones
// nothing depends on. That is an extraction problem, not a drawing problem, so
// it lives here and hands its result to the renderer.
//
// The extraction is deliberately shallow. A parser per language would be
// accurate and enormous; what the question "what is the architecture of this
// workspace" needs is module granularity — groups of files and the arrows
// between them — and every language in this repository states its imports in a
// form a line-oriented scan can find. When the scan misses something, the
// diagram is missing an arrow, not wrong about a fact.
//
// The unit is the *module*: the deepest directory that holds source files.
// Deepest, not top-level, because a repo with `core/`, `agent/` and `webui/`
// drawn as three boxes tells nobody anything they did not already know.

import * as fs from 'fs/promises';
import * as path from 'path';
import { isRepository, ownership } from './repo_identity.js';

export interface ModuleNode {
  /** Stable id: the module's path, forward-slashed, no leading "./". */
  id: string;
  /** Directory name — what a person calls it. */
  label: string;
  /** Source files directly in this module (not its children). */
  files: number;
  /** Lines of source directly in this module. */
  lines: number;
  /** Languages present, most common first. */
  languages: string[];
  /** True for a leaf module that nothing else imports. */
  orphan: boolean;
}

export interface ModuleEdge {
  from: string;
  to: string;
  /** Number of import statements pointing this way. */
  weight: number;
}

export interface Architecture {
  modules: ModuleNode[];
  edges: ModuleEdge[];
  /** Files examined. */
  files: number;
  /** Files in a recognised language. */
  sourceFiles: number;
  /** Modules found. */
  total: number;
}

/** Language by extension. Only languages whose imports this scanner reads. */
const LANGUAGES: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.vue': 'vue', '.svelte': 'vue',
  '.go': 'go',
  '.py': 'py',
  '.rs': 'rs',
  '.java': 'java', '.kt': 'java',
  '.c': 'c', '.h': 'c', '.cc': 'c', '.cpp': 'c', '.hpp': 'c',
  '.cs': 'cs',
};

/** Directories that are never part of the architecture. */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  'vendor', '__pycache__', '.venv', 'venv', '.tox', 'coverage', '.cache',
  '.turbo', '.parcel-cache', 'release', 'bin', 'obj', '.idea', '.vscode',
]);

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 400_000;

/**
 * The import statements a line scan can recognise.
 *
 * Each returns the raw specifier; resolving it to a module is the next step and
 * differs per language (a Go import is a package path, a TS one is relative to
 * the file). Keeping the two apart is what lets one scanner handle six
 * languages without pretending they are the same.
 */
const IMPORT_PATTERNS: Array<{ lang: string; re: RegExp; group: number }> = [
  // `import x from 'y'`, `import 'y'`, `export ... from 'y'`, `require('y')`
  { lang: 'ts', re: /(?:^|\s)(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, group: 1 },
  { lang: 'js', re: /require\(\s*['"]([^'"]+)['"]\s*\)/g, group: 1 },
  // Go: `import "x"` or a block of them. Only the quoted path matters.
  { lang: 'go', re: /^\s*(?:import\s+)?(?:[A-Za-z_.][\w.]*\s+)?"([^"]+)"\s*$/gm, group: 1 },
  // Python: `import a.b`, `from a.b import c`
  { lang: 'py', re: /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm, group: 0 },
  { lang: 'rs', re: /^\s*(?:pub\s+)?use\s+([\w:]+)/gm, group: 1 },
  { lang: 'java', re: /^\s*import\s+(?:static\s+)?([\w.]+)\s*;/gm, group: 1 },
];

function languageOf(file: string): string | undefined {
  const ext = path.extname(file).toLowerCase();
  return LANGUAGES[ext];
}

function isSkippedDir(name: string): boolean {
  if (SKIP_DIRS.has(name)) return true;
  // Hidden directories hold tooling state, not architecture.
  return name.startsWith('.') && name !== '.';
}

/**
 * Prefix that makes an ignore entry match at any depth.
 *
 * Built rather than written as a literal so it never appears verbatim in a
 * comment: the two-character sequence that closes a block comment is the middle
 * of the glob, and writing it inline silently ends the comment early.
 */
const ANY_DEPTH_PREFIX = `*${'*'}/`;

/**
 * Directory paths the project itself excludes.
 *
 * Without this, a repository that keeps a reference clone, a scratch checkout or
 * a vendored copy next to its own source gets an architecture diagram dominated
 * by code that is not part of it — the diagram answers a question nobody asked.
 * `.gitignore` is the project's own statement of "this is not my source", so it
 * is the right input.
 *
 * Patterns are matched by relative path, not by bare name, because the useful
 * ones usually carry a path: a `/tui/reference/` style entry names one directory,
 * and matching only its last segment would also hide a legitimate directory of
 * the same name elsewhere in the tree.
 *
 * Only simple path patterns are read — no wildcards, no negation. Anything more
 * exotic is left to the built-in skip list rather than guessed at: a pattern
 * engine that is right nine times out of ten would silently drop a real module
 * the tenth time.
 */
async function loadIgnoredPaths(root: string): Promise<Set<string>> {
  const ignored = new Set<string>();
  let text = '';
  try {
    text = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return ignored;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.includes('*') || line.includes('?') || line.includes('[')) continue;
    const dir = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!dir) continue;
    // A bare name (no slash) matches that name at any depth, which is what a
    // bare name means in an ignore file. A path matches exactly itself.
    ignored.add(dir.includes('/') ? dir : `${ANY_DEPTH_PREFIX}${dir}`);
  }
  return ignored;
}

/**
 * Is this directory excluded?
 *
 * `rel` is the path relative to the workspace root, forward-slashed. A bare
 * name from the ignore file is stored prefixed so it matches at any depth; a
 * path (one containing a slash) matches exactly itself, so the same name deeper
 * in the tree is still the project's own code.
 */
function isIgnored(rel: string, patterns: Set<string>): boolean {
  if (patterns.has(rel)) return true;
  for (const pattern of patterns) {
    if (!pattern.startsWith(ANY_DEPTH_PREFIX)) continue;
    const name = pattern.slice(ANY_DEPTH_PREFIX.length);
    if (rel === name || rel.endsWith(`/${name}`)) return true;
  }
  return false;
}

interface SourceFile {
  /** Path relative to the root, forward-slashed. */
  rel: string;
  abs: string;
  lang: string;
  lines: number;
}

/**
 * Walk the tree once, collecting source files and their line counts.
 *
 * `ignored` and `root` are carried per-branch rather than fixed for the walk: a
 * nested repository has its own ignore rules and its own owner, and a rule that
 * applies to the outer project must not be applied to a module that governs
 * itself (or the other way round).
 */
async function collect(root: string, ignored = new Set<string>()): Promise<{ files: SourceFile[]; examined: number }> {
  const out: SourceFile[] = [];
  let examined = 0;

  const walk = async (dir: string, relDir: string, rules: Set<string>, projectRoot: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isSkippedDir(entry.name)) continue;

        // A nested repository carries its own ignore rules, and they are the
        // ones that know what is inside it. Without this, trusting the outer
        // repository would let a reference clone kept inside a module
        // (`agent/opencode/`) back into the diagram — which is exactly what
        // happened the first time this was written.
        let nestedIgnored = rules;
        let nestedRoot = projectRoot;
        if (await isRepository(abs)) {
          const ours = await ownership(abs, projectRoot);
          if (ours === 'foreign') continue;
          if (ours === 'ours') {
            // One of the project's own modules. An ignore entry in the parent is
            // a release decision, not a statement that the code is not here.
            nestedIgnored = await loadIgnoredPaths(abs);
            nestedRoot = abs;
          } else if (isIgnored(rel, rules)) {
            // Unknown ownership and the parent excludes it: excluded is the
            // safe reading, since including somebody else's checkout is the
            // failure this whole path exists to prevent.
            continue;
          }
        } else if (isIgnored(rel, rules)) {
          continue;
        }
        await walk(abs, rel, nestedIgnored, nestedRoot);
        continue;
      }
      if (!entry.isFile()) continue;
      examined += 1;
      const lang = languageOf(entry.name);
      if (!lang) continue;
      let size = 0;
      try {
        size = (await fs.stat(abs)).size;
      } catch {
        continue;
      }
      if (size > MAX_FILE_BYTES) continue;
      out.push({
        rel: path.relative(root, abs).replace(/\\/g, '/'),
        abs,
        lang,
        lines: 0, // filled in only for files whose imports we read
      });
    }
  };

  await walk(root, '', ignored, root);
  return { files: out, examined };
}

/**
 * The module a file belongs to: its directory.
 *
 * Grouping by directory rather than by file is what makes a diagram readable —
 * forty files in one directory is one box, not forty. A file at the root becomes
 * its own module named after the root, which is honest: a root-level file has no
 * module of its own to belong to.
 */
function moduleOf(rel: string, rootName: string): string {
  const dir = path.posix.dirname(rel);
  return dir === '.' ? rootName : dir;
}

/** Roots a specifier may resolve to, most specific first. */
function resolveTarget(fromModule: string, spec: string, lang: string, rootName: string, known: Set<string>): string | undefined {
  if (lang === 'go') {
    // A Go import path is a package path; the module is the last segment that
    // matches a directory we actually found, so a repository path like
    // `0kay/core/internal/gateway` lands on `core/internal/gateway`.
    const parts = spec.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      const candidate = parts.slice(i).join('/');
      if (known.has(candidate)) return candidate;
    }
    return undefined;
  }
  if (lang === 'py') {
    // A Python import is a dotted path from a root, so the match is a PREFIX:
    // `lib.util` is `lib/util` if that exists, otherwise the package `lib`.
    // Trying suffixes here fails on every normal import — `util` is not a
    // directory, which is how this was found.
    const parts = spec.split('.').filter(Boolean);
    for (let i = parts.length; i >= 1; i -= 1) {
      const candidate = parts.slice(0, i).join('/');
      if (known.has(candidate)) return candidate;
    }
    return undefined;
  }
  if (lang === 'rs' || lang === 'java') {
    // Crate/package-absolute, and the leading segments (`crate`, `self`, the
    // package name) are not directories, so the match is the longest prefix that
    // does exist.
    const parts = spec.replace(/::/g, '/').replace(/\./g, '/').split('/').filter(Boolean);
    for (let i = parts.length; i >= 1; i -= 1) {
      const candidate = parts.slice(0, i).join('/');
      if (known.has(candidate)) return candidate;
    }
    return undefined;
  }

  // ts / js / vue: relative specifiers only. A bare specifier is a dependency,
  // not a module of this workspace, and drawing it would fill the diagram with
  // node_modules.
  if (!spec.startsWith('.')) return undefined;
  const joined = path.posix.normalize(path.posix.join(fromModule, spec));

  // Two things to get right, and getting either wrong makes every arrow
  // disappear (which is exactly how this was found):
  //
  //   1. The specifier names a FILE but the graph is in DIRECTORY units, so the
  //      resolved path has to be mapped back to its own module.
  //   2. ESM/TS writes `.js` for a file that is `.ts` on disk, so the extension
  //      in the specifier cannot be trusted.
  const withoutExt = joined.replace(/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/, '');
  const asFiles = [joined, `${withoutExt}.ts`, `${withoutExt}.tsx`, `${withoutExt}.js`, `${withoutExt}.vue`];
  for (const candidate of asFiles) {
    // A directory import resolves to the directory itself, or its index file.
    const asModule = known.has(candidate) ? candidate : path.posix.dirname(candidate);
    if (known.has(asModule)) return asModule;
    if (known.has(path.posix.join(candidate, 'index'))) return path.posix.join(candidate, 'index');
  }
  return undefined;
}

/** Read one file's import specifiers. */
async function importsOf(file: SourceFile): Promise<string[]> {
  let text = '';
  try {
    text = await fs.readFile(file.abs, 'utf8');
  } catch {
    return [];
  }
  const specs: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    if (pattern.lang !== file.lang) continue;
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(text))) {
      // Python's pattern has two alternatives in one regex; take whichever
      // group actually captured.
      const raw = pattern.group === 0 ? (match[1] || match[2] || '') : match[pattern.group] || '';
      if (raw) specs.push(raw);
    }
  }
  return specs;
}

/**
 * Build the architecture of a workspace.
 *
 * `maxModules` exists because a diagram is a communication device: a hundred
 * boxes communicate nothing. The busiest modules by line count are kept, and the
 * rest are folded into "other" — with the count reported, so nobody thinks the
 * workspace was smaller than it is.
 */
export async function analyzeArchitecture(
  root: string,
  options: { maxModules?: number } = {},
): Promise<Architecture> {
  const resolvedRoot = path.resolve(root);
  const rootName = path.basename(resolvedRoot) || 'root';
  const ignored = await loadIgnoredPaths(resolvedRoot);
  const { files, examined } = await collect(resolvedRoot, ignored);

  // Every directory that holds a source file is a module.
  const known = new Set<string>();
  for (const file of files) known.add(moduleOf(file.rel, rootName));

  const stats = new Map<string, { files: number; lines: number; langs: Map<string, number> }>();
  const edges = new Map<string, ModuleEdge>();
  const imported = new Set<string>();

  for (const file of files) {
    const mod = moduleOf(file.rel, rootName);
    const entry = stats.get(mod) || { files: 0, lines: 0, langs: new Map<string, number>() };
    entry.files += 1;
    entry.langs.set(file.lang, (entry.langs.get(file.lang) || 0) + 1);
    stats.set(mod, entry);

    const specs = await importsOf(file);
    if (!specs.length) continue;
    // Line count costs a split; only worth it for files we already read.
    let text = '';
    try { text = await fs.readFile(file.abs, 'utf8') } catch { /* counted as 0 */ }
    entry.lines += text ? text.split('\n').length : 0;

    for (const spec of specs) {
      const target = resolveTarget(mod, spec, file.lang, rootName, known);
      if (!target || target === mod) continue;
      imported.add(target);
      const key = `${mod}\u0000${target}`;
      const existing = edges.get(key);
      if (existing) existing.weight += 1;
      else edges.set(key, { from: mod, to: target, weight: 1 });
    }
  }

  // Files that never contributed a line count (no imports) still have a size;
  // leaving them at zero would make a busy module look empty.
  for (const file of files) {
    const mod = moduleOf(file.rel, rootName);
    const entry = stats.get(mod);
    if (!entry) continue;
    if (entry.lines === 0) {
      try {
        const text = await fs.readFile(file.abs, 'utf8');
        entry.lines += text.split('\n').length;
      } catch { /* unreadable, counted as files only */ }
    }
  }

  let modules: ModuleNode[] = [...stats.entries()].map(([id, entry]) => ({
    id,
    label: path.posix.basename(id),
    files: entry.files,
    lines: entry.lines,
    languages: [...entry.langs.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang),
    orphan: false,
  }));

  // An orphan is a leaf nothing imports. It is a real finding — dead code, an
  // entry point, or something only reachable through reflection — and a diagram
  // that marks it lets a reader ask which.
  for (const module of modules) {
    module.orphan = !imported.has(module.id) && edges.size > 0 && !hasChildren(module.id, modules);
  }

  const maxModules = Math.max(4, Math.min(60, options.maxModules ?? 24));
  if (modules.length > maxModules) {
    modules = modules.sort((a, b) => b.lines - a.lines).slice(0, maxModules);
    const kept = new Set(modules.map((module) => module.id));
    for (const key of [...edges.keys()]) {
      const edge = edges.get(key)!;
      // Drop arrows whose endpoints were folded away; a dangling edge renders as
      // a box the reader cannot find in the legend.
      if (!kept.has(edge.from) || !kept.has(edge.to)) edges.delete(key);
    }
    modules.sort((a, b) => a.id.localeCompare(b.id));
  }

  return {
    modules,
    edges: [...edges.values()].sort((a, b) => b.weight - a.weight),
    files: examined,
    sourceFiles: files.length,
    total: stats.size,
  };
}

/** Does another module live under this one? Then it is a group, not a leaf. */
function hasChildren(id: string, modules: ModuleNode[]): boolean {
  const prefix = `${id}/`;
  return modules.some((module) => module.id.startsWith(prefix));
}

/** Mermaid for a derived architecture, with the arrows weighted by import count. */
export function architectureToMermaid(arch: Architecture, title = 'Architecture'): string {
  const lines = ['flowchart LR'];
  const idOf = (module: ModuleNode, index: number) => `m${index}`;
  const index = new Map<string, string>();
  arch.modules.forEach((module, i) => index.set(module.id, idOf(module, i)));

  lines.push(`  %% ${title}: ${arch.total} module(s), ${arch.sourceFiles} source file(s)`);
  arch.modules.forEach((module, i) => {
    const langs = module.languages.slice(0, 2).join('/');
    const shape = module.orphan ? `${idOf(module, i)}["${module.label}<br/><small>${module.files}f ${module.lines}L ${langs}</small>"]` : `${idOf(module, i)}["${module.label}<br/><small>${module.files}f ${module.lines}L ${langs}</small>"]`;
    lines.push(`  ${shape}:::${module.orphan ? 'orphan' : 'module'}`);
  });
  for (const edge of arch.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (!from || !to) continue;
    lines.push(edge.weight > 1 ? `  ${from} -->|${edge.weight}| ${to}` : `  ${from} --> ${to}`);
  }
  lines.push('  classDef module fill:#eef2ff,stroke:#4f46e5,color:#1e1b4b');
  lines.push('  classDef orphan fill:#fef3c7,stroke:#d97706,color:#78350f');
  return lines.join('\n');
}

/**
 * The same architecture as text, for a model that has to reason about it.
 *
 * A diagram is for the person; the model reads this. Ordering by inbound
 * imports answers "what is central", which is the question behind most
 * architecture requests.
 */
export function describeArchitecture(arch: Architecture): string {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const edge of arch.edges) {
    inbound.set(edge.to, (inbound.get(edge.to) || 0) + edge.weight);
    outbound.set(edge.from, (outbound.get(edge.from) || 0) + edge.weight);
  }
  const byCentrality = [...arch.modules].sort((a, b) => (inbound.get(b.id) || 0) - (inbound.get(a.id) || 0));
  const lines = [
    `${arch.sourceFiles} source file(s) across ${arch.total} module(s).`,
    '',
    'Modules, most depended-on first:',
    ...byCentrality.map((module) => {
      const i = inbound.get(module.id) || 0;
      const o = outbound.get(module.id) || 0;
      return `- ${module.id} — ${module.files} file(s), ${module.lines} line(s), ${module.languages.join('/')}; ${i} inbound, ${o} outbound${module.orphan ? ', nothing imports it' : ''}`;
    }),
  ];
  if (arch.edges.length) {
    lines.push('', 'Dependencies:');
    for (const edge of arch.edges.slice(0, 80)) {
      lines.push(`- ${edge.from} -> ${edge.to}${edge.weight > 1 ? ` (${edge.weight})` : ''}`);
    }
  }
  return lines.join('\n');
}