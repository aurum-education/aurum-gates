// Gate `lint-bans`: counts ESLint findings of the ban-list config (src/eslint.mjs) per file and rule, from the JSON report
// the repo's own ESLint pass wrote (`reports/eslint-bans.json`). A missing report or a finding without a rule id (a
// parse error) is a broken gate, never "no findings". Output is file paths, rule names and counts.
import { relative, resolve } from 'node:path';
import { readJson } from '../gate.mjs';
import { BAN_RULES } from '../eslint.mjs';

export const REPORT = 'reports/eslint-bans.json';

export function find({ root }) {
  const report = readJson(root, REPORT);
  if (!Array.isArray(report)) throw new Error(`${REPORT} is not an ESLint JSON report`);
  const found = {};
  for (const { filePath, messages } of report) {
    const where = relative(root, resolve(root, filePath)).split('\\').join('/');
    for (const { ruleId, fatal } of messages) {
      if (!fatal && !ruleId) continue; // a directive notice (noInlineConfig): not a finding
      if (fatal) throw new Error(`${REPORT}: ${where} has a finding with no rule (a parse error)`);
      if (!Object.hasOwn(BAN_RULES, ruleId)) throw new Error(`${REPORT}: unknown rule "${ruleId}" in ${where}`);
      (found[where] ??= {})[ruleId] ??= 0;
      found[where][ruleId] += 1;
    }
  }
  return found;
}

export const lintBans = { rules: BAN_RULES, baseline: 'quality/baselines/lint-bans.json', find };
