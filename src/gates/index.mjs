// The gates this package runs: `aurum-gates run <gate>` and `aurum-gates tighten <gate>` look a gate up here.
// A gate is `{ rules: { id: { why, fix, allow? } }, baseline: 'quality/baselines/<gate>.json', find({ root }) }`, where
// `find` returns `{ where: { rule: count } }` (where = a file path or ID, never page text). Each gate step adds its own
// (6.152 honest-tests, 6.155 reuse, ...). None exists yet.
export const GATES = {};
