import * as fs from 'fs/promises';
import * as path from 'path';
import { Tool, type ToolContext, type ToolResult } from './types.js';
import { success, failure, clamp } from './helpers.js';
import { isPathAllowed } from '../workspace/paths.js';

export interface DiagramNode {
  id?: string;
  label: string;
  shape?: 'rect' | 'rounded' | 'stadium' | 'diamond' | 'circle' | 'ellipse';
  group?: string;
  note?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

export interface DiagramSpec {
  kind?: 'mindmap' | 'flowchart' | 'tree' | 'sequence' | 'architecture';
  title?: string;
  direction?: 'TB' | 'LR';
  nodes?: DiagramNode[];
  edges?: DiagramEdge[];
  outline?: string;
  theme?: 'light' | 'dark';
}

interface Placed {
  id: string;
  label: string;
  shape: string;
  x: number;
  y: number;
  width: number;
  height: number;
  group?: string;
  note?: string;
}

interface Routed {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  points: Array<{ x: number; y: number }>;
}

const PALETTE = {
  light: { bg: '#ffffff', ink: '#1f2937', muted: '#6b7280', line: '#94a3b8', card: '#f8fafc', accent: '#2563eb', border: '#cbd5e1' },
  dark: { bg: '#0b1220', ink: '#e5e7eb', muted: '#94a3b8', line: '#475569', card: '#111c33', accent: '#60a5fa', border: '#334155' },
};

const GROUP_COLORS = ['#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#c026d3', '#65a30d'];

function slug(value: string, index: number): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
  return base ? `${base}-${index}` : `n${index}`;
}

function textWidth(label: string, fontSize: number): number {
  let units = 0;
  for (const ch of label) units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.58;
  return units * fontSize;
}

function outlineToGraph(outline: string): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const stack: Array<{ depth: number; id: string }> = [];
  const lines = outline.split(/\r?\n/).filter((line) => line.trim());
  let currentHeading = -1;
  lines.forEach((raw, index) => {
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw.trim());
    let depth: number;
    let label: string;
    if (heading) {
      depth = heading[1].length - 1;
      currentHeading = depth;
      label = heading[2].trim();
    } else {
      const indent = raw.match(/^[\t ]*/)?.[0] || '';
      const indentDepth = Math.floor(indent.replace(/\t/g, '  ').length / 2);
      depth = currentHeading >= 0 ? currentHeading + 1 + indentDepth : indentDepth;
      label = raw.trim().replace(/^[-*+]\s+/, '');
    }
    const id = slug(label, index);
    nodes.push({ id, label });
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) edges.push({ from: stack[stack.length - 1].id, to: id });
    stack.push({ depth, id });
  });
  return { nodes, edges };
}

function normalizeSpec(spec: DiagramSpec): { nodes: Array<DiagramNode & { id: string }>; edges: DiagramEdge[] } {
  let nodes = spec.nodes ? [...spec.nodes] : [];
  let edges = spec.edges ? [...spec.edges] : [];
  if ((!nodes.length || !edges.length) && spec.outline) {
    const graph = outlineToGraph(spec.outline);
    if (!nodes.length) nodes = graph.nodes;
    if (!edges.length) edges = graph.edges;
  }
  const normalized: Array<DiagramNode & { id: string }> = nodes.map((node, index) => ({ ...node, id: node.id || slug(node.label, index) }));
  const ids = new Set(normalized.map((node) => node.id));
  for (const edge of edges) {
    if (!ids.has(edge.from)) { normalized.push({ id: edge.from, label: edge.from }); ids.add(edge.from); }
    if (!ids.has(edge.to)) { normalized.push({ id: edge.to, label: edge.to }); ids.add(edge.to); }
  }
  if (!edges.length && normalized.length > 1) {
    for (let i = 1; i < normalized.length; i++) edges.push({ from: normalized[0].id, to: normalized[i].id });
  }
  return { nodes: normalized, edges };
}

