/**
 * Function decompiler: disassembly → CFG → frame → IR → structured control
 * flow → C.
 *
 * This is not a source-level reconstruction. It prints what the instructions
 * do: registers stay registers, stack slots become named locals, flags are
 * folded into the comparison that produced them, and loops become `while` /
 * `do` when their shape is recognisable. Anything the pipeline cannot express
 * stays as an `unknown` comment instead of being dropped.
 */
import { disassembleFunction } from './function.js';
import { buildCfg } from './cfg.js';
import { analyzeFrame, type Convention, type Frame } from './frame.js';
import { lift, type Expr, type Stmt } from './ir.js';
import { structure, type CtrlStmt } from './structure.js';
import { typeForSize, typeOfExpr, refineParam, type CType } from './types.js';

export interface DecompileOptions {
  name?: string;
  convention?: Convention;
  imageFormat?: string;
  /** Exclusive end of the function, normally the next symbol's entry. */
  end?: number;
  maxInstructions?: number;
}

export interface DecompiledFunction {
  name: string;
  entry: number;
  c: string;
  instructions: number;
  unknownPct: number;
  blocks: number;
  loops: number;
  gotos: number;
  params: Array<{ name: string; type: CType }>;
  locals: Array<{ name: string; type: CType }>;
  note?: string;
}

export function decompileFunction(
  code: Uint8Array,
  baseVaddr: number,
  entry: number,
  options: DecompileOptions = {},
): DecompiledFunction {
  const convention: Convention = options.convention
    || (options.imageFormat === 'pe' ? 'win64' : 'sysv');
  const fn = disassembleFunction(code, baseVaddr, entry, {
    name: options.name,
    end: options.end,
    maxInstructions: options.maxInstructions ?? 4000,
  });
  const blocks = buildCfg(fn.instructions);
  const frame = analyzeFrame(fn.instructions, convention);
  const lifted = lift(fn.instructions, blocks, frame);
  foldStackCheck(lifted, entry);
  const structured = structure(lifted, entry);
  const body = optimize(structured.body);

  const info = collect(body, frame);
  const params = parameterList(frame, info);
  const locals = [...info.vars.values()]
    .filter((local) => !params.some((param) => param.name === local.name))
    .map((local) => ({ name: local.name, type: local.type }));
  const signature = `${returnType(info)} ${fn.name}(${params.length ? params.map((param) => `${param.type} ${param.name}`).join(', ') : 'void'})`;

  const lines: string[] = [];
  const unknownPct = fn.instructions.length
    ? Math.round((fn.unknown / fn.instructions.length) * 1000) / 10
    : 0;
  lines.push(`/* ${fn.name} @ 0x${entry.toString(16)} — ${fn.instructions.length} instructions, ${blocks.length} blocks, ${structured.loops} loop(s), ${structured.gotos} goto(s)${unknownPct ? `, ${unknownPct}% undecoded` : ''} */`);
  lines.push(`${signature}`);
  lines.push('{');
  for (const local of locals) lines.push(`    ${local.type} ${local.name};`);
  if (locals.length) lines.push('');
  for (const stmt of body) lines.push(...printStmt(stmt, 1));
  lines.push('}');

  return {
    name: fn.name,
    entry,
    c: lines.join('\n'),
    instructions: fn.instructions.length,
    unknownPct,
    blocks: blocks.length,
    loops: structured.loops,
    gotos: structured.gotos,
    params,
    locals,
    ...(fn.truncated ? { note: 'traversal hit its instruction budget; this is a partial function' } : {}),
  };
}


/**
 * Go emits a stack-growth check as a branch to a thunk that calls morestack and
 * jumps back to the entry. Read literally it is `while (1)` around the whole
 * function; the branch is a prologue detail, so the thunk is folded away and
 * the entry keeps its fall-through.
 */
