// Tests for the gate mechanics (step 6.151 AC1, DS-059 §4.1). The fixture root is test/fixtures.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  EXIT_BROKEN,
  EXIT_FINDINGS,
  ceilingFailures,
  compareCeilings,
  compareCounts,
  countFailures,
  message,
  modeOf,
  readJson,
  runGate,
} from '../src/gate.mjs';

const root = join(import.meta.dirname, 'fixtures');
const BASELINE = 'quality/baselines/demo.json';
const CEILINGS = 'quality/ceilings.json';
const SCREEN = 'teacher.assessments.list';
const RULES = {
  contrast: { why: 'text must be readable. REQ-ACC-001.', fix: 'use a token with enough contrast.' },
  lcp: { why: 'a slow screen reads as broken. DS-020 §4.12.', fix: 'make the largest element lighter.' },
};
const BUDGETS = { lcp: { budget: 2.5, unit: ' s' } };

const counts = (n) => ({ [SCREEN]: { contrast: n } });
const countGate = (gate, found, baselineFile = BASELINE) =>
  runGate({ gate, root, rules: RULES, check: ({ mode }) => countFailures({ root, mode, baselineFile, found }) });
const lcpGate = (gate, seconds) =>
  runGate({
    gate,
    root,
    rules: RULES,
    check: ({ mode }) =>
      ceilingFailures({
        root,
        mode,
        ceilingsFile: CEILINGS,
        readings: { [SCREEN]: { lcp: seconds } },
        budgets: BUDGETS,
      }),
  });

describe('modes (quality/gates.json)', () => {
  it('reads the mode of a gate', () => {
    assert.equal(modeOf(root, 'demo-report'), 'report');
    assert.equal(modeOf(root, 'demo-ratchet'), 'ratchet');
    assert.equal(modeOf(root, 'demo-enforce'), 'enforce');
  });

  it('throws on an unknown gate, an invalid mode and a missing file', () => {
    assert.throws(() => modeOf(root, 'nope'), { message: 'unknown gate "nope": not in quality/gates.json' });
    assert.throws(() => modeOf(root, 'constructor'), {
      message: 'unknown gate "constructor": not in quality/gates.json',
    });
    assert.throws(() => modeOf(root, 'demo-bad-mode'), { message: /gate "demo-bad-mode" has no valid mode/ });
    assert.throws(() => modeOf(`${root}/quality`, 'demo-report'), {
      message: 'quality/gates.json is missing or cannot be read',
    });
  });
});

describe('counts, two-way', () => {
  it('passes at the baseline', async () => {
    assert.equal((await countGate('demo-ratchet', counts(5))).code, 0);
  });

  it('fails a rise with the DS-059 §4.1 message, the mode and the counts', async () => {
    const result = await countGate('demo-ratchet', counts(6));
    assert.equal(result.code, EXIT_FINDINGS);
    assert.equal(
      result.text,
      [
        `GATE demo-ratchet ✗ ${SCREEN}  contrast`,
        '  Why:   text must be readable. REQ-ACC-001.',
        '  Fix:   use a token with enough contrast.',
        '  Allow: none for this rule.',
        '  Mode:  ratchet. Baseline 5, now 6 (+1: this change added a finding)',
        'GATE demo-ratchet: 1 finding(s), 1 failing.',
      ].join('\n'),
    );
  });

  it('fails a fall with the tighten message', async () => {
    const result = await countGate('demo-ratchet', counts(4));
    assert.equal(result.code, EXIT_FINDINGS);
    assert.ok(result.text.includes(`  Mode:  ratchet. Baseline 5, now 4: lower ${BASELINE} to 4`));
  });

  it('counts a pair the baseline lacks from 0 and a pair the run no longer finds to 0', () => {
    assert.deepEqual(compareCounts({ baseline: {}, found: { a: { r: 2 } }, file: 'b.json' }), [
      { where: 'a', rule: 'r', detail: 'Baseline 0, now 2 (+2: this change added a finding)' },
    ]);
    assert.deepEqual(compareCounts({ baseline: { a: { r: 2 } }, found: {}, file: 'b.json' }), [
      { where: 'a', rule: 'r', detail: 'Baseline 2, now 0: lower b.json to 0' },
    ]);
  });

  it('allows nothing in enforce and reads no baseline there', async () => {
    const result = await countGate('demo-enforce', counts(5), 'quality/baselines/none.json');
    assert.equal(result.code, EXIT_FINDINGS);
    assert.ok(result.text.includes('  Mode:  enforce. Baseline 0, now 5 (+5: this change added a finding)'));
    assert.equal((await countGate('demo-enforce', {}, 'quality/baselines/none.json')).code, 0);
  });
});

