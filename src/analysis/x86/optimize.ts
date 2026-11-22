/**
 * Local value propagation and dead-store removal.
 *
 * This is what a decompiler does before printing: fold `x = 1; y = x + 2` into
 * `y = 3`, and drop assignments nobody reads. It runs per basic block on
 * purpose — a cross-block pass needs SSA and phi nodes, and the printer would
 * then have to lower them back; the local pass buys most of the readability for
 * a fraction of the risk.
 */
import type { Expr, Stmt } from './ir.js';

const PURE: Record<Expr['t'], boolean> = {
  const: true, reg: true, var: true, load: true,
  bin: true, un: true, cast: true, select: true, call: false, unknown: false,
};

function isPure(expr: Expr): boolean {
  switch (expr.t) {
    case 'bin': return isPure(expr.left) && isPure(expr.right);
    case 'un': return isPure(expr.value);
    case 'cast': return isPure(expr.value);
    case 'select': return isPure(expr.cond) && isPure(expr.a) && isPure(expr.b);
    case 'call': return false;
    default: return true;
  }
}

function readsOf(expr: Expr, into: Set<string>): void {
  switch (expr.t) {
    case 'reg':
    case 'var':
      into.add(expr.name);
      return;
    case 'load':
      readsOf(expr.addr, into);
      return;
    case 'bin':
      readsOf(expr.left, into); readsOf(expr.right, into); return;
    case 'un':
      readsOf(expr.value, into); return;
    case 'cast':
      readsOf(expr.value, into); return;
    case 'select':
      readsOf(expr.cond, into); readsOf(expr.a, into); readsOf(expr.b, into); return;
    case 'call':
      for (const arg of expr.args) readsOf(arg, into);
      return;
    default:
      return;
  }
}

function substitute(expr: Expr, env: Map<string, Expr>): Expr {
  switch (expr.t) {
    case 'reg':
    case 'var': {
      const known = env.get(expr.name);
      // Only fold a value that is itself cheap; folding a load into every use
      // would duplicate memory reads that the original performed once.
      return known && (known.t === 'const' || known.t === 'reg' || known.t === 'var') ? known : expr;
    }
    case 'load':
      return { ...expr, addr: substitute(expr.addr, env) };
    case 'bin':
      return { ...expr, left: substitute(expr.left, env), right: substitute(expr.right, env) };
    case 'un':
      // `&x` is the address of `x`, not the address of whatever `x` currently holds.
      // Substituting into it turned `mov [rsp+0x30], 0x2d; lea rbx, [rsp+0x30]` into
      // `v_48 = 0x2d; rbx = &0x2d;`, which is not C at all — `cl` reports
      // `C2101: '&' on constant`. Every other unary operator takes the value, so `-x` and
      // `~x` are still folded.
      if (expr.op === '&') return expr;
      return { ...expr, value: substitute(expr.value, env) };
    case 'cast':
      return { ...expr, value: substitute(expr.value, env) };
    case 'select':
      return { ...expr, cond: substitute(expr.cond, env), a: substitute(expr.a, env), b: substitute(expr.b, env) };
    case 'call':
      return { ...expr, args: expr.args.map((arg) => substitute(arg, env)) };
    default:
      return expr;
  }
}

