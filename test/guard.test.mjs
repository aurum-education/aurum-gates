// Tests for the baseline guard (step 6.151 AC2, DS-059 §4.1). Each rule has a case that must fail and one that must pass;
// the last block runs the CLI against a real git repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { guard, unallowed } from '../src/guard.mjs';

const GATES = 'quality/gates.json';
const BASELINE = 'quality/baselines/reuse.json';

const files = (map) => new Map(Object.entries(map).map(([file, value]) => [file, JSON.stringify(value)]));
const found = (base, head, extra = {}) =>
  guard({ base: files(base), head: files(head), ...extra }).map((f) => `${f.label}: ${f.rule}`);

describe('a count that rises', () => {
  it('fails, naming the file, the key, both numbers and the allowance line', () => {
    const failures = guard({
      base: files({ [BASELINE]: { 'src/a.ts': { dup: 5 } } }),
      head: files({ [BASELINE]: { 'src/a.ts': { dup: 6 } } }),
    });
    assert.deepEqual(failures, [
      {
        label: 'reuse',
        where: `${BASELINE} src/a.ts > dup`,
        rule: 'raised',
        detail: 'Merge base 5, now 6',
        allow: '`baseline-raise: reuse — <reason>` in the PR body; the reviewer reads it.',
      },
    ]);
  });

  it('passes when equal or lower, and when a key is removed', () => {
    const base = { [BASELINE]: { 'src/a.ts': { dup: 5 }, 'src/b.ts': { dup: 1 } } };
    assert.deepEqual(found(base, base), []);
    assert.deepEqual(found(base, { [BASELINE]: { 'src/a.ts': { dup: 4 } } }), []);
  });

  it('fails a number replaced by something that cannot be compared, and the reverse', () => {
    const pair = (was, now) => found({ [BASELINE]: { a: { r: was } } }, { [BASELINE]: { a: { r: now } } });
    assert.deepEqual(pair(5, '5'), ['reuse: raised']);
    assert.deepEqual(pair(null, 9), ['reuse: raised']);
    assert.deepEqual(pair('1', 9), ['reuse: raised']);
    assert.deepEqual(pair('1', '2'), []);
  });
});

describe('a file that cannot be compared by key', () => {
  it('throws on a list anywhere in a watched file: a swapped entry would keep its index and pass', () => {
    const list = (value) => new Map([[BASELINE, JSON.stringify(value)]]);
    const expected = { message: `${BASELINE} holds a list; a watched file must be objects keyed by ID` };
    assert.throws(() => guard({ base: list(['a']), head: list(['b']) }), expected);
    assert.throws(() => guard({ base: list({}), head: list({ a: [{ r: 1 }] }) }), expected);
    assert.throws(() => guard({ base: new Map(), head: list([]) }), expected);
  });

  it('throws on a watched file that is not JSON, on either side', () => {
    const bad = new Map([[BASELINE, '{']]);
    const expected = { message: `${BASELINE} is not valid JSON` };
    assert.throws(() => guard({ base: files({ [BASELINE]: {} }), head: bad }), expected);
    assert.throws(() => guard({ base: bad, head: files({ [BASELINE]: {} }) }), expected);
    assert.throws(() => guard({ base: new Map(), head: new Map([[GATES, 'x']]) }), {
      message: `${GATES} is not valid JSON`,
    });
  });

  it('ignores an unwatched file', () => {
    assert.deepEqual(found({ 'quality/other.json': { n: 1 } }, { 'quality/other.json': { n: 2 } }), []);
  });
});

describe('a key that is added', () => {
  it('fails: a new finding let through', () => {
    assert.deepEqual(found({ [BASELINE]: { a: { r: 1 } } }, { [BASELINE]: { a: { r: 1, s: 1 } } }), [
      'reuse: key-added',
    ]);
    assert.deepEqual(found({ [BASELINE]: { a: { r: 1 } } }, { [BASELINE]: { a: { r: 1 }, b: { r: 1 } } }), [
      'reuse: key-added',
    ]);
  });
});

