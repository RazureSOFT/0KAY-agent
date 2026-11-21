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
  | { t: 'continue' }
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
  /**
   * The loops whose body is currently being emitted, innermost last.
   *
   * A `jmp` back to a loop header is a `continue`, and printing nothing for it left
   * an empty branch where the source had `if (...) { continue }`. The information
   * exists — the dominator analysis already knows the edge is a back edge — it just
   * had no name in the output.
   */
  const loopStack: { header: number; exit: number | null }[] = [];

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
      // Every block is labelled where it is printed. A `goto` can only point at a
      // block that some other path already printed, and the label has to be at that
      // first printing — which is here. Labelling only the blocks that looked like
      // they would be jumped to left 534 functions per 4000 jumping to a label that
      // was never written; labelling the ones that are never jumped to costs nothing
      // because `pruneLabels` takes them out again at the end.
      out.push({ t: 'label', name: labelOf(current) }, ...block.stmts);

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
        if (dominators.get(current)?.has(target)) {
          // Back edge. If it closes the loop the body is inside, that is `continue`.
          const enclosing = loopStack.find((entry) => entry.header === target);
          if (enclosing) out.push({ t: 'continue' });
          break;
        }
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
        // A branch into a folded block is a branch into the stack-growth retry,
        // which the reader should not see. Once it is gone the guard has no
        // alternative, so the block continues at its fall-through — and keeping
        // the block's own statements (already pushed above) is what stops a
        // `lea` that computed a value from disappearing with the guard.
        const targetBlock = block.target != null ? byStart.get(block.target) : undefined;
        const branchGone = block.target != null && (!targetBlock || targetBlock.folded);
        if (branchGone) {
          current = next;
          continue;
        }
        const thenBlock = block.target ?? null;
        const elseBlock = next;
        const join = ipdom(current);
        if (thenBlock == null || elseBlock == null) break;
        if (join === elseBlock) {
          const thenBody = emitRange(thenBlock, join);
          // An empty then-body is the negative of the same test. Printing
          // `if (x != 0x12) { } else { ... }` for a comparison chain that tests
          // for equality makes every case of a type switch read backwards, and
          // the empty braces look like lost code.
          if (!thenBody.length) out.push({ t: 'if', cond: negate(cond), then: emitRange(elseBlock, join) });
          else out.push({ t: 'if', cond, then: thenBody });
        } else if (join === thenBlock) {
          out.push({ t: 'if', cond: negate(cond), then: emitRange(elseBlock, join) });
        } else {
          const thenBody = emitRange(thenBlock, join);
          const elseBody = emitRange(elseBlock, join);
          // A branch onto an already-emitted epilogue comes out empty, because the
          // block was printed once and `emitRange` stops at `emitted`. When that
          // block does nothing but return, the branch's body *is* that return:
          // printing an empty pair of braces hides a real early exit, and Go shares
          // one epilogue between every exit in the function, so this is common.
          const epilogue = thenBody.length ? [] : sharedReturn(thenBlock, join, byStart, emitted);
          // An empty then-body beside a real else-body is the same test written the
          // other way round. It happens when the branch target was already emitted
          // by an enclosing structure, so `emitRange` returned nothing: printing
          // `if (x) { } else { ... }` shows an empty block that reads as lost code,
          // and every case of a switch that shares a tail comes out inverted.
          if (epilogue.length) out.push({ t: 'if', cond, then: epilogue, ...(elseBody.length ? { else: elseBody } : {}) });
          else if (!thenBody.length && elseBody.length) out.push({ t: 'if', cond: negate(cond), then: elseBody });
          else out.push({ t: 'if', cond, then: thenBody, ...(elseBody.length ? { else: elseBody } : {}) });
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
    const headerLabel: CtrlStmt = { t: 'label', name: labelOf(loop.header) };
    const headerNext = nextBlock(header, byStart, order);
    // Everything emitted from here on is inside this loop, so a backward branch to
    // this header is a `continue` rather than an unexplained edge.
    loopStack.push({ header: loop.header, exit: exit ?? null });

    // while (cond) { ... }: the header branches to the exit and falls into the body.
    if (header.term === 'jcc' && header.target === exit && headerNext != null && loop.blocks.has(headerNext)) {
      const body = [headerLabel, ...emitRange(headerNext, loop.header)];
      depth -= 1;
      loopStack.pop();
      return { t: 'while', cond: header.cond || null, body };
    }

    // do { ... } while (cond): the latch branches back to the header.
    // A latch is a block whose branch goes back into the loop. Requiring it to
    // target the *header* is too strict: Go lays a loop out so the backward branch
    // can land on a block that continues the body, not on the block the dominator
    // analysis named as the header. Those loops used to fall through to the
    // `while (1)` case with an empty body and dump every block as an orphan.
    // A latch is a block whose control reaches back to the loop start. That is
    // normally a conditional branch, but a `fallthrough` block followed by the
    // header is the same edge with no instruction of its own — Go uses it when
    // the body ends exactly at the loop top. Requiring `jcc` skipped those and the
    // loop came out as `while (1)` with an empty body.
    const latch = loop.latches.map((start) => byStart.get(start)).find((block) => {
      if (!block) return false;
      const next = nextBlock(block, byStart, order);
      if (block.term === 'jcc') return block.target != null && (block.target === loop.header || loop.blocks.has(block.target));
      if (block.term === 'fallthrough') return next === loop.header || (next != null && loop.blocks.has(next));
      return false;
    });
    if (latch) {
      emitted.add(latch.start);
      // The body is the header plus everything the loop owns up to the latch, in
      // execution order — not the address range between them. Go lays a loop out
      // so the latch can sit *before* the header (`test; jl` at a lower address),
      // and an address-bounded range then comes out empty: the whole loop body
      // landed in the orphan list at the end of the function, reading registers
      // whose assignments had been optimised away in a different subtree.
      const body: CtrlStmt[] = [];
      for (const start of loopBlocksInOrder(loop, order)) {
        const block = byStart.get(start);
        if (!block || start === latch.start) continue;
        emitted.add(start);
        body.push({ t: 'label', name: labelOf(start) }, ...block.stmts);
        // A branch out of the loop, with its target still present, is a real
        // conditional inside the body.
        if (block.term === 'jcc' && block.target != null && !loop.blocks.has(block.target)) {
          const targetBlock = byStart.get(block.target);
          if (targetBlock && !targetBlock.folded && block.target !== exit) {
            body.push({ t: 'if', cond: block.cond || { t: 'unknown', text: 'flags', size: 1 }, then: emitRange(block.target, exit) });
          }
        }
      }
      body.push(...latch.stmts);
      depth -= 1;
      // A fallthrough latch carries no condition; the loop repeats when the header's
      // own guard allows it, so the header's condition is the loop condition.
      // A latch with no condition of its own means the loop is re-entered
      // unconditionally and leaves through a guard inside the body — Go's
      // `while (1) { ... if bad { break } ... }`. Printing `while (flags 0)` there
      // would be a condition the binary does not have.
      const loopBody = [headerLabel, ...body];
      if (!latch.cond) { loopStack.pop(); return { t: 'while', cond: null, body: loopBody }; }
      loopStack.pop();
      return { t: 'do', body: loopBody, cond: latch.cond };
    }

    // while (1) { ... }: the exit is reached from inside.
    const body = [headerLabel, ...emitRange(headerNext, exit)];
    depth -= 1;
    loopStack.pop();
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
  const gotos2 = pruneLabels(body);
  void depth;
  return { body, orphans, loops: loops.length, gotos: gotos2 };
}