function layoutMindmap(nodes: Array<DiagramNode & { id: string }>, edges: DiagramEdge[], loop = false): { placed: Placed[]; routed: Routed[]; width: number; height: number } {
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of edges) {
    if (!children.has(edge.from)) children.set(edge.from, []);
    children.get(edge.from)!.push(edge.to);
    hasParent.add(edge.to);
  }
  const roots = nodes.filter((node) => !hasParent.has(node.id));
  const root = roots[0] || nodes[0];
  const level1 = children.get(root.id) || [];
  const placed = new Map<string, Placed>();
  const cx = 0, cy = 0;
  const rootW = Math.max(140, textWidth(root.label, 18) + 40);
  const rootH = 54;
  placed.set(root.id, { id: root.id, label: root.label, shape: 'stadium', x: cx, y: cy, width: rootW, height: rootH });
  const total = Math.max(1, level1.length);
  const radius = loop ? 320 : Math.max(320, total * 90);
  const childPlacements: Array<{ parent: string; id: string; x: number; y: number }> = [];
  level1.forEach((id, index) => {
    const angle = (index / total) * Math.PI * 2 - Math.PI / 2;
    const node = nodes.find((n) => n.id === id)!;
    const width = Math.max(120, textWidth(node.label, 14) + 32);
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    placed.set(id, { id, label: node.label, shape: 'rounded', x, y, width, height: 44 });
    childPlacements.push({ parent: id, id, x, y });
    const grand = children.get(id) || [];
    grand.forEach((gid, gIndex) => {
      const gnode = nodes.find((n) => n.id === gid)!;
      const spread = (gIndex - (grand.length - 1) / 2) * 40;
      const gx = cx + Math.cos(angle) * (radius + 210) + Math.cos(angle + Math.PI / 2) * spread;
      const gy = cy + Math.sin(angle) * (radius + 210) + Math.sin(angle + Math.PI / 2) * spread;
      const gwidth = Math.max(110, textWidth(gnode.label, 13) + 28);
      placed.set(gid, { id: gid, label: gnode.label, shape: 'rounded', x: gx, y: gy, width: gwidth, height: 40 });
    });
  });
  for (const node of nodes) if (!placed.has(node.id)) {
    const parentEdge = edges.find((edge) => edge.to === node.id);
    const parent = parentEdge ? placed.get(parentEdge.from) : undefined;
    const width = Math.max(100, textWidth(node.label, 13) + 28);
    placed.set(node.id, { id: node.id, label: node.label, shape: 'rounded', x: (parent?.x || 0) + 240, y: (parent?.y || 0) + 80, width, height: 40 });
  }
  const all = [...placed.values()];
  const minX = Math.min(...all.map((p) => p.x - p.width / 2));
  const maxX = Math.max(...all.map((p) => p.x + p.width / 2));
  const minY = Math.min(...all.map((p) => p.y - p.height / 2));
  const maxY = Math.max(...all.map((p) => p.y + p.height / 2));
  const pad = 60;
  for (const p of all) { p.x += pad - minX; p.y += pad - minY; }
  const routed: Routed[] = edges
    .filter((edge) => placed.has(edge.from) && placed.has(edge.to))
    .map((edge) => ({
      from: edge.from, to: edge.to, label: edge.label, dashed: edge.dashed,
      points: [center(placed.get(edge.from)!), center(placed.get(edge.to)!)],
    }));
  return { placed: all, routed, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2 };
}

interface Layer { nodes: string[]; }

