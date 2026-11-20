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
import { analyzeFrame, inferRegisterParams, type Convention, type Frame } from './frame.js';
import { lift, type Expr, type Stmt } from './ir.js';
import { structure, type CtrlStmt } from './structure.js';
import { optimizeStatements } from './optimize.js';
import { recoverSwitch } from './switch.js';
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
  for (let index = 0; index < lifted.length; index++) {
    const info = recoverSwitch(
      lifted[index], blocks[index]?.instructions || [], code, baseVaddr,
      (address) => address >= baseVaddr && address - baseVaddr < code.length,
    );
    if (info) lifted[index].switch = info;
  }
  foldStackCheck(lifted, entry);
  const structured = structure(lifted, entry);
  const body = optimizeControl(optimize(structured.body));
  // Judged on the structured body, before dead-store elimination: a single
  // constant move followed by `ret rax` optimises down to one statement, and
  // deciding afterwards would call that a pass-through when the function did
  // compute something.
  const passThroughReturn = structured.body.length === 1 && structured.body[0]?.t === 'return';

  // Go does not spill its register arguments, so when the frame has no saved
  // arguments the inputs are recovered from the first reads instead.
  const frameParams = [...frame.slots.values()].some((slot) => /^arg\d+$/.test(slot.name));
  const inferred = frameParams ? [] : inferRegisterParams(fn.instructions, frame);
  const renamed = new Map(inferred.map((param) => [param.register, param.name]));
  const paramNames = new Set(inferred.map((param) => param.name));
  const finalBody = renamed.size ? body.map((stmt) => renameStmt(stmt, renamed, paramNames)) : body;

  const info = collect(finalBody, frame, paramNames, passThroughReturn);
  const params = parameterList(frame, info);
  for (const param of inferred) {
    if (params.some((existing) => existing.name === param.name)) continue;
    const entry = info.vars.get(param.name);
    params.push({ name: param.name, type: entry?.type === 'void *' ? 'void *' : 'long' });
  }
  params.sort((a, b) => Number(a.name.replace(/\D/g, '')) - Number(b.name.replace(/\D/g, '')));
  const locals = [...info.vars.values()]
    .filter((local) => !params.some((param) => param.name === local.name))
    .map((local) => ({ name: local.name, type: local.type }));
  const signature = `${returnType(info)} ${fn.name}(${params.length ? params.map((param) => `${param.type} ${param.name}`).join(', ') : 'void'})`;

  const lines: string[] = [];
  const unknownPct = fn.instructions.length
    ? Math.round((fn.unknown / fn.instructions.length) * 1000) / 10
    : 0;
  lines.push(`/* ${fn.name} @ 0x${entry.toString(16)} — ${fn.instructions.length} instructions, ${blocks.length} blocks, ${structured.loops} loop(s), ${structured.gotos} goto(s)${unknownPct ? `, ${unknownPct}% undecoded` : ''} */`);
  if (inferred.length) lines.push('/* parameters inferred from register reads (register ABI); the signature is approximate */');
  lines.push(`${signature}`);
  lines.push('{');
  for (const local of locals) lines.push(`    ${local.type} ${local.name};`);
  const uninitialised = uninitialisedNote(info);
  if (uninitialised) lines.push(`    ${uninitialised}`);
  if (locals.length) lines.push('');
  for (const stmt of finalBody) lines.push(...printStmt(stmt, 1));
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

  // Only the thunk is folded. The walk above follows single successors, and on a
  // function whose thunk jumps back to the entry the chain continues straight
  // into the entry's *own* following blocks — real code, which used to be marked
  // folded and vanish from the output along with the `lea` that computed a loop
  // bound. A block counts as thunk only while it has no statement of its own.
  entryBlock.stmts.unshift({ t: 'unknown', text: 'stack check: morestack thunk folded' });
  entryBlock.term = 'fallthrough';
  entryBlock.cond = null;
  delete entryBlock.target;
  for (const start of seen) {
    if (start === entry) continue;
    const block = byStart.get(start);
    if (block && !block.stmts.length) block.folded = true;
  }
}

interface Collected {
  vars: Map<string, { name: string; size: number; type: CType }>;
  returnsValue: boolean;
  /** Names returned without ever being written — an undefined read, not a value. */
  undefinedReturns: Set<string>;
}

