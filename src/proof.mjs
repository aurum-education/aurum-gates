// `regression-proof` (DS-059 §4.3 G2, step 6.154): a `type: fix` PR's named test must fail with an ASSERTION on the base
// (the PR's source changes undone, its test and test-support files kept) and pass on the head. A compile error, a missing
// module, a timeout or a test that passes on the base is not proof. Output is paths, test names and categories only,
// never failure messages (workspace non-negotiable 2). The mode is `regression-proof` in quality/gates.json.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGate } from './gate.mjs';

export const RULES = {
  'passes-on-base': {
    why: 'a test that passes without the fix is not a regression test: it would not have caught the bug. DS-059 §4.3.',
    fix: 'make the test assert the broken behaviour so it fails on the base, then keep the fix that makes it pass.',
  },
  'not-run-on-base': {
    why: 'a compile error, a missing module, a timeout or a test the runner cannot find proves nothing about the bug. DS-059 §4.3.',
    fix: 'use an assertion that fails, or move the helper the test needs to a test-support path.',
  },
  'fails-on-head': {
    why: 'the named test must pass with the fix in place. DS-059 §4.3.',
    fix: 'fix the test or the change until it passes on the PR head.',
  },
};

/** Paths whose changes are kept on the base so a fix that adds a helper its test needs still runs (DS-059 §4.3 step 3). */
export const SUPPORT = /(^|\/)(test|tests|__tests__|__mocks__|__fixtures__|fixtures|mocks|test-support|e2e)\//;
const ANSI = /\u001b\[[0-9;]*m/g; // eslint-disable-line no-control-regex -- colour codes in runner messages
const TIMEOUT = /timed? ?out/i;

/** `<path>::<name>` from the PR's regression-test line, or `{ none }` for `none — <reason>`. */
export function parseTest(text) {
  const t = (text ?? '').trim();
  if (/^none — \S/.test(t)) return { none: t };
  const [path, ...name] = t.split('::');
  if (!path?.trim() || !name.join('::').trim())
    throw new Error('--test must be "<path>::<test name>" or "none — <reason>"');
  return { path: path.trim(), name: name.join('::').trim() };
}

/**
 * What one run of the named test did, from the runner's JSON report: `assertion` (failed on an expectation), `passed`,
 * `timeout`, `error` (failed any other way: compile, import, throw), or `none` (no test ran). Only the category leaves.
 */
export function classify(runner, text) {
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return 'error';
  }
  const tests = [];
  if (runner === 'vitest') {
    for (const file of report.testResults ?? []) {
      if (file.status === 'failed' && !(file.assertionResults ?? []).length) return 'error'; // the file did not load
      for (const t of file.assertionResults ?? [])
        tests.push({ status: t.status, message: (t.failureMessages ?? [])[0] ?? '' });
    }
  } else {
    const walk = (suite) => {
      for (const spec of suite.specs ?? [])
        for (const t of spec.tests ?? [])
          for (const r of t.results ?? []) tests.push({ status: r.status, message: r.error?.message ?? '' });
      for (const s of suite.suites ?? []) walk(s);
    };
    for (const s of report.suites ?? []) walk(s);
    if ((report.errors ?? []).length && !tests.length) return 'error';
  }
  const ran = tests.filter((t) => !['skipped', 'pending', 'todo', 'disabled'].includes(t.status));
  if (!ran.length) return 'none';
  const bad = ran.find((t) => !['passed', 'pass'].includes(t.status));
  if (!bad) return 'passed';
  const message = bad.message.replace(ANSI, '');
  if (bad.status === 'timedOut' || TIMEOUT.test(message.slice(0, 120))) return 'timeout';
  // Vitest: `AssertionError: …`; Playwright: `Error: expect(received)…`.
  return /^(?:Error: )?expect\(|^AssertionError\b/.test(message) ? 'assertion' : 'error';
}

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
};