function layoutLayered(nodes: Array<DiagramNode & { id: string }>, edges: DiagramEdge[], direction: 'TB' | 'LR'): { placed: Placed[]; routed: Routed[]; width: number; height: number } {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const node of nodes) { indeg.set(node.id, 0); adj.set(node.id, []); }
  for (const edge of edges) {
    if (!adj.has(edge.from) || !indeg.has(edge.to)) continue;
    adj.get(edge.from)!.push(edge.to);
    indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
  }
  const rank = new Map<string, number>();
  const queue = nodes.filter((node) => (indeg.get(node.id) || 0) === 0).map((node) => node.id);
  for (const id of queue) rank.set(id, 0);
  const seen = new Set<string>(queue);
  while (queue.length) {
    const id = queue.shift()!;
    for (const next of adj.get(id) || []) {
      rank.set(next, Math.max(rank.get(next) || 0, (rank.get(id) || 0) + 1));
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  for (const node of nodes) if (!rank.has(node.id)) rank.set(node.id, 0);
  const layers: Layer[] = [];
  for (const node of nodes) {
    const r = rank.get(node.id)!;
    while (layers.length <= r) layers.push({ nodes: [] });
    layers[r].nodes.push(node.id);
  }
  const posInLayer = new Map<string, number>();
  for (let i = 1; i < layers.length; i++) {
    const score = new Map<string, number>();
    for (const id of layers[i].nodes) {
      const preds = edges.filter((edge) => edge.to === id).map((edge) => posInLayer.get(edge.from)).filter((v): v is number => v !== undefined);
      score.set(id, preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : Number.MAX_SAFE_INTEGER);
    }
    layers[i].nodes.sort((a, b) => (score.get(a)! - score.get(b)!));
  }
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const placed: Placed[] = [];
  const GAP = direction === 'TB' ? 80 : 70;
  const RANK_GAP = direction === 'TB' ? 96 : 200;
  let cross = 0;
  layers.forEach((layer, layerIndex) => {
    let along = 0;
    for (const id of layer.nodes) {
      const node = nodesById.get(id)!;
      const width = Math.max(120, textWidth(node.label, 14) + 40);
      const height = node.note ? 56 : 44;
      const shape = node.shape || 'rounded';
      const x = direction === 'TB' ? along + width / 2 : layerIndex * RANK_GAP + width / 2;
      const y = direction === 'TB' ? layerIndex * RANK_GAP + height / 2 : along + height / 2;
      placed.push({ id, label: node.label, shape, x, y, width, height, group: node.group, note: node.note });
      posInLayer.set(id, along + width / 2);
      along += (direction === 'TB' ? width : height) + GAP;
    }
    cross = Math.max(cross, along);
  });
  const pad = 60;
  const byId = new Map(placed.map((p) => [p.id, p]));
  const routed: Routed[] = edges.map((edge) => {
    const a = byId.get(edge.from)!;
    const b = byId.get(edge.to)!;
    if (!a || !b) return { from: edge.from, to: edge.to, points: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    return { from: edge.from, to: edge.to, label: edge.label, dashed: edge.dashed, points: routeEdge(a, b, direction) };
  });
  const minX = Math.min(...placed.map((p) => p.x - p.width / 2));
  const minY = Math.min(...placed.map((p) => p.y - p.height / 2));
  for (const p of placed) { p.x += pad - minX; p.y += pad - minY; }
  for (const r of routed) for (const point of r.points) { point.x += pad - minX; point.y += pad - minY; }
  const maxX = Math.max(...placed.map((p) => p.x + p.width / 2));
  const maxY = Math.max(...placed.map((p) => p.y + p.height / 2));
  void cross;
  return { placed, routed, width: maxX + pad, height: maxY + pad };
}

function center(p: Placed): { x: number; y: number } { return { x: p.x, y: p.y }; }

function routeEdge(a: Placed, b: Placed, direction: 'TB' | 'LR'): Array<{ x: number; y: number }> {
  if (direction === 'TB') {
    const start = { x: a.x, y: a.y + a.height / 2 };
    const end = { x: b.x, y: b.y - b.height / 2 };
    const midY = (start.y + end.y) / 2;
    return [start, { x: start.x, y: midY }, { x: end.x, y: midY }, end];
  }
  const start = { x: a.x + a.width / 2, y: a.y };
  const end = { x: b.x - b.width / 2, y: b.y };
  const midX = (start.x + end.x) / 2;
  return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
}

function layoutSequence(nodes: Array<DiagramNode & { id: string }>, edges: DiagramEdge[], theme: 'light' | 'dark'): { placed: Placed[]; routed: Routed[]; width: number; height: number; sequence: true } {
  const participants = nodes.length ? nodes : [];
  const placed: Placed[] = [];
  const columnWidth = 220;
  const pad = 60;
  participants.forEach((node, index) => {
    placed.push({ id: node.id, label: node.label, shape: 'rect', x: pad + index * columnWidth + columnWidth / 2, y: 70, width: columnWidth - 30, height: 44 });
  });
  const routed: Routed[] = edges.map((edge, index) => {
    const from = placed.find((p) => p.id === edge.from);
    const to = placed.find((p) => p.id === edge.to);
    const y = 170 + index * 64;
    const x1 = from ? from.x : pad;
    const x2 = to ? to.x : pad + columnWidth;
    return { from: edge.from, to: edge.to, label: edge.label, dashed: edge.dashed, points: [{ x: x1, y }, { x: x2, y }] };
  });
  void theme;
  return { placed, routed, width: pad * 2 + columnWidth * participants.length, height: 170 + edges.length * 64 + 60, sequence: true };
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]!));
}

