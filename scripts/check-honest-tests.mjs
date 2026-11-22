// Honest-tests gate (workspace non-negotiable 9, DS-013 §4.2.2, step 6.142). Same file in every repo.
// Fails on the greppable ways a test bends around product behaviour, in test and e2e sources:
//   1. waitForTimeout outside e2e/perf.
//   2. A real-time wait: any setTimeout( call, or setTimeout from node:timers/promises (use a fake clock).
//   3. A force: true interaction (not the force flag of rm and rmSync).
//   4. An outcome-set assertion (expect([a, b]).toContain(x), expect([a, b].includes(x)), expect(x === a || x === b))
//      without `// spec: <ID> §<n>` on the line above. The ID is DS-NNN, REQ-AREA-NNN or ADR-NNNN.
//      The same holds for an open-ended status check: expect(res.status).toBeGreaterThanOrEqual(500).
// `// spec:` is the only allowance, and only for rule 4: the spec names no free-text escape for the others.
// `--report` prints the hits and exits 0: for a repo whose fix step has not merged yet.
import { appendFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'reports']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:e2e|test|tests|__tests__)\/.*\.[cm]?[jt]sx?$/;
const SPEC = /\/\/\s*spec:\s*(?:DS-\d{3}|REQ-[A-Z]+-\d{3}|ADR-\d{4})\b[^\n]*§\s*\d/;
const REMOVAL = /\b(?:rmSync|rm|rmdir|unlinkSync)\s*\([^;]*$/;
const NOT_EXPECT = '(?:(?!expect\\()[\\s\\S])';

const RULES = [
  {
    name: 'waitForTimeout outside e2e/perf',
    re: /\bwaitForTimeout\s*\(/g,
    skip: (file) => /(?:^|\/)e2e\/perf\//.test(file),
  },
  {
    name: 'real-time wait',
    re: /\bsetTimeout\s*\(|from\s+['"](?:node:)?timers\/promises['"]/g,
  },
  { name: 'forced interaction', re: /\bforce\s*:\s*true\b/g, ignoreBefore: REMOVAL },
  {
    name: 'outcome-set assertion without a spec comment',
    re: new RegExp(
      `\\bexpect\\(\\s*\\[${NOT_EXPECT}{0,200}?\\]\\s*(?:,${NOT_EXPECT}{0,120}?)?\\)\\s*\\.toContain\\(|\\bexpect\\(\\s*\\[[^()]{0,200}?\\]\\s*\\.includes\\([^()]*\\)\\s*\\)\\s*\\.toBe\\(true\\)|\\bexpect\\((?:(?!=>)[^;]){0,100}(?:===|==)(?:(?!=>)[^;]){0,100}\\|\\|(?:(?!=>)[^;]){0,100}\\)\\s*\\.toBe\\(true\\)`,
      'g',
    ),
    spec: true,
  },
  {
    name: 'open-ended status assertion without a spec comment',
    re: /\bexpect\([^;\n]*\bstatus\b[^;\n]*\)\s*\.(?:toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual)\(\s*[2-5]\d\d\s*\)|\bexpect\([^;\n]*\bstatus\s*[<>]=?\s*[2-5]\d\d[^;\n]*\)\s*\.toBe\(true\)/g,
    spec: true,
  },
];

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

// Returns the hits ('file:line: rule') of one file.
export function scan(file, text) {
  const lines = text.split('\n');
  const hits = [];
  for (const rule of RULES) {
    if (rule.skip?.(file)) continue;
    for (const m of text.matchAll(rule.re)) {
      if (rule.ignoreBefore?.test(text.slice(Math.max(0, m.index - 160), m.index))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      const above = lines[line - 2] ?? '';
      if (rule.spec && SPEC.test(above)) continue;
      hits.push(`${file}:${line}: ${rule.name}`);
    }
  }
  return hits;
}

// Scans the test files under root; the CLI wraps it.
export function check(root) {
  const files = walk(root)
    .map((f) => relative(root, f).split('\\').join('/'))
    .filter((f) => TEST_FILE.test(f));
  const hits = files.flatMap((f) => scan(f, readFileSync(join(root, f), 'utf8')));
  if (!files.length) hits.push('no test file was found: the check would pass without checking anything');
  const summary = `Honest tests (non-negotiable 9): ${files.length} file(s) scanned, ${hits.length} hit(s).`;
  return { files: files.length, hits, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const report = process.argv.includes('--report');
  const { hits, summary } = check(process.cwd());
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}${report ? ' (report only)' : ''}\n`);
  if (hits.length) {
    console.error(
      `${report ? 'Report only, not failing. ' : ''}Tests must tell the truth (DS-013 §4.2.2):\n  ${hits.join('\n  ')}`,
    );
    if (!report) process.exit(1);
  }
}
