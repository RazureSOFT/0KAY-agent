import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_CAPABILITIES, resolveCli } from './deps.js';

test('CLI probes reject missing programs and nonzero exits', async () => {
  const spec = { name: 'probe-regression', commands: ['0kay-nonexistent-probe-7fb29'], versionArg: ['--version'], purpose: 'test' };
  CLI_CAPABILITIES.push(spec);
  try {
    assert.equal((await resolveCli(spec.name, { refresh: true })).available, false);
    spec.commands = ['node'];
    spec.versionArg = ['-e', 'process.exit(3)'];
    assert.equal((await resolveCli(spec.name, { refresh: true })).available, false);
    spec.versionArg = ['--version'];
    assert.equal((await resolveCli(spec.name, { refresh: true })).available, true);
  } finally {
    CLI_CAPABILITIES.splice(CLI_CAPABILITIES.indexOf(spec), 1);
  }
});
