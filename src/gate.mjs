// Gate mechanics of DS-059 §4.1 (step 6.151): modes in quality/gates.json, shrink-only baselines, one failure message.
// The README says how a gate uses it. (Moved here from aurum-web's scripts/quality, step 6.160.)
//   Counts are compared two-way: a rise fails, and a fall fails with "lower the baseline" (DS-059 invariant 2).
//   Timing ceilings are compared one-way: only a reading above the ceiling fails (DS-060 §4.2 item 3).
//   A broken gate (missing or unreadable file, unknown gate, rule or metric) throws, and runGate turns a throw into a
//   non-zero exit in every mode (DS-059 §4.1 rollout rule 5). Report mode forgives findings only.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** In promotion order: a gate moves right, never left (the baseline guard checks that). */
export const MODES = ['report', 'ratchet', 'enforce'];
export const GATES_FILE = 'quality/gates.json';
/** Exit code of a gate that found something, and of a gate that could not run. */
export const EXIT_FINDINGS = 1;
export const EXIT_BROKEN = 2;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A JSON file under root. A missing or unparseable file is a broken gate, never "no findings". */
export function readJson(root, file) {
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    throw new Error(`${file} is missing or cannot be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

/** The mode of one gate, from quality/gates.json. */
export function modeOf(root, gate) {
  const gates = readJson(root, GATES_FILE);
  if (!isObject(gates) || !Object.hasOwn(gates, gate)) throw new Error(`unknown gate "${gate}": not in ${GATES_FILE}`);
  const mode = gates[gate]?.mode;
  if (!MODES.includes(mode)) throw new Error(`gate "${gate}" has no valid mode in ${GATES_FILE} (${MODES.join(', ')})`);
  return mode;
}

/** Every [where, rule, number] of a `{ where: { rule: number } }` table; `ok` says which numbers the table may hold. */
function entries(table, file, ok) {
  if (!isObject(table)) throw new Error(`${file} must be an object of { where: { rule: number } }`);
  return Object.entries(table).flatMap(([where, rules]) => {
    if (!isObject(rules)) throw new Error(`${file}: "${where}" must be an object of { rule: number }`);
    return Object.entries(rules).map(([rule, n]) => {
      if (!ok(n)) throw new Error(`${file}: "${where}" "${rule}" is not a valid number`);
      return [where, rule, n];
    });
  });
}

const isCount = (n) => Number.isInteger(n) && n >= 0;
const isReading = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Counts against their baseline, both `{ where: { rule: count } }`. Returns one failure per pair that differs:
 * a rise (a new finding) and a fall (the baseline must be lowered in the change that made the progress).
 */
export function compareCounts({ baseline, found, file }) {
  const was = new Map(entries(baseline, file, isCount).map(([w, r, n]) => [JSON.stringify([w, r]), n]));
  const now = new Map(entries(found, 'the findings', isCount).map(([w, r, n]) => [JSON.stringify([w, r]), n]));
  const failures = [];
  for (const key of new Set([...was.keys(), ...now.keys()])) {
    const [where, rule] = JSON.parse(key);
    const b = was.get(key) ?? 0;
    const n = now.get(key) ?? 0;
    if (n > b)
      failures.push({ where, rule, detail: `Baseline ${b}, now ${n} (+${n - b}: this change added a finding)` });
    else if (n < b) failures.push({ where, rule, detail: `Baseline ${b}, now ${n}: lower ${file} to ${n}` });
  }
  return failures;
}

/**
 * The count failures of a gate in its mode. `enforce` allows nothing, so it reads no baseline; `report` and `ratchet`
 * need the file (an empty `{}` is a valid baseline, a missing file is a broken gate).
 */
export function countFailures({ root, mode, baselineFile, found }) {
  const baseline = mode === 'enforce' ? {} : readJson(root, baselineFile);
  return compareCounts({ baseline, found, file: baselineFile });
}

/**
 * Readings against their limits, one-way. `readings` and `ceilings` are `{ where: { metric: number } }`; `budgets` is
 * `{ metric: { budget, unit? } }`. A pair with a ceiling is held to the ceiling, every other pair to the budget. A
 * reading below its limit never fails: a time that falls is not a finding (DS-060 §4.2 item 3).
 */
export function compareCeilings({ ceilings, readings, budgets, file }) {
  const known = (metric, source) => {
    if (!Object.hasOwn(budgets, metric)) throw new Error(`unknown metric "${metric}" in ${source}`);
    return budgets[metric];
  };
  const listed = new Map();
  for (const [where, metric, ceiling] of entries(ceilings, file, isReading)) {
    known(metric, file);
    listed.set(JSON.stringify([where, metric]), ceiling);
  }
  return entries(readings, 'the readings', isReading).flatMap(([where, metric, now]) => {
    const { budget, unit = '' } = known(metric, 'the readings');
    const ceiling = listed.get(JSON.stringify([where, metric]));
    if (now <= (ceiling ?? budget)) return [];
    const detail =
      ceiling === undefined
        ? `Budget ${budget}${unit}, now ${now}${unit}`
        : `Ceiling ${ceiling}${unit} (${file}), now ${now}${unit}; the budget is ${budget}${unit}`;
    return [{ where, rule: metric, detail }];
  });
}

/** The ceiling failures of a gate in its mode. `enforce` holds every pair to the budget and reads no ceilings file. */
export function ceilingFailures({ root, mode, ceilingsFile, readings, budgets }) {
  const ceilings = mode === 'enforce' ? {} : readJson(root, ceilingsFile);
  return compareCeilings({ ceilings, readings, budgets, file: ceilingsFile });
}

/** The one failure message of DS-059 §4.1. */
export function message({ gate, mode, where, rule, why, fix, allow = 'none for this rule.', detail }) {
  return [
    `GATE ${gate} ✗ ${where}  ${rule}`,
    `  Why:   ${why}`,
    `  Fix:   ${fix}`,
    `  Allow: ${allow}`,
    `  Mode:  ${mode}. ${detail}`,
  ].join('\n');
}

/**
 * Runs one gate and returns its exit code and output, without printing or exiting (so tests can read both).
 * `rules` is `{ id: { why, fix, allow? } }`; `check({ root, mode })` returns failures `{ where, rule, detail }`.
 * A failure may carry its own `mode` (the guard reports one path while it enforces the rest) or `allow`.
 * `mode` is given only by a gate that has no entry in quality/gates.json (the baseline guard).
 */
export async function runGate({ gate, root = process.cwd(), rules, mode, check }) {
  try {
    const gateMode = mode ?? modeOf(root, gate);
    const failures = await check({ root, mode: gateMode });
    const blocks = failures.map((f) => {
      if (!Object.hasOwn(rules, f.rule)) throw new Error(`unknown rule "${f.rule}"`);
      return message({ gate, mode: gateMode, ...rules[f.rule], ...f });
    });
    const failing = failures.filter((f) => (f.mode ?? gateMode) !== 'report').length;
    const summary = `GATE ${gate}: ${failures.length} finding(s), ${failing} failing.`;
    return { code: failing ? EXIT_FINDINGS : 0, summary, text: [...blocks, summary].join('\n') };
  } catch (error) {
    const summary = `GATE ${gate} ✗ could not run: ${error.message}.`;
    const text = `${summary}\n  A gate that cannot run fails in every mode (DS-059 §4.1 rollout rule 5).`;
    return { code: EXIT_BROKEN, summary, text };
  }
}

/** Prints a runGate result, adds its summary line to the job summary and sets the exit code. */
export function finish({ code, summary, text }) {
  (code ? console.error : console.log)(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  process.exitCode = code;
}