describe('a file that appears', () => {
  it('fails without a new gate in quality/gates.json and passes with one', () => {
    const head = { [BASELINE]: { a: { r: 1 } } };
    assert.deepEqual(found({}, head), ['reuse: new-file']);
    assert.deepEqual(found({ [GATES]: {} }, { ...head, [GATES]: { reuse: { mode: 'ratchet' } } }), []);
  });
});

describe('a mode that moves backwards', () => {
  const mode = (m) => ({ [GATES]: { reuse: { mode: m } } });

  it('fails each step back and a removed gate, under the label `<gate> mode`', () => {
    assert.deepEqual(guard({ base: files(mode('enforce')), head: files(mode('ratchet')) }), [
      {
        label: 'reuse mode',
        where: GATES,
        rule: 'mode-backwards',
        detail: '"reuse" was enforce, now "ratchet"',
        allow: '`baseline-raise: reuse mode — <reason>` in the PR body; the reviewer reads it.',
      },
    ]);
    assert.deepEqual(found(mode('ratchet'), mode('report')), ['reuse mode: mode-backwards']);
    assert.deepEqual(found(mode('enforce'), mode('off')), ['reuse mode: mode-backwards']);
    assert.deepEqual(found(mode('report'), { [GATES]: {} }), ['reuse mode: mode-backwards']);
    assert.deepEqual(found(mode('report'), {}), ['reuse mode: mode-backwards']);
  });

  it('passes a promotion, an unchanged mode and a new gate', () => {
    assert.deepEqual(found(mode('report'), mode('ratchet')), []);
    assert.deepEqual(found(mode('ratchet'), mode('ratchet')), []);
    assert.deepEqual(found({ [GATES]: {} }, mode('report')), []);
  });

  it('is allowed only by its own label, not by the gate line', () => {
    const back = guard({ base: files(mode('ratchet')), head: files(mode('report')) });
    assert.deepEqual(unallowed(back, 'baseline-raise: reuse — a reason'), back);
    assert.deepEqual(unallowed(back, 'baseline-raise: reuse mode — demoted, fix PR #1'), []);
  });
});

describe('a moved source file carries its count (DS-059 §4.1)', () => {
  const base = { [BASELINE]: { 'src/old.ts': { dup: 3 }, 'src/same.ts': { dup: 1 } } };
  const renames = new Map([['src/old.ts', 'src/new.ts']]);

  it('is neutral at an equal or lower count', () => {
    assert.deepEqual(
      found(base, { [BASELINE]: { 'src/new.ts': { dup: 3 }, 'src/same.ts': { dup: 1 } } }, { renames }),
      [],
    );
    assert.deepEqual(
      found(base, { [BASELINE]: { 'src/new.ts': { dup: 2 }, 'src/same.ts': { dup: 1 } } }, { renames }),
      [],
    );
  });

  it('fails at a higher count, and without a rename the new key is a new finding', () => {
    const head = { [BASELINE]: { 'src/new.ts': { dup: 4 }, 'src/same.ts': { dup: 1 } } };
    assert.deepEqual(found(base, head, { renames }), ['reuse: raised']);
    assert.deepEqual(found(base, { [BASELINE]: { 'src/new.ts': { dup: 3 }, 'src/same.ts': { dup: 1 } } }), [
      'reuse: key-added',
    ]);
  });

  it('adds the counts of two files merged into one', () => {
    const merged = new Map([
      ['src/old.ts', 'src/new.ts'],
      ['src/same.ts', 'src/new.ts'],
    ]);
    assert.deepEqual(found(base, { [BASELINE]: { 'src/new.ts': { dup: 4 } } }, { renames: merged }), []);
    assert.deepEqual(found(base, { [BASELINE]: { 'src/new.ts': { dup: 5 } } }, { renames: merged }), ['reuse: raised']);
  });
});

