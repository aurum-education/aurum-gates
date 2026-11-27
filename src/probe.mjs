// `flake-probe` (DS-059 §4.4 G3, step 6.156 slice 3): runs the test files a PR adds or changes repeatedly, so a new flake
// stops at the PR that brings it. Vitest: 5 runs per file with `--sequence.shuffle` and a different seed each time.
// Playwright: one run of the changed files with `--repeat-each=3 --retries=0`. Any failure fails the job, naming the
// test id and the seed (never the failure message: workspace non-negotiable 2). More than `--cap` changed files (default 8) skips with a
// notice, the nightly covers them. The mode is `flake-probe` in quality/gates.json (report for 14 days, then enforce).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { readJunit } from './flakes.mjs';
import { runGate } from './gate.mjs';

export const RULES = {
  'fails-on-repeat': {
    why: 'a test that fails on a repeat, or in another order, is flaky: it will fail a stranger’s PR later. DS-059 §4.4, DS-013 §4.2.2.',
    fix: 'make the test deterministic (a fake clock or a controlled fake, never a wait); do not retry, skip or quarantine it.',
  },
};

export const REPEATS = 5; // Vitest runs per file
export const PLAYWRIGHT_REPEATS = 3;
export const DEFAULT_CAP = 8;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

const git = (root, args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed`);
  return r.stdout;
};

/** Test files this branch adds or changes against `base`, for one runner (Playwright owns `e2e/`, Vitest the rest). */
export function changedTests({ root, base, runner }) {
  return git(root, ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`])
    .split('\n')
    .filter((f) => TEST_FILE.test(f) && /^e2e\//.test(f) === (runner === 'playwright'))
    .sort();
}

/** The real runner: runs a command and returns `{ status, junit }` (the JUnit text, or undefined if none was written). */
export function execRunner(root) {
  return (command, args, env = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'aurum-probe-'));
    const out = join(dir, 'junit.xml');
    const r = spawnSync(
      command,
      args.map((a) => a.replace('{junit}', out)),
      {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, ...env, PLAYWRIGHT_JUNIT_OUTPUT_FILE: out },
      },
    );
    let junit;
    try {
      junit = readFileSync(out, 'utf8');
    } catch {
      /* no report: the caller treats a failed status with no failed test as a failing file */
    }
    rmSync(dir, { recursive: true, force: true });
    return { status: r.status, junit };
  };
}

/** Failures `{ where, rule, detail }` of the probe. `exec(command, args)` returns `{ status, junit }`. */
export function probe({ files, runner, exec, seeds }) {
  const failures = [];
  const add = (where, detail) => failures.push({ where, rule: 'fails-on-repeat', detail });
  const check = ({ status, junit }, file, label) => {
    const failed = junit ? [...readJunit(junit).failed] : [];
    for (const t of failed) add(t, label);
    if (!failed.length && status !== 0)
      add(file, `${label}; the run failed with no failed test (a crash or a load error)`);
  };
  if (runner === 'playwright')
    check(
      exec('pnpm', [
        'exec',
        'playwright',
        'test',
        `--repeat-each=${PLAYWRIGHT_REPEATS}`,
        '--retries=0',
        '--trace',
        'off',
        '--reporter=junit',
        ...files,
      ]),
      files.join(' '),
      `${PLAYWRIGHT_REPEATS} repeats, retries 0`,
    );
  else
    for (const file of files)
      for (const seed of seeds)
        check(
          exec('pnpm', [
            'exec',
            'vitest',
            'run',
            '--sequence.shuffle',
            `--sequence.seed=${seed}`,
            '--reporter=junit',
            '--outputFile.junit={junit}',
            file,
          ]),
          file,
          `seed ${seed}`,
        );
  return failures;
}

/** The command: `flake-probe [--base <ref>] [--runner vitest|playwright] [--cap <n>]`. `exec` is the test seam. */
export async function run(root, args, { exec } = {}) {
  const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
  return runGate({
    gate: 'flake-probe',
    root,
    rules: RULES,
    check: () => {
      const runner = opt('runner', 'vitest');
      if (!['vitest', 'playwright'].includes(runner))
        throw new Error(`--runner must be vitest or playwright, not "${runner}"`);
      const cap = Number(opt('cap', DEFAULT_CAP));
      if (!(cap > 0)) throw new Error('--cap must be a positive number');
      const files = changedTests({ root, base: opt('base', 'origin/main'), runner });
      if (files.length > cap) {
        console.log(
          `flake-probe: ${files.length} changed ${runner} test files (cap ${cap}): skipped; the nightly covers them.`,
        );
        return [];
      }
      console.log(`flake-probe: ${files.length} changed ${runner} test file(s).`);
      const seeds = Array.from({ length: REPEATS }, () => randomInt(1, 2 ** 31));
      return probe({ files, runner, exec: exec ?? execRunner(root), seeds });
    },
  });
}
