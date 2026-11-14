/**
 * Recover structured control flow from the CFG.
 *
 * The recursion is driven by post-dominators: the join of a conditional is the
 * immediate post-dominator, so `if`/`else` is decided by which side reaches it.
 * A back edge (target dominates the source) marks a loop; the three shapes
 * compilers emit — `while`, `do/while`, `while (1)` — are recognised directly.
 * Anything irreducible keeps a label and a `goto` instead of being guessed at.
 */
import type { Expr, LiftedBlock, Stmt } from './ir.js';

export type CtrlStmt =
  | Stmt
  | { t: 'if'; cond: Expr; then: CtrlStmt[]; else?: CtrlStmt[] }
  | { t: 'while'; cond: Expr | null; body: CtrlStmt[] }
  | { t: 'do'; body: CtrlStmt[]; cond: Expr }
  | { t: 'switch'; value: Expr; cases: Array<{ value: number; body: CtrlStmt[] }>; defaultBody?: CtrlStmt[] }
  | { t: 'goto'; label: string }
  | { t: 'label'; name: string };

export interface StructureResult {
  body: CtrlStmt[];
  /** Blocks that could not be placed in the structured tree. */
  orphans: number[];
  loops: number;
  gotos: number;
}

interface LoopInfo {
  header: number;
  latches: number[];
  blocks: Set<number>;
  exit: number | null;
}

export function structure(blocks: LiftedBlock[], entry: number): StructureResult {
  const byStart = new Map<number, LiftedBlock>();
  for (const block of blocks) byStart.set(block.start, block);
  const order = blocks.filter((block) => !block.folded).map((block) => block.start);

  const successors = new Map<number, number[]>();
  const predecessors = new Map<number, number[]>();
  for (const block of blocks) {
    const next = nextBlock(block, byStart, order);
    const out: number[] = [];
    if (block.switch) {
      for (const entry of block.switch.cases) out.push(entry.target);
      if (block.switch.defaultTarget != null) out.push(block.switch.defaultTarget);
    } else if (block.term === 'jmp' && block.target != null) out.push(block.target);
    else if (block.term === 'jcc') {
      if (block.target != null) out.push(block.target);
      if (next != null) out.push(next);
    } else if (block.term === 'fallthrough' && next != null) out.push(next);
    successors.set(block.start, [...new Set(out)]);
    for (const target of out) {
      const list = predecessors.get(target) || [];
      list.push(block.start);
      predecessors.set(target, list);
    }
  }

  const dominators = computeDominators(entry, order, successors, predecessors);
  const postDominators = computePostDominators(order, successors, predecessors);
  const ipdom = (block: number): number | null => immediatePostDominator(block, postDominators);

  const loops = findLoops(order, successors, dominators);
  const loopByHeader = new Map<number, LoopInfo>();
  for (const loop of loops) {
    // The exit is the header's immediate post-dominator when it lies outside
    // the body; the address-ordered guess is only a fallback.
    const candidate = ipdom(loop.header);
    if (candidate != null && !loop.blocks.has(candidate)) loop.exit = candidate;
    loopByHeader.set(loop.header, loop);
  }

  const emitted = new Set<number>();
  let gotos = 0;
  let depth = 0;

  const emitRange = (start: number | null, stop: number | null): CtrlStmt[] => {
    const out: CtrlStmt[] = [];
    let current = start;
    let guard = 0;
    while (current != null && current !== stop && guard++ < order.length * 4) {
      if (emitted.has(current)) break;
      const loop = loopByHeader.get(current);
      if (loop) {
        out.push(emitLoop(loop));
        current = loop.exit;
        continue;
      }
      emitted.add(current);
      const block = byStart.get(current);
      if (!block) break;
      out.push(...block.stmts);

      if (block.term === 'ret') break;
      if (block.switch) {
        const join = ipdom(current);
        const cases = block.switch.cases.map((entry) => ({ value: entry.value, body: emitRange(entry.target, join) }));
        const defaultBody = block.switch.defaultTarget != null ? emitRange(block.switch.defaultTarget, join) : undefined;
        out.push({ t: 'switch', value: block.switch.value, cases, ...(defaultBody ? { defaultBody } : {}) });
        current = join;
        continue;
      }
      const next = nextBlock(block, byStart, order);

      if (block.term === 'jmp') {
        const target = block.target ?? null;
        if (target == null) break;
        if (target === stop) break;
        if (dominators.get(current)?.has(target)) break; // back edge: the loop owns it
        if (emitted.has(target)) {
          out.push({ t: 'goto', label: labelOf(target) });
          gotos += 1;
          break;
        }
        current = target;
        continue;
      }

      if (block.term === 'jcc') {
        const cond = block.cond || { t: 'unknown' as const, text: 'flags', size: 1 };
        const thenBlock = block.target ?? null;
        const elseBlock = next;
        const join = ipdom(current);
        if (thenBlock == null || elseBlock == null) break;
        if (join === elseBlock) {
          out.push({ t: 'if', cond, then: emitRange(thenBlock, join) });
        } else if (join === thenBlock) {
          out.push({ t: 'if', cond: negate(cond), then: emitRange(elseBlock, join) });
        } else {
          const thenBody = emitRange(thenBlock, join);
          const elseBody = emitRange(elseBlock, join);
          out.push({ t: 'if', cond, then: thenBody, ...(elseBody.length ? { else: elseBody } : {}) });
        }
        current = join;
        continue;
      }

      current = next;
    }
    return out;
  };

  const emitLoop = (loop: LoopInfo): CtrlStmt => {
    depth += 1;
    const header = byStart.get(loop.header);
    const exit = loop.exit;
    if (!header) {
      depth -= 1;
      return { t: 'unknown', text: `loop at 0x${loop.header.toString(16)}` };
    }
    emitted.add(loop.header);
    const headerNext = nextBlock(header, byStart, order);

    // while (cond) { ... }: the header branches to the exit and falls into the body.
    if (header.term === 'jcc' && header.target === exit && headerNext != null && loop.blocks.has(headerNext)) {
      const body = emitRange(headerNext, loop.header);
      depth -= 1;
      return { t: 'while', cond: header.cond || null, body };
    }

    // do { ... } while (cond): a latch branches back to the header.
    const latch = loop.latches.map((start) => byStart.get(start)).find((block) => block && block.term === 'jcc' && block.target === loop.header);
    if (latch) {
      emitted.add(latch.start);
      const body = emitRange(header.start, latch.start);
      body.push(...latch.stmts);
      depth -= 1;
      return { t: 'do', body, cond: latch.cond || { t: 'unknown', text: 'flags', size: 1 } };
    }

    // while (1) { ... }: the exit is reached from inside.
    const body = emitRange(headerNext, exit);
    depth -= 1;
    return { t: 'while', cond: null, body };
  };

  const body = emitRange(entry, null);
  const orphans = order.filter((start) => !emitted.has(start));
  // Anything unreachable is still shown, after a label, rather than dropped.
  for (const start of orphans) {
    const block = byStart.get(start);
    if (!block) continue;
    body.push({ t: 'label', name: labelOf(start) }, ...block.stmts);
    if (block.term === 'jmp' && block.target != null) body.push({ t: 'goto', label: labelOf(block.target) });
    emitted.add(start);
  }
  void depth;
  return { body, orphans, loops: loops.length, gotos };
}

