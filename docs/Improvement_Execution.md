# Improvement implementation and acceptance evidence

The source [improvement plan](Topsl_Improvement_Plan.md) is preserved as proposed requirements. This file records the implementation and its actual acceptance boundaries. Work began on 14 October 2026 from commit `2c6318d5d3d459086a5a796f82637c5db56c1994`, preserving the existing local macOS packaging changes.

The user requested one GPT-6.1 Sol subagent with extra-high reasoning for each phase. All seven phases have separate implementation assignments using that model and reasoning setting. Dependent changes are integrated through the common service, persistence and runtime contracts before final verification.

The implementation audit, before commit delivery, retained `main` at the starting commit. The two packaging workflows, `package.json`, package-summary script, macOS verification script and macOS package test retain their starting hashes. Existing README/packaging edits were retained; status documentation was extended while preserving the prior packaging work. The copied requirements attachment matches the Desktop original byte-for-byte (`ace92a78275c364131b8b018fb959fab035c247e68432030f5a4eeef47f3a477`).

| Phase | Evidence record | Current acceptance |
|---|---|---|
| 0 — baseline, grants and scoped history | [Baseline](Coordination_Baseline.md) | Baseline check and desktop smoke passed; 22 targeted tests passed. |
| 1 — domain, persistence and ownership | [Phase 1](Coordination_Phase_1.md) | Typecheck and 36 coordination/runtime/store tests passed. |
| 2 — builder, reviewer, repair and verification | [Phase 2](Coordination_Phase_2.md) | Both service-level provider directions passed through actual local fixture subprocesses. |
| 3 — synchronization and history/context reconciliation | [Phase 3](Coordination_Phase_3.md) | Scoped source/revision/replay/conflict tests passed; shared service paths integrated. |
| 4 — parallel workspaces and integration | [Phase 4](Coordination_Phase_4.md) | Two actual fixture processes, queued capacity and combined-candidate checks passed. |
| 5 — interface, recovery and hardening | [Phase 5](Coordination_Phase_5.md) | Responsive interface, scoped events, source-aware usage and independent 100,000-message Electron journey passed, including encrypted restart and task-switch regression. |
| 6 — advanced collaboration and optional replication | [Phase 6](Coordination_Phase_6.md) | 20 advanced workflow/service and portable replication fixtures passed, including actual check processes and owner-agreement controls. Production isolation and remote transport remain gated. |

## Verification boundary

The integrated working-tree `npm run check` passed on 14 October 2026: TypeScript, **235 unit tests**, **17 release tests** and the desktop/service/CLI/renderer build. This working-tree release count includes the pre-existing macOS packaging test. Two optional unit cases were skipped (heavy benchmark and native provider acceptance); their absence is not counted as live acceptance. The heavy store benchmark was run separately. The build retains the existing renderer chunk-size warning above 500 kB.

The independent `npm run test:desktop` passed after the final typecheck/build, including 100,000 messages, four source reconciliations, scoped late updates, 20-row virtualization, rapid A→B task inspection, Unicode/long paths, Paper/Night/System, reduced motion, native 150% capture, 560-pixel dialog/keyboard behavior, and encrypted restart/search. The first independent attempt exposed a null inspector comparison before any task selection; it was corrected, and the complete journey was rerun successfully. Standard, compact and enlarged screenshots were visually inspected. Earlier phase and baseline results alone do not certify the application.

The full `npm run check` was rerun once more after that UI correction and passed with the same 235 unit / 17 release totals. `git diff --check` passed. Local command logs are `/tmp/topsl-final-check-20261014.log` and `/tmp/topsl-final-desktop-20261014.log`; reproducible commands, fixtures and archived benchmark JSON remain in this checkout.

An intermediate integrated run passed 41 tests across `protected-check-inputs`, `builder-reviewer`, `parallel-workspaces`, `specification-updates` and `workflow-service`. Parent review also added frozen acceptance inputs, atomic single-use check dispatch, retained resource provenance and a confirmed-stop boundary before candidate capture. These checks include an actual process race negative control, immutable original test/script inputs, permitted new tests and dependency updates, and indirect package-script weakening.

