// Tests for `tighten` and the CLI's run, tighten and error paths (step 6.151 AC1, DS-059 §4.1).
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { tighten, tightened } from '../src/tighten.mjs';

const RULES = { contrast: { why: 'text must be readable. REQ-ACC-001.', fix: 'use a token.' } };
const SCREEN = 'teacher.assessments.list';

describe('tightened: downward only', () => {
  it('lowers a count, drops a zero and an emptied key, and keeps an unchanged count', () => {
    assert.deepEqual(
      tightened({
        baseline: { a: { r: 5, s: 2 }, b: { r: 1 }, c: { r: 3 } },
        found: { a: { r: 4, s: 2 }, c: { r: 3 } },
        file: 'b.json',
      }),
      { a: { r: 4, s: 2 }, c: { r: 3 } },
    );
  });

  it('refuses a higher count and a key the baseline lacks', () => {
    assert.throws(() => tightened({ baseline: { a: { r: 1 } }, found: { a: { r: 2 } }, file: 'b.json' }), {
      message: 'a r is 2, above the baseline 1: fix the finding',
    });
    assert.throws(() => tightened({ baseline: {}, found: { a: { r: 1 } }, file: 'b.json' }), {
      message: 'a r has 1 finding(s) the baseline lacks: fix them, do not record them',
    });
  });
});

describe('the CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'gates-cli-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(join(import.meta.dirname, 'fixtures'), root, { recursive: true });
  const gates = (n) => ({
    'demo-ratchet': {
      rules: RULES,
      baseline: 'quality/baselines/demo.json',
      find: () => ({ [SCREEN]: { contrast: n } }),
    },
  });

  it('runs a gate in its mode and with --report', async () => {
    assert.equal((await main(['run', 'demo-ratchet'], { root, gates: gates(5) })).code, 0);
    assert.equal((await main(['run', 'demo-ratchet'], { root, gates: gates(6) })).code, 1);
    assert.equal((await main(['run', 'demo-ratchet', '--report'], { root, gates: gates(6) })).code, 0);
  });

  it('exits 2 for a gate that crashes, an unknown gate, an unknown command and no command', async () => {
    const crash = {
      'demo-ratchet': {
        rules: RULES,
        baseline: 'x',
        find: () => {
          throw new Error('the scan crashed');
        },
      },
    };
    const crashed = await main(['run', 'demo-ratchet'], { root, gates: crash });
    assert.equal(crashed.code, 2);
    assert.ok(crashed.text.includes('could not run: the scan crashed'));
    const unknown = await main(['run', 'nope'], { root, gates: gates(5) });
    assert.equal(unknown.code, 2);
    assert.ok(unknown.text.includes('unknown gate "nope" (known: demo-ratchet)'));
    assert.equal((await main(['run', 'constructor'], { root, gates: gates(5) })).code, 2);
    assert.ok((await main(['run'], { root, gates: {} })).text.includes('(known: none yet)'));
    assert.ok((await main(['frobnicate'], { root })).text.includes('unknown command "frobnicate"'));
    assert.ok((await main([], { root })).text.includes('no command'));
  });

  it('tightens a baseline down, never up', async () => {
    assert.equal((await main(['tighten', 'demo-ratchet'], { root, gates: gates(3) })).code, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'quality/baselines/demo.json'), 'utf8')), {
      [SCREEN]: { contrast: 3 },
    });
    const higher = await main(['tighten', 'demo-ratchet'], { root, gates: gates(4) });
    assert.equal(higher.code, 2);
    assert.ok(higher.text.includes(`${SCREEN} contrast is 4, above the baseline 3: fix the finding`));
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'quality/baselines/demo.json'), 'utf8')), {
      [SCREEN]: { contrast: 3 },
    });
  });

  it('tighten reports a baseline that is already as low as it can be', () => {
    assert.equal(
      tighten({ root, baselineFile: 'quality/baselines/demo.json', found: { [SCREEN]: { contrast: 3 } } }),
      false,
    );
  });
});
