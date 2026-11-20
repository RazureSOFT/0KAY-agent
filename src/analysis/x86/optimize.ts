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
  for (const stmt of stmts) {
    if (stmt.t === 'assign') {
      const value = substitute(stmt.value, env);
      let target = stmt.target;
      // A pinned name being redefined becomes a fresh variable, not an
      // overwrite of the value that arrived in it.
      const targetName = target.t === 'var' || target.t === 'reg' ? target.name : '';
      if (targetName && pinned.has(targetName)) {
        const next = (versions.get(targetName) || 1) + 1;
        versions.set(targetName, next);
        target = { ...target, name: `${targetName}_${next}` } as Expr;
        env.delete(targetName);
      }
      if (target.t === 'reg' || target.t === 'var') {
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
      out.push(stmt.value ? { t: 'return', value: substitute(stmt.value, env) } : stmt);
      continue;
    }
    if (stmt.t === 'expr') {
      out.push({ t: 'expr', expr: substitute(stmt.expr, env) });
      continue;
    }
    env.clear();
    out.push(stmt);
  }
  return out;
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
  return removeDeadStores(propagate(stmts), liveAfter);
}