A subsequent full unit pass recorded 227 passing tests and two optional skips. Later review added absent/external check-harness rejection, arbitrary harness/configuration pinning, ordered usage snapshot handling, source-overlap uncertainty, stream-only metadata broadcasts and advanced process-check execution. Those final additions are included in the final integrated rerun below, rather than being certified by the earlier count.

Read-only discovery submitted no provider model turns and changed no vendor authentication, installation, configuration or native project registry. Live structured Claude coordination remains gated pending supported product authentication and effective access controls; native terminal operation remains available. Independent templates require enforced access and cannot silently fall back to prompt instructions.

Current-machine fixtures do not establish authenticated live execution, native sidebar refresh, real subscription usage coverage, all packaged operating systems, or cross-device transport deployment. These remain separate acceptance gates.

## Commit delivery

The user's subsequent direct request authorized splitting this implementation into commits and pushing the existing `main` branch. Delivery separates the following changes; the documentation/evidence commit contains this record.

| Commit | Scope |
|---|---|
| `cb3d851` | Encrypted coordination contracts, ownership, context, provider adapters, scoped history and reconciliation foundations. |
| `2700b35` | Guarded workflow engines, frozen checks, parallel resources, advanced templates and portable encrypted replication. |
| `702588a` | Service/runtime/CLI and desktop integration, scoped events, inspectors, bounded history and end-to-end fixtures. |

A clean export of the staged application tree, excluding all pre-existing packaging edits, passed `npm run check`: TypeScript, **235 unit tests**, **16 release tests**, two optional skips, and build. Its independent `npm run test:desktop` passed the same 100,000-message journey and encrypted restart. Logs are `/tmp/topsl-commit-delivery-check.log` and `/tmp/topsl-commit-delivery-desktop.log`; [its desktop measurement](benchmarks/commit-delivery-desktop-2026-10-14.json) is archived separately.

The existing packaging workflow/configuration/scripts/test, README edits and packaging-specific status paragraph remain uncommitted. The earlier 17-test working-tree release result does not certify those edits as part of this delivery. No release tag or provider authentication/billing change is part of the requested push.

## Measured scale

The opt-in `TOPSL_BENCHMARK=1 npm test -- tests/coordination-benchmark.test.ts` run on this macOS arm64 / Apple M5 host ingested 100,000 messages across eight projects and 16 conversations into the encrypted vault in 8.87 seconds. Scoped 200-message page queries measured 5.58 ms p95. Four fixture streams measured 4.11 ms p95 from commit through the normalized event consumer; resync snapshot time was 1.42 ms. RSS changed from 95.8 MB to 131.2 MB during that run.

These measurements exclude Chromium paint and provider network/inference. The cancellation measurement (0.69 ms) is a durable local control update, not provider termination. The live concurrency default stays two. Full machine/workload/measurement details are preserved in [the store benchmark](benchmarks/phase5-store-2026-10-14.json); the desktop journey separately loads 100,000 imported messages, exercises scoped history and checks a bounded 20-row transcript window.

The final recorded Electron journey used two projects and four explicit native-source fixtures (approximately 7.09 MB each). History IPC query p95 was 0.80 ms, ordinary UI interaction p95 was 36 ms, and a selected streaming update appeared 27.7 ms after the concurrent reconciliation command responses. Five single-source command-start-to-render samples measured 348 ms p95, including IPC and full-source parsing/reconciliation. Neither figure is a direct certification of the plan's service-commit-to-paint target. [The desktop benchmark](benchmarks/phase5-desktop-2026-10-14.json) records process memory and these measurement boundaries.

## Acceptance matrix

These are the plan's acceptance scenarios, mapped to executable evidence. A passing fixture establishes the stated local behavior; it does not establish a provider or operating-system capability that the fixture does not exercise.