/** Fold constants and copies inside one statement list. */
export function propagate(stmts: Stmt[]): Stmt[] {
  const env = new Map<string, Expr>();
  /**
   * Names that must not be shadowed.
   *
   * `mov rcx, rbx` then `sar rbx, 63` used to print `rbx = arg0 >> 63`: the
   * environment still held `rbx -> arg0` from the first read, so the
   * instruction that *redefines* rbx read the value rbx had before. The result
   * was arithmetic on the wrong operand — `arg0 >> 63` instead of `rbx >> 63` —
   * which is the kind of error that silently changes what the code means.
   *
   * A parameter (or any named slot) keeps its name. A register that shadows one
   * gets a numbered name instead, so the two lives are visibly different.
   */
  const pinned = new Set<string>();
  for (const stmt of stmts) {
    if (stmt.t !== 'assign') continue;
    const target = stmt.target;
    const name = target.t === 'var' || target.t === 'reg' ? target.name : '';
    if (name && /^(arg\d+$|v_|stack_|rbx|r12|r13|r14|r15)$/.test(name)) pinned.add(name);
  }
  const versions = new Map<string, number>();
  const out: Stmt[] = [];
  /**
   * Old name -> current name for a pinned register that has been redefined.
   *
   * Renaming the destination without renaming the later reads left `rcx = rbx`
   * referring to a name that the rename had just retired: the new `rbx_2 = rcx`
   * was then unreferenced and deleted as a dead store, so `rbx` ended up read
   * with no assignment anywhere. The two instructions are a save and a restore
   * of the same value, and they have to agree on what it is called.
   */
  const current = new Map<string, string>();
  const readName = (name: string): string => current.get(name) || name;
  for (const stmt of stmts) {
    if (stmt.t === 'assign') {
      const value = renameReads(substitute(stmt.value, env), readName);
      let target = stmt.target;
      // A pinned name being redefined becomes a fresh variable, not an
      // overwrite of the value that arrived in it.
      const targetName = target.t === 'var' || target.t === 'reg' ? target.name : '';
      if (targetName && pinned.has(targetName)) {
        const seenBefore = versions.get(targetName) || 0;
        versions.set(targetName, seenBefore + 1);
        // The first write keeps the plain name: it is the value the function
        // receives or computes first, and calling it `rbx_2` would leave `rbx`
        // with no assignment anywhere — the read that follows would name a value
        // that does not exist in the output. Only a genuine second write gets a
        // numbered name, because that one really is a different value.
        if (seenBefore > 0) {
          const fresh = `${targetName}_${seenBefore + 1}`;
          target = { ...target, name: fresh } as Expr;
          current.set(targetName, fresh);
          env.delete(targetName);
          env.delete(fresh);
        } else {
          current.set(targetName, targetName);
          env.delete(targetName);
        }
      }
      if (target.t === 'reg' || target.t === 'var') {
        // A write kills every alias that pointed *at* this name, not only the one
        // under it. `rcx = rax; rax = rbx; rbx = rcx` rotates three registers; keeping
        // `rcx -> rax` past the write to rax turned the third move into `rbx = rax`,
        // which reads the value rax holds *after* the rotation started. The register
        // forwarding chain in a Go call sequence is exactly this shape.
        for (const [key, existing] of [...env]) {
          if ((existing.t === 'reg' || existing.t === 'var') && existing.name === target.name) env.delete(key);
        }
        if (value.t === 'const' || value.t === 'reg' || value.t === 'var') env.set(target.name, value);
        else env.delete(target.name);
      } else {
        // A store through a pointer may alias anything.
        env.clear();
      }
      out.push({ t: 'assign', target, value });
      continue;
    }
    if (stmt.t === 'return') {
      out.push(stmt.value ? { t: 'return', value: renameReads(substitute(stmt.value, env), readName) } : stmt);
      continue;
    }
    if (stmt.t === 'expr') {
      out.push({ t: 'expr', expr: renameReads(substitute(stmt.expr, env), readName) });
      continue;
    }
    env.clear();
    current.clear();
    out.push(stmt);
  }
  return out;
}

/** Apply the pinned-register rename to every read inside an expression. */
function renameReads(expr: Expr, readName: (name: string) => string): Expr {
  switch (expr.t) {
    case 'reg':
    case 'var': {
      const name = readName(expr.name);
      return name === expr.name ? expr : { ...expr, name };
    }
    case 'load': return { ...expr, addr: renameReads(expr.addr, readName) };
    case 'bin': return { ...expr, left: renameReads(expr.left, readName), right: renameReads(expr.right, readName) };
    case 'un': return { ...expr, value: renameReads(expr.value, readName) };
    case 'cast': return { ...expr, value: renameReads(expr.value, readName) };
    case 'select': return { ...expr, cond: renameReads(expr.cond, readName), a: renameReads(expr.a, readName), b: renameReads(expr.b, readName) };
    case 'call': return { ...expr, args: expr.args.map((arg) => renameReads(arg, readName)) };
    default: return expr;
  }
}

/**
 * Drop assignments whose destination is never read and whose value has no
 * side effect. Argument variables are kept: the caller can observe them.
 */
export function removeDeadStores(stmts: Stmt[], liveAfter: Set<string> = new Set()): Stmt[] {
  let current = stmts;
  for (let pass = 0; pass < 3; pass++) {
    const reads = new Set<string>();
    for (const stmt of current) {
      if (stmt.t === 'assign') { readsOf(stmt.value, reads); if (stmt.target.t === 'load') readsOf(stmt.target.addr, reads); }
      else if (stmt.t === 'expr') readsOf(stmt.expr, reads);
      else if (stmt.t === 'return' && stmt.value) readsOf(stmt.value, reads);
    }
    const next = current.filter((stmt) => {
      if (stmt.t !== 'assign') return true;
      if (stmt.target.t !== 'reg' && stmt.target.t !== 'var') return true;
      const name = stmt.target.name;
      if (reads.has(name) || liveAfter.has(name)) return true;
      // Stack slots, arguments and outgoing spills are observable by the caller;
      // only a scratch register can be dropped safely. `stack_arg_` is the slot Go
      // spills a result into — dropping that write would delete the only thing
      // the function did.
      if (/^(arg\d+|v_|stack_)/.test(name)) return true;
      if (!isPure(stmt.value)) return true;
      return false;
    });
    if (next.length === current.length) break;
    current = next;
  }
  return current;
}