describe('timing ceilings, one-way', () => {
  it('passes below the ceiling with no tighten failure, and at it', async () => {
    const below = await lcpGate('demo-ratchet', 2.4);
    assert.equal(below.code, 0);
    assert.equal(below.text, 'GATE demo-ratchet: 0 finding(s), 0 failing.');
    assert.equal((await lcpGate('demo-ratchet', 2.9)).code, 0);
  });

  it('fails above the ceiling, naming it', async () => {
    const result = await lcpGate('demo-ratchet', 3.0);
    assert.equal(result.code, EXIT_FINDINGS);
    assert.ok(result.text.includes(`GATE demo-ratchet ✗ ${SCREEN}  lcp`));
    assert.ok(result.text.includes(`  Mode:  ratchet. Ceiling 2.9 s (${CEILINGS}), now 3 s; the budget is 2.5 s`));
  });

  it('holds a pair with no ceiling to the budget', () => {
    const args = { ceilings: {}, budgets: BUDGETS, file: CEILINGS };
    assert.deepEqual(compareCeilings({ ...args, readings: { 'student.home': { lcp: 2.5 } } }), []);
    assert.deepEqual(compareCeilings({ ...args, readings: { 'student.home': { lcp: 2.6 } } }), [
      { where: 'student.home', rule: 'lcp', detail: 'Budget 2.5 s, now 2.6 s' },
    ]);
  });

  it('holds every pair to the budget in enforce', async () => {
    const result = await lcpGate('demo-enforce', 2.8);
    assert.equal(result.code, EXIT_FINDINGS);
    assert.ok(result.text.includes('  Mode:  enforce. Budget 2.5 s, now 2.8 s'));
  });
});

describe('a broken gate fails in every mode', () => {
  const broken = async (run) => {
    const results = await Promise.all(['demo-report', 'demo-ratchet', 'demo-enforce'].map(run));
    for (const result of results) assert.equal(result.code, EXIT_BROKEN);
    return results[0].text;
  };

  it('a crash', async () => {
    const crash = () => {
      throw new Error('the browser closed');
    };
    const text = await broken((gate) => runGate({ gate, root, rules: RULES, check: crash }));
    assert.equal(
      text,
      'GATE demo-report ✗ could not run: the browser closed.\n  A gate that cannot run fails in every mode (DS-059 §4.1 rollout rule 5).',
    );
  });

  it('a missing baseline (report and ratchet read one)', async () => {
    for (const gate of ['demo-report', 'demo-ratchet']) {
      const result = await countGate(gate, counts(5), 'quality/baselines/none.json');
      assert.equal(result.code, EXIT_BROKEN);
      assert.ok(result.text.includes('quality/baselines/none.json is missing or cannot be read'));
    }
  });

  it('an unknown rule', async () => {
    const text = await broken((gate) =>
      runGate({ gate, root, rules: RULES, check: () => [{ where: SCREEN, rule: 'made-up', detail: 'x' }] }),
    );
    assert.ok(text.includes('unknown rule "made-up"'));
  });

  it('an unknown gate, an unparseable baseline and a baseline of the wrong shape', async () => {
    assert.equal((await countGate('nope', counts(5))).code, EXIT_BROKEN);
    assert.throws(() => readJson(root, 'quality/baselines/broken.txt'), { message: /is not valid JSON/ });
    assert.equal((await countGate('demo-ratchet', counts(5), 'quality/baselines/broken.txt')).code, EXIT_BROKEN);
    assert.throws(() => compareCounts({ baseline: { a: 1 }, found: {}, file: 'b.json' }), {
      message: /b.json: "a" must be an object/,
    });
    assert.throws(() => compareCounts({ baseline: { a: { r: -1 } }, found: {}, file: 'b.json' }), {
      message: /not a valid number/,
    });
    assert.throws(() => compareCounts({ baseline: [], found: {}, file: 'b.json' }), {
      message: /b.json must be an object/,
    });
  });

  it('an unknown metric and a reading that is not a number', async () => {
    const args = { ceilings: {}, budgets: BUDGETS, file: CEILINGS };
    assert.throws(() => compareCeilings({ ...args, readings: { a: { tbt: 1 } } }), {
      message: 'unknown metric "tbt" in the readings',
    });
    assert.throws(() => compareCeilings({ ...args, ceilings: { a: { tbt: 1 } }, readings: {} }), {
      message: `unknown metric "tbt" in ${CEILINGS}`,
    });
    // A measurement that failed must not pass as "not above the ceiling".
    assert.equal((await lcpGate('demo-report', Number.NaN)).code, EXIT_BROKEN);
  });
});

describe('report mode', () => {
  it('prints a finding and exits 0', async () => {
    const result = await countGate('demo-report', counts(6));
    assert.equal(result.code, 0);
    assert.ok(result.text.includes('  Mode:  report. Baseline 5, now 6 (+1: this change added a finding)'));
    assert.ok(result.text.includes('GATE demo-report: 1 finding(s), 0 failing.'));
  });

  it('lets one failure be report-only inside an enforcing gate', async () => {
    const check = () => [{ where: SCREEN, rule: 'contrast', detail: 'x', mode: 'report' }];
    assert.equal((await runGate({ gate: 'g', root, rules: RULES, mode: 'enforce', check })).code, 0);
  });
});

describe('message', () => {
  it('names the allowance when the rule has one', () => {
    assert.equal(
      message({ gate: 'g', mode: 'ratchet', where: 'w', rule: 'r', why: 'y', fix: 'f', allow: 'a line.', detail: 'd' }),
      'GATE g ✗ w  r\n  Why:   y\n  Fix:   f\n  Allow: a line.\n  Mode:  ratchet. d',
    );
  });
});
