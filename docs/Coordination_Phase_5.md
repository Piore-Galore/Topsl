# Phase 5 — Interface, recovery and release evidence

Recorded 14 October 2026. This document separates working local code, fixture evidence, actual Electron acceptance, and unperformed release gates. The source acceptance plan is [Topsl_Improvement_Plan.md](Topsl_Improvement_Plan.md).

## Delivered surfaces

The primary navigation is Projects, Activity, Applications and Settings. A selected project has Overview, Tasks, Changes, Context, History and Synchronization. Existing native Workspace/History controls, terminals, application lifecycle ownership and configuration review remain accessible. Selected project/workflow/view preferences survive encrypted restart.

Tasks show responsibility, state, blocker/next action, acceptance criteria, workspace/lease ownership, requested/effective model evidence, bound runtime/version, sanitized account status, native billing uncertainty, pinned code/context/specification inputs, dependency freshness, source identities behind details, activity timestamps and incomplete usage. Native IDs are secondary details with copy actions. Workflow evidence retains captured files, findings, checks, omissions and delivery evidence. Parallel groups expose their recorded specialist queue, submitted candidates, conflict selection, combined checks and acceptance. Creation/execution routes remain capability gated; an empty interface does not claim a tested live provider route.

Runtime selection is explicit. Discovery does not automatically choose the first trusted executable or replace the requested model. Requested models absent from discovery stay unconfirmed. Late scoped responses cannot replace a different selected project/session. Pending state disables the initiating control while preserving its independent trust/validity conditions; service-side revisions and ownership remain authoritative.

First workflow dispatch requires a native review of the exact captured manifest, omissions, specification, selected runtime/model assignments and expected workflow revision. A durable input approval binds that digest. Captured files alone are not described as user review or provider comprehension. Specification changes prepare an explicit restart and never replay uncertain work.

Compact navigation collapses behind a labelled toggle; task details use a native HTML dialog with focus containment and Escape. Paper, Night and System dark, reduced motion, Unicode, long temporary paths, 150% zoom, and 560-pixel layout are exercised by the desktop harness. Full screen-reader/assistive-technology review remains an external acceptance gate.

## Durable subscriptions and bounded payloads

Schema 4 adds monotonically ordered control metadata in the same SQLite transaction as each document mutation. Events carry identities, scope and mutation type; they contain no transcript/artifact bodies or credentials. A project snapshot records sequence N and the coordinator instance epoch. Scoped event pages resume after N. Envelope validation rejects malformed bounds, duplicates and out-of-order entries; skipped unrelated sequences are valid. Reconnect replaces the scoped snapshot/epoch, including restored vaults whose sequence has regrown. Large notification backlogs trigger a canonical scoped resync.

The worker/main relay forwards bounded metadata batches (200 records). Runtime/history updates do not emit bulk global snapshots. Compatibility catalog updates are explicitly dirty or catalog-triggered and contain empty message/conversation/run/usage/approval/terminal arrays. Project-scoped queries supply current runs, usage, approvals and terminals. A small active-work signal preserves native close review independently of catalog snapshots.

History and search apply project/conversation predicates before LIMIT and use stable scoped cursors. Initial history pages contain at most 80 messages; individual previews contain at most 6,000 characters, and explicit message chunks at most 20,000. The transcript mounts at most 20 rows with scrolling message content and paged older history. Artifact/context contents are fetched by explicit inspection, not included in control-event broadcasts.

The large benchmark exposed unindexed FTS deletion by message ID and repeated native statement preparation. FTS row IDs now match the indexed document sequence, including migrated records; replacement/deletion/search joins use that identity. Store statements are reused. Schema migration rebuilds the FTS projection while preserving canonical encrypted documents and backup/restore protections.

## Usage and alerts

Native facts retain provider/source/session/turn identity and declared cumulative or delta semantics. Replayed snapshots and event IDs deduplicate. Comparable native ordinals take precedence over arrival order. Unordered/conflicting reports, overlapping sources, legacy semantics, session/turn overlap and missing reports remain explicitly uncertain. Cached input is accounted for once. API estimates are excluded from native reported totals; native allowances are unknown until a provider reports them.

Project token/wall-time thresholds are persisted advisory preferences. Alerts do not grant spending authority, introduce provider substitution, or automatically terminate native work. Wall time is the observed attempt span, including waiting. Unknown usage can exceed a visible threshold.

## Actual measurements

Both reports record hardware, OS/runtime versions, payload sizes, concurrency and limits. Raw copies are saved as the [store report](benchmarks/phase5-store-2026-10-14.json) and [actual Electron report](benchmarks/phase5-desktop-2026-10-14.json).