export function optimizeStatements(stmts: Stmt[], liveAfter: Set<string> = new Set()): Stmt[] {
  return dropSelfAssignments(
    inlineSingleUseTemps(removeDeadStores(collapseSaveRestore(propagate(stmts)), liveAfter)),
  );
}

/**
 * Remove `x = x`.
 *
 * The rename in `propagate` gives a redefined pinned register a numbered name, and
 * when the value being stored is that same register under its old name the renaming
 * makes the two sides equal: `r9 = rbx` became `r9 = r9` once `rbx` was retired in
 * favour of `r9`. Those two lines read as a mistake in the listing — 327 functions
 * per 4000 had one — and the cleanup that the caller does runs *before* this pass,
 * so it cannot catch what the renaming creates here. It has to happen after the last
 * step that can introduce one.
 */
function dropSelfAssignments(stmts: Stmt[]): Stmt[] {
  // `x = x` never produces a value, so removing it can never remove the definition a
  // reader needs: whatever the reader finds afterwards is what it would have found
  // anyway. An earlier attempt kept the ones whose name had no other definition in the
  // *same list*, which was the wrong question — the counterpart is usually in another
  // block. `(*Map).Clear` prints
  //
  //     rcx = v_16;
  //     rdx = rdx;      <- the compiler's "rdx needs no restore"
  //     rbx = stack_arg_24;
  //
  // among the register restores after a call, and `rdx` was written by an `inc rdx`
  // several blocks earlier. Keeping the line does not make `rdx` defined; it only
  // shows the reader a statement that does nothing.
  return stmts.filter((stmt) => {
    if (stmt.t !== 'assign') return true;
    if (stmt.target.t !== stmt.value.t) return true;
    if (stmt.target.t !== 'reg' && stmt.target.t !== 'var') return true;
    return stmt.target.name !== (stmt.value as { name?: string }).name;
  });
}

function collapseSaveRestore(stmts: Stmt[]): Stmt[] {
  const out: Stmt[] = [];
  let index = 0;
  while (index < stmts.length) {
    const save = stmts[index];
    const saveTargetName = save.t === 'assign' && (save.target.t === 'reg' || save.target.t === 'var') ? save.target.name : '';
    const saveSourceName = save.t === 'assign' && (save.value.t === 'reg' || save.value.t === 'var') ? save.value.name : '';
    if (saveTargetName && saveSourceName && saveTargetName !== saveSourceName) {
      const restoreAt = findRestore(stmts, index, saveTargetName, saveSourceName);
      if (restoreAt > index) {
        // Keep what happened between the two, drop the pair itself.
        out.push(...stmts.slice(index + 1, restoreAt));
        index = restoreAt + 1;
        continue;
      }
    }
    out.push(save);
    index += 1;
  }
  return out;
}

/**
 * The index of the matching restore, or -1.
 *
 * The restore is `source = saved` with nothing writing `saved` in between. It also
 * requires nothing writing `source` in between: if the live value had been
 * replaced, restoring the saved copy is not a no-op.
 */
function findRestore(stmts: Stmt[], from: number, savedName: string, sourceName: string): number {
  for (let scan = from + 1; scan < stmts.length; scan++) {
    const candidate = stmts[scan];
    if (candidate.t !== 'assign') continue;
    const targetName = candidate.target.t === 'reg' || candidate.target.t === 'var' ? candidate.target.name : '';
    const valueName = candidate.value.t === 'reg' || candidate.value.t === 'var' ? candidate.value.name : '';
    if (targetName === savedName) return -1;
    if (targetName === sourceName && valueName === savedName) {
      for (let inner = from + 1; inner < scan; inner++) {
        const between = stmts[inner];
        if (between.t !== 'assign') continue;
        const betweenTarget = between.target.t === 'reg' || between.target.t === 'var' ? between.target.name : '';
        if (betweenTarget === sourceName) return -1;
      }
      return scan;
    }
  }
  return -1;
}

/**
 * Fold a versioned temporary that has exactly one reader into that reader.
 *
 * `rbx_2 = arg1 >> 0x3d; rdx = rbx_2 + rbx_2` keeps a numbered name for a value
 * that exists to be used once. The number is an artifact of the versioning pass,
 * and printing it makes the reader wonder what the plain `rbx` was for. When the
 * value is pure and read once, the name disappears.
 *
 * Ordinary locals are left alone: one reader does not make a name the author
 * chose disposable. Only names the versioning created qualify.
 */

