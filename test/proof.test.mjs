// Tests for `regression-proof` (step 6.154): AC1 fixtures (pass, import error, timeout, helper overlay), the modes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { classify, escaped, parseTest } from '../src/proof.mjs';

const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd }).status, 0);
const put = (r, f, text) => (mkdirSync(join(r, f, '..'), { recursive: true }), writeFileSync(join(r, f), text));

/** A repo whose branch changes src/a.ts (the fix), adds test/helper.ts (support) and src/a.test.ts (the test). */
function repo(mode = 'report') {
  const r = mkdtempSync(join(tmpdir(), 'proof-'));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@example.com');
  git(r, 'config', 'user.name', 't');
  put(r, 'quality/gates.json', JSON.stringify({ 'regression-proof': { mode } }));
  put(r, 'src/a.ts', 'broken\n');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'base');
  git(r, 'checkout', '-q', '-b', 'pr');
  put(r, 'src/a.ts', 'fixed\n');
  put(r, 'src/b.ts', 'new source\n');
  put(r, 'test/helper.ts', 'helper\n');
  put(r, 'src/a.test.ts', 'test\n');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'pr');
  return r;
}

const vitest = (status, message = '') =>
  JSON.stringify({
    testResults: [{ status, assertionResults: [{ status, failureMessages: message ? [message] : [] }] }],
  });
const playwright = (status, message = '') =>
  JSON.stringify({
    suites: [{ specs: [{ tests: [{ results: [{ status, error: message ? { message } : undefined }] }] }] }],
  });
const ARGS = ['regression-proof', '--base', 'main', '--test', 'src/a.test.ts::it works'];

describe('classify', () => {
  it('reads the category from a Vitest report', () => {
    assert.equal(classify('vitest', vitest('passed')), 'passed');
    assert.equal(classify('vitest', vitest('failed', 'AssertionError: expected 1 to be 2')), 'assertion');
    assert.equal(classify('vitest', vitest('failed', 'Error: Test timed out in 5000ms.')), 'timeout');
    assert.equal(classify('vitest', vitest('failed', 'TypeError: x is not a function')), 'error');
    assert.equal(
      classify('vitest', JSON.stringify({ testResults: [{ status: 'failed', assertionResults: [] }] })),
      'error',
    );
    assert.equal(classify('vitest', vitest('skipped')), 'none');
    assert.equal(classify('vitest', 'not json'), 'error');
  });
  it('reads the category from a Playwright report', () => {
    assert.equal(classify('playwright', playwright('passed')), 'passed');
    assert.equal(classify('playwright', playwright('failed', '\u001b[2mexpect(\u001b[22mlocator)')), 'assertion');
    assert.equal(classify('playwright', playwright('failed', 'Error: expect(received).toBe(expected)')), 'assertion');
    assert.equal(classify('playwright', playwright('timedOut', 'Test timeout of 30000ms exceeded.')), 'timeout');
    assert.equal(classify('playwright', playwright('failed', 'Error: page.goto: net::ERR')), 'error');
  });
});

describe('parseTest', () => {
  it('splits path and name, and takes a none with a reason', () => {
    assert.deepEqual(parseTest('a/b.test.ts::x::y'), { path: 'a/b.test.ts', name: 'x::y' });
    assert.ok(parseTest('none — infra template').none);
    assert.throws(() => parseTest('a/b.test.ts'));
    assert.throws(() => parseTest('none'));
  });
});

describe('regression-proof command', () => {
  /** Runner that records the working tree at each call and answers base then head. */
  const runner =
    (base, head, seen = []) =>
    (...call) => {
      const repoDir = process.cwd();
      seen.push({
        call,
        src: existsSync(join(repoDir, 'src/b.ts')),
        helper: existsSync(join(repoDir, 'test/helper.ts')),
      });
      return { status: 0, report: seen.length === 1 ? base : head };
    };
  const inRepo = async (r, exec, args = ARGS) => {
    const cwd = process.cwd();
    process.chdir(r);
    try {
      return await main(args, { root: r, runner: exec });
    } finally {
      process.chdir(cwd);
    }
  };

  it('passes a test that fails with an assertion on the base and passes on the head, keeping the helper', async () => {
    const seen = [];
    const result = await inRepo(
      repo('enforce'),
      runner(vitest('failed', 'AssertionError: no'), vitest('passed'), seen),
    );
    assert.equal(result.code, 0, result.text);
    assert.deepEqual(
      seen.map((s) => [s.src, s.helper]),
      [
        [false, true],
        [true, true],
      ],
    ); // source undone, helper kept, head restored
  });

  it('rejects a test that passes on the base', async () => {
    const r = await inRepo(repo('enforce'), runner(vitest('passed'), vitest('passed')));
    assert.equal(r.code, 1);
    assert.match(r.text, /passes-on-base/);
  });

  it('rejects an import error and a timeout on the base', async () => {
    for (const bad of [
      vitest('failed', 'Error: Failed to resolve import'),
      vitest('failed', 'Error: Test timed out'),
    ]) {
      const r = await inRepo(repo('enforce'), runner(bad, vitest('passed')));
      assert.match(r.text, /not-run-on-base/);
      assert.equal(r.code, 1);
    }
  });

  it('rejects a test that fails on the head', async () => {
    const r = await inRepo(
      repo('enforce'),
      runner(vitest('failed', 'AssertionError: x'), vitest('failed', 'AssertionError: x')),
    );
    assert.match(r.text, /fails-on-head/);
  });

  it('only reports in report mode, and puts no failure text in the output', async () => {
    const r = await inRepo(repo('report'), runner(vitest('passed'), vitest('failed', 'AssertionError: SECRET')));
    assert.equal(r.code, 0);
    assert.ok(!r.text.includes('SECRET'));
  });

  it('lists a none allowance without running anything', async () => {
    const r = await inRepo(repo('enforce'), () => assert.fail('ran'), [
      'regression-proof',
      '--test',
      'none — a template',
    ]);
    assert.equal(r.code, 0);
  });

  it('cannot run on a dirty tree or without --test', async () => {
    const dirty = repo('enforce');
    put(dirty, 'x.txt', 'x');
    assert.equal((await inRepo(dirty, runner('', ''))).code, 2);
    assert.equal((await inRepo(repo('enforce'), runner('', ''), ['regression-proof'])).code, 2);
  });
});

describe('escaped', () => {
  it('makes a test name match itself as a regular expression', () => {
    for (const name of ['adds (1) item [x]', 'a.b*c', 'cost $5 | tax']) assert.ok(new RegExp(escaped(name)).test(name));
    assert.ok(!new RegExp(escaped('a.b')).test('axb'));
  });
});