describe('a repo that watches more files (config)', () => {
  const FILE = 'quality/limits.json';
  const config = {
    roots: [FILE],
    watched: [
      { match: /^quality\/limits\.json$/, label: () => 'limits', keyLabel: (key) => `limit ${key}`, removal: true },
    ],
    rules: {},
    soft: (f) => f.label === 'limit soft',
  };
  const both = (base, head) =>
    guard({ base: files(base), head: files(head), config }).map((f) => `${f.label}: ${f.rule}`);

  it('applies the watched entry: a label per key, and a removed file', () => {
    assert.deepEqual(both({ [FILE]: { a: 1 } }, { [FILE]: { a: 2 } }), ['limit a: raised']);
    assert.deepEqual(both({ [FILE]: { a: 1 } }, {}), ['limits: removed']);
  });

  it('runs `extra` for a file that stays', () => {
    const extra = ({ path }) => [{ label: 'limits', where: path, rule: 'removed', detail: 'x', allow: 'own line.' }];
    const failures = guard({
      base: files({ [FILE]: { a: 1 } }),
      head: files({ [FILE]: { a: 1 } }),
      config: { ...config, watched: [{ ...config.watched[0], extra }] },
    });
    assert.deepEqual(failures, [{ label: 'limits', where: FILE, rule: 'removed', detail: 'x', allow: 'own line.' }]);
  });
});

describe('a finding no line can allow', () => {
  it('keeps its own Allow text and is never let through by the body', () => {
    const extra = ({ path }) => [{ label: 'limits', where: path, rule: 'removed', detail: 'x', allowable: false }];
    const failures = guard({
      base: files({ 'quality/limits.json': { a: 1 } }),
      head: files({ 'quality/limits.json': { a: 1 } }),
      config: {
        roots: ['quality/limits.json'],
        watched: [{ match: /^quality\/limits\.json$/, label: () => 'limits', extra }],
        rules: {},
        soft: () => false,
      },
    });
    assert.deepEqual(failures, [
      { label: 'limits', where: 'quality/limits.json', rule: 'removed', detail: 'x', allowable: false },
    ]);
    assert.deepEqual(unallowed(failures, 'baseline-raise: limits — a reason'), failures);
  });
});

describe('the baseline-raise line', () => {
  const failures = [{ label: 'reuse' }, { label: 'g3 flake' }];
  const left = (body) => unallowed(failures, body).map((f) => f.label);

  it('allows only the label it names, with a reason', () => {
    assert.deepEqual(left(''), ['reuse', 'g3 flake']);
    assert.deepEqual(left('type: fix\r\nbaseline-raise: reuse — the new dialog, fixed in 6.170\r\n'), ['g3 flake']);
    assert.deepEqual(left('baseline-raise: reuse — x\nbaseline-raise: g3 flake — y'), []);
  });

  it('does not accept a line with no reason, another gate, a longer gate name or a mention in prose', () => {
    const all = ['reuse', 'g3 flake'];
    assert.deepEqual(left('baseline-raise: reuse'), all);
    assert.deepEqual(left('baseline-raise: reuse — '), all);
    assert.deepEqual(left('baseline-raise: other — a reason'), all);
    assert.deepEqual(left('baseline-raise: reuse-extra — a reason'), all);
    assert.deepEqual(left('I did not add baseline-raise: reuse — a reason'), all);
  });
});