/** Files the PR changed, `{ status, path }` (A, M, D), and the paths to keep on the base: the named test plus test-support paths. */
export function changes({ root, base, test }) {
  const files = git(root, ['diff', '--no-renames', '--name-status', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ status: l[0], path: l.slice(1).trim() }));
  const keep = (f) => f.path === test || SUPPORT.test(f.path);
  return { revert: files.filter((f) => !keep(f)), kept: files.filter(keep) };
}

/** `-t` and `-g` take a regular expression: a name with brackets or a dot must match itself. */
export const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The real runner: runs the named test and returns `{ status, report }` (the JSON text, or undefined). */
export function execRunner(root) {
  return (runner, path, name) => {
    const dir = mkdtempSync(join(tmpdir(), 'aurum-proof-'));
    const out = join(dir, 'report.json');
    const args =
      runner === 'vitest'
        ? [
            'exec',
            'vitest',
            'run',
            path,
            '-t',
            escaped(name),
            '--coverage.enabled=false',
            '--reporter=json',
            `--outputFile.json=${out}`,
          ]
        : ['exec', 'playwright', 'test', path, '-g', escaped(name), '--retries=0', '--trace', 'off', '--reporter=json'];
    const r = spawnSync('pnpm', args, {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: out, PLAYWRIGHT_JSON_OUTPUT_FILE: out },
    });
    let report;
    try {
      report = readFileSync(out, 'utf8');
    } catch {
      /* no report: classified as an error */
    }
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, report };
  };
}

/** Undoes the PR's source changes in the working tree, runs `fn`, and always puts the head back. */
function onBase({ root, base, revert }, fn) {
  try {
    for (const f of revert) {
      if (f.status === 'A') git(root, ['rm', '-qf', '--', f.path]);
      else git(root, ['checkout', base, '--', f.path]);
    }
    return fn();
  } finally {
    git(root, ['reset', '-q', '--hard', 'HEAD']);
  }
}

/** Failures `{ where, rule, detail }`. `exec(runner, path, name)` returns `{ status, report }`. */
export function prove({ root, base, runner, test, exec }) {
  const where = `${test.path}::${test.name}`;
  const { revert } = changes({ root, base, test: test.path });
  const outcome = (r) => (r.report ? classify(runner, r.report) : 'error');
  const onBaseOutcome = onBase({ root, base, revert }, () => outcome(exec(runner, test.path, test.name)));
  const failures = [];
  if (onBaseOutcome === 'passed') failures.push({ where, rule: 'passes-on-base', detail: 'it passes on the base' });
  else if (onBaseOutcome !== 'assertion')
    failures.push({ where, rule: 'not-run-on-base', detail: `on the base it ended as: ${onBaseOutcome}` });
  const head = outcome(exec(runner, test.path, test.name));
  if (head !== 'passed') failures.push({ where, rule: 'fails-on-head', detail: `on the head it ended as: ${head}` });
  return failures;
}

/** The command: `regression-proof --test "<path>::<name>" [--base <ref>] [--runner vitest|playwright]`. `exec` is the test seam. */
export async function run(root, args, { exec } = {}) {
  const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  return runGate({
    gate: 'regression-proof',
    root,
    rules: RULES,
    check: () => {
      const runner = opt('runner', 'vitest');
      if (!['vitest', 'playwright'].includes(runner))
        throw new Error(`--runner must be vitest or playwright, not "${runner}"`);
      const test = parseTest(opt('test'));
      if (test.none) {
        console.log(`regression-proof: ${test.none} (listed for the reviewer, DS-059 §4.3 step 4).`);
        return [];
      }
      // The proof rewrites the working tree and ends with `git reset --hard`: CI only, never over local work.
      if (git(root, ['status', '--porcelain']).trim()) throw new Error('the working tree has uncommitted changes');
      const base = git(root, ['merge-base', opt('base', 'origin/main'), 'HEAD']).trim();
      return prove({ root, base, runner, test, exec: exec ?? execRunner(root) });
    },
  });
}
