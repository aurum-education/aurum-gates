// Tests for `pr-evidence` (step 6.153, DS-059 §4.8). Each rule has a case that must fail and one that must pass; the
// last blocks run the command against a real git repository and a fake GitHub (AC1 to AC3).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { evaluate, globToRegExp, markersOf, statusOf } from '../src/evidence.mjs';
import { main } from '../src/cli.mjs';

const ATTRIBUTION = `<!-- claude-projects-attribution: {"github_login":"jmal1"} -->\n_Requested by **Dana** · [project thread](https://claude.ai/code/project/x)_\n`;
const body = (...lines) => `${ATTRIBUTION}\n${lines.join('\n')}\n`;
const SHA = 'a'.repeat(40);
const marker = (kind, sha = SHA, rest = '', verdict = 'pass') => ({ kind, verdict, sha, rest });
const base = {
  files: ['src/a.js'],
  markers: [marker('independent-review')],
  patchIdOf: () => 'p',
  headPatchId: 'p',
  visible: () => false,
};
const rules = (input) => evaluate({ ...base, ...input }).findings.map((f) => f.rule);

describe('the PR body', () => {
  const ok = body('type: feature', 'step: 6.153');
  it('passes with attribution, type, step and a review', () => assert.deepEqual(rules({ body: ok }), []));
  it('fails without the attribution lines', () =>
    assert.deepEqual(rules({ body: 'type: feature\nstep: 6.153' }), ['attribution']));
  it('fails without a type, and with the template line or an unknown type', () => {
    assert.deepEqual(rules({ body: body('step: 6.153') }), ['type']);
    assert.deepEqual(rules({ body: body('type: feature | fix | docs', 'step: 6.153') }), ['type']);
    assert.deepEqual(rules({ body: body('type: wip', 'step: 6.153') }), ['type']);
  });
  it('fails without a step or with the template step', () => {
    assert.deepEqual(rules({ body: body('type: feature') }), ['step']);
    assert.deepEqual(rules({ body: body('type: feature', 'step: X.Y') }), ['step']);
  });
  it('needs no step for a log', () =>
    assert.deepEqual(rules({ body: body('type: log'), files: ['vault/50-Implementation/log.md'], markers: [] }), []));
});

describe('type: fix', () => {
  const fix = (line) => body('type: fix', 'step: 6.1', ...line);
  it('fails without a regression-test line', () => assert.deepEqual(rules({ body: fix([]) }), ['regression-test']));
  it('fails when the path is not a file the diff changes', () =>
    assert.deepEqual(rules({ body: fix(['regression-test: test/b.test.mjs::it works']) }), ['regression-test']));
  it('passes when the diff changes the file', () =>
    assert.deepEqual(
      rules({ body: fix(['regression-test: test/a.test.mjs::it works']), files: ['src/a.js', 'test/a.test.mjs'] }),
      [],
    ));
  it('passes with none and a reason, and lists it', () => {
    const result = evaluate({ ...base, body: fix(['regression-test: none — an infra template']) });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.notes, ['regression-test: none — an infra template']);
  });
  it('fails with none and no reason', () =>
    assert.deepEqual(rules({ body: fix(['regression-test: none']) }), ['regression-test']));
});

