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

/** Widen a parameter that the body dereferences into a pointer. */
export function refineParam(type: CType, usedAsAddress: boolean): CType {
  if (usedAsAddress) return 'void *';
  return type;
}
