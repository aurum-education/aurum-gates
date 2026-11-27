// Tests for the flaky ledger and its use by `flake-hunt` (step 6.156 slice 3).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { LEDGER_FILE, initLedger, readLedger, schoolDaysBetween, verdict } from '../src/ledger.mjs';

const root = (files = {}) => {
  const r = mkdtempSync(join(tmpdir(), 'ledger-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(r, f, '..'), { recursive: true });
    writeFileSync(join(r, f), text);
  }
  return r;
};

describe('schoolDaysBetween', () => {
  it('counts weekdays only', () => {
    // 2026-11-27 is a Friday.
    assert.equal(schoolDaysBetween('2026-11-27T10:00:00Z', '2026-11-28T10:00:00Z'), 0);
    assert.equal(schoolDaysBetween('2026-11-27T10:00:00Z', '2026-11-30T10:00:00Z'), 1);
    assert.equal(schoolDaysBetween('2026-11-27T10:00:00Z', '2026-12-02T10:00:00Z'), 3);
  });
});

describe('verdict', () => {
  const ledger = { 'a > old': { issue: 5 }, 'a > new': { issue: 6 } };
  it('is clean for a ledger test inside the SLO', () => {
    const found = [{ test: 'a > new', issue: 6, created: '2026-11-27T10:00:00Z' }];
    assert.deepEqual(verdict({ ledger, found, now: '2026-12-01T10:00:00Z' }), { unlisted: [], overdue: [] });
  });
  it('names a flake the ledger lacks', () => {
    const found = [{ test: 'b > fresh', issue: 9, created: '2026-11-27T10:00:00Z' }];
    assert.deepEqual(verdict({ ledger, found, now: '2026-11-27T11:00:00Z' }).unlisted, ['b > fresh']);
  });
  it('names a ledger test whose issue is past 2 school days', () => {
    const found = [{ test: 'a > old', issue: 5, created: '2026-11-23T10:00:00Z' }];
    assert.deepEqual(verdict({ ledger, found, now: '2026-11-27T10:00:00Z' }).overdue, ['a > old']);
  });
});

describe('ledger file', () => {
  it('is written once, sorted, with issue numbers only, and never overwritten', () => {
    const r = root();
    const found = [
      { test: 'b', issue: 2 },
      { test: 'a', issue: 1 },
      { test: 'dry', issue: undefined },
    ];
    assert.equal(initLedger({ root: r, found }), 2);
    assert.equal(
      readFileSync(join(r, LEDGER_FILE), 'utf8'),
      '{\n  "a": {\n    "issue": 1\n  },\n  "b": {\n    "issue": 2\n  }\n}\n',
    );
    assert.equal(initLedger({ root: r, found: [{ test: 'c', issue: 3 }] }), -1);
    assert.deepEqual(Object.keys(readLedger(r)), ['a', 'b']);
  });
  it('refuses an entry without an integer issue', () => {
    assert.throws(() => readLedger(root({ [LEDGER_FILE]: '{"a":{"issue":"x"}}' })), /needs an integer "issue"/);
  });
  it('is absent in a repo that has none', () => assert.equal(readLedger(root()), undefined));
});

describe('flake-hunt with a ledger', () => {
  const bad = '<testsuites><testcase classname="a" name="one"><failure message="SECRET"/></testcase></testsuites>';
  const good = '<testsuites><testcase classname="a" name="one"/></testsuites>';
  const gh = (created_at) => async (path) => {
    if (path.includes('/workflows/')) return { workflow_runs: [{ id: 1, run_attempt: 2, head_sha: 's' }] };
    if (path.includes('/artifacts?'))
      return {
        artifacts: [
          { id: 10, name: 'test-reports-attempt-1', expired: false },
          { id: 11, name: 'test-reports-attempt-2', expired: false },
        ],
      };
    if (path.includes('/zip')) return zipOf(path.includes('/10/') ? bad : good);
    if (path.includes('state=open')) return [{ number: 7, title: 'flaky: a > one', created_at }];
    return [];
  };
  const zipOf = (text) => {
    const data = Buffer.from(text);
    const n = Buffer.from('junit.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(n.length, 28);
    const dir = Buffer.concat([central, n]);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(30 + n.length + data.length, 16);
    return Buffer.concat([local, n, data, dir, end]);
  };
  const ARGS = ['flake-hunt', '--repo', 'o/web'];

  it('--init-ledger writes the ledger from the first hunt', async () => {
    process.env.GITHUB_TOKEN = 'x';
    const r = root();
    const out = await main([...ARGS, '--init-ledger'], { root: r, hunter: gh(new Date().toISOString()) });
    assert.equal(out.code, 0);
    assert.deepEqual(readLedger(r), { 'a > one': { issue: 7 } });
  });

  it('is red in enforce mode for a test the ledger lacks, and only says so in report mode', async () => {
    process.env.GITHUB_TOKEN = 'x';
    for (const [mode, code] of [
      ['report', 0],
      ['enforce', 1],
    ]) {
      const r = root({ [LEDGER_FILE]: '{}', 'quality/gates.json': JSON.stringify({ 'flake-hunt': { mode } }) });
      const out = await main(ARGS, { root: r, hunter: gh(new Date().toISOString()) });
      assert.equal(out.code, code);
      assert.match(out.text, /not in the ledger: a > one/);
    }
  });

  it('is red for a ledger test past the SLO and clean inside it', async () => {
    process.env.GITHUB_TOKEN = 'x';
    const files = {
      [LEDGER_FILE]: '{"a > one":{"issue":7}}',
      'quality/gates.json': JSON.stringify({ 'flake-hunt': { mode: 'enforce' } }),
    };
    assert.equal((await main(ARGS, { root: root(files), hunter: gh('2020-01-01T00:00:00Z') })).code, 1);
    assert.equal((await main(ARGS, { root: root(files), hunter: gh(new Date().toISOString()) })).code, 0);
  });
});
