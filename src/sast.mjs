// The `sast` gate (DS-059 §4.1): Semgrep OSS with Aurum's own rules (sast/rules/aurum.yml) over a repo's
// source, counted per file and rule against quality/baselines/sast.json like every other gate. Severity ERROR blocks in
// `ratchet` and `enforce`; WARNING is counted and shown but never blocks (a rule's `reportOnly`). Semgrep is the
// consumer's tool, installed by the workflow (pip, a pinned version); this module only runs it and reads its JSON.
// `sast-issues` files one issue per ERROR fingerprint from the nightly full scan. Output is rule IDs, file paths, line
// numbers and counts: never the matched code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES_DIR = join(import.meta.dirname, '..', 'sast', 'rules');
/** Not product code: tests, fixtures, generated and vendored files. `.semgrepignore` adds the repo's own. */
export const EXCLUDES = [
  'node_modules',
  'dist',
  'coverage',
  'reports',
  'test',
  'tests',
  'e2e',
  '__tests__',
  'fixtures',
  '*.test.*',
  '*.spec.*',
];
/** The most issues one nightly run opens, so a first night cannot flood the tracker; the rest wait for the next run. */
export const MAX_NEW_ISSUES = 25;

/** Runs semgrep over `root` and returns its parsed JSON. A missing semgrep or a failed run is a broken gate. */
export function semgrepJson(root, { rulesDir = RULES_DIR, spawn = spawnSync } = {}) {
  const args = ['scan', '--config', rulesDir, '--json', '--quiet', '--metrics=off', '--disable-version-check'];
  for (const e of EXCLUDES) args.push('--exclude', e);
  const out = spawn('semgrep', [...args, '.'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (out.error) throw new Error(`semgrep could not start (${out.error.code ?? out.error.message}); install it first`);
  let json;
  try {
    json = JSON.parse(out.stdout);
  } catch {
    throw new Error(`semgrep exited ${out.status} without JSON output`);
  }
  const fatal = (json.errors ?? []).filter((e) => e.level === 'error');
  if (fatal.length)
    throw new Error(`semgrep reported ${fatal.length} error(s), such as ${fatal[0].type}: the scan is incomplete`);
  return json;
}

/** One finding per result: `{ rule, path, line, severity, message, cwe, fix, fingerprint }`. */
export function findingsOf(json, { root }) {
  return (json.results ?? []).map((r) => {
    // Semgrep prefixes the id with the rule directory's path; the id itself is `aurum.<name>`.
    const rule = /aurum\.[a-z0-9-]+$/.exec(r.check_id)?.[0] ?? r.check_id;
    const path = r.path.replace(/^\.\//, '');
    let line = '';
    try {
      line = readFileSync(join(root, path), 'utf8').split('\n')[r.start.line - 1] ?? '';
    } catch {
      // the file is gone: the fingerprint then rests on the rule and path alone
    }
    const fingerprint = createHash('sha256')
      .update(`${rule}\0${path}\0${line.trim().replace(/\s+/g, ' ')}`)
      .digest('hex')
      .slice(0, 12);
    const m = r.extra?.metadata ?? {};
    return {
      rule,
      path,
      line: r.start.line,
      severity: r.extra?.severity ?? 'WARNING',
      message: r.extra?.message ?? '',
      cwe: m.cwe,
      fix: m.fix,
      fingerprint,
    };
  });
}

/** `{ path: { rule: count } }`, the shape every baseline has. */
export function countsOf(findings) {
  const out = {};
  for (const f of findings) {
    out[f.path] ??= {};
    out[f.path][f.rule] = (out[f.path][f.rule] ?? 0) + 1;
  }
  return out;
}

export const scan = (root, options) => findingsOf(semgrepJson(root, options), { root });

/** The gate's rule table, filled by `find` from what the scan reports: unknown rules cannot happen, they are in the scan. */
export const rules = {};

/** The gate; tests pass their own `options` (a fake semgrep). */
export const makeGate = (options) => ({
  rules,
  baseline: 'quality/baselines/sast.json',
  find({ root }) {
    const findings = scan(root, options);
    for (const f of findings)
      rules[f.rule] = {
        why: `${f.message} ${f.cwe ?? ''}`.trim(),
        fix: f.fix ?? 'fix the finding',
        allow: `\`// nosemgrep: ${f.rule} -- <reason>\` on the line above; the reviewer reads the reason`,
        reportOnly: f.severity !== 'ERROR',
      };
    return countsOf(findings);
  },
});
export const gate = makeGate();

/** The issues the nightly run should open: one per ERROR fingerprint, the first MAX_NEW_ISSUES not yet filed. */
export function fileIssues({
  findings,
  repo,
  runUrl = '',
  gh = (args) => spawnSync('gh', args, { encoding: 'utf8' }),
}) {
  const seen = new Set();
  const lines = [];
  let opened = 0;
  for (const f of findings.filter((x) => x.severity === 'ERROR')) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    const title = `SAST ${f.rule} in ${f.path} [${f.fingerprint}]`;
    // Any state: a closed issue is a triage decision, and the same fingerprint is not filed again.
    const found = gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--search',
      `"[${f.fingerprint}]" in:title`,
      '--json',
      'number',
    ]);
    if (found.status !== 0) throw new Error(`gh issue list failed for ${f.fingerprint}`);
    if (JSON.parse(found.stdout || '[]').length) continue;
    if (opened >= MAX_NEW_ISSUES) {
      lines.push(`deferred ${f.fingerprint}`);
      continue;
    }
    const body = [
      `Semgrep rule \`${f.rule}\` (${f.severity}) at \`${f.path}:${f.line}\`. ${f.message}`,
      f.fix ? `Fix: ${f.fix}.` : '',
      `Triage: fix it, or allow it with \`// nosemgrep: ${f.rule} -- <reason>\` on the line above. Close this issue when done; a closed issue is never filed again.`,
      `Fingerprint: ${f.fingerprint}${runUrl ? ` · ${runUrl}` : ''}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    const made = gh(['issue', 'create', '--repo', repo, '--title', title, '--body', body]);
    if (made.status !== 0) throw new Error(`gh issue create failed for ${f.fingerprint}`);
    opened += 1;
    lines.push(`opened ${f.fingerprint} ${f.rule} ${f.path}`);
  }
  return lines;
}
