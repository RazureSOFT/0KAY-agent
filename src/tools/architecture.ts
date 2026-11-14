// The architecture tool: derive the map, draw it, keep it, notice drift.
//
// Three capabilities that only make sense together. A derived diagram without
// storage cannot answer "what changed"; storage without derivation is a map
// somebody has to maintain by hand and therefore will not; and neither is
// useful without the diagram, which is the part a person actually reads.
//
// The actions, in the order they are usually reached:
//
//   scan   — derive from the workspace, optionally against the stored map
//   draw   — scan and render (svg / mermaid / html) to a file
//   save   — scan and store, so the next scan can report drift
//   diff   — what changed between the stored map and the workspace now
//
// `scan` and `diff` are read-only. `draw` writes an artefact the user asked for.
// `save` writes the map, which is a change to stored state — it goes through the
// same approval path as any other write, because "the agent rewrote its own
// understanding of your codebase" is exactly the kind of thing an operator
// should get to see happen.

import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure } from './helpers.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { analyzeArchitecture, architectureToMermaid, describeArchitecture, type Architecture } from '../analysis/arch/extract.js';
import { changedModules, diffArchitectures, readArchMap, writeArchMap } from '../analysis/arch/store.js';

export class ArchitectureTool extends Tool {
  get name(): string { return 'architecture'; }

  get description(): string {
    return 'Map the architecture of a workspace: which modules exist, which depend on which, and what changed since the last map was saved. Derives the structure from the code itself, so it reports what is there rather than what the code is supposed to look like. Actions: scan (derive, optional drift against the saved map), draw (derive and write an SVG/mermaid/HTML diagram), save (store the map so the next scan can report drift), diff (what changed since the saved map). Use this when asked about the structure of a codebase, how parts relate, or what a change did to the shape of the project.';
  }

  get parameters(): Record<string, any> {
    return {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['scan', 'draw', 'save', 'diff'], description: 'What to do. Default scan.' },
        path: { type: 'string', description: 'Workspace root; defaults to the task working directory.' },
        kind: { type: 'string', enum: ['architecture', 'mindmap', 'flowchart'], description: 'Diagram kind for draw; default architecture.' },
        theme: { type: 'string', enum: ['light', 'dark'], description: 'Diagram theme; default light.' },
        format: { type: 'string', enum: ['svg', 'mermaid', 'html'], description: 'Output format for draw; default svg.' },
        maxModules: { type: 'integer', minimum: 4, maximum: 60, description: 'Keep the busiest N modules; default 24. Others are folded away, and the real total is still reported.' },
        out: { type: 'string', description: 'Output directory for draw; defaults to the workspace root.' },
        name: { type: 'string', description: 'Base file name for draw, without extension; default "architecture".' },
      },
    };
  }

  /** `save` writes stored state, so it is a change and is announced as one. */
  get dangerous(): boolean { return true; }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const action = String(args.action || 'scan').toLowerCase();
      const root = path.resolve(String(args.path || context.cwd || process.cwd()));
      const maxModules = Number(args.maxModules) || 24;

      if (action === 'scan' || action === 'diff') {
        const arch = await analyzeArchitecture(root, { maxModules });
        const stored = await readArchMap(root);
        if (stored === undefined) {
          // A first scan has nothing to compare against, and saying so is more
          // useful than an empty diff the caller might read as "no change".
          return success({
            action,
            root,
            architecture: describeArchitecture(arch),
            modules: arch.modules.length,
            totalModules: arch.total,
            sourceFiles: arch.sourceFiles,
            savedAt: null,
            note: action === 'diff'
              ? 'there is no saved map for this workspace yet, so there is nothing to compare against; run action "save" first'
              : 'no saved map; run action "save" to make later scans report what changed',
          });
        }
        const diff = diffArchitectures(stored.arch, arch);
        const grown = changedModules(stored.arch, arch);
        return success({
          action,
          root,
          architecture: describeArchitecture(arch),
          modules: arch.modules.length,
          totalModules: arch.total,
          sourceFiles: arch.sourceFiles,
          savedAt: new Date(stored.at).toISOString(),
          drift: diff.summary,
          clean: diff.clean,
          added: diff.added,
          removed: diff.removed,
          newDependencies: diff.newEdges,
          droppedDependencies: diff.droppedEdges,
          // A module that grew is not a structural change, but a diagram reader
          // wants to know, and a structural diff alone would say "clean".
          changedButStillPresent: grown,
        });
      }

      if (action === 'save') {
        const arch = await analyzeArchitecture(root, { maxModules });
        const stored = await readArchMap(root);
        const file = await writeArchMap(root, arch, root);
        const diff = stored ? diffArchitectures(stored.arch, arch) : undefined;
        return success({
          action,
          root,
          file,
          modules: arch.modules.length,
          totalModules: arch.total,
          sourceFiles: arch.sourceFiles,
          replaced: stored ? new Date(stored.at).toISOString() : null,
          driftSincePrevious: diff?.summary || null,
        });
      }

      if (action === 'draw') {
        const arch = await analyzeArchitecture(root, { maxModules });
        const format = String(args.format || 'svg').toLowerCase();
        const outDir = path.resolve(String(args.out || root));
        const base = sanitizeName(String(args.name || 'architecture'));
        await fs.mkdir(outDir, { recursive: true });

        const mermaid = toMermaid(arch, String(args.kind || 'architecture'), String(args.theme || 'light'));
        let file: string;
        let bytes: number;
        if (format === 'mermaid') {
          file = path.join(outDir, `${base}.mmd`);
          const body = mermaid;
          await fs.writeFile(file, body, 'utf8');
          bytes = Buffer.byteLength(body);
        } else if (format === 'html') {
          file = path.join(outDir, `${base}.html`);
          const body = renderHtmlPage(arch, mermaid);
          await fs.writeFile(file, body, 'utf8');
          bytes = Buffer.byteLength(body);
        } else {
          // SVG is produced from the same node/edge data through the diagram
          // tool's renderer, so the two do not drift apart.
          file = path.join(outDir, `${base}.svg`);
          const { renderSvg } = await import('./diagram.js');
          const svg = renderSvg({
            kind: 'architecture',
            title: `Architecture — ${path.basename(root)}`,
            direction: 'LR',
            theme: args.theme === 'dark' ? 'dark' : 'light',
            nodes: arch.modules.map((module) => ({
              id: module.id,
              label: `${module.label}\n${module.files}f · ${module.lines}L`,
              shape: 'rounded' as const,
              group: module.id.includes('/') ? module.id.split('/').slice(0, -1).join('/') : undefined,
            })),
            edges: arch.edges.map((edge) => ({ from: edge.from, to: edge.to, label: edge.weight > 1 ? String(edge.weight) : undefined })),
          });
          await fs.writeFile(file, svg.svg, 'utf8');
          bytes = Buffer.byteLength(svg.svg);
        }

        return success({
          action,
          root,
          file,
          format,
          bytes,
          modules: arch.modules.length,
          totalModules: arch.total,
          sourceFiles: arch.sourceFiles,
          mermaid,
          architecture: describeArchitecture(arch),
        });
      }

      return failure(`unknown action "${action}"; expected scan, draw, save or diff`);
    } catch (error) {
      return failure(error);
    }
  }
}

