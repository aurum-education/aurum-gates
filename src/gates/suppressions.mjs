// Gate `suppressions`: budgets, as shrink-only counts per file, of what switches checking off: `any`, `@ts-ignore`
// (and `-nocheck`, `-expect-error`) and `eslint-disable`, and of each of those without a reason. A text scan, no
// dependencies: it can count `any` in a comment-free line only, so the baseline records today's reading and only shrinks.
// Test files are left out. Output is file paths, rule names and counts.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'reports']);
// Build output folders are skipped at the repo root only: `src/build/` is source.
const ROOT_SKIP_DIRS = new Set(['build', '.next', 'out']);
const SOURCE = /\.[cm]?[jt]sx?$/;
const TEST =
  /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:e2e|test|tests|__tests__|fixtures)\/|(?:^|\/)(?:testing|[^/]*-testing)\.[cm]?[jt]sx?$/;
const MIN_REASON = 10;

const REASON_FIX =
  'add ` -- <reason>` (at least 10 characters) after the directive, saying why the check is wrong here.';
export const SUPPRESSION_RULES = {
  'explicit-any': {
    why: 'any turns the type checker off for everything it touches. DS-013.',
    fix: 'use unknown and narrow it, or write the type.',
  },
  'ts-suppression': {
    why: 'a TypeScript suppression hides an error the compiler found. DS-013.',
    fix: 'fix the type; while one stays it needs a reason.',
  },
  'ts-suppression-no-reason': {
    why: 'a suppression with no reason cannot be reviewed or removed later. DS-059 §4.1.',
    fix: REASON_FIX,
  },
  'eslint-disable': {
    why: 'a disabled lint rule hides what it was written to catch. DS-059 §4.1.',
    fix: 'fix the finding.',
  },
  'eslint-disable-no-reason': {
    why: 'a disable with no reason cannot be reviewed or removed later. DS-059 §4.1.',
    fix: REASON_FIX,
  },
};

const ANY = /(?::\s*|=>?\s*|\bas\s+|\bkeyof\s+|[<,|&]\s*)any\b/g;

const STRING = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;

/** The counts of one file's text, `{ rule: count }`. Strings are blanked first, so a comma in copy is not a type. */
export function scanText(text) {
  const n = {};
  const add = (rule, by = 1) => (n[rule] = (n[rule] ?? 0) + by);
  let inBlock = false; // inside a /* ... */ comment that began on an earlier line
  for (const raw of text.split('\n')) {
    let line = raw.replace(STRING, '""');
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue; // all comment: no directive starts here, and no type is written in it
      line = ' '.repeat(end + 2) + line.slice(end + 2);
      inBlock = false;
    }
    const comment = /\/\/|\/\*/.exec(line);
    const code = comment ? line.slice(0, comment.index) : line;
    const note = comment ? line.slice(comment.index) : '';
    if (comment?.[0] === '/*' && !note.includes('*/')) inBlock = true;
    // A directive starts its comment: prose that mentions one is not a directive.
    const ts = /^(?:\/\/\/?|\/\*+)\s*@ts-(?:ignore|nocheck|expect-error)\b(.*)/.exec(note);
    if (ts) {
      add('ts-suppression');
      if (
        ts[1]
          .replace(/^\s*[:-]*\s*/, '')
          .replace(/\*\/.*$/, '')
          .trim().length < MIN_REASON
      )
        add('ts-suppression-no-reason');
    }
    const es = /^(?:\/\/|\/\*+)\s*eslint-disable(?:-next-line|-line)?\b(.*)/.exec(note);
    if (es) {
      add('eslint-disable');
      const reason = es[1].includes('--')
        ? es[1]
            .slice(es[1].indexOf('--') + 2)
            .replace(/\*\/.*$/, '')
            .trim()
        : '';
      if (reason.length < MIN_REASON) add('eslint-disable-no-reason');
    }
    const anys = code.match(ANY);
    if (anys) add('explicit-any', anys.length);
  }
  return n;
}

function* walk(root, dir = '') {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !(dir === '' && ROOT_SKIP_DIRS.has(entry.name))) yield* walk(root, path);
    } else if (SOURCE.test(entry.name) && !TEST.test(path) && !entry.name.endsWith('.d.ts')) yield path;
  }
}

export function find({ root }) {
  const found = {};
  for (const file of walk(root)) {
    const counts = scanText(readFileSync(join(root, file), 'utf8'));
    if (Object.keys(counts).length) found[file] = counts;
  }
  return found;
}

export const suppressions = { rules: SUPPRESSION_RULES, baseline: 'quality/baselines/suppressions.json', find };