/** How many times `name` appears inside one expression. */
function countInExpr(value: Expr, name: string): number {
  let total = 0;
  const walk = (expr: Expr | undefined): void => {
    if (!expr) return;
    switch (expr.t) {
      case 'reg': case 'var': if (expr.name === name) total += 1; return;
      case 'load': walk(expr.addr); return;
      case 'bin': walk(expr.left); walk(expr.right); return;
      case 'un': case 'cast': walk(expr.value); return;
      case 'select': walk(expr.cond); walk(expr.a); walk(expr.b); return;
      case 'call': for (const arg of expr.args) walk(arg); return;
      default: return;
    }
  };
  walk(value);
  return total;
}

export function inlineSingleUseTemps(stmts: Stmt[]): Stmt[] {
  const PURE = new Set(['bin', 'un', 'cast', 'const']);
  const swap = (value: Expr, name: string, with_: Expr): Expr => {
    switch (value.t) {
      case 'reg': case 'var': return value.name === name ? with_ : value;
      case 'load': return { ...value, addr: swap(value.addr, name, with_) };
      case 'bin': return { ...value, left: swap(value.left, name, with_), right: swap(value.right, name, with_) };
      case 'un':
        // `&x` needs `x` to stay a name. Inlining the value into it gave
        // `rbx = &0x2d` for `mov [rsp+0x30], 0x2d; lea rbx, [rsp+0x30]`, and `cl`
        // rejects that with `C2101: '&' on constant`. Same rule as `substitute`.
        return value.op === '&' ? value : { ...value, value: swap(value.value, name, with_) };
      case 'cast': return { ...value, value: swap(value.value, name, with_) };
      case 'select': return { ...value, cond: swap(value.cond, name, with_), a: swap(value.a, name, with_), b: swap(value.b, name, with_) };
      case 'call': return { ...value, args: value.args.map((arg) => swap(arg, name, with_)) };
      default: return value;
    }
  };
  // Count readers first, so a value with exactly one reader can be folded wherever
  // that reader sits. Order is not the point: the versioning pass can emit the
  // definition after the use it feeds, and folding only forward then dropped the
  // definition and left the reader naming a value that no longer existed.
  const reads = new Map<string, number>();
  const countIn = (value: Expr | undefined): void => {
    if (!value) return;
    switch (value.t) {
      case 'reg': case 'var': reads.set(value.name, (reads.get(value.name) || 0) + 1); return;
      case 'load': countIn(value.addr); return;
      case 'bin': countIn(value.left); countIn(value.right); return;
      case 'un': case 'cast': countIn(value.value); return;
      case 'select': countIn(value.cond); countIn(value.a); countIn(value.b); return;
      case 'call': for (const arg of value.args) countIn(arg); return;
      default: return;
    }
  };
  for (const stmt of stmts) {
    if (stmt.t === 'assign') countIn(stmt.value);
    else if (stmt.t === 'expr') countIn(stmt.expr);
    else if (stmt.t === 'return') countIn(stmt.value);
  }

  const foldable = new Map<string, Expr>();
  for (const stmt of stmts) {
    if (stmt.t !== 'assign') continue;
    if (stmt.target.t !== 'reg' && stmt.target.t !== 'var') continue;
    const name = stmt.target.name;
    if (!/_[2-9]\d*$/.test(name)) continue;
    if (!PURE.has(stmt.value.t)) continue;
    // The value must not mention its own name: `rbx_3 = rbx_3 - 1` is a recurrence,
    // and folding it into its reader would leave a name that nothing defines.
    if (countInExpr(stmt.value, name) > 0) continue;
    if ((reads.get(name) || 0) !== 1) continue;
    foldable.set(name, stmt.value);
  }
  if (!foldable.size) return stmts;

  // Folding is transitive: `rbx_4 = rbx_3 - 1` mentions `rbx_3`, which may itself be
  // foldable. Substituting once left the reader naming an intermediate whose
  // definition had just been dropped, which is exactly the "read a value nothing
  // assigns" the whole pass exists to avoid. Repeating until nothing changes costs
  // one extra comparison per name and removes the ordering dependence.
  const expand = (value: Expr): Expr => {
    let current = value;
    for (let round = 0; round < foldable.size + 1; round += 1) {
      let next = current;
      for (const [name, replacement] of foldable) next = swap(next, name, replacement);
      if (next === current) break;
      current = next;
    }
    return current;
  };

  const out: Stmt[] = [];
  for (const stmt of stmts) {
    // Drop the definition of a value that has been folded into its single reader.
    if (stmt.t === 'assign' && (stmt.target.t === 'reg' || stmt.target.t === 'var') && foldable.has(stmt.target.name)) continue;
    if (stmt.t === 'assign') { out.push({ ...stmt, value: expand(stmt.value) }); continue; }
    if (stmt.t === 'expr') { out.push({ ...stmt, expr: expand(stmt.expr) }); continue; }
    if (stmt.t === 'return' && stmt.value) { out.push({ t: 'return', value: expand(stmt.value) }); continue; }
    out.push(stmt);
  }
  return out;
}
