// `flake-hunt` (DS-059 §4.4 G3, step 6.156 slice 2): reads a repo's recent PR runs from the GitHub API, finds the runs
// that failed and then passed on rerun of the same sha, compares attempt 1's JUnit reports with the passing attempt's
// (`flake-record`'s rules), and opens one `flaky` issue per flaky test. IDs only: repo, test id, sha, run link. Never
// a failure message or log (workspace non-negotiable 2). It never comments on an issue or a PR (owner rule 2026-11-22):
// an open issue with the same title is the dedupe, and a repeat flake adds nothing. Infra-only reruns (a crash or a
// lost runner with no failed testcase) are counted, not filed.
import { inflateRawSync } from 'node:zlib';
import { flakeRecords, readJunit } from './flakes.mjs';

export const LABEL = 'flaky';
/** The only fields an issue body carries (a test asserts it). */
export const BODY_FIELDS = ['repo', 'test', 'sha', 'run'];
const TITLE_MAX = 200;

export const title = (test) => `flaky: ${test}`.slice(0, TITLE_MAX);
export const body = (r) => BODY_FIELDS.map((k) => `${k}: ${r[k]}`).join('\n');

/** The JUnit files of a zip (any depth, `junit*.xml`), as text. Stored and deflated entries only, as GitHub writes them. */
export function junitFromZip(zip) {
  const out = [];
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) return out;
  let at = zip.readUInt32LE(end + 16);
  for (let n = zip.readUInt16LE(end + 10); n > 0; n -= 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const [nameLen, extraLen, commentLen] = [28, 30, 32].map((o) => zip.readUInt16LE(at + o));
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!/(^|\/)junit[^/]*\.xml$/.test(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + size);
    out.push((method === 8 ? inflateRawSync(data, { maxOutputLength: 64 * 1024 * 1024 }) : data).toString('utf8'));
  }
  return out;
}

const merge = (xmls) => {
  const out = { failed: new Set(), passed: new Set(), files: xmls.length };
  for (const x of xmls) {
    const { failed, passed } = readJunit(x);
    failed.forEach((t) => out.failed.add(t));
    passed.forEach((t) => out.passed.add(t));
  }
  return out;
};

/**
 * `gh` is `(path, { method, body, raw }) => json | Buffer`. Returns counts and the issues filed (or, in a dry run,
 * the ones it would file). One summary, no text of any test.
 */
// `created>=since` lists runs created in the window: an older run that was rerun recently is not seen (3 days covers a PR's rerun).
export async function hunt({ gh, repo, workflow = 'pr.yml', since, dryRun = false }) {
  const stats = { runs: 0, reruns: 0, infra: 0, noReport: 0, tests: 0, filed: [], existing: 0 };
  const records = [];
  for (let page = 1; page <= 10; page += 1) {
    const { workflow_runs: runs } = await gh(
      `/repos/${repo}/actions/workflows/${workflow}/runs?status=success&created=%3E%3D${since}&per_page=100&page=${page}`,
    );
    for (const run of runs) {
      stats.runs += 1;
      if (run.run_attempt < 2) continue;
      stats.reruns += 1;
      const { artifacts } = await gh(`/repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`);
      const read = async (name) => {
        const a = artifacts.find((x) => x.name === name && !x.expired);
        return a ? merge(junitFromZip(await gh(`/repos/${repo}/actions/artifacts/${a.id}/zip`, { raw: true }))) : null;
      };
      const [first, last] = [
        await read('test-reports-attempt-1'),
        await read(`test-reports-attempt-${run.run_attempt}`),
      ];
      if (!first?.files || !last?.files) {
        stats.noReport += 1;
        continue;
      }
      const link = `https://github.com/${repo}/actions/runs/${run.id}`;
      for (const r of flakeRecords({ repo, sha: run.head_sha, run: link, first, last }))
        if (r.kind === 'infra') stats.infra += 1;
        else records.push(r);
    }
    if (runs.length < 100) break;
  }
  // Open issues dedupe by title. Closed ones in the window dedupe by title and run, so a flake filed and closed the same
  // day is not filed again for the same run the next night (a new run of it still files a new issue).
  const open = new Set();
  const closed = new Set();
  for (const [state, extra] of [
    ['open', ''],
    ['closed', `&since=${since}T00:00:00Z`],
  ])
    for (let page = 1; ; page += 1) {
      const issues = await gh(`/repos/${repo}/issues?labels=${LABEL}&state=${state}&per_page=100&page=${page}${extra}`);
      for (const i of issues) {
        if (state === 'open') open.add(i.title);
        else closed.add(`${i.title}\n${/^run: (\S+)/m.exec(i.body ?? '')?.[1]}`);
      }
      if (issues.length < 100) break;
    }
  for (const r of records) {
    const t = title(r.test);
    if (open.has(t) || closed.has(`${t}\n${r.run}`)) {
      stats.existing += 1;
      continue;
    }
    open.add(t); // the same test on two runs files once
    if (!dryRun)
      await gh(`/repos/${repo}/issues`, { method: 'POST', body: { title: t, body: body(r), labels: [LABEL] } });
    stats.filed.push(t);
  }
  stats.tests = new Set(records.map((r) => r.test)).size;
  return stats;
}

/** A `gh` over `fetch` for the repo's own token (GITHUB_TOKEN: `actions: read`, `issues: write`). Retries 5xx and 429 twice. */
export function githubApi(token) {
  return async (path, { method = 'GET', body, raw } = {}) => {
    for (let attempt = 1; ; attempt += 1) {
      const res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        body: body && JSON.stringify(body),
      });
      if (res.ok) return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
      if (attempt < 3 && (res.status >= 500 || res.status === 429))
        await new Promise((r) => setTimeout(r, attempt * 2000));
      else throw new Error(`GitHub ${method} ${path.split('?')[0]} answered ${res.status}`);
    }
  };
}