function labelOf(address: number): string {
  return `L_${address.toString(16)}`;
}

/**
 * The fall-through block is the next block in address order, not the block
 * that happens to start at `end`: padding, alignment and an undecoded byte
 * all leave gaps, and looking up `end` would silently lose the edge.
 */
function nextBlock(block: LiftedBlock, byStart: Map<number, LiftedBlock>, ordered: number[]): number | null {
  const index = ordered.indexOf(block.start);
  if (index < 0 || index + 1 >= ordered.length) return null;
  const next = byStart.get(ordered[index + 1]);
  return next ? next.start : null;
}

function negate(expr: Expr): Expr {
  if (expr.t === 'bin') {
    const opposite: Record<string, string> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
    if (opposite[expr.op]) return { t: 'bin', op: opposite[expr.op], left: expr.left, right: expr.right, size: 1 };
  }
  return { t: 'un', op: '!', value: expr, size: 1 };
}

function computeDominators(
  entry: number,
  order: number[],
  successors: Map<number, number[]>,
  predecessors: Map<number, number[]>,
): Map<number, Set<number>> {
  const all = new Set(order);
  const dominators = new Map<number, Set<number>>();
  for (const block of order) dominators.set(block, block === entry ? new Set([entry]) : new Set(all));
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < order.length * 4) {
    changed = false;
    for (const block of order) {
      if (block === entry) continue;
      const preds = predecessors.get(block) || [];
      let next: Set<number> | null = null;
      for (const pred of preds) {
        const set = dominators.get(pred);
        if (!set) continue;
        next = next ? new Set<number>([...next].filter((value: number) => set.has(value))) : new Set<number>(set);
      }
      const merged = new Set([block, ...(next || [])]);
      const before = dominators.get(block)!;
      if (merged.size !== before.size) { dominators.set(block, merged); changed = true; }
    }
  }
  void successors;
  return dominators;
}

