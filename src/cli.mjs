// The `aurum-gates` command (DS-059 §4.1). Exit codes: 0 clean (or findings in `report`), 1 findings, 2 the gate could
// not run (a bad command, an unknown gate, a crash, a missing or broken file).
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EXIT_BROKEN, countFailures, finish, runGate } from './gate.mjs';
import { GATES } from './gates/index.mjs';
import { run as runEvidence } from './evidence.mjs';
import { flakeRecords, readDir } from './flakes.mjs';
import { run as runGuard } from './guard.mjs';
import { fileIssues, scan } from './sast.mjs';
import { tighten } from './tighten.mjs';

const USAGE = `usage: aurum-gates run <gate> | tighten <gate> | pr-evidence [--all] | sast-issues | flake-record --repo <r> --sha <s> --run <url> <firstDir> <lastDir> | baseline-guard [--base <ref>] [--report=<label>] [--config <module>]`;

const broken = (message) => ({
  code: EXIT_BROKEN,
  summary: `aurum-gates ✗ ${message}`,
  text: `aurum-gates ✗ ${message}\n  ${USAGE}`,
});

/** Runs one command and returns its result without printing or exiting; `gates` is the registry (tests pass their own). */
export async function main(argv, { root = process.cwd(), gates = GATES } = {}) {
  const [command, name, ...rest] = argv;
  if (command === 'baseline-guard') {
    const args = argv.slice(1);
    const at = args.indexOf('--config');
    if (at < 0) return runGuard(root, args);
    // A repo that watches more files names its config module; a missing module or export is a gate that cannot run.
    try {
      const file = resolve(root, args[at + 1] ?? '');
      const { config } = await import(pathToFileURL(file).href);
      if (!config) throw new Error('the module has no `config` export');
      return runGuard(root, [...args.slice(0, at), ...args.slice(at + 2)], config, relative(root, file));
    } catch (error) {
      return broken(`baseline-guard --config: ${error.message}`);
    }
  }
  if (command === 'flake-record') {
    const args = argv.slice(1);
    const opt = (n) => args[args.indexOf(`--${n}`) + 1];
    const dirs = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
    if (dirs.length !== 2 || !['repo', 'sha', 'run'].every((n) => args.includes(`--${n}`) && opt(n)))
      return broken('flake-record needs --repo, --sha, --run and two report directories');
    const [first, last] = dirs.map(readDir);
    if (!last.files) return broken(`flake-record: no JUnit report under ${dirs[1]}`);
    const records = flakeRecords({ repo: opt('repo'), sha: opt('sha'), run: opt('run'), first, last });
    const summary = `aurum-gates flake-record: ${records.length} record(s)`;
    return { code: 0, summary, text: [...records.map((r) => JSON.stringify(r)), summary].join('\n') };
  }
  if (command === 'sast-issues') {
    try {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
      const run =
        process.env.GITHUB_RUN_ID &&
        `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
      const lines = fileIssues({ findings: scan(root), repo, runUrl: run });
      const summary = `sast-issues: ${lines.filter((l) => l.startsWith('opened')).length} opened, ${lines.filter((l) => l.startsWith('deferred')).length} deferred.`;
      return { code: 0, summary, text: [...lines, summary].join('\n') };
    } catch (error) {
      return broken(`sast-issues: ${error.message}`);
    }
  }
  if (command === 'pr-evidence') return runEvidence(root, argv.slice(1));
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
      // A rule marked reportOnly (a WARNING) is shown in every mode and never fails.
      return failures.map((f) => (report || gate.rules[f.rule]?.reportOnly ? { ...f, mode: 'report' } : f));
    },
  });
}

export async function cli(argv) {
  finish(await main(argv));
}
