// `aurum-gates tighten <gate>`: rewrites a count baseline downward only (DS-059 §4.1). It never writes a higher number
// and never adds a key, so it cannot hide a finding; a rise is the author's to fix or to allow with `baseline-raise:`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson } from './gate.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The baseline with every count lowered to what was found; a count that reaches 0 is dropped, and so is an emptied
 * `where`. `found` and `baseline` are `{ where: { rule: count } }`. Throws when `found` is above the baseline or has a
 * key the baseline lacks: that is a finding to fix, not a baseline to write.
 */
export function tightened({ baseline, found, file }) {
  const out = {};
  const wheres = new Set([...Object.keys(baseline), ...Object.keys(found)]);
  for (const where of [...wheres].sort()) {
    const was = baseline[where] ?? {};
    const now = found[where] ?? {};
    if (!isObject(was) || !isObject(now)) throw new Error(`${file}: "${where}" must be an object of { rule: count }`);
    for (const rule of Object.keys(now)) {
      if (!Object.hasOwn(was, rule) && now[rule] > 0)
        throw new Error(
          `${where} ${rule} has ${now[rule]} finding(s) the baseline lacks: fix them, do not record them`,
        );
      if (now[rule] > was[rule])
        throw new Error(`${where} ${rule} is ${now[rule]}, above the baseline ${was[rule]}: fix the finding`);
    }
    for (const rule of Object.keys(was).sort()) {
      const n = Math.min(was[rule], now[rule] ?? 0);
      if (n > 0) (out[where] ??= {})[rule] = n;
    }
  }
  return out;
}

/** Rewrites `baselineFile` under root with the tightened counts; returns whether the file changed. */
export function tighten({ root, baselineFile, found }) {
  const baseline = readJson(root, baselineFile);
  const next = tightened({ baseline, found, file: baselineFile });
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (text === `${JSON.stringify(baseline, null, 2)}\n`) return false;
  writeFileSync(join(root, baselineFile), text);
  return true;
}

/**
 * Writes `baselineFile` from today's findings, only when the file does not exist: the one way a baseline starts. A file
 * that exists is never rewritten here (it only moves down, by `tighten`). Returns whether it wrote.
 */
export function initBaseline({ root, baselineFile, found }) {
  const path = join(root, baselineFile);
  mkdirSync(dirname(path), { recursive: true });
  const sorted = Object.fromEntries(
    Object.entries(found)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([where, rules]) => [where, Object.fromEntries(Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : 1)))]),
  );
  try {
    writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, { flag: 'wx' }); // wx: never overwrites
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
  return true;
}