function foldStackCheck(lifted: import('./ir.js').LiftedBlock[], entry: number): void {
  const ordered = lifted.filter((block) => !block.folded).map((block) => block.start).sort((a, b) => a - b);
  const byStart = new Map(lifted.map((block) => [block.start, block]));
  const entryBlock = byStart.get(entry);
  if (!entryBlock || entryBlock.term !== 'jcc' || entryBlock.target == null) return;

  // Walk the single-successor chain from the branch target; the thunk may call
  // morestack first and jump back from a following block.
  const seen = new Set<number>();
  let current: number | null = entryBlock.target;
  let returnsToEntry = false;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const block = byStart.get(current);
    if (!block) break;
    if (block.term === 'jmp') { returnsToEntry = block.target === entry; break; }
    if (block.term === 'ret' || block.term === 'jcc') break;
    const index = ordered.indexOf(current);
    current = index >= 0 && index + 1 < ordered.length ? ordered[index + 1] : null;
  }
  if (!returnsToEntry) return;

  entryBlock.stmts.unshift({ t: 'unknown', text: 'stack check: morestack thunk folded' });
  entryBlock.term = 'fallthrough';
  entryBlock.cond = null;
  delete entryBlock.target;
  for (const start of seen) {
    const block = byStart.get(start);
    if (block) block.folded = true;
  }
}

interface Collected {
  vars: Map<string, { name: string; size: number; type: CType }>;
  returnsValue: boolean;
}

function collect(body: CtrlStmt[], frame: Frame): Collected {
  const vars: Collected['vars'] = new Map();
  let returnsValue = false;

  const note = (name: string, size: number) => {
    const existing = vars.get(name);
    if (existing) {
      if (size > existing.size) { existing.size = size; existing.type = typeForSize(size); }
      return;
    }
    const slot = [...frame.slots.values()].find((candidate) => candidate.name === name);
    const resolved = slot ? slot.size : size;
    vars.set(name, { name, size: resolved, type: typeForSize(resolved) });
  };

  const expr = (value: Expr | undefined) => {
    if (!value) return;
    switch (value.t) {
      case 'reg':
      case 'var':
        note(value.name, value.size);
        return;
      case 'load': {
        if (value.addr.t === 'var' || value.addr.t === 'reg') {
          note(value.addr.name, value.addr.size);
          const entry = vars.get(value.addr.name);
          if (entry) entry.type = 'void *';
        }
        expr(value.addr);
        return;
      }
      case 'bin':
        expr(value.left); expr(value.right); return;
      case 'un':
        expr(value.value); return;
      case 'cast':
        expr(value.value); return;
      case 'select':
        expr(value.cond); expr(value.a); expr(value.b); return;
      case 'call':
        for (const arg of value.args) expr(arg);
        return;
      default:
        return;
    }
  };

  const stmt = (item: CtrlStmt) => {
    switch (item.t) {
      case 'assign':
        expr(item.target); expr(item.value);
        if (item.target.t === 'reg' && item.target.name === 'rax') returnsValue = true;
        return;
      case 'expr':
        expr(item.expr);
        return;
      case 'return':
        if (item.value) { expr(item.value); returnsValue = true; }
        return;
      case 'if':
        expr(item.cond); item.then.forEach(stmt); item.else?.forEach(stmt); return;
      case 'while':
        if (item.cond) expr(item.cond);
        item.body.forEach(stmt);
        return;
      case 'do':
        item.body.forEach(stmt); expr(item.cond); return;
      default:
        return;
    }
  };

  body.forEach(stmt);
  return { vars, returnsValue };
}

