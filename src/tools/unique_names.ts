import { sanitiseName } from '../analysis/x86/ir.js';

/** C99 guarantees 63 significant characters; MSVC reports `C2151` past that. */
const LIMIT = 63;

/**
 * A name that is a valid, unique C identifier, with room for what MSVC accepts.
 *
 * `sanitiseName` already makes the name legal — a Go symbol has `.`, `/` and `[]` in it —
 * but 3817 of 19376 symbols sanitise to more than 63 characters, and the generics are the
 * longest: one shape-parameterised method reaches 246. MSVC truncates and *then* compares,
 * so the first 63 characters of a dozen different `sync.(*HashTrieMap[...])` methods are
 * identical and the compiler sees one name redefined many times.
 *
 * The address is appended after truncation rather than instead of it, so the readable
 * prefix survives: a reader can still tell which method it was.
 */
function legalName(symbol: string, entry: number): string {
  const base = sanitiseName(symbol);
  if (base.length <= LIMIT) return base;
  const suffix = `_${entry.toString(16)}`;
  return `${base.slice(0, LIMIT - suffix.length)}${suffix}`;
}

/**
 * Address-to-name where no two entries share a name.
 *
 * A Go symbol is not unique. `internal/bytealg.countGeneric` is built once per element
 * size and every copy keeps the name, so `mapKeyError2`'s call to what the table calls
 * `countGeneric` resolves to whichever entry came first. The listing then reads as a
 * recursive call the function does not make, and — because the wrong copy's signature is
 * nowhere in sight — `cl` reports `C2198: too few arguments for call`. 58 of 19376
 * entries are duplicates.
 *
 * The names come back **already legal**, so a caller can hand them straight to the
 * listing. A second disambiguating pass at print time could only guess: it would not know
 * which entries collide.
 */
export function uniqueNames(functions: { entry: number; name: string }[]): Map<number, string> {
  const first = new Map<number, string>();
  for (const entry of functions) first.set(entry.entry, legalName(entry.name, entry.entry));
  const totals = new Map<string, number>();
  for (const name of first.values()) totals.set(name, (totals.get(name) ?? 0) + 1);
  const names = new Map<number, string>();
  for (const [address, name] of first) {
    const total = totals.get(name) ?? 1;
    if (total === 1) { names.set(address, name); continue; }
    const suffix = `_${address.toString(16)}`;
    names.set(address, `${name.slice(0, LIMIT - suffix.length)}${suffix}`);
  }
  return names;
}