describe('the CLI against a git repository', () => {
  const cli = join(import.meta.dirname, '..', 'bin', 'aurum-gates.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'baseline-guard-'));
  after(() => rmSync(repo, { recursive: true, force: true }));

  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: repo,
    });
    if (result.status !== 0) throw new Error(`git ${args[0]}: ${result.stderr}`);
  };
  const write = (file, value) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  // PR_NUMBER is cleared so a run inside CI never reads the real PR's body.
  const run = (body, ...args) =>
    spawnSync('node', [cli, 'baseline-guard', ...(args.includes('--base') ? [] : ['--base', 'HEAD']), ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PR_NUMBER: '', GITHUB_STEP_SUMMARY: '', ...(body === undefined ? {} : { PR_BODY: body }) },
    });

  git('init', '-q');
  write(GATES, { reuse: { mode: 'ratchet' } });
  write(BASELINE, { 'src/old.ts': { dup: 5 } });
  git('add', '.');
  git('commit', '-q', '-m', 'base');

  it('passes an unchanged tree', () => {
    const result = run();
    assert.equal(result.stdout, 'GATE baseline-guard: 0 finding(s), 0 failing.\n');
    assert.equal(result.status, 0);
  });

  it('fails a raised count, and passes it with the line in the PR body', () => {
    write(BASELINE, { 'src/old.ts': { dup: 6 } });
    const result = run();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`GATE baseline-guard ✗ ${BASELINE} src/old.ts > dup  raised`));
    assert.ok(
      result.stderr.includes('  Allow: `baseline-raise: reuse — <reason>` in the PR body; the reviewer reads it.'),
    );
    assert.ok(result.stderr.includes('  Mode:  enforce. Merge base 5, now 6'));
    assert.equal(run('').status, 1);
    assert.equal(run('baseline-raise: reuse — the new dialog, fixed in 6.170').status, 0);
    write(BASELINE, { 'src/old.ts': { dup: 5 } });
  });

  it('prints a reported label without failing, and still fails the others', () => {
    write(BASELINE, { 'src/old.ts': { dup: 6 } });
    const reported = run(undefined, '--report=reuse');
    assert.equal(reported.status, 0);
    assert.ok(reported.stdout.includes('  Mode:  report. Merge base 5, now 6'));
    write(GATES, { reuse: { mode: 'report' } });
    assert.equal(run(undefined, '--report=reuse').status, 1, 'a mode moved backwards is never reported');
    git('checkout', '--', GATES, BASELINE);
  });

  it('carries a count through a git rename of the source file (committed: a PR is its commits)', () => {
    write('src/old.ts', 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'source file');
    git('tag', 'before-move');
    git('mv', 'src/old.ts', 'src/new.ts');
    write(BASELINE, { 'src/new.ts': { dup: 5 } });
    git('add', '.');
    git('commit', '-q', '-m', 'move');
    assert.equal(run(undefined, '--base', 'before-move').status, 0);
    write(BASELINE, { 'src/new.ts': { dup: 6 } });
    const raised = run(undefined, '--base', 'before-move');
    assert.equal(raised.status, 1);
    assert.ok(raised.stderr.includes('Merge base 5, now 6'));
    git('checkout', '--', BASELINE);
    git('reset', '-q', '--hard', 'before-move');
  });

  it('sees a new, uncommitted baseline file', () => {
    write('quality/baselines/other.json', {});
    const result = run();
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('GATE baseline-guard ✗ quality/baselines/other.json  new-file'));
    rmSync(join(repo, 'quality/baselines/other.json'));
  });

  it('loads a repo config with --config, and exits 2 for a missing module or export', () => {
    write(
      'guard-config.mjs',
      'export const config = { roots: ["quality/limits.json"], watched: [{ match: /^quality\\/limits\\.json$/, label: () => "limits" }], rules: {}, soft: () => false };\n',
    );
    write('no-config.mjs', 'export const other = 1;\n');
    write('quality/limits.json', { a: 1 });
    git('add', '.');
    git('commit', '-q', '-m', 'limits');
    write('quality/limits.json', { a: 2 });
    const failed = run(undefined, '--config', 'guard-config.mjs');
    assert.equal(failed.status, 1);
    assert.ok(failed.stderr.includes('quality/limits.json a  raised'));
    assert.equal(run('baseline-raise: limits — a reason', '--config', 'guard-config.mjs').status, 0);
    for (const bad of ['missing.mjs', 'no-config.mjs']) {
      const result = run(undefined, '--config', bad);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes('aurum-gates ✗ baseline-guard --config:'));
    }
    git('reset', '-q', '--hard', 'HEAD~1');
  });

  it('exits 2 when it cannot run: an unknown base commit or a broken file', () => {
    const unknown = spawnSync('node', [cli, 'baseline-guard', '--base', 'no-such-ref'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(unknown.status, 2);
    assert.ok(unknown.stderr.includes('GATE baseline-guard ✗ could not run: git rev-parse failed'));
    write(BASELINE, '{');
    assert.equal(run().status, 2);
    write(BASELINE, { 'src/old.ts': { dup: 5 } });
  });
});
