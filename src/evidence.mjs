// The `pr-evidence` check (DS-059 §4.8, step 6.153): every PR shows its attribution, `type:`, `step:`, regression-test
// line and review markers, as a commit status on the PR's head SHA. It reads the PR and the repository as data and never
// runs PR code; the workflow that calls it runs from the base branch's copy.
//   aurum-gates pr-evidence [--all]
//   PR_NUMBER (the one PR), --all (every open PR: the rollout run before a ruleset requires the status),
//   GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID / GITHUB_SERVER_URL (the status's link).
// The mode is `pr-evidence` in quality/gates.json of the checked-out base: `report` posts a green status whose
// description lists what is missing; `ratchet` and `enforce` post a red one. The job itself fails only when the check
// could not run (exit 2). No PR comment is written: the status description and the job summary carry the findings.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXIT_BROKEN, message, modeOf } from './gate.mjs';

export const GATE = 'pr-evidence';
export const TYPES = ['fix', 'feature', 'refactor', 'docs', 'chore', 'log'];
const REVIEWERS = ['OWNER', 'MEMBER']; // author_association of a marker's comment (every thread acts as the owner's account)
const MARKER = /^(independent-review|design-review): (pass|fail) ([0-9a-f]{40})(?:\s+(.*))?$/;
const ATTRIBUTION =
  /^<!-- claude-projects-attribution: \{.*\} -->\r?\n_Requested by \*\*.+\*\* · \[project thread\]\(.+\)_/;
const LOG_PATHS = /^(?:vault\/50-Implementation\/|vault\/00-Meta\/Changelog\.md$)/;
const SPEC_PATH = /^vault\/40-Design\/(DS-\d+)[^/]*\.md$/;
const SPEC_LINES = 40; // DS-059 §4.8: "more than 40 changed lines" (or a status change) makes a spec change substantial
const PAGES = 10;
const ATTEMPTS = 3;

export const RULES = {
  attribution: {
    why: 'a PR body starts with the two attribution lines of the project rule. DS-059 §4.8.',
    fix: 'restore the two lines at the top of the PR body.',
    allow: '`evidence-exempt: <reason>` in the body, for a hand-made owner PR; the job summary lists it.',
  },
  type: {
    why: 'every PR names its type. DS-059 §4.3 and §4.8.',
    fix: `add a line \`type: ${TYPES.join(' | ')}\` with one value.`,
  },
  step: {
    why: 'every PR but a log links its step. DS-059 §4.8.',
    fix: 'add a line `step: <id>` (for example `step: 6.153`).',
  },
  'regression-test': {
    why: 'a fix names the test it adds or changes, first. DS-059 §4.3.',
    fix: 'add `regression-test: <path>::<test name>` with a test file this PR changes.',
    allow: '`regression-test: none — <reason>` when there is no runnable test; the reviewer accepts the reason.',
  },
  'review-missing': {
    why: 'a change is reviewed by a thread that did not write it. DS-059 §4.8.',
    fix: 'have the reviewer post `independent-review: pass <full head sha>` as the first line of a PR comment.',
    allow: '`type: log` with a diff only under vault/50-Implementation/ and the Changelog.',
  },
  'review-failed': {
    why: 'the latest review of this code said fail. DS-059 §4.8.',
    fix: 'fix the findings and have the reviewer post a pass marker.',
  },
  'design-review-missing': {
    why: 'a change a person sees gets a design review too. DS-059 §4.8, project design review rule.',
    fix: 'have the design reviewer post `design-review: pass <full head sha>`.',
  },
  'design-review-failed': {
    why: 'the latest design review of this code said fail. DS-059 §4.8.',
    fix: 'fix the findings and have the reviewer post a pass marker.',
  },
  'spec-review-missing': {
    why: 'a spec added or substantially rewritten is reviewed, and the marker names it. DS-059 §4.8, spec review rule.',
    fix: 'have the reviewer put the spec ID after the SHA: `independent-review: pass <sha> DS-NNN`.',
  },
};

const line = (body, re) => new RegExp(re, 'm').exec(body);

/** Patterns like `apps/*\/src/**\/*.{tsx,css}` as a RegExp: `**` any depth, `*` within a folder, `{a,b}` a choice. */
export function globToRegExp(glob) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '{') {
      depth++;
      out += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      out += ')';
    } else if (c === ',' && depth) out += '|';
    else out += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Markers of PR comments, oldest first: `{ kind, verdict, sha, rest }` from a comment's first line, reviewers' only. */
export function markersOf(comments) {
  return comments
    .filter((c) => REVIEWERS.includes(c.author_association))
    .flatMap((c) => {
      const m = MARKER.exec((c.body ?? '').split('\n', 1)[0].trim());
      return m ? [{ kind: m[1], verdict: m[2], sha: m[3], rest: m[4] ?? '' }] : [];
    });
}