| Store/normalized-client workload | Recorded result |
|---|---:|
| Encrypted messages / projects / conversations | 100,000 / 8 / 16 |
| Text payload / concurrent fixture streams | 202 bytes per message / 4 |
| Ingestion | 8,870 ms |
| Scoped 200-message query p95 | 5.58 ms |
| Four fixture commits plus normalized event consumer p95 | 4.11 ms |
| Durable cancellation-control round trip | 0.69 ms |
| Scoped resync snapshot | 1.42 ms |
| RSS before / after | 95,764,480 / 131,235,840 bytes |
| Encrypted database / live WAL | 119,185,408 / 119,859,072 bytes |

Host: Apple M5, 10 cores, 32 GiB memory, Darwin 27.0.0 arm64; Electron 44.4.5 / bundled Node 24.21.0 / SQLite 3.53.4. This benchmark excludes Chromium painting, inference/network latency and provider termination. Four streams measure fixture headroom; the initial live coordinator budget remains two.

The separate real Electron harness loads 100,000 messages across two projects from four selected JSONL files of about 7.09 MB each. It measures 80-message IPC queries, 20 project-view interactions, four source reconciliations, visible selected-session updates and actual Electron process memory. The final local desktop run passed on the latest stream-suppression/catalog-bypass implementation; its report was recorded at 2026-10-14T10:17:17Z. Scoped history IPC query p95 was 0.80 ms, ordinary view-interaction p95 was 35 ms, and four-source response-to-render was 2.7 ms. Five selected-source command-start-to-render samples were 364, 349, 353, 349 and 352 ms (reported sample p95 353 ms by the harness lower-rank estimator). That conservative upper bound includes reparsing a 7.09 MB source and the durable reconcile before rendering; it does not certify a service-commit target. Electron reported renderer working set 184,192 → 266,736 KiB and largest utility working set 103,936 → 375,984 KiB, with its utility peak 430,496 KiB; these are per-process observations, not a guarantee of stable long-running memory. Paper/Night/System-dark, enlarged and compact screenshots were visually inspected, then the horizontal tabs were corrected and retested. Response-to-render and command-start-to-render are distinct: neither is silently relabelled as an exact service-commit-to-paint p95. The plan's universal latency targets remain un-certified.

Reproduce with `TOPSL_BENCHMARK=1 npm test -- tests/coordination-benchmark.test.ts` and `npm run build && npm run test:desktop`. The heavy benchmark is opt-in; routine checks mark it skipped. Desktop fixtures make no paid model requests and modify no real native stores, settings or credentials.

## Fault acceptance and release matrix

| Scenario | Evidence | Acceptance boundary |
|---|---|---|
| Durable gaps, malformed/reordered/duplicate batches, rollback, wrong/restored cursor, scoped isolation | `events-usage.test.ts` and `scoped-events-service.test.ts` | Tested deterministic metadata consumer and actual scoped service; service epoch resets on reconnect |
| Bulk streams without global history snapshots, preview/chunk limits, cross-project denial, native close activity | `scoped-events-service.test.ts` | Local service fixtures |
| Cumulative/delta/cache/snapshot deduplication, source overlap, unknown reports/legacy facts, advisory alerts | `events-usage.test.ts`, existing runtime/provider fixtures | Source-aware synthetic facts; no native quota feed or API pricing claim |
| Unknown dispatch/crash, owner exclusion, expired live writer, encrypted migration/rollback/restore/future schema | `coordination.test.ts`, `lifecycle.test.ts` | No automatic native replay or unsafe lease reassignment |
| Account/executable/profile/folder changes, stale approvals, cancelled late evidence, spec updates | `runtime.test.ts`, `specification-updates.test.ts`, workflow/provider suites | Provider/executable subprocess fixtures; full paid/live acceptance remains separate |
| Truncated/rotated history, parser uncertainty, tombstone replay, source provenance | `native-history-reconciliation.test.ts` | Read-only disposable native JSONL fixtures |
| Standard/compact/zoom/theme/keyboard/reduced-motion/Unicode + 100k mixed history + encrypted restart | `scripts/desktop-test.mjs` | Actual unpackaged Electron on this macOS arm64 host |
| macOS arm64 packaged build | Existing historical pilot packaging evidence | This changed coordinator revision still needs clean packaged launch/signing acceptance |
| macOS x64, Windows x64, Linux x64 | Existing target definitions and fixture portability | No current-phase host or packaged/native runtime acceptance on these OS combinations |
| Authenticated Codex/Claude model turns, provider-specific approval/sandbox/fan-out behavior | Capability inventories and deliberate gates | Not exercised; production structured Claude and unsupported native controls stay gated |
| Screen readers, clean-machine installation/update/elevation, distribution signatures | Not performed | Release gates remain open |

Focused local records before the final parent integration: the full actual Electron smoke plus encrypted reopen passed after the final service/renderer integration; TypeScript passed; store/coordination/history/runtime focused suites passed; nine usage/event cases plus the scoped service case passed; the source-aware dispatch approval service fixtures passed. The parent run records the final combined `npm run check` and independent desktop outcome in [Improvement_Execution.md](Improvement_Execution.md). Source tests and actual local UI evidence do not establish packaged/live provider support.
