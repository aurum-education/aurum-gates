// Tests for `flake-probe` (step 6.156 slice 3): AC1 (a flaky fixture fails the probe, names test and seed), the cap, the modes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { main } from '../src/cli.mjs';
import { DEFAULT_CAP, PLAYWRIGHT_REPEATS, REPEATS, changedTests, probe } from '../src/probe.mjs';

const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd }).status, 0);

/** A repo whose `main` has one test file and whose branch adds/changes the given files. */
function repo(changed, mode = 'report') {
  const r = mkdtempSync(join(tmpdir(), 'probe-'));
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@example.com');
  git(r, 'config', 'user.name', 't');
  mkdirSync(join(r, 'quality'));
  writeFileSync(join(r, 'quality/gates.json'), JSON.stringify({ 'flake-probe': { mode } }));
  writeFileSync(join(r, 'old.test.ts'), '// old\n');
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'base');
  git(r, 'checkout', '-q', '-b', 'pr');
  for (const f of changed) {
    mkdirSync(join(r, f, '..'), { recursive: true });
    writeFileSync(join(r, f), '// new\n');
  }
  git(r, 'add', '.');
  git(r, 'commit', '-qm', 'pr', '--allow-empty');
  return r;
}

const junit = (bad) =>
  `<testsuites><testcase classname="a.test.ts" name="flaky one">${bad ? '<failure message="SECRET page text"/>' : ''}</testcase></testsuites>`;
const ARGS = ['flake-probe', '--base', 'main'];

describe('changedTests', () => {
  it('lists added and changed test files for the runner, not other files', () => {
    const r = repo(['src/a.test.ts', 'src/a.ts', 'e2e/b.spec.ts', 'old.test.ts']);
    assert.deepEqual(changedTests({ root: r, base: 'main', runner: 'vitest' }), ['old.test.ts', 'src/a.test.ts']);
    assert.deepEqual(changedTests({ root: r, base: 'main', runner: 'playwright' }), ['e2e/b.spec.ts']);
  });
});

describe('probe', () => {
  it('runs each file once per seed under shuffle and names the seed of a failing run (AC1)', () => {
    const calls = [];
    const exec = (command, args) => {
      calls.push(args);
      const seed = args.find((a) => a.startsWith('--sequence.seed=')).split('=')[1];
      return { status: seed === '3' ? 1 : 0, junit: junit(seed === '3') };
    };
    const failures = probe({ files: ['a.test.ts'], runner: 'vitest', exec, seeds: [1, 2, 3, 4, 5] });
    assert.equal(calls.length, REPEATS);
    assert.ok(calls.every((a) => a.includes('--sequence.shuffle')));
    assert.deepEqual(failures, [{ where: 'a.test.ts > flaky one', rule: 'fails-on-repeat', detail: 'seed 3' }]);
  });

  it('passes a stable test', () => {
    const exec = () => ({ status: 0, junit: junit(false) });
    assert.deepEqual(probe({ files: ['a.test.ts'], runner: 'vitest', exec, seeds: [1, 2] }), []);
  });

  it('counts a run that failed with no failed test (a load error) against its file', () => {
    const failures = probe({ files: ['a.test.ts'], runner: 'vitest', exec: () => ({ status: 1 }), seeds: [7] });
    assert.equal(failures[0].where, 'a.test.ts');
    assert.match(failures[0].detail, /seed 7.*no failed test/);
  });

  it('runs Playwright once with repeat-each and no retries', () => {
    const calls = [];
    const exec = (command, args) => (calls.push(args), { status: 0, junit: junit(false) });
    probe({ files: ['e2e/a.spec.ts', 'e2e/b.spec.ts'], runner: 'playwright', exec, seeds: [] });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes(`--repeat-each=${PLAYWRIGHT_REPEATS}`) && calls[0].includes('--retries=0'));
  });

  it('puts no report text in a failure', () => {
    const exec = () => ({ status: 1, junit: junit(true) });
    assert.ok(!JSON.stringify(probe({ files: ['a.test.ts'], runner: 'vitest', exec, seeds: [1] })).includes('SECRET'));
  });
});

describe('flake-probe command', () => {
  const flaky = () => ({ status: 1, junit: junit(true) });
  it('fails in enforce mode and only reports in report mode', async () => {
    assert.equal((await main(ARGS, { root: repo(['a.test.ts'], 'enforce'), runner: flaky })).code, 1);
    const report = await main(ARGS, { root: repo(['a.test.ts'], 'report'), runner: flaky });
    assert.equal(report.code, 0);
    assert.match(report.text, /GATE flake-probe ✗ a\.test\.ts > flaky one/);
  });

  it('skips more than the cap of changed files with a notice', async () => {
    const files = Array.from({ length: DEFAULT_CAP + 1 }, (_, i) => `t${i}.test.ts`);
    let ran = 0;
    const r = await main(ARGS, { root: repo(files, 'enforce'), runner: () => ((ran += 1), flaky()) });
    assert.equal(r.code, 0);
    assert.equal(ran, 0);
  });

  it('is broken for an unknown runner or a missing gates entry', async () => {
    assert.equal((await main([...ARGS, '--runner', 'jest'], { root: repo(['a.test.ts']) })).code, 2);
    const r = repo(['a.test.ts']);
    writeFileSync(join(r, 'quality/gates.json'), '{}');
    assert.equal((await main(ARGS, { root: r, runner: flaky })).code, 2);
  });
});