/**
 * The findings for one PR. Inputs are data only: `body`, `bot` (a bot author), `files` (changed paths), `specs`
 * (`[{ id, substantial }]` of changed specs), `markers`, `patchIdOf(sha)` (undefined for a SHA this repository lacks),
 * `headPatchId`, `visible(file)`. Returns `{ findings: [{ rule, where, detail }], notes: [string], exempt? }`.
 */
export function evaluate({ body = '', bot = false, files, specs = [], markers, patchIdOf, headPatchId, visible }) {
  const exempt = line(body, '^evidence-exempt: (\\S.*)$');
  if (bot) return { findings: [], notes: [], exempt: 'bot author' };
  if (exempt) return { findings: [], notes: [], exempt: exempt[1] };
  const findings = [];
  const add = (rule, detail) => findings.push({ rule, where: 'PR', detail });
  const notes = [];

  if (!ATTRIBUTION.test(body)) add('attribution', 'The body does not start with the two attribution lines');
  const type = line(body, '^type: (\\S+)\\s*$')?.[1];
  if (!TYPES.includes(type)) add('type', type ? `"${type}" is not one of ${TYPES.join(', ')}` : 'No `type:` line');
  if (type !== 'log' && !line(body, '^step: (?!X\\.Y\\b)\\S')) add('step', 'No `step:` line');
  if (type === 'fix') {
    const test = line(body, '^regression-test: (.+)$')?.[1].trim();
    const none = /^none — \S/.test(test ?? '');
    const path = test?.split('::')[0].trim();
    if (none) notes.push(`regression-test: ${test}`);
    else if (!test || !files.includes(path))
      add('regression-test', test ? `"${path}" is not a file this PR changes` : 'No `regression-test:` line');
  }

  const logOnly = type === 'log' && files.every((f) => LOG_PATHS.test(f));
  const needsDesign = files.some(visible);
  const decide = (kind) => [...markers].reverse().find((m) => m.kind === kind && patchIdOf(m.sha) === headPatchId);
  if (!logOnly) {
    const review = decide('independent-review');
    if (!review) add('review-missing', 'No pass marker for this code (a marker for other code does not count)');
    else if (review.verdict === 'fail') add('review-failed', `The latest review is fail for ${review.sha.slice(0, 7)}`);
    else
      for (const spec of specs.filter((s) => s.substantial))
        if (!review.rest.includes(spec.id)) add('spec-review-missing', `The marker does not name ${spec.id}`);
    if (needsDesign) {
      const design = decide('design-review');
      if (!design) add('design-review-missing', 'This change touches a path a person sees');
      else if (design.verdict === 'fail') add('design-review-failed', `The latest design review is fail`);
    }
  }
  return { findings, notes };
}

/** The status a result makes: green in `report` (the description lists what is missing), red otherwise. */
export function statusOf({ findings, notes, exempt }, mode) {
  const rules = [...new Set(findings.map((f) => f.rule))];
  const say = (s) => s.slice(0, 140);
  if (exempt) return { state: 'success', description: say(`ok: exempt (${exempt})`) };
  if (!rules.length) return { state: 'success', description: say(notes.length ? `ok: ${notes.join('; ')}` : 'ok') };
  if (mode === 'report')
    return { state: 'success', description: say(`report (not failing): missing ${rules.join(', ')}`) };
  return { state: 'failure', description: say(`missing ${rules.join(', ')}`) };
}

// ----- git and GitHub, the parts that read -----

function git(root, args, input) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() };
}
const gitOrThrow = (root, args, input) => {
  const r = git(root, args, input);
  if (!r.ok) throw new Error(`git ${args[0]} failed: ${r.err}`);
  return r.out;
};

/** Makes a commit present locally when it can be fetched; says whether it is. */
function have(root, sha, fetch = true) {
  if (git(root, ['cat-file', '-e', `${sha}^{commit}`]).ok) return true;
  if (fetch) git(root, ['fetch', '--no-tags', '--filter=blob:none', '-q', 'origin', sha]);
  return git(root, ['cat-file', '-e', `${sha}^{commit}`]).ok;
}

/** `git patch-id --stable` of the PR's own diff without Markdown files; '' for a diff with no code in it. */
export function patchId(root, baseSha, sha) {
  const mb = gitOrThrow(root, ['merge-base', baseSha, sha]).trim();
  const diff = gitOrThrow(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-renames',
    mb,
    sha,
    '--',
    '.',
    ':(exclude,glob)**/*.md',
  ]);
  return diff ? gitOrThrow(root, ['patch-id', '--stable'], diff).split(/\s/)[0] : '';
}

