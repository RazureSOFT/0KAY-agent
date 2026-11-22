/**
 * The set of calls that never return.
 *
 * Used to decide where a function's control flow ends: nothing follows
 * `runtime.gopanic()`, so the code after it belongs to the unwind path and not to the
 * body. Getting the spelling wrong here is silent — the set simply stops matching and
 * the panic paths are read as if they continued, which put `return rbx` into bodies
 * where rbx is the panic value.
 *
 * A regression of exactly that kind happened when calls started printing symbol names
 * instead of `sub_<address>`: the set held only the address spelling and matched
 * nothing at all, so 14 of 800 functions ended on `rax = runtime_panicBounds();`
 * looking like a function that runs off its end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectNoReturnTargets } from './binary_analysis.js';

test('a panic helper is named the way the listing names a call', () => {
  // `runtime.gopanic` is what the symbol table calls it and `runtime_gopanic` is what
  // the printed call looks like. The set has to hold the printed form, because that is
  // what a lifted call carries.
  const targets = collectNoReturnTargets([
    { name: 'runtime.gopanic', entry: 0x1000 },
    { name: 'runtime.panicBounds', entry: 0x2000 },
  ]);
  assert.ok(targets.has('runtime_gopanic'), `the printed spelling is present: ${[...targets].join(', ')}`);
  assert.ok(targets.has('runtime_panicBounds'), 'panicBounds is recognised');
});

test('a function that does return is not in the set', () => {
  // An ordinary function must not be treated as the end of a path, or the code after a
  // call to it would be dropped from the body as unreachable.
  const targets = collectNoReturnTargets([
    { name: 'runtime.gopanic', entry: 0x1000 },
    { name: 'runtime.mapassign', entry: 0x3000 },
    { name: 'main.compute', entry: 0x4000 },
  ]);
  assert.ok(!targets.has('runtime_mapassign'), 'mapassign returns');
  assert.ok(!targets.has('main_compute'), 'main.compute returns');
});

test('morestack is included, because the retry does not come back to the call site', () => {
  const targets = collectNoReturnTargets([
    { name: 'runtime.morestack_noctxt', entry: 0x5000 },
    { name: 'runtime.throw', entry: 0x6000 },
  ]);
  assert.ok(targets.has('runtime_morestack_noctxt'), 'the stack-growth thunk restarts the function');
  assert.ok(targets.has('runtime_throw'), 'throw does not return');
});