function shapePath(node: Placed, color: string, theme: 'light' | 'dark'): string {
  const { x, y, width, height } = node;
  const left = x - width / 2, top = y - height / 2;
  const fill = theme === 'dark' ? PALETTE.dark.card : PALETTE.light.card;
  const stroke = color;
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="1.6"`;
  if (node.shape === 'diamond') {
    return `<polygon points="${x},${top} ${left + width},${y} ${x},${top + height} ${left},${y}" ${common}/>`;
  }
  if (node.shape === 'circle' || node.shape === 'ellipse') {
    return `<ellipse cx="${x}" cy="${y}" rx="${width / 2}" ry="${height / 2}" ${common}/>`;
  }
  if (node.shape === 'stadium') {
    return `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="${height / 2}" ${common}/>`;
  }
  if (node.shape === 'rect') {
    return `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="4" ${common}/>`;
  }
  return `<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="10" ${common}/>`;
}

function wrapLabel(label: string, maxChars = 22): string[] {
  if (label.length <= maxChars) return [label];
  const words = label.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current) { lines.push(current.trim()); current = word; }
    else current = `${current} ${word}`.trim();
    while (current.length > maxChars) { lines.push(current.slice(0, maxChars)); current = current.slice(maxChars); }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.slice(0, 4);
}

export function renderSvg(spec: DiagramSpec): { svg: string; width: number; height: number } {
  const kind = spec.kind || 'mindmap';
  const theme = spec.theme === 'dark' ? 'dark' : 'light';
  const pal = PALETTE[theme];
  const { nodes, edges } = normalizeSpec(spec);

  let layout: { placed: Placed[]; routed: Routed[]; width: number; height: number; sequence?: boolean };
  if (kind === 'mindmap') layout = layoutMindmap(nodes, edges);
  else if (kind === 'sequence') layout = layoutSequence(nodes, edges, theme);
  else layout = layoutLayered(nodes, edges, spec.direction === 'LR' ? 'LR' : 'TB');

  const titleHeight = spec.title ? 56 : 16;
  const groupColor = new Map<string, string>();
  let groupIndex = 0;
  for (const p of layout.placed) {
    if (p.group && !groupColor.has(p.group)) { groupColor.set(p.group, GROUP_COLORS[groupIndex++ % GROUP_COLORS.length]); }
  }

  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height + titleHeight)}" width="${Math.ceil(layout.width)}" height="${Math.ceil(layout.height + titleHeight)}" font-family="'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif">`);
  parts.push(`<rect x="0" y="0" width="100%" height="100%" fill="${pal.bg}"/>`);
  parts.push(`<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 z" fill="${pal.line}"/></marker></defs>`);
  if (spec.title) parts.push(`<text x="${layout.width / 2}" y="34" text-anchor="middle" font-size="22" font-weight="700" fill="${pal.ink}">${escapeXml(spec.title)}</text>`);

  const offsetX = 0, offsetY = titleHeight;
  parts.push(`<g transform="translate(${offsetX},${offsetY})">`);

  if ((kind === 'architecture' || kind === 'flowchart') && groupColor.size) {
    for (const [group, color] of groupColor) {
      const members = layout.placed.filter((p) => p.group === group);
      if (!members.length) continue;
      const minX = Math.min(...members.map((m) => m.x - m.width / 2)) - 22;
      const minY = Math.min(...members.map((m) => m.y - m.height / 2)) - 26;
      const maxX = Math.max(...members.map((m) => m.x + m.width / 2)) + 22;
      const maxY = Math.max(...members.map((m) => m.y + m.height / 2)) + 22;
      parts.push(`<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="14" fill="${color}14" stroke="${color}" stroke-dasharray="6 4" stroke-opacity="0.6"/>`);
      parts.push(`<text x="${minX + 12}" y="${minY + 20}" font-size="12" font-weight="600" fill="${color}">${escapeXml(group)}</text>`);
    }
  }

  for (const route of layout.routed) {
    const d = route.points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    parts.push(`<path d="${d}" fill="none" stroke="${pal.line}" stroke-width="1.8"${route.dashed ? ' stroke-dasharray="6 5"' : ''} marker-end="url(#arrow)"/>`);
    if (route.label) {
      const mid = route.points[Math.floor(route.points.length / 2)];
      const lw = textWidth(route.label, 12) + 16;
      parts.push(`<rect x="${mid.x - lw / 2}" y="${mid.y - 20}" width="${lw}" height="18" rx="6" fill="${pal.bg}" stroke="${pal.border}"/>`);
      parts.push(`<text x="${mid.x}" y="${mid.y - 7}" text-anchor="middle" font-size="12" fill="${pal.muted}">${escapeXml(route.label)}</text>`);
    }
  }

  for (const node of layout.placed) {
    const color = (node.group && groupColor.get(node.group)) || pal.accent;
    parts.push(shapePath(node, color, theme));
    const lines = wrapLabel(node.label);
    const lineHeight = 18;
    const startY = node.y - ((lines.length - 1) * lineHeight) / 2 + 5;
    lines.forEach((line, index) => {
      parts.push(`<text x="${node.x}" y="${startY + index * lineHeight}" text-anchor="middle" font-size="14" font-weight="${index === 0 ? 600 : 400}" fill="${pal.ink}">${escapeXml(line)}</text>`);
    });
    if (node.note) parts.push(`<text x="${node.x}" y="${node.y + node.height / 2 - 4}" text-anchor="middle" font-size="11" fill="${pal.muted}">${escapeXml(node.note)}</text>`);
  }

  if (layout.sequence) {
    for (const participant of layout.placed) {
      parts.push(`<line x1="${participant.x}" y1="${participant.y + participant.height / 2}" x2="${participant.x}" y2="${layout.height - 20}" stroke="${pal.border}" stroke-dasharray="5 5"/>`);
    }
  }

  parts.push(`</g></svg>`);
  return { svg: parts.join('\n'), width: Math.ceil(layout.width), height: Math.ceil(layout.height + titleHeight) };
}