function changedFiles(root, baseSha, sha) {
  const mb = gitOrThrow(root, ['merge-base', baseSha, sha]).trim();
  const out = gitOrThrow(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', mb, sha]);
  const rows = out
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  const files = rows.map((r) => r[2]);
  const specs = rows.flatMap(([added, removed, file]) => {
    const id = SPEC_PATH.exec(file)?.[1];
    if (!id) return [];
    const isNew = !git(root, ['cat-file', '-e', `${mb}:${file}`]).ok;
    const status = gitOrThrow(root, ['diff', '-U0', mb, sha, '--', file])
      .split('\n')
      .some((l) => /^[+-]status:/.test(l));
    return [{ id, substantial: isNew || status || Number(added) + Number(removed) > SPEC_LINES }];
  });
  return { files, specs };
}

function makeApi({ token, repo, fetch, sleep }) {
  return async (path, init = {}) => {
    let last;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', ...init.headers },
          signal: AbortSignal.timeout(20_000),
        });
        if (res.status < 500) {
          if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status}`);
          return res.status === 201 || res.status === 204 ? undefined : res.json();
        }
        last = new Error(`${init.method ?? 'GET'} ${path.split('?')[0]}: HTTP ${res.status}`);
      } catch (error) {
        if (error.message.includes('HTTP 4')) throw error; // a real refusal is never retried
        last = error;
      }
      if (attempt < ATTEMPTS) await sleep(2000 * attempt);
    }
    throw last;
  };
}

const pages = async (api, path) => {
  const out = [];
  for (let page = 1; page <= PAGES; page++) {
    const rows = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
};

/** Evaluates one PR (an object of GitHub's pulls API) and posts its status. Returns the line for the summary. */
async function check({ root, api, pr, mode, visible, targetUrl }) {
  const { number, head, base } = pr;
  git(root, ['fetch', '--no-tags', '--filter=blob:none', '-q', 'origin', `refs/pull/${number}/head`]);
  if (!have(root, head.sha) || !have(root, base.sha))
    throw new Error(`#${number}: the head or base commit is not in the checkout`);
  const { files, specs } = changedFiles(root, base.sha, head.sha);
  const markers = markersOf(await pages(api, `/issues/${number}/comments`));
  const cache = new Map();
  const patchIdOf = (sha) => {
    if (!cache.has(sha)) cache.set(sha, have(root, sha) ? patchId(root, base.sha, sha) : undefined);
    return cache.get(sha);
  };
  const result = evaluate({
    body: pr.body ?? '',
    bot: pr.user?.type === 'Bot',
    files,
    specs,
    markers,
    patchIdOf,
    headPatchId: patchId(root, base.sha, head.sha),
    visible,
  });
  const status = statusOf(result, mode);
  await api(`/statuses/${head.sha}`, {
    method: 'POST',
    body: JSON.stringify({ ...status, context: GATE, target_url: targetUrl }),
  });
  const blocks = result.findings.map((f) =>
    message({ gate: GATE, mode, where: `#${number}`, ...RULES[f.rule], rule: f.rule, detail: f.detail }),
  );
  const extra = [...result.notes.map((n) => `  note: ${n}`), ...(result.exempt ? [`  exempt: ${result.exempt}`] : [])];
  return {
    text: [`#${number} ${head.sha.slice(0, 7)}: ${status.state} (${status.description})`, ...blocks, ...extra].join(
      '\n',
    ),
    failing: status.state === 'failure',
  };
}

/** The command. `env`, `fetch` and `sleep` are injected so tests run with no network and no waiting. */
export async function run(
  root,
  argv,
  { env = process.env, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  try {
    const {
      GITHUB_TOKEN: token,
      GITHUB_REPOSITORY: repo,
      PR_NUMBER: number,
      GITHUB_RUN_ID: run,
      GITHUB_SERVER_URL: server,
    } = env;
    if (!token || !repo) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    const all = argv.includes('--all');
    if (!all && !number) throw new Error('PR_NUMBER or --all is required');
    const mode = modeOf(root, GATE);
    const visibleFile = join(root, 'quality/visible-paths.json');
    const globs = existsSync(visibleFile) ? JSON.parse(readFileSync(visibleFile, 'utf8')) : [];
    if (!Array.isArray(globs)) throw new Error('quality/visible-paths.json must be a list of globs');
    const regs = globs.map(globToRegExp);
    const visible = (file) => regs.some((r) => r.test(file));
    const api = makeApi({ token, repo, fetch, sleep });
    const targetUrl = run ? `${server ?? 'https://github.com'}/${repo}/actions/runs/${run}` : undefined;
    const prs = all ? await pages(api, '/pulls?state=open') : [await api(`/pulls/${number}`)];
    const lines = [];
    for (const pr of prs.filter((p) => p.state === 'open'))
      lines.push(await check({ root, api, pr, mode, visible, targetUrl }));
    const text = lines.map((l) => l.text).join('\n') || 'no open PR to check';
    const summary = `GATE ${GATE}: ${lines.length} PR(s) checked in ${mode} mode, ${lines.filter((l) => l.failing).length} failing status(es).`;
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n${summary}\n`);
    return { code: 0, summary, text: `${text}\n${summary}` };
  } catch (error) {
    const summary = `GATE ${GATE} ✗ could not run: ${error.message}.`;
    return {
      code: EXIT_BROKEN,
      summary,
      text: `${summary}\n  A gate that cannot run fails in every mode (DS-059 §4.1 rollout rule 5).`,
    };
  }
}
