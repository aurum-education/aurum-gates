// The `aurum-gates` command (DS-059 §4.1). Exit codes: 0 clean (or findings in `report`), 1 findings, 2 the gate could
// not run (a bad command, an unknown gate, a crash, a missing or broken file).
import { EXIT_BROKEN, countFailures, finish, runGate } from './gate.mjs';
import { GATES } from './gates/index.mjs';
import { run as runGuard } from './guard.mjs';
import { tighten } from './tighten.mjs';

const USAGE = `usage: aurum-gates run <gate> | tighten <gate> | baseline-guard [--base <ref>] [--report=<label>]`;

const broken = (message) => ({
  code: EXIT_BROKEN,
  summary: `aurum-gates ✗ ${message}`,
  text: `aurum-gates ✗ ${message}\n  ${USAGE}`,
});

/** Runs one command and returns its result without printing or exiting; `gates` is the registry (tests pass their own). */
export async function main(argv, { root = process.cwd(), gates = GATES } = {}) {
  const [command, name, ...rest] = argv;
  if (command === 'baseline-guard') return runGuard(root, argv.slice(1));
  if (command !== 'run' && command !== 'tighten')
    return broken(command ? `unknown command "${command}"` : 'no command');
  const gate = name && Object.hasOwn(gates, name) ? gates[name] : undefined;
  if (!gate) return broken(`unknown gate "${name ?? ''}" (known: ${Object.keys(gates).join(', ') || 'none yet'})`);
  if (command === 'tighten')
    return runGate({
      gate: name,
      root,
      rules: gate.rules,
      check: async () => {
        const changed = tighten({ root, baselineFile: gate.baseline, found: await gate.find({ root }) });
        console.log(changed ? `${gate.baseline} lowered.` : `${gate.baseline} is already as low as it can be.`);
        return [];
      },
    });
  const report = rest.includes('--report');
  return runGate({
    gate: name,
    root,
    rules: gate.rules,
    check: async ({ root: r, mode }) => {
      const failures = countFailures({
        root: r,
        mode,
        baselineFile: gate.baseline,
        found: await gate.find({ root: r }),
      });
      return report ? failures.map((f) => ({ ...f, mode: 'report' })) : failures;
    },
  });
}

export async function cli(argv) {
  finish(await main(argv));
}
