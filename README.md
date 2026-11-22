# @jmal1/aurum-gates

Quality-gate mechanics for the Aurum repos (DS-059 §4.1, step 6.151): gate modes, shrink-only baselines, the one failure
message and the baseline guard. Zero runtime dependencies, plain ESM, Node ≥ 22.12. Owning spec: DS-059. Working in this
repo with Claude Code: see `CLAUDE.md`.

## Install (no token)

```json
"@jmal1/aurum-gates": "https://codeload.github.com/jmal1/aurum-gates/tar.gz/refs/tags/vX.Y.Z"
```

then `pnpm install`. A repo pins one exact tag and bumps it in its own PR. The tarball's integrity is **not** in
pnpm's lockfile for a URL dependency, so a tag is never moved (see `CLAUDE.md`); a repository ruleset on `refs/tags/v*` that blocks update and deletion enforces it (owner setting). The `install-probe` job in `pr.yml` repeats the pnpm version of `packageManager`: change both together.

## Use

| Command                                                        | What it does                                                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `aurum-gates run <gate> [--report]`                            | Runs a gate of `src/gates/` in its mode from `quality/gates.json`                                         |
| `aurum-gates tighten <gate>`                                   | Lowers the gate's baseline to today's findings; never raises it (`pnpm gates:tighten` in a repo)          |
| `aurum-gates baseline-guard [--base <ref>] [--report=<label>]` | Fails when a baseline count rises, a key is added or a mode moves backwards, unless the PR body allows it |

Exit codes: 0 clean (findings in `report` mode included), 1 findings, 2 the gate could not run (bad command, crash,
missing or broken file; every mode).

A repo's own gate script imports the helpers:

```js
import { countFailures, finish, runGate } from '@jmal1/aurum-gates';

finish(
  await runGate({
    gate: 'my-gate', // its mode comes from quality/gates.json
    rules: { 'my-rule': { why: '… REQ-X-001.', fix: '…', allow: 'a `// spec: <ID> §<n>` comment' } },
    check: ({ root, mode }) =>
      countFailures({
        root,
        mode,
        baselineFile: 'quality/baselines/my-gate.json',
        found /* { where: { rule: count } } */,
      }),
  }),
);
```

## Files in the consuming repo

- `quality/gates.json`: `{ "<gate>": { "mode": "report" | "ratchet" | "enforce" } }`. A mode only moves right.
- `quality/baselines/<gate>.json`: `{ "<file or ID>": { "<rule>": count } }`. Counts compare two-way: a rise fails, and a
  fall fails with "lower the baseline" (`aurum-gates tighten`). Nothing here raises a baseline.
- Timing ceilings (`ceilingFailures`) compare one-way: only a reading above its ceiling fails.

## The baseline guard

Compares the watched files with the merge base. A finding is allowed only by a line in the PR body,
`baseline-raise: <label> — <reason>`, where the label is the gate name (`<gate> mode` for a mode moved back). The
reviewer reads the line. A baseline file may first appear only in the PR that adds its gate to `quality/gates.json`. A
moved source file (git rename detection) carries its count: a rename with an equal or lower count is neutral.

A repo that watches more files passes a `config` (see `DEFAULT_CONFIG` in `src/guard.mjs`), as aurum-web does for its UX
gates (DS-060 §4.5).

## Invariants

1. A gate that cannot run fails in every mode (DS-059 §4.1 rollout rule 5).
2. Every failure uses the one message: `GATE … ✗`, Why, Fix, Allow, Mode.
3. Output is IDs, rule names, counts, paths and timings; no page or test content.
4. There is no command that raises a baseline.

## Test

`pnpm test` (`node --test`). Each rule has a case that must fail and one that must pass; the guard's CLI runs against a
temporary git repository.

## Release

The `version` in `package.json` on `main` is a release: `release.yml` runs the checks and tags `vX.Y.Z` if no tag has
that name. A tag is never moved.