/**
 * The statements of an already-emitted epilogue, when a branch targets one.
 *
 * Returns the block's own statements if it is a bare return — the shared exit Go
 * uses for every `return` in a function — and nothing otherwise. Reusing them is
 * correct because a return has no side effects beyond leaving, and inlining it
 * where the branch goes says "this path exits here", which an empty block does not.
 */
function sharedReturn(
  target: number | null,
  stop: number | null,
  byStart: Map<number, import('./ir.js').LiftedBlock>,
  emitted: Set<number>,
): CtrlStmt[] {
  if (target == null || target === stop || !emitted.has(target)) return [];
  const block = byStart.get(target);
  if (!block || block.term !== 'ret') return [];
  // Only a body that is nothing but the return, so nothing is duplicated.
  if (block.stmts.length !== 1 || block.stmts[0].t !== 'return') return [];
  return [{ ...block.stmts[0] }];
}

/**
 * Drop the labels nothing jumps to, and return how many jumps remain.
 *
 * Labels are written generously — every block gets one, because a `goto` can point at
 * any block that some other path printed first, and guessing which ones those are is
 * what produced jumps to labels that were never written. Writing them all and then
 * removing the unused ones is the cheap direction: the alternative is a listing
 * buried in names nobody refers to (86 labels, 85 of them unused, in one function
 * when this was first tried).
 *
 * Mutates the tree in place and returns the count, so the header and the body agree.
 */