export function renderMermaid(spec: DiagramSpec): string {
  const kind = spec.kind || 'mindmap';
  const { nodes, edges } = normalizeSpec(spec);
  const id = (value: string) => value.replace(/[^A-Za-z0-9_]/g, '_');
  const label = (value: string) => value.replace(/[\n"]/g, ' ');
  if (kind === 'mindmap') {
    const children = new Map<string, string[]>();
    const hasParent = new Set<string>();
    for (const edge of edges) { if (!children.has(edge.from)) children.set(edge.from, []); children.get(edge.from)!.push(edge.to); hasParent.add(edge.to); }
    const root = nodes.find((node) => !hasParent.has(node.id)) || nodes[0];
    const lines = ['mindmap'];
    const walk = (nodeId: string, depth: number) => {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      lines.push(`${'  '.repeat(depth + 1)}${depth === 0 ? `root((${label(node.label)}))` : label(node.label)}`);
      for (const child of children.get(nodeId) || []) walk(child, depth + 1);
    };
    if (root) walk(root.id, 0);
    return lines.join('\n');
  }
  if (kind === 'sequence') {
    const lines = ['sequenceDiagram'];
    for (const node of nodes) lines.push(`  participant ${id(node.id)} as ${label(node.label)}`);
    for (const edge of edges) lines.push(`  ${id(edge.from)}->>${id(edge.to)}: ${label(edge.label || '')}`);
    return lines.join('\n');
  }
  const direction = spec.direction === 'LR' ? 'LR' : 'TD';
  const lines = [`flowchart ${direction}`];
  for (const node of nodes) {
    const wrap = node.shape === 'diamond' ? [`{${label(node.label)}}`] : node.shape === 'circle' || node.shape === 'ellipse' ? [`((${label(node.label)}))`] : node.shape === 'stadium' ? [`([${label(node.label)}])`] : [`[${label(node.label)}]`];
    lines.push(`  ${id(node.id)}${wrap[0]}`);
  }
  for (const edge of edges) lines.push(`  ${id(edge.from)} ${edge.dashed ? '-.->' : '-->'}${edge.label ? `|${label(edge.label)}|` : ''} ${id(edge.to)}`);
  return lines.join('\n');
}

export function renderHtml(spec: DiagramSpec, svg: string, mermaid: string): string {
  const title = spec.title || 'Diagram';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeXml(title)}</title>
<style>
  :root { color-scheme: ${spec.theme === 'dark' ? 'dark' : 'light'}; }
  body { margin: 0; font-family: 'Segoe UI','PingFang SC','Microsoft YaHei',system-ui,sans-serif; background: ${spec.theme === 'dark' ? '#0b1220' : '#f1f5f9'}; }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px; background:${spec.theme === 'dark' ? '#111c33' : '#ffffff'}; box-shadow:0 1px 3px rgba(0,0,0,.12); position:sticky; top:0; z-index:5; }
  header h1 { font-size:16px; margin:0; flex:1; }
  button { border:1px solid ${spec.theme === 'dark' ? '#334155' : '#cbd5e1'}; background:transparent; color:inherit; border-radius:8px; padding:6px 10px; cursor:pointer; font-size:13px; }
  #stage { overflow:auto; height: calc(100vh - 52px); cursor:grab; }
  #stage.dragging { cursor:grabbing; }
  #canvas { transform-origin:0 0; }
  details { padding:12px 18px; }
  pre { background:${spec.theme === 'dark' ? '#111c33' : '#ffffff'}; padding:12px; border-radius:8px; overflow:auto; }
</style>
</head>
<body>
<header>
  <h1>${escapeXml(title)}</h1>
  <button id="zin">Zoom +</button>
  <button id="zout">Zoom −</button>
  <button id="fit">Fit</button>
  <button id="dl">Download SVG</button>
</header>
<div id="stage"><div id="canvas">${svg}</div></div>
<script>
  const canvas = document.getElementById('canvas');
  let scale = 1, x = 0, y = 0, dragging = false, sx = 0, sy = 0;
  const apply = () => { canvas.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')'; };
  document.getElementById('zin').onclick = () => { scale = Math.min(4, scale * 1.2); apply(); };
  document.getElementById('zout').onclick = () => { scale = Math.max(0.2, scale / 1.2); apply(); };
  document.getElementById('fit').onclick = () => { scale = 1; x = 0; y = 0; apply(); };
  document.getElementById('dl').onclick = () => {
    const blob = new Blob([${JSON.stringify(svg)}], { type: 'image/svg+xml' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'diagram.svg'; a.click();
  };
  const stage = document.getElementById('stage');
  stage.addEventListener('mousedown', (e) => { dragging = true; sx = e.clientX - x; sy = e.clientY - y; stage.classList.add('dragging'); });
  window.addEventListener('mousemove', (e) => { if (!dragging) return; x = e.clientX - sx; y = e.clientY - sy; apply(); });
  window.addEventListener('mouseup', () => { dragging = false; stage.classList.remove('dragging'); });
  stage.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); scale = Math.min(4, Math.max(0.2, scale * (e.deltaY < 0 ? 1.1 : 0.9))); apply(); }, { passive: false });
