// The flaky ledger (DS-059 §4.4 G3, step 6.156 slice 3): `quality/baselines/flaky-ledger.json`, `{ "<test id>": { "issue": n } }`.
// It is debt, not quarantine: it changes only whether the nightly hunt goes red a second time for a test whose `flaky`
// issue is open and inside the DS-013 SLO (2 school days, counted as weekdays). It never skips, retries or hides a test.
// Created once, from the first report-mode hunt (`flake-hunt --init-ledger`); after that it only shrinks (baseline guard).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LEDGER_FILE = 'quality/baselines/flaky-ledger.json';
export const SLO_SCHOOL_DAYS = 2;
/** An issue title is cut at 200 characters (`flaky: ` + the test id), so a long test id is known by its first 193. */
export const idKey = (test) => test.slice(0, 200 - 'flaky: '.length);

/** Weekdays after `from` up to and including `to` (ISO times). A Friday issue is 1 day old on Monday morning. */
export function schoolDaysBetween(from, to) {
  const end = new Date(to);
  if (Number.isNaN(end.getTime()) || Number.isNaN(new Date(from).getTime())) throw new Error('not a date');
  let n = 0;
  for (let d = new Date(from); ;) {
    d = new Date(d.getTime() + 864e5);
    if (d > end) return n;
    if (d.getUTCDay() % 6 !== 0) n += 1;
  }
}

/** The ledger under root, or undefined when the repo has none yet. A file that is not `{ test: { issue } }` throws. */
export function readLedger(root) {
  const path = join(root, LEDGER_FILE);
  if (!existsSync(path)) return undefined;
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  for (const [test, entry] of Object.entries(ledger))
    if (!Number.isInteger(entry?.issue)) throw new Error(`${LEDGER_FILE}: "${test}" needs an integer "issue"`);
  return ledger;
}

/**
 * What the nightly turns red for. `found` is the hunt's flakes in its window and `open` every open `flaky` issue, each `[{ test, issue, created }]`.
 * `unlisted`: a flaky test the ledger lacks (no path adds an entry after rollout, so it is fixed or deleted).
 * `overdue`: a ledger test whose open issue is older than the SLO, flaking this week or not.
 */
export function verdict({ ledger, found, open = [], now }) {
  const listed = new Set(Object.keys(ledger).map(idKey));
  const unlisted = found.filter((f) => !listed.has(idKey(f.test))).map((f) => f.test);
  // The SLO reads every open issue of a ledger test, so a test that is quiet this week is still held to it.
  const overdue = open
    .filter((i) => listed.has(idKey(i.test)) && i.created && schoolDaysBetween(i.created, now) > SLO_SCHOOL_DAYS)
    .map((i) => i.test);
  return { unlisted: unlisted.sort(), overdue: overdue.sort() };
}

/** Writes the ledger from a hunt, only when the file does not exist (`wx`). Returns the number of entries, or -1. */
export function initLedger({ root, found }) {
  const path = join(root, LEDGER_FILE);
  const sorted = Object.fromEntries(
    found
      .filter((f) => Number.isInteger(f.issue))
      .sort((a, b) => (a.test < b.test ? -1 : 1))
      .map((f) => [f.test, { issue: f.issue }]),
  );
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return -1;
    throw error;
  }
  return Object.keys(sorted).length;
}