function collect(body: CtrlStmt[], frame: Frame, params: Set<string> = new Set(), passThroughReturn = false): Collected {
  const vars: Collected['vars'] = new Map();
  const defined = new Set<string>(params);
  const undefinedReturns = new Set<string>();
  /** Names the body writes. Empty means the function computes nothing of its own. */
  const writes = new Set<string>();
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
        // The value is read before the target is written: `rax = rax + 1`
        // reads an undefined rax, and that is the bug this catches.
        undefinedReads(item.value, defined, undefinedReturns);
        expr(item.value);
        expr(item.target);
        // A versioned name (`rbx_2`) is a fresh variable, but the base name has
        // been written too: without this every version of a pinned register read
        // as undefined.
        defined.add(nameOf(item.target));
        if (nameOf(item.target)) {
          writes.add(nameOf(item.target));
          const base = nameOf(item.target).replace(/_\d+$/, '');
          if (base !== nameOf(item.target)) defined.add(base);
        }
        if (item.target.t === 'reg' && item.target.name === 'rax') returnsValue = true;
        return;
      case 'expr':
        undefinedReads(item.expr, defined, undefinedReturns);
        expr(item.expr);
        return;
      case 'return':
        if (item.value) {
          // A pass-through is the whole body: a bare `ret` handing back the
          // register it was given. Go emits that idiom widely, and labelling it
          // put the warning on a third of every binary until readers learned to
          // ignore it. Anything longer that reads an unwritten name really is
          // an undefined read.
          if (!passThroughReturn) undefinedReads(item.value, defined, undefinedReturns);
          expr(item.value);
          returnsValue = true;
        }
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
  return { vars, returnsValue, undefinedReturns };
}

/**
 * Names this expression reads that nothing has written yet.
 *
 * Walked rather than checked at the top level: `return rax + 1` reads rax one
 * level down, and a top-level-only check called that fine.
 */
function undefinedReads(value: Expr | undefined, defined: Set<string>, out: Set<string>): void {
  if (!value) return;
  switch (value.t) {
    case 'reg':
    case 'var':
      if (value.name && !defined.has(value.name)) out.add(value.name);
      return;
    case 'load': undefinedReads(value.addr, defined, out); return;
    case 'bin': undefinedReads(value.left, defined, out); undefinedReads(value.right, defined, out); return;
    // `lea rax, [rsp+32]` takes the address of a slot; that is not a read of the
    // slot's contents, and a stack slot has an address from the moment the frame
    // exists. Counting it put the warning on every function that passes a local
    // by pointer.
    case 'un': if (value.op !== '&') undefinedReads(value.value, defined, out); return;
    case 'cast': undefinedReads(value.value, defined, out); return;
    case 'select': undefinedReads(value.cond, defined, out); undefinedReads(value.a, defined, out); undefinedReads(value.b, defined, out); return;
    case 'call': for (const arg of value.args) undefinedReads(arg, defined, out); return;
    default: return;
  }
}

