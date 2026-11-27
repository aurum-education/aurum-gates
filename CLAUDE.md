# aurum-gates

This repo holds `@jmal1/aurum-gates`, the shared quality-gate mechanics of Isomorph (public name Aurum): gate modes, shrink-only baselines, the one failure message and the baseline guard (DS-059 §4.1). It is **public** and holds gate code only: no tenant content, no secrets. Consumers pin a tagged release by tarball (`https://codeload.github.com/aurum-education/aurum-gates/tar.gz/refs/tags/vX.Y.Z`), so no token is needed to install it. Every gate (G1 to G4, G6, G7) lands here in its own step.

Product context, requirements, and design live in the Isomorph vault (`../../vault/` when checked out in the
workspace). This repo links to them by ID (REQ-…, DS-…, ADR-…, step X.Y) and never copies them.

## Owning specs

| Spec   | Covers                                                                                                     |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| DS-059 | Engineering standards gates: §4.1 modes, baselines, message format, baseline guard, install by tag tarball |
| DS-060 | UX quality gates, which use the same mechanics (§4.8)                                                      |
| DS-013 | Quality and test strategy                                                                                  |

## Commands

| Task               | Command                                                               |
| ------------------ | --------------------------------------------------------------------- |
| Install            | `pnpm install` (no token needed)                                      |
| Test               | `pnpm test` (`node --test`; JUnit report in `reports/`)               |
| Format             | `pnpm format:check`                                                   |
| Policy checks      | `pnpm check:no-skips` (after `pnpm test`) · `pnpm check:honest-tests` |
| IaC what-if / plan | n/a — no infrastructure in this repo                                  |

## Workspace rules apply

The non-negotiables in the workspace `CLAUDE.md` (tenant isolation, operator-blind telemetry, no lost student work,
IaC-first, docs-as-part-of-done, ponytail, accessibility, don't invent requirements) apply to every change here.

## Engineering standards (DS-059)

Every change here passes the gates in the workspace spec **DS-059 Engineering Standards Gates**
(`../../vault/40-Design/DS-059 Engineering Standards Gates.md`). A gate's baseline file only shrinks; never edit one
upward to get green (`baseline-raise: <gate> — <reason>` in the PR body, read by the reviewer). Every PR body carries
`type:`, `step:` and, before merge, the independent review's marker comment (`independent-review: pass <sha>`).

## Repo-specific rules

- One step per PR into `main`. PR description links the step file and lists AC evidence.
- **Zero runtime dependencies**, plain ESM JavaScript (Node ≥ 22.12), no build step: the tag's files are what consumers run.
- **A tag is never moved or deleted.** A release is the `version` in `package.json` on `main`: `release.yml` tags `vX.Y.Z` when none exists. Consumers pin the tarball of that tag.
- A gate that needs a tool (jscpd, DS-059 §4.5) lists it as a dev dependency of the consuming repo, not here.
- Every rule has a failing fixture, a passing fixture and one per allowance (DS-059 §4.1).
- Output is IDs, rule names, counts, file paths and timings. Never page text or test content (workspace non-negotiable 2).

## Layout

| Path                                 | Contents                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bin/aurum-gates.mjs`, `src/cli.mjs` | The CLI: `run`, `tighten`, `init`, `baseline-guard`, `pr-evidence`, `flake-record`, `flake-hunt`, `flake-probe`                      |
| `src/gate.mjs`                       | Modes, count and ceiling compare, failure message, `runGate`, `finish`                                                               |
| `src/guard.mjs`                      | The baseline guard engine and its default watched files                                                                              |
| `src/evidence.mjs`                   | `pr-evidence`: the PR body and review-marker rules, the commit status                                                                |
| `src/flakes.mjs`                     | `flake-record`: tests that failed then passed between two attempts' JUnit reports, IDs only (G3, step 6.156)                         |
| `src/hunt.mjs`                       | `flake-hunt`: rerun-passed PR runs to one `flaky` issue per test, IDs only (G3, step 6.156 slice 2)                                  |
| `src/ledger.mjs`                     | The flaky ledger (`quality/baselines/flaky-ledger.json`): school-day SLO, verdict for the nightly (G3, step 6.156 slice 3)           |
| `src/probe.mjs`                      | `flake-probe`: changed test files repeated under shuffled seeds on the PR, test ID and seed only (G3, step 6.156 slice 3)            |
| `src/sast.mjs`, `sast/rules/`        | The `sast` gate (Semgrep with our own rules, `sast-issues`) and the rules with their test cases                                      |
| `src/tighten.mjs`                    | `tighten`: baselines move down only                                                                                                  |
| `src/eslint.mjs`, `src/gates/`       | The ban-list ESLint config (`bans()`), the `lint-bans` and `suppressions` gates, and the registry of gates (each gate step adds one) |
| `test/`, `test/fixtures/`            | Tests (`node:test`) and the fixture repo root                                                                                        |
| `docs/adr/`                          | Repo-local ADRs                                                                                                                      |
| `.github/workflows/`                 | `pr.yml` (checks, install probe), `pr-evidence.yml` (the `pr-evidence` status), `release.yml` (tags `vX.Y.Z` from `main`)            |
