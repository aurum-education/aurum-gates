## Step

Implements step **X.Y** — `vault/50-Implementation/<milestone>/X.Y <title>.md`
Requirements: REQ-… · Specs: DS-… · ADRs: ADR-…

type: feature | fix | refactor | docs | chore | log
step: X.Y
regression-test: <path>::<test name> (type fix only)
guide: <audience>/<slug> | none — <reason> (type feature that a person sees only)

## What changed

-

## Acceptance criteria evidence

| AC  | Evidence (test name, command output, screenshot) |
| --- | ------------------------------------------------ |
| AC1 |                                                  |

## Checklist

- [ ] Tenant-scoped data access only (partition key + authz check)
- [ ] No tenant content or PII in logs, traces, metrics, or errors
- [ ] Writes are idempotent (client operation ID honored)
- [ ] IaC what-if/plan output attached if infrastructure changed; no manual cloud changes
- [ ] Docs updated in this PR (README, spec as-built notes, runbook, ADR)
- [ ] Accessibility checked for UI changes (keyboard, screen reader, contrast)
- [ ] Independent review marker posted (`independent-review: pass <sha>`; plus `design-review: pass <sha>` if a person sees the change)
- [ ] Assumptions recorded in the step's implementation log