function parameterList(frame: Frame, info: Collected): Array<{ name: string; type: CType }> {
  const byIndex = new Map<number, { name: string; type: CType }>();
  for (const slot of frame.slots.values()) {
    const match = /^arg(\d+)$/.exec(slot.name);
    if (!match) continue;
    const index = Number(match[1]);
    const entry = info.vars.get(slot.name);
    const usedAsAddress = entry?.type === 'void *';
    byIndex.set(index, { name: slot.name, type: refineParam(typeForSize(slot.size || 64), usedAsAddress) });
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
}

function returnType(info: Collected): CType | 'void' {
  return info.returnsValue ? 'long' : 'void';
}

function optimize(stmts: CtrlStmt[]): CtrlStmt[] {
  const out: CtrlStmt[] = [];
  for (const stmt of stmts) {
    if (stmt.t === 'assign' && stmt.target.t === stmt.value.t && 'name' in stmt.target && 'name' in stmt.value
      && stmt.target.name === stmt.value.name) {
      continue; // x = x
    }
    if (stmt.t === 'return' && stmt.value?.t === 'reg' && stmt.value.name === 'rax') {
      const previous = out[out.length - 1];
      if (previous && previous.t === 'assign' && previous.target.t === 'reg' && previous.target.name === 'rax') {
        out[out.length - 1] = { t: 'return', value: previous.value };
        continue;
      }
      out.push({ t: 'return' });
      continue;
    }
    if (stmt.t === 'if') {
      out.push({ t: 'if', cond: stmt.cond, then: optimize(stmt.then), ...(stmt.else ? { else: optimize(stmt.else) } : {}) });
      continue;
    }
    if (stmt.t === 'while') { out.push({ t: 'while', cond: stmt.cond, body: optimize(stmt.body) }); continue; }
    if (stmt.t === 'do') { out.push({ t: 'do', body: optimize(stmt.body), cond: stmt.cond }); continue; }
    out.push(stmt);
  }
  return out;
}

const PRECEDENCE: Record<string, number> = {
  '*': 80, '/': 80, '%': 80,
  '+': 70, '-': 70,
  '<<': 60, '>>': 60,
  '<': 50, '>': 50, '<=': 50, '>=': 50,
  '==': 40, '!=': 40,
  '&': 35, '^': 30, '|': 25,
};

function printExpr(expr: Expr, parentPrecedence = 0): string {
  switch (expr.t) {
    case 'const': {
      const value = expr.v;
      if (value < 0) return `-0x${Math.abs(value).toString(16)}`;
      return value <= 9 ? String(value) : `0x${value.toString(16)}`;
    }
    case 'reg':
    case 'var':
      return expr.name;
    case 'load':
      return `*(${typeForSize(expr.size)} *)${wrap(expr.addr, 90)}`;
    case 'bin': {
      if ((expr.op === '>>' || expr.op === '<<') && expr.right.t === 'const' && expr.right.v === 0) return printExpr(expr.left, parentPrecedence);
      const precedence = PRECEDENCE[expr.op] ?? 10;
      const text = `${printExpr(expr.left, precedence)} ${expr.op} ${printExpr(expr.right, precedence + 1)}`;
      return precedence < parentPrecedence ? `(${text})` : text;
    }
    case 'un':
      return `${expr.op}${wrap(expr.value, 90)}`;
    case 'cast':
      return `(${typeForSize(expr.size, !expr.signed)})${wrap(expr.value, 90)}`;
    case 'select':
      return `${printExpr(expr.cond, 20)} ? ${printExpr(expr.a, 20)} : ${printExpr(expr.b, 20)}`;
    case 'call':
      return `${expr.target}(${expr.args.map((arg) => printExpr(arg)).join(', ')})`;
    case 'unknown':
      return `/* ${expr.text} */ 0`;
    default:
      return '0';
  }
}

function wrap(expr: Expr, precedence: number): string {
  const text = printExpr(expr, precedence);
  return text.startsWith('(') || /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) || /^(0x[0-9a-f]+|\d+)$/.test(text)
    ? text
    : `(${text})`;
}

function indent(level: number): string {
  return '    '.repeat(level);
}

function printStmt(stmt: CtrlStmt, level: number): string[] {
  const pad = indent(level);
  switch (stmt.t) {
    case 'assign': {
      if (stmt.target.t === 'load') {
        return [`${pad}*(${typeForSize(stmt.target.size)} *)${wrap(stmt.target.addr, 90)} = ${printExpr(stmt.value)};`];
      }
      return [`${pad}${printExpr(stmt.target)} = ${printExpr(stmt.value)};`];
    }
    case 'expr':
      return [`${pad}${printExpr(stmt.expr)};`];
    case 'return':
      return [stmt.value ? `${pad}return ${printExpr(stmt.value)};` : `${pad}return;`];
    case 'unknown':
      return [`${pad}/* unknown: ${stmt.text} */`];
    case 'if': {
      const lines = [`${pad}if (${printExpr(stmt.cond)}) {`];
      for (const inner of stmt.then) lines.push(...printStmt(inner, level + 1));
      if (stmt.else?.length) {
        lines.push(`${pad}} else {`);
        for (const inner of stmt.else) lines.push(...printStmt(inner, level + 1));
      }
      lines.push(`${pad}}`);
      return lines;
    }
    case 'while': {
      const lines = [`${pad}while (${stmt.cond ? printExpr(stmt.cond) : '1'}) {`];
      for (const inner of stmt.body) lines.push(...printStmt(inner, level + 1));
      lines.push(`${pad}}`);
      return lines;
    }
    case 'do': {
      const lines = [`${pad}do {`];
      for (const inner of stmt.body) lines.push(...printStmt(inner, level + 1));
      lines.push(`${pad}} while (${printExpr(stmt.cond)});`);
      return lines;
    }
    case 'goto':
      return [`${pad}goto ${stmt.label};`];
    case 'label':
      return [`${pad}${stmt.name}:;`];
    default:
      return [];
  }
}