| Plan scenario | Executable evidence | Boundary |
|---|---|---|
| AT-01 independent context grants | `context-pagination.test.ts` simultaneous grants, token exchange, expiry and separate revocation | Actual local socket requests. |
| AT-02 withheld context retrieval | `context-pagination.test.ts` allowlists and exclusions before search, history and handoff selection | Every exposed context retrieval route is scoped. |
| AT-03 filesystem/tool independence | `advanced-workflows.test.ts`, `parallel-workspaces.test.ts` missing capability/access-policy refusal | Live provider enforcement is unverified; unsupported independent modes remain gated. |
| AT-04 history beyond 5,000 global records | `context-pagination.test.ts` scoped pagination; `coordination-benchmark.test.ts` 100,000-message dataset | Indexed encrypted local vault. |
| AT-05 duplicate events and cumulative usage | `runtime.test.ts`, `claude-provider.test.ts`, `events-usage.test.ts` | Provider fixtures and source-aware accounting. |
| AT-06 unknown dispatch recovery | `coordination.test.ts`, `builder-reviewer.test.ts` lost acknowledgement and restart | No automatic replacement model turn. |
| AT-07 duplicate coordinator | `coordination.test.ts` second owner and pre-dispatch recovery exclusion | Same local profile/database. |
| AT-08 path aliases | `coordination.test.ts`, `parallel-workspaces.test.ts` symlink/canonical identity collision | Actual local filesystem identities. |
| AT-09 lease expiry with live process | `coordination.test.ts` expiry and stale-generation release; `parallel-workspaces.test.ts` delayed child exit | Expiry/inference completion never proves process termination. |
| AT-10 two isolated workers | `parallel-workspaces.test.ts` two actual child processes in one project | Separate workspaces and mutable resources; no claim of OS sandboxing. |
| AT-11 stale candidate evidence | `builder-reviewer.test.ts`, `parallel-workspaces.test.ts` accepted-source drift | Old snapshots/evidence remain historical. |
| AT-12 failing combined integration | `parallel-workspaces.test.ts` individually passing workers and failing combined check | Actual check process on combined captured bytes. |
| AT-13 changed shared specification | `specification-updates.test.ts` running-input staleness, downstream dispatch and acceptance guards | Old delivered context remains immutable. |
| AT-14 truncated/rotated native source | `native-history-reconciliation.test.ts` partial record, rotation, rewrite and restart | Explicitly approved JSONL files; unknown native formats are unsupported. |
| AT-15 deletion/reimport | `native-history-reconciliation.test.ts`, `context-pagination.test.ts`, `coordination.test.ts` | Tombstones and derived content deletion survive reopen. |
| AT-16 changed account/runtime/root | `runtime.test.ts`, `native-history-reconciliation.test.ts`, `specification-updates.test.ts` | Exact source/profile, executable identity and canonical-root checks. |
| AT-17 stale approvals | `runtime.test.ts`, `protected-check-inputs.test.ts`, `parallel-workspaces.test.ts` | Revision/digest binding and atomic single-use dispatch. |
| AT-18 external workspace mutation | `candidates-context.test.ts`, `builder-reviewer.test.ts`, `parallel-workspaces.test.ts` | Captured bytes remain stable; source drift blocks acceptance. |
| AT-19 registry versus visible sidebar | `sync-reconciliation.test.ts`, `specification-updates.test.ts`, desktop smoke | Fixture registry readback; real native sidebar remains unverified. |
| AT-20 disconnected scoped event stream | `events-usage.test.ts`, desktop smoke | Epoch/sequence gap resync, bounded batches and selection fences. |
| AT-21 missing provider usage | `events-usage.test.ts` incomplete coverage, cached/cumulative accounting | No invented zero usage or subscription allowance. |
| AT-22 mandatory context overflow | `candidates-context.test.ts`, `builder-reviewer.test.ts` | Block before task/copy/dispatch; no silent criterion truncation. |
| AT-23 unsupported required capability | `advanced-workflows.test.ts`, `workflow-service.test.ts`, `parallel-workspaces.test.ts` | No weaker automatic fallback or provider substitution. |
| AT-24 cancellation and late completion | `parallel-workspaces.test.ts`, `runtime.test.ts` | Original attempt evidence retained; acceptance stays explicit. |
| AT-25 migration interruption/restore | `coordination.test.ts`, `context-pagination.test.ts`, `events-usage.test.ts` | Encrypted backups, rollback/integrity and future-schema write refusal; no live WAL copy. |
| AT-26 disconnected device conflicts | `replication.test.ts` conflicts, delayed ancestors, deletion and owner rules | Portable local encrypted transfers; remote control/ownership transfer unsupported. |

The source document is a requirements attachment. Its proposed branching, publication and live-provider examples are not separate authorization to alter the existing checkout, publish a release, spend credits or modify authentication. This implementation preserves the supplied checkout and its pre-existing packaging work.