describe('the review marker', () => {
  const b = body('type: feature', 'step: 6.1');
  it('fails with no marker, and with a marker for other code', () => {
    assert.deepEqual(rules({ body: b, markers: [] }), ['review-missing']);
    assert.deepEqual(rules({ body: b, patchIdOf: () => 'other' }), ['review-missing']);
  });
  it('fails when the latest marker for this code says fail, and passes when a pass follows', () => {
    assert.deepEqual(rules({ body: b, markers: [marker('independent-review', SHA, '', 'fail')] }), ['review-failed']);
    assert.deepEqual(
      rules({ body: b, markers: [marker('independent-review', SHA, '', 'fail'), marker('independent-review')] }),
      [],
    );
  });
  it('lets a log that touches only step logs and the Changelog skip the marker, and no other log', () => {
    const log = body('type: log');
    assert.deepEqual(
      rules({ body: log, markers: [], files: ['vault/50-Implementation/x.md', 'vault/00-Meta/Changelog.md'] }),
      [],
    );
    assert.deepEqual(rules({ body: log, markers: [], files: ['vault/50-Implementation/x.md', 'src/a.js'] }), [
      'review-missing',
    ]);
  });
  it('asks for a design review of a visible path, and passes with one', () => {
    const visible = (f) => f.startsWith('src/pages/');
    const files = ['src/pages/Home.tsx'];
    assert.deepEqual(rules({ body: b, files, visible }), ['design-review-missing']);
    assert.deepEqual(
      rules({ body: b, files, visible, markers: [marker('independent-review'), marker('design-review')] }),
      [],
    );
    assert.deepEqual(
      rules({
        body: b,
        files,
        visible,
        markers: [marker('independent-review'), marker('design-review', SHA, '', 'fail')],
      }),
      ['design-review-failed'],
    );
  });
  it('asks a substantial spec change to be named in the marker', () => {
    const specs = [{ id: 'DS-099', substantial: true }];
    assert.deepEqual(rules({ body: b, specs }), ['spec-review-missing']);
    assert.deepEqual(rules({ body: b, specs, markers: [marker('independent-review', SHA, 'DS-099')] }), []);
    assert.deepEqual(rules({ body: b, specs: [{ id: 'DS-099', substantial: false }] }), []);
  });
});

describe('exemptions', () => {
  it('passes a hand-made PR with an evidence-exempt line, and lists the reason', () => {
    const result = evaluate({ ...base, body: 'fix a typo\nevidence-exempt: owner hand edit', markers: [] });
    assert.deepEqual(result, { findings: [], notes: [], exempt: 'owner hand edit' });
  });
  it('does not accept an empty reason', () =>
    assert.deepEqual(rules({ body: 'x\nevidence-exempt: ', markers: [] }).includes('attribution'), true));
  it('passes a bot author', () =>
    assert.equal(evaluate({ ...base, body: '', bot: true, markers: [] }).exempt, 'bot author'));
});

describe('markers and globs', () => {
  it('reads the first line of a reviewer comment only', () => {
    const comments = [
      { author_association: 'OWNER', body: `independent-review: pass ${SHA} DS-1\nmore` },
      { author_association: 'NONE', body: `independent-review: pass ${SHA}` },
      { author_association: 'OWNER', body: `see\nindependent-review: pass ${SHA}` },
      { author_association: 'MEMBER', body: `design-review: fail ${SHA}` },
    ];
    assert.deepEqual(markersOf(comments), [
      marker('independent-review', SHA, 'DS-1'),
      marker('design-review', SHA, '', 'fail'),
    ]);
  });
  it('turns the visible-path globs into patterns', () => {
    const r = globToRegExp('apps/*/src/**/*.{tsx,css}');
    assert.equal(r.test('apps/teacher/src/a/b.tsx'), true);
    assert.equal(r.test('apps/teacher/src/b.css'), true);
    assert.equal(r.test('apps/teacher/src/b.ts'), false);
    assert.equal(globToRegExp('packages/ui/**').test('packages/ui/a/b.ts'), true);
  });
});

describe('the status', () => {
  const missing = { findings: [{ rule: 'type' }, { rule: 'step' }, { rule: 'type' }], notes: [] };
  it('is green in report and lists what is missing', () =>
    assert.deepEqual(statusOf(missing, 'report'), {
      state: 'success',
      description: 'report (not failing): missing type, step',
    }));
  it('is red in enforce', () =>
    assert.deepEqual(statusOf(missing, 'enforce'), { state: 'failure', description: 'missing type, step' }));
  it('is green with nothing missing', () =>
    assert.deepEqual(statusOf({ findings: [], notes: [] }, 'enforce'), { state: 'success', description: 'ok' }));
});

