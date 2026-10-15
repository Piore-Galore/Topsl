# Round 2 Phase 1 — lifecycle and durable execution

Implemented on 15 October 2026 in the existing working tree after the [unchanged baseline](Round_2_Baseline.md) completed. This document records local implementation and fixture evidence. A clean delivery commit, the four operating-system targets and live provider acceptance remain separate gates.

## Behavior and ordering

`ProviderConnection.close()` now returns an idempotent promise carrying process evidence. Runtime completion retains active management-unit/workspace exclusion and concurrency slots until the promise establishes quiescence. Provider results and child `exit` events alone do not release capacity. Inspection, native project peers, test teardown, service shutdown, utility-process exit and desktop quit await their applicable close boundary. Shutdown stops new dispatch, drains tracked operations, and closes protected storage last. A timed-out unresolved service operation keeps storage open. Native PTY sessions retain uncertain ownership because their descendant containment is unqualified.

The process observer records launch PID/group, termination request, child exit, stdio close, outcome, observation time and remaining group/tree evidence. POSIX children launch in a dedicated process group. Windows uses a bounded PowerShell CIM process-tree observation, following retained parent PID relationships; query failure or remaining descendants produces uncertainty. Neither mechanism is an OS sandbox or a guarantee against escaped processes or ancestry lost before observation. Windows Job enforcement and a universal descendant guarantee are not claimed. The Windows implementation has not been executed on this macOS host.

Existing builder/reviewer, parallel and advanced workflow checks share `CheckExecutions` through the existing encrypted store. The execution path:

1. Checks exact approval, protected harness/candidate, executable and service owner.
2. Atomically consumes the single-use plan and records execution, dispatch intent and exclusion before materialization or process effects.
3. Records materialized/resource identities, then records dispatching before launching once. Ambiguous outcomes never launch automatically again.
4. Persists bounded protected output while running, retaining cancellation and late evidence separately from the short error summary. Recognized credentials are redacted across partial stream chunks; oversized lines are omitted. The cap is 1,000,000 bytes and 256 chunks per execution, with explicit truncation; each retained line is at most 16,000 bytes.
5. Verifies process quiescence and candidate/harness integrity, then atomically commits output/artifact/verification, execution outcome and independent cleanup intent. Storage failure exposes an unresolved execution and cannot return a durable pass.
6. Runs cleanup only after that commit. Cleanup failure preserves the check result; retry has no execution/approval authority, verifies root identity, and rejects cross-project access before returning any cached concurrent operation.

`checks.list(projectId)` returns executions and cleanup summaries; `inspect(projectId, executionId)` includes the exact plan/environment and protected log chunks. `retryCleanup(projectId, cleanupId)` only retries recorded owned paths. Explicit `reconcileStopped(projectId, executionId)` requires inactive uncertainty and observed PID plus scoped group/tree absence. It records an ineligible error and cleanup eligibility, never recreates a lost passing result. Missing process identity or unknown descendants blocks automatic reconciliation. Late callbacks are fenced from persistence after finalization, including unresolved bounded stops.

Schema 5 uses the existing consistent encrypted backup/integrity migration and fences older writers. Historical verification records retain their original interpretation; no missing environment or lifecycle provenance is invented. The service-owned `durable-checks` rollout switch can stop new effects, while historical reads and recovery remain available. It cannot supply runtime qualification, permissions or user approval.

## Deterministic fixtures

The parallel worker now exposes ready/release barriers. Concurrency and alias collision assertions remain intact. A separate exit barrier holds completed turns while the test asserts occupied capacity and queued work. Teardown releases barriers and awaits closure before removing fixture roots. Seeded scheduling delays change event scheduling; assertions do not depend on a fixed elapsed overlap window.

`node scripts/lifecycle-stress.mjs --iterations 20 --seed example-seed --output <new-directory>` runs the parallel, runtime and durable execution suites with a distinct recorded seed per iteration. It retains each Vitest report/output and a manifest and stops on the first failure. Reuse a seed to reproduce the scheduling choices; use a fresh output directory. The standalone CI workflow owns four-target repetition; local fixture success does not establish CI success.

## Local evidence and remaining acceptance

Executed on macOS arm64 with the existing dependencies:

| Check | Observed result |
|---|---|
| Original focused runtime/concurrency/check/coordinator/project suites after lifecycle changes | 77 tests passed |
| Claude/advanced/workflow/service/specification/native-project/synchronization regression selection | 37 tests passed; one opt-in native test skipped |
| New durable execution suite | 10 tests passed: rollout no-dispatch, cleanup fault/concurrent scope/retry, final storage failure and no replay, approval/cancellation race, incremental redaction, bounded logs, timeout, orphan descendant, shutdown/reopen, finalized callback fence |
| TypeScript | Passed after lifecycle changes; rerun by integrated qualification as other phases modify shared contracts |
| Final focused runtime/concurrency/durable execution run after provider fixture declaration | 33 tests passed; preceding typecheck passed |
| First seeded stress attempt | Failed and stopped at iteration 1 when the concurrently integrated provider readiness gate rejected eight old fixture declarations. [Original failed report](round-2-evidence/r2-1-lifecycle-stress/iteration-1.json) and [full output](round-2-evidence/r2-1-lifecycle-stress/iteration-1.txt) retained. No retry was counted as a passing original run. Provider owner subsequently added the explicit isolated fixture declaration. |

R2-AT-01/02 keep their real two-worker and capacity assertions with barriers. R2-AT-03 covers a real parent exit with a surviving owned descendant as a negative control. R2-AT-04 covers awaited check shutdown and encrypted reopen without replay. R2-AT-05–08 exercise cleanup, consumed-intent recovery, concurrent authorization/cancellation and injected final storage failure. These are local fixture results. They do not complete the live seeded-defect/restart/cleanup journey in R2-AT-39 or clean committed four-target qualification in R2-AT-40. Broader fault coverage for physical disk exhaustion, Windows/Intel Mac behavior and provider-specific escaped descendants remains pending.

Follow-up, 15 October 2026: an explicit stop now waits for the owned POSIX group within its timeout and sends SIGKILL to members that outlive the leader. Normal completion still records surviving descendants as `uncertain`. See the [review follow-up](Round_2_Execution.md#review-follow-up--15-october-2026).
