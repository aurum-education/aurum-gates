// No-skip gate (REQ-TST-009, DS-013 §4.2.2).
// 1. Every JUnit report under reports/ must contain zero skipped or todo tests (catches conditional skips).
// 2. No test source may use .skip/.only/.todo/.fixme/.fail or x-prefixed tests, unless the line carries
//    `// exception: ADR-NNNN` and test-exceptions.json has a matching, unexpired entry.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const MARKER =
  /\b(?:it|test|describe|suite|bench)\s*\.\s*(?:skip|only|todo|fixme|fail|skipIf|runIf)\b|\b(?:xit|xtest|xdescribe)\s*\(/;
const EXCEPTION = /\/\/\s*exception:\s*(ADR-\d{4})/;
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(path);
  }
  return files;
}

export function skippedInJunit(xml) {
  return (xml.match(/<skipped\b/g) ?? []).length;
}

export function sourceViolations(file, text, exceptions, today) {
  return text.split('\n').flatMap((line, i) => {
    if (!MARKER.test(line)) return [];
    const adr = line.match(EXCEPTION)?.[1];
    const ok = adr && exceptions.some((e) => e.file === file && e.adr === adr && e.expires >= today);
    return ok ? [] : [`${file}:${i + 1}: ${line.trim()}`];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const files = walk(root).map((f) => relative(root, f));
  const problems = [];

  const junit = files.filter((f) => /(^|\/)reports\/junit.*\.xml$/.test(f));
  if (!junit.length) problems.push('No JUnit report found under reports/ — run `pnpm test` first.');
  for (const f of junit) {
    const n = skippedInJunit(readFileSync(f, 'utf8'));
    if (n) problems.push(`${f}: ${n} skipped or todo test(s)`);
  }

  const exceptions = existsSync('test-exceptions.json') ? JSON.parse(readFileSync('test-exceptions.json', 'utf8')) : [];
  const today = new Date().toISOString().slice(0, 10);
  for (const f of files.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f))) {
    problems.push(...sourceViolations(f, readFileSync(f, 'utf8'), exceptions, today));
  }

  if (problems.length) {
    console.error(`No-skip policy (REQ-TST-009) violated:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`No-skip policy (REQ-TST-009): ${junit.length} report(s) with 0 skipped, no skip markers.`);
}