// ----- the command against a real repository and a fake GitHub -----

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const git = (root, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const put = (root, file, text) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
const commit = (root, message, files) => {
  for (const [f, t] of Object.entries(files)) put(root, f, t);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
};
function repo(mode = 'report') {
  const root = mkdtempSync(join(tmpdir(), 'evidence-'));
  dirs.push(root);
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'one', {
    'src/a.js': 'a\n',
    'README.md': 'readme\n',
    'quality/gates.json': JSON.stringify({ 'pr-evidence': { mode } }),
  });
  return root;
}
/** A fake GitHub: serves one PR and its comments, records the statuses posted. */
function github({ pr, comments = [] }) {
  const posted = [];
  const answer = (data) => ({ ok: true, status: 200, json: async () => data });
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/repos/o/r', '');
    if (init.method === 'POST') {
      posted.push({ path, ...JSON.parse(init.body) });
      return { ok: true, status: 201, json: async () => ({}) };
    }
    if (path === `/pulls/${pr.number}`) return answer(pr);
    if (path === '/pulls') return answer([pr]);
    if (path === `/issues/${pr.number}/comments`) return answer(comments);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetch, posted };
}
const env = (extra = {}) => ({ GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', PR_NUMBER: '7', ...extra });
const sleep = async () => {};
const prOf = (root, head, prBody = body('type: feature', 'step: 6.1')) => ({
  number: 7,
  state: 'open',
  body: prBody,
  user: { type: 'User' },
  head: { sha: head },
  base: { sha: git(root, 'rev-parse', 'main') },
});
const review = (sha, rest = '') => ({ author_association: 'OWNER', body: `independent-review: pass ${sha}${rest}` });
const evidence = (root, gh, extra) =>
  import('../src/evidence.mjs').then((m) => m.run(root, [], { env: env(extra), fetch: gh.fetch, sleep }));

describe('what the review covers (AC1)', () => {
  function reviewed() {
    const root = repo();
    git(root, 'checkout', '-qb', 'pr');
    const reviewedSha = commit(root, 'change', { 'src/a.js': 'a\nb\n' });
    git(root, 'checkout', '-q', 'main');
    return { root, reviewedSha };
  }
  const statusOfPr = async (root, head, comments) => {
    const gh = github({ pr: prOf(root, head), comments });
    const result = await evidence(root, gh);
    assert.equal(result.code, 0, result.text);
    return gh.posted[0];
  };

  it('keeps a marker valid across a rebase onto a newer main', async () => {
    const { root, reviewedSha } = reviewed();
    commit(root, 'main moves', { 'src/other.js': 'o\n' });
    git(root, 'checkout', '-q', 'pr');
    git(root, 'rebase', '-q', 'main');
    const head = git(root, 'rev-parse', 'HEAD');
    assert.notEqual(head, reviewedSha);
    git(root, 'checkout', '-q', 'main');
    const status = await statusOfPr(root, head, [review(reviewedSha)]);
    assert.equal(status.description, 'ok');
  });

  it('invalidates the marker when the code changes after the review', async () => {
    const { root, reviewedSha } = reviewed();
    git(root, 'checkout', '-q', 'pr');
    const head = commit(root, 'more code', { 'src/a.js': 'a\nb\nc\n' });
    git(root, 'checkout', '-q', 'main');
    const status = await statusOfPr(root, head, [review(reviewedSha)]);
    assert.equal(status.description, 'report (not failing): missing review-missing');
  });

  it('keeps the marker valid when only Markdown changes after the review', async () => {
    const { root, reviewedSha } = reviewed();
    git(root, 'checkout', '-q', 'pr');
    const head = commit(root, 'docs', { 'README.md': 'readme\nmore\n' });
    git(root, 'checkout', '-q', 'main');
    const status = await statusOfPr(root, head, [review(reviewedSha)]);
    assert.equal(status.description, 'ok');
  });

  it('needs no marker for a log that touches only step logs', async () => {
    const root = repo();
    git(root, 'checkout', '-qb', 'pr');
    const head = commit(root, 'log', { 'vault/50-Implementation/log.md': 'log\n' });
    git(root, 'checkout', '-q', 'main');
    const gh = github({ pr: prOf(root, head, body('type: log')) });
    await evidence(root, gh);
    assert.equal(gh.posted[0].description, 'ok');
  });

  it('asks for the marker of a spec change to name the spec', async () => {
    const root = repo();
    git(root, 'checkout', '-qb', 'pr');
    const head = commit(root, 'spec', { 'vault/40-Design/DS-099 Tracker.md': 'x\n'.repeat(5) });
    git(root, 'checkout', '-q', 'main');
    const gh = github({ pr: prOf(root, head), comments: [review(head)] });
    await evidence(root, gh);
    assert.equal(gh.posted[0].description, 'report (not failing): missing spec-review-missing');
    const named = github({ pr: prOf(root, head), comments: [review(head, ' DS-099')] });
    await evidence(root, named);
    assert.equal(named.posted[0].description, 'ok');
  });
});

describe('where the status goes and how it fails (AC2, AC3)', () => {
  it('posts the status on the PR head SHA, as the pr-evidence context', async () => {
    const root = repo();
    git(root, 'checkout', '-qb', 'pr');
    const head = commit(root, 'change', { 'src/a.js': 'a\nb\n' });
    git(root, 'checkout', '-q', 'main');
    const gh = github({ pr: prOf(root, head), comments: [review(head)] });
    await evidence(root, gh, { GITHUB_RUN_ID: '9' });
    assert.equal(gh.posted.length, 1);
    assert.equal(gh.posted[0].path, `/statuses/${head}`);
    assert.equal(gh.posted[0].context, 'pr-evidence');
    assert.equal(gh.posted[0].target_url, 'https://github.com/o/r/actions/runs/9');
  });

  it('in report mode never fails, and in enforce mode fails the status with the missing rules', async () => {
    for (const [mode, state] of [
      ['report', 'success'],
      ['enforce', 'failure'],
    ]) {
      const root = repo(mode);
      git(root, 'checkout', '-qb', 'pr');
      const head = commit(root, 'change', { 'src/a.js': 'a\nb\n' });
      git(root, 'checkout', '-q', 'main');
      const gh = github({ pr: prOf(root, head, 'no lines at all') });
      const result = await evidence(root, gh);
      assert.equal(result.code, 0);
      assert.equal(gh.posted[0].state, state);
      assert.match(gh.posted[0].description, /attribution, type, step, review-missing/);
      assert.match(result.text, /GATE pr-evidence ✗ #7 {2}attribution/);
    }
  });

  it('evaluates every open PR with --all', async () => {
    const root = repo();
    git(root, 'checkout', '-qb', 'pr');
    const head = commit(root, 'change', { 'src/a.js': 'a\nb\n' });
    git(root, 'checkout', '-q', 'main');
    const gh = github({ pr: prOf(root, head), comments: [review(head)] });
    const { run } = await import('../src/evidence.mjs');
    const result = await run(root, ['--all'], { env: env({ PR_NUMBER: '' }), fetch: gh.fetch, sleep });
    assert.equal(result.code, 0);
    assert.equal(gh.posted.length, 1);
  });

  it('could not run: no mode, no token and a refused API call each exit 2', async () => {
    const root = repo();
    git(root, 'checkout', '-qb', 'pr');
    const head = commit(root, 'change', { 'src/a.js': 'a\nb\n' });
    git(root, 'checkout', '-q', 'main');
    const gh = github({ pr: prOf(root, head) });
    assert.equal((await evidence(root, gh, { GITHUB_TOKEN: '' })).code, 2);
    assert.equal((await evidence(root, gh, { PR_NUMBER: '8' })).code, 2);
    const bare = mkdtempSync(join(tmpdir(), 'evidence-'));
    dirs.push(bare);
    assert.equal((await evidence(bare, gh)).code, 2);
  });

  it('is a command of the CLI', async () => {
    const result = await main(['pr-evidence'], { root: repo() });
    assert.equal(result.code, 2);
    assert.match(result.summary, /GITHUB_TOKEN/);
  });
});