/** A file-name-safe base name; a title with a slash would write outside `out`. */
function sanitizeName(value: string): string {
  const cleaned = value.trim().replace(/[^\w.\- ]+/g, '-').replace(/^[-.]+/, '').replace(/\s+/g, '-');
  return cleaned || 'architecture';
}

function toMermaid(arch: Architecture, kind: string, theme: string): string {
  const mermaid = architectureToMermaid(arch, kind === 'mindmap' ? 'Architecture (mindmap)' : 'Architecture');
  if (theme !== 'dark') return mermaid;
  // Only the palette changes: the structure is the same diagram either way, and
  // a second layout code path would be a second thing to keep correct.
  return mermaid
    .replace('classDef module fill:#eef2ff,stroke:#4f46e5,color:#1e1b4b', 'classDef module fill:#1e1b4b,stroke:#818cf8,color:#e0e7ff')
    .replace('classDef orphan fill:#fef3c7,stroke:#d97706,color:#78350f', 'classDef orphan fill:#422006,stroke:#f59e0b,color:#fef3c7');
}

function renderHtmlPage(arch: Architecture, mermaid: string): string {
  const escape = (value: string) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Architecture — ${escape(arch.modules.length ? 'workspace' : 'empty')}</title>
<style>
  body { margin: 0; padding: 24px; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #fafafa; color: #111; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.meta { color: #555; margin: 0 0 20px; }
  pre { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; overflow: auto; }
</style>
</head>
<body>
<h1>Architecture</h1>
<p class="meta">${arch.sourceFiles} source file(s) · ${arch.total} module(s) · ${arch.edges.length} dependency(ies)</p>
<pre class="mermaid">${escape(mermaid)}</pre>
<script type="module">
  // Rendered by the browser so the file is portable: no build step, no bundled
  // Mermaid, and it degrades to the readable source above when offline.
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
</script>
</body>
</html>
`;
}
