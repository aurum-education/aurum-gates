// `flake-record` (DS-059 §4.4 G3, step 6.156 slice 1): finds the tests that failed in one attempt of a run and passed in
// a later attempt of the same sha, from JUnit reports. Output is IDs only: repo, sha, run link, test id (class > name).
// Never a failure message, log or assertion text (workspace non-negotiable 2). A failed attempt with no failed
// testcase (a worker crash, a runner loss) is recorded once as `kind: "infra"`, so pool churn stays apart from tests.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const unescape = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Test ids of a JUnit report: `{ failed, passed }`, each a Set of "classname > name". Messages are never read. */
export function readJunit(xml) {
  const failed = new Set();
  const passed = new Set();
  for (const m of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attr = (n) => unescape(new RegExp(`\\b${n}="([^"]*)"`).exec(m[1])?.[1] ?? '');
    const id = `${attr('classname')} > ${attr('name')}`;
    const body = m[3] ?? '';
    if (/<(failure|error)\b/.test(body)) failed.add(id);
    else if (!/<skipped\b/.test(body)) passed.add(id);
  }
  return { failed, passed };
}

/** Every `junit*.xml` under a directory (not recursive), merged. A missing directory is an attempt with no report. */
export function readDir(dir) {
  const out = { failed: new Set(), passed: new Set(), files: 0 };
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return out;
  for (const f of readdirSync(dir).filter((n) => /^junit.*\.xml$/.test(n))) {
    const { failed, passed } = readJunit(readFileSync(join(dir, f), 'utf8'));
    failed.forEach((t) => out.failed.add(t));
    passed.forEach((t) => out.passed.add(t));
    out.files += 1;
  }
  return out;
}

/**
 * Flake records for one rerun: tests failed in `first` and passed in `last`. A test that failed in both is a real
 * failure, not a flake. If `first` shows no failed test, one `infra` record says the attempt failed without one.
 */
export function flakeRecords({ repo, sha, run, first, last }) {
  const base = { repo, sha, run };
  const flaky = [...first.failed].filter((t) => last.passed.has(t) && !last.failed.has(t)).sort();
  if (flaky.length) return flaky.map((test) => ({ ...base, kind: 'test', test }));
  return first.failed.size ? [] : [{ ...base, kind: 'infra' }];
}
