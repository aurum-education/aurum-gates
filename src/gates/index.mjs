// The gates this package runs: `aurum-gates run <gate>` and `aurum-gates tighten <gate>` look a gate up here.
// A gate is `{ rules: { id: { why, fix, allow? } }, baseline: 'quality/baselines/<gate>.json', find({ root }) }`, where
// `find` returns `{ where: { rule: count } }` (where = a file path or ID, never page text). Each gate step adds its own
// (6.152 honest-tests, 6.155 reuse, ...). A gate's `rules` may be filled by `find` (sast); a rule with `reportOnly` is
// shown but never fails. Gates: lint-bans and suppressions (assurance step 1), sast (assurance assessment 2026-11-27, step 2).
import { gate as sast } from '../sast.mjs';
import { lintBans } from './lint-bans.mjs';
import { suppressions } from './suppressions.mjs';

export const GATES = { sast, 'lint-bans': lintBans, suppressions };