/** Which name an expression reads or writes, when it is one name. */
function nameOf(expr: Expr): string {
  return expr.t === 'var' || expr.t === 'reg' ? expr.name : '';
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

/**
 * A value that is printed before anything writes it.
 *
 * The disassembly is complete — the register really is read with no prior
 * write in this function — so the honest output says so once at the declaration
 * instead of leaving a bare `long rax;` that reads like a normal local.
 */
function uninitialisedNote(info: Collected): string | null {
  if (!info.undefinedReturns.size) return null;
  return `/* read before written: ${[...info.undefinedReturns].sort().join(', ')} — the disassembly shows no store to it */`;
}


/** Turn an inferred parameter register into a named variable throughout the body. */
function renameExpr(expr: Expr, mapping: Map<string, string>): Expr {
  switch (expr.t) {
    case 'reg':
      return mapping.has(expr.name) ? { t: 'var', name: mapping.get(expr.name) as string, size: expr.size } : expr;
    case 'load':
      return { ...expr, addr: renameExpr(expr.addr, mapping) };
    case 'bin':
      return { ...expr, left: renameExpr(expr.left, mapping), right: renameExpr(expr.right, mapping) };
    case 'un':
      return { ...expr, value: renameExpr(expr.value, mapping) };
    case 'cast':
      return { ...expr, value: renameExpr(expr.value, mapping) };
    case 'select':
      return { ...expr, cond: renameExpr(expr.cond, mapping), a: renameExpr(expr.a, mapping), b: renameExpr(expr.b, mapping) };
    case 'call':
      return { ...expr, args: expr.args.map((arg) => renameExpr(arg, mapping)) };
    default:
      return expr;
  }
}

/**
 * Rename registers to parameter names, and stop the body from assigning them.
 *
 * A parameter is a name for a value that arrived in a register, not a variable
 * the body owns. After the rename, `rdi` becomes `arg0` everywhere — including
 * in places where the register is being used as scratch space after a call,
 * which would print `arg0 = call(...)` and claim the caller's argument had been
 * overwritten by the callee's result. No compiler emits that, and a reader who
 * believes it draws the wrong conclusion about the data flow.
 *
 * So an assignment whose target is a parameter keeps the register name instead:
 * the value is real, the variable it lands in is not the argument.
 */
function renameStmt(stmt: CtrlStmt, mapping: Map<string, string>, params: Set<string>): CtrlStmt {
  switch (stmt.t) {
    case 'assign': {
      const value = renameExpr(stmt.value, mapping);
      const renamed = renameExpr(stmt.target, mapping);
      // A parameter target falls back to the raw register it came from.
      const target = renamed.t === 'var' && params.has(renamed.name)
        ? unrenameExpr(renamed, mapping)
        : renamed;
      return { t: 'assign', target, value };
    }
    case 'expr':
      return { t: 'expr', expr: renameExpr(stmt.expr, mapping) };
    case 'return':
      return stmt.value ? { t: 'return', value: renameExpr(stmt.value, mapping) } : stmt;
    case 'if':
      return { t: 'if', cond: renameExpr(stmt.cond, mapping), then: stmt.then.map((inner) => renameStmt(inner, mapping, params)), ...(stmt.else ? { else: stmt.else.map((inner) => renameStmt(inner, mapping, params)) } : {}) };
    case 'while':
      return { t: 'while', cond: stmt.cond ? renameExpr(stmt.cond, mapping) : null, body: stmt.body.map((inner) => renameStmt(inner, mapping, params)) };
    case 'do':
      return { t: 'do', body: stmt.body.map((inner) => renameStmt(inner, mapping, params)), cond: renameExpr(stmt.cond, mapping) };
    default:
      return stmt;
  }
}

/** The inverse of `mapping`, for the one case where a name must not be used. */
function unrenameExpr(expr: Expr, mapping: Map<string, string>): Expr {
  if (expr.t !== 'var') return expr;
  for (const [register, name] of mapping) {
    if (name === expr.name) return { t: 'reg', name: register, size: expr.size };
  }
  return expr;
}


/** Apply value propagation to each run of straight-line statements. */
function optimizeControl(stmts: CtrlStmt[]): CtrlStmt[] {
  const out: CtrlStmt[] = [];
  let buffer: Stmt[] = [];
  const flush = () => {
    if (!buffer.length) return;
    out.push(...optimizeStatements(buffer));
    buffer = [];
  };
  for (const stmt of stmts) {
    if (stmt.t === 'assign' || stmt.t === 'expr' || stmt.t === 'return' || stmt.t === 'unknown') {
      buffer.push(stmt);
      continue;
    }
    flush();
    if (stmt.t === 'if') out.push({ ...stmt, then: optimizeControl(stmt.then), ...(stmt.else ? { else: optimizeControl(stmt.else) } : {}) });
    else if (stmt.t === 'while') out.push({ ...stmt, body: optimizeControl(stmt.body) });
    else if (stmt.t === 'do') out.push({ ...stmt, body: optimizeControl(stmt.body) });
    else out.push(stmt);
  }
  flush();
  return out;
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
      // rax was not written in this block; keep the value rather than turning a
      // real return into `return;` (the callee may have set it in another path).
      out.push(stmt);
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
    case 'switch': {
      const lines = [`${pad}switch (${printExpr(stmt.value)}) {`];
      for (const entry of stmt.cases) {
        lines.push(`${pad}case ${entry.value}:`);
        for (const inner of entry.body) lines.push(...printStmt(inner, level + 1));
        lines.push(`${pad}    break;`);
      }
      if (stmt.defaultBody) {
        lines.push(`${pad}default:`);
        for (const inner of stmt.defaultBody) lines.push(...printStmt(inner, level + 1));
        lines.push(`${pad}    break;`);
      }
      lines.push(`${pad}}`);
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