function computePostDominators(
  order: number[],
  successors: Map<number, number[]>,
  predecessors: Map<number, number[]>,
): Map<number, Set<number>> {
  const all = new Set(order);
  const post = new Map<number, Set<number>>();
  const exits = order.filter((block) => (successors.get(block) || []).length === 0);
  for (const block of order) post.set(block, exits.includes(block) ? new Set([block]) : new Set(all));
  let changed = true;
  let rounds = 0;
  while (changed && rounds++ < order.length * 4) {
    changed = false;
    for (const block of order) {
      if (exits.includes(block)) continue;
      const succs = successors.get(block) || [];
      let next: Set<number> | null = null;
      for (const succ of succs) {
        const set = post.get(succ);
        if (!set) continue;
        next = next ? new Set<number>([...next].filter((value: number) => set.has(value))) : new Set<number>(set);
      }
      const merged = new Set([block, ...(next || [])]);
      const before = post.get(block)!;
      if (merged.size !== before.size) { post.set(block, merged); changed = true; }
    }
  }
  void predecessors;
  return post;
}

/**
 * The immediate post-dominator is the strict post-dominator that every other
 * strict post-dominator also post-dominates. Blocks are few, so the quadratic
 * scan is fine and has no edge cases around virtual exits.
 */
function immediatePostDominator(block: number, post: Map<number, Set<number>>): number | null {
  const strict = [...(post.get(block) || [])].filter((candidate) => candidate !== block);
  if (!strict.length) return null;
  for (const candidate of strict) {
    const candidateSet = post.get(candidate);
    if (!candidateSet) continue;
    if (strict.every((other) => other === candidate || candidateSet.has(other))) return candidate;
  }
  return strict[0];
}

function findLoops(
  order: number[],
  successors: Map<number, number[]>,
  dominators: Map<number, Set<number>>,
): LoopInfo[] {
  const loops = new Map<number, LoopInfo>();
  for (const block of order) {
    for (const target of successors.get(block) || []) {
      const targetDominates = dominators.get(block)?.has(target);
      if (!targetDominates) continue;
      let loop = loops.get(target);
      if (!loop) {
        loop = { header: target, latches: [], blocks: new Set([target]), exit: null };
        loops.set(target, loop);
      }
      if (!loop.latches.includes(block)) loop.latches.push(block);
      // Body: every block dominated by the header that can reach a latch.
      const reachable = reachableToLatch(target, loop.latches, successors, dominators);
      for (const member of reachable) loop.blocks.add(member);
    }
  }
  for (const loop of loops.values()) {
    const exits = new Set<number>();
    for (const member of loop.blocks) {
      for (const target of successors.get(member) || []) {
        if (!loop.blocks.has(target)) exits.add(target);
      }
    }
    // The common exit is the post-dominator of the header among the exits; the
    // smallest address is a stable, predictable choice when several exist.
    loop.exit = exits.size ? [...exits].sort((a, b) => a - b)[0] : null;
  }
  return [...loops.values()].sort((a, b) => a.header - b.header);
}

function reachableToLatch(header: number, latches: number[], successors: Map<number, number[]>, dominators: Map<number, Set<number>>): Set<number> {
  const seen = new Set<number>([header]);
  const queue = [header];
  while (queue.length) {
    const block = queue.shift() as number;
    for (const target of successors.get(block) || []) {
      if (seen.has(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  // Keep only what lies on a path to a latch: a simple forward/backward pass.
  const canReach = new Set<number>(latches);
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of seen) {
      if (canReach.has(block)) continue;
      if ((successors.get(block) || []).some((target) => canReach.has(target))) {
        canReach.add(block);
        changed = true;
      }
    }
  }
  // Only blocks the header dominates belong to the loop; without this a
  // latch near the end of the function pulls every preceding block in.
  return new Set([...seen].filter((block) => canReach.has(block) && dominators.get(block)?.has(header)));
}
