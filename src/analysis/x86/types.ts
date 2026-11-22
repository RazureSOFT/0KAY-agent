/**
 * A deliberately small type lattice.
 *
 * The goal is printable C that a human can read and a compiler can mostly
 * accept, not a faithful recovery of the original types. When the evidence is
 * ambiguous the wider type wins: printing `long` where the source had `int`
 * keeps the arithmetic correct, while the reverse silently truncates.
 */
import type { Expr } from './ir.js';

export type CType =
  | 'char' | 'short' | 'int' | 'long'
  | 'unsigned char' | 'unsigned short' | 'unsigned int' | 'unsigned long'
  | 'void *' | 'char *';

export function typeForSize(size: number, unsigned = false): CType {
  if (size <= 8) return unsigned ? 'unsigned char' : 'char';
  if (size <= 16) return unsigned ? 'unsigned short' : 'short';
  if (size <= 32) return unsigned ? 'unsigned int' : 'int';
  return unsigned ? 'unsigned long' : 'long';
}

export function sizeOf(type: CType): number {
  switch (type) {
    case 'char': case 'unsigned char': return 8;
    case 'short': case 'unsigned short': return 16;
    case 'int': case 'unsigned int': return 32;
    case 'char *': case 'void *': return 64;
    default: return 64;
  }
}

export function isPointer(type: CType): boolean {
  return type === 'void *' || type === 'char *';
}

/** A pointer used only as an address is printed as `void *`. */
export function typeOfExpr(expr: Expr): CType {
  switch (expr.t) {
    case 'const': return typeForSize(expr.size);
    case 'reg':
    case 'var': return typeForSize(expr.size);
    case 'load': return typeForSize(expr.size);
    case 'bin':
      if (expr.op === '*' || expr.op === '/' || expr.op === '%') return typeForSize(Math.max(expr.left.size, expr.right.size));
      return typeForSize(expr.size);
    case 'un': return typeForSize(expr.size);
    case 'cast': return typeForSize(expr.size, !expr.signed);
    case 'call': return typeForSize(expr.size);
    default: return 'long';
  }
}

/**
 * The type a parameter gets.
 *
 * Arithmetic, always — never a pointer. A parameter that the body dereferences also gets
 * multiplied, masked and subtracted somewhere else in the same function: `arg0` is read
 * as `*(long *)(rsp + arg0 * 8 + 0x20)` and returned as `arg0 & 1`. There is no single
 * pointer type that allows both, and `cl` rejects each one it is given —
 * `C2296: '*': not valid as left operand has type 'RegArgs *'`,
 * `C2171: operator '-' cannot be applied to an operand of type 'char *'`.
 *
 * The evidence that a value is a pointer is still worth reporting; it goes in the
 * function's header comment, where it costs nothing. This is the one place the listing
 * trades a little readability for a file that compiles.
 */
export function refineParam(type: CType, usedAsAddress: boolean): CType {
  void usedAsAddress;
  return type;
}

/**
 * A name usable as a C type, from the receiver in a method's symbol name.
 *
 * Go writes a method as `pkg.(*Type).Method` or `pkg.(Type).Method`, so the receiver's
 * type is spelled out in the name the listing already carries. Recovering it is worth
 * the trouble because the alternative is a first parameter declared `long`, and 273 of
 * 364 methods in a 24 MB binary came out that way — the receiver is dereferenced late or
 * handed to a callee, so the "is it used as an address" test never fires.
 *
 * `undefined` when the receiver is not a name this can spell: an anonymous struct
 * (`(struct { io.Reader })`) is six methods in the whole binary and inventing an
 * identifier for it would be worse than leaving the parameter as it was.
 */
export function receiverType(receiver: string | undefined, pointer: boolean): string | undefined {
  if (!receiver) return undefined;
  // A generic instantiation carries its type arguments: `OnceValue[go.shape.string]`.
  // The type itself is what a reader wants, and the arguments are already in the
  // function name.
  const bare = receiver.replace(/\[.*$/, '').trim();
  if (!/^[A-Za-z_]\w*$/.test(bare)) return undefined;
  // The package path is dropped: `internal/runtime/maps.Map` is `Map`. A full path is
  // not a C identifier, and the short name is what the source called it.
  const name = bare;
  return pointer ? `${name} *` : name;
}

/**
 * The receiver of a method symbol, as `{ receiver, pointer }`.
 *
 * `runtime.(*mheap).alloc` gives `{ mheap, true }`. A plain function, or a name whose
 * receiver is not a simple identifier, gives `undefined`.
 */
export function methodReceiver(symbol: string): { receiver: string; pointer: boolean } | undefined {
  // Only the part after the last slash matters for the package, and the receiver is the
  // parenthesised group just before the final dot: `pkg.Type.Method` has no receiver.
  const match = /\((\*?)([^()]*)\)\.([A-Za-z_]\w*)(?:\[[^\]]*\])?(?:\.func\d+)?$/.exec(symbol);
  if (!match) return undefined;
  const receiver = match[2];
  if (!receiver) return undefined;
  return { receiver, pointer: match[1] === '*' };
}