</script>
<details open><summary>Mermaid source</summary><pre>${escapeXml(mermaid)}</pre></details>
</body>
</html>
`;
}

export class DiagramTool extends Tool {
  get name(): string { return 'diagram'; }
  get description(): string {
    return [
      'Draw a diagram the user can see, to make an explanation easy to grasp.',
      'kinds: mindmap (radial), flowchart, tree, sequence, architecture.',
      'Provide nodes [{id,label,shape,group,note}] and edges [{from,to,label,dashed}],',
      'OR an outline (indented text / markdown headings) that is turned into a graph.',
      'Writes a self-contained SVG and a zoomable HTML viewer under `out` (default the task workdir),',
      'and returns the SVG inline plus Mermaid source. Use group to color/label clusters (architecture).',
    ].join('\n');
  }
  get parameters(): Record<string, any> {
    return { type: 'object', properties: {
      kind: { type: 'string', enum: ['mindmap', 'flowchart', 'tree', 'sequence', 'architecture'], description: 'Diagram kind; default mindmap.' },
      title: { type: 'string', description: 'Diagram title.' },
      direction: { type: 'string', enum: ['TB', 'LR'], description: 'Flow direction for layered kinds; default TB.' },
      nodes: { type: 'array', items: { type: 'object', properties: {
        id: { type: 'string' }, label: { type: 'string' },
        shape: { type: 'string', enum: ['rect', 'rounded', 'stadium', 'diamond', 'circle', 'ellipse'] },
        group: { type: 'string' }, note: { type: 'string' },
      }, required: ['label'] }, description: 'Graph nodes.' },
      edges: { type: 'array', items: { type: 'object', properties: {
        from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' }, dashed: { type: 'boolean' },
      }, required: ['from', 'to'] }, description: 'Graph edges.' },
      outline: { type: 'string', description: 'Alternative to nodes/edges: an indented outline or markdown headings.' },
      theme: { type: 'string', enum: ['light', 'dark'], description: 'Color theme; default light.' },
      out: { type: 'string', description: 'Output directory (default: task working directory).' },
      name: { type: 'string', description: 'Base file name (without extension); default "diagram".' },
      inline: { type: 'boolean', description: 'Include the full SVG markup in the result; default true.' },
    }};
  }

  async execute(args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
    try {
      const kinds = ['mindmap', 'flowchart', 'tree', 'sequence', 'architecture'] as const;
      const kind = kinds.includes(args.kind) ? args.kind : 'mindmap';
      const spec: DiagramSpec = {
        kind,
        title: typeof args.title === 'string' ? args.title : undefined,
        direction: args.direction === 'LR' ? 'LR' : 'TB',
        nodes: Array.isArray(args.nodes) ? args.nodes.map((n: any) => ({ id: n?.id, label: String(n?.label ?? n?.id ?? ''), shape: n?.shape, group: n?.group, note: n?.note })) : undefined,
        edges: Array.isArray(args.edges) ? args.edges.map((e: any) => ({ from: String(e?.from ?? ''), to: String(e?.to ?? ''), label: e?.label, dashed: e?.dashed })) : undefined,
        outline: typeof args.outline === 'string' ? args.outline : undefined,
        theme: args.theme === 'dark' ? 'dark' : 'light',
      };
      const { nodes } = normalizeSpec(spec);
      if (!nodes.length) throw new Error('diagram needs nodes/edges or an outline');

      const { svg, width, height } = renderSvg(spec);
      const mermaid = renderMermaid(spec);
      const html = renderHtml(spec, svg, mermaid);

      const outDir = path.resolve(context.cwd, typeof args.out === 'string' && args.out.trim() ? args.out : '.');
      if (!isPathAllowed(outDir)) throw new Error('path not allowed: outside workspace roots');
      await fs.mkdir(outDir, { recursive: true });
      const base = (typeof args.name === 'string' && args.name.trim() ? args.name : 'diagram').replace(/[^\w.-]+/g, '_');
      const svgPath = path.join(outDir, `${base}.svg`);
      const htmlPath = path.join(outDir, `${base}.html`);
      await fs.writeFile(svgPath, svg, 'utf8');
      await fs.writeFile(htmlPath, html, 'utf8');

      return success({
        kind: spec.kind,
        title: spec.title || '',
        nodes: nodes.length,
        edges: (spec.edges || []).length || undefined,
        width, height,
        files: [svgPath, htmlPath],
        mermaid,
        ...(args.inline === false ? {} : { svg }),
      });
    } catch (error) { return failure(error); }
  }
}
