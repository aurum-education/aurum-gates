// Tests for `flake-record` (step 6.156 AC2: records carry IDs only, never message text).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { flakeRecords, readJunit } from '../src/flakes.mjs';

const xml = (cases) =>
  `<testsuites>${cases.map(([c, n, bad]) => `<testcase classname="${c}" name="${n}">${bad ? '<failure message="SECRET page text"/>' : ''}</testcase>`).join('')}</testsuites>`;
const sets = (r) => readJunit(xml(r));
const ID = { repo: 'web', sha: 'abc', run: 'https://x/runs/1' };

describe('flakeRecords', () => {
  it('records a test that failed then passed, ids only', () => {
    const first = sets([
      ['a.test', 'one &amp; two', true],
      ['a.test', 'ok'],
    ]);
    const last = sets([
      ['a.test', 'one &amp; two'],
      ['a.test', 'ok'],
    ]);
    assert.deepEqual(flakeRecords({ ...ID, first, last }), [{ ...ID, kind: 'test', test: 'a.test > one & two' }]);
  });

  it('is not a flake when the test fails again', () => {
    const both = sets([['a.test', 'one', true]]);
    assert.deepEqual(flakeRecords({ ...ID, first: both, last: both }), []);
  });

  it('records one infra entry when the failed attempt names no failed test', () => {
    const none = sets([['a.test', 'one']]);
    assert.deepEqual(flakeRecords({ ...ID, first: none, last: none }), [{ ...ID, kind: 'infra' }]);
  });
});

describe('flake-record command', () => {
  const dir = (name, cases) => {
    const d = join(mkdtempSync(join(tmpdir(), 'flake-')), name);
    mkdirSync(d);
    writeFileSync(join(d, 'junit.xml'), xml(cases));
    return d;
  };
  const flags = ['--repo', 'web', '--sha', 'abc', '--run', 'https://x/runs/1'];

  it('prints one JSON line per flake and never the failure message', async () => {
    const r = await main(['flake-record', ...flags, dir('a', [['t', 'n', true]]), dir('b', [['t', 'n']])]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.text.split('\n')[0]), { ...ID, kind: 'test', test: 't > n' });
    assert.ok(!r.text.includes('SECRET'));
  });

  it('is a broken gate with no report in the last attempt or missing flags', async () => {
    assert.equal((await main(['flake-record', ...flags, dir('a', []), '/nope'])).code, 2);
    assert.equal((await main(['flake-record', dir('a', []), dir('b', [])])).code, 2);
  });
});