function pruneLabels(body: CtrlStmt[]): number {
  const referenced = new Set<string>();
  let jumps = 0;
  const collect = (nodes: CtrlStmt[]): void => {
    for (const node of nodes) {
      if (node.t === 'goto') { referenced.add(node.label); jumps += 1; }
      else if (node.t === 'if') { collect(node.then); if (node.else) collect(node.else); }
      else if (node.t === 'while' || node.t === 'do') collect(node.body);
      else if (node.t === 'switch') {
        for (const c of node.cases) collect(c.body);
        if (node.defaultBody) collect(node.defaultBody);
      }
    }
  };
  collect(body);
  const keep = new Set(body);
  const filter = (nodes: CtrlStmt[]): CtrlStmt[] => {
    const kept: CtrlStmt[] = [];
    for (const node of nodes) {
      if (node.t === 'label' && !referenced.has(node.name)) continue;
      if (node.t === 'if') {
        kept.push({ ...node, then: filter(node.then), ...(node.else ? { else: filter(node.else) } : {}) });
      } else if (node.t === 'while' || node.t === 'do') {
        kept.push({ ...node, body: filter(node.body) });
      } else if (node.t === 'switch') {
        kept.push({
          ...node,
          cases: node.cases.map((c) => ({ ...c, body: filter(c.body) })),
          ...(node.defaultBody ? { defaultBody: filter(node.defaultBody) } : {}),
        });
      } else {
        kept.push(node);
      }
    }
    return kept;
  };
  const pruned = filter(body);
  body.length = 0;
  body.push(...pruned);
  void keep;
  // The header reports how many jumps the listing contains, so it has to be the
  // number printed, not the number of distinct labels: two branches to the same
  // target are two statements the reader counts.
  return jumps;
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

/** The opposite of a comparison, or a logical not when there is no opposite. */
export function negate(expr: Expr): Expr {
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


/**
 * The loop's blocks in execution order, starting at the header.
 *
 * A loop body is a graph, not an address range. Walking from the header by
 * successors and keeping only members keeps the order the code runs in, which is
 * what the printout needs — and it works when the latch sits at a lower address
 * than the header, where an address-bounded range is empty.
 */
function loopBlocksInOrder(loop: LoopInfo, order: number[]): number[] {
  const started = [loop.header];
  const seen = new Set<number>(started);
  for (let index = 0; index < started.length; index++) {
    const block = started[index];
    const position = order.indexOf(block);
    const next = position >= 0 && position + 1 < order.length ? order[position + 1] : null;
    const candidates = [next, ...(loop.latches.includes(block) ? [] : [])].filter((item): item is number => item != null);
    for (const candidate of candidates) {
      if (!loop.blocks.has(candidate) || seen.has(candidate)) continue;
      seen.add(candidate);
      started.push(candidate);
    }
  }
  // Any member the walk could not reach from the header (a branch target inside
  // the body) is appended in address order so nothing is silently dropped.
  for (const member of [...loop.blocks].sort((a, b) => a - b)) {
    if (!seen.has(member)) { seen.add(member); started.push(member); }
  }
  return started;
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
