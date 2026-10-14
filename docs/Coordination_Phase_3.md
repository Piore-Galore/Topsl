# Phase 3 — local synchronization, shared revisions, and native history

Implemented 14 October 2026 in the existing checkout. These are local coordinator and deterministic fixture results. No provider turn, account change, installation, native database edit, or billing fallback was performed.

## Synchronization has separate state and evidence

`packages/domain/sync.ts` and `packages/sync/reconciler.ts` model observations independently for identity, code, context, history, configuration, and native presentation. Each stored observation carries expected/observed revisions, check time, last successful time, evidence level/source, a detail, and a suggested next action. An error retains the last success rather than erasing it. `current` requires recorded evidence; unsupported and unverified observations cannot become current through a percentage calculation.

Three-way fields retain their last common value, local intent, and native observation. Incompatible changes on both sides yield a conflict. A directional decision is revision checked and durable. Choosing local intent leaves a pending write; it does not manufacture native readback. Provider-owned facts cannot be overwritten. Existing migrated native naming behavior is preserved until the user explicitly changes authority. Coordinated Topsl-owned names can remain local through native refresh, and conflicting remote names stay visible.

The supported Codex name push uses the exact native group, bound profile, and observed native revision through the existing `project/read` / `project/update` / registry readback route. Other providers and removed/unlinked or mismatched profiles are rejected. Registry readback, source discovery, folder opening, and visible sidebar confirmation remain separate facts. The generic projection never converts registry readback into sidebar confirmation.

## Shared inputs remain immutable

`packages/context/revisions.ts` stores immutable specification, decision, and interface revisions with content hashes and checked mutable heads. Every workflow specification is tracked under a stable workflow-specific shared record. Context construction includes current approved shared decisions/interfaces as mandatory text and source references; the existing byte-budget gate blocks rather than truncates them.

Each dispatched package is bound immutably to its task and then its exact attempt. Shared-head comparisons show which input revision was used, what is now available, and whether the change blocks dispatch. Advisory changes remain visible. Blocking updates are evaluated in workflow preparation, direct task dispatch, and the coordinator's final dispatch boundary. Final acceptance also checks current shared requirements and task input bindings.

Publishing requirements does not replace the active workflow's recorded inputs. The explicit restart flow:

1. Records the newer specification and leaves previous attempts/packages unchanged.
2. Refuses uncertain executions, unsupported interruption, and writer ownership without confirmed stop evidence.
3. Uses supported interruption when needed and waits if the provider has not yet reported a terminal outcome.
4. Captures the approved selected files as a new baseline, cancels/supersedes prior active tasks, invalidates old candidate verification, and prepares a fresh ready builder task.
5. Requires a separate advance action before dispatch. Fresh review and required checks must pass before acceptance.

Checkpoint update receipts are a separate API and require provider acknowledgment/readback. The product does not expose an unverified native checkpoint route as successful delivery. Completing against old inputs remains historical; it cannot accept newer requirements without the required fresh evidence.

Context binding and transport delivery have separate observations. A submitted prompt is pending; a provider acknowledgment is delivery evidence and explicitly does not prove comprehension or native instruction loading.

## Explicit native sources and durable cursors

`packages/history/reconcile.ts` supports bounded text projections of Codex response-item and Claude user/assistant JSONL records. Source identity includes project, provider, declared profile, native session, and approved canonical file. A source is approved through an explicit selected `.jsonl` or `.ndjson` file. There is no home-directory scan, credential reader, native database writer, or native-history polling without source opt-in.

The reader opens one regular file within a 30 MB limit and checks file/canonical-path stability before accepting its snapshot. Native metadata session/root mismatches fail. Invalid complete JSON or UTF-8 records fail without exposing parser snippets. Persisted errors use the shared redactor.

Messages and the durable byte cursor commit in one encrypted transaction. The live source route never advances beyond a newline-delimited complete record; partial trailing bytes remain pending. The finite explicit-import compatibility helper may accept a complete final JSON value without a newline. Every message records source revision/hash, parser version, native record order, and byte bounds; display timestamps are separate.

Native event IDs are preferred. New fallback identity is the canonical complete record hash plus its occurrence count within the observed source, preserving intentional repeated records and exact replay. Conflicting native IDs roll back the entire batch and retain the cursor. Rotation, truncation, and committed-prefix rewrites retain prior evidence and durable coverage-loss notices; a later successful read does not erase those notices. Unsupported record types/tool bodies are omitted from this text-only projection. A reconciled cursor therefore covers this documented parser, not full native transcript semantics or native resume capability.

The compatibility import route preserves existing legacy conversation/message IDs and snapshot references only for the `explicit-import` reference profile. Its original actual provider profile remains unknown; newly approved actual profiles remain separate. Legacy tombstones and new reference-session tombstones prevent accidental resurrection. Imported conversations have no writable native-session binding and stay non-resumable.

Native messages and generic context excerpts now include a source ID and content/source revision hashes. Excerpts over 2,000 characters carry explicit omission details as well as the truncation marker; full encrypted messages remain durable.

## Groups, roots, removal, and folder relink

Generic native links retain provider/profile/group identity, names/order/source revision, roots, and removal state. Each root has its own optional approved workspace/trust mapping. Matching one approved root grants nothing to another root. Root mapping requires the same logical project and exact approved canonical workspace identity. Native removal retains Topsl history and leaves a removal boundary; it schedules no automatic recreation. An explicit local unlink remains unlinked even when subsequent native observations still list the group.

Explicit project folder relink creates a new approved default workspace and preserves old workspace identity and task references. The old current workspace trust is invalidated; its historical revisions remain intact. New dispatch must use a currently approved mapping. Active/uncertain execution prevents a default-workspace relink.

## Requested and effective configuration

Versioned configuration evidence records the stage `requested`, `configured`, `discovered`, `enabled`, or `effective`, capability classification, session/source revisions, hashes, and evidence. Per-attempt requested models and instruction-manifest hashes are attributed to the session. Provider model reports remain separate attempt facts.

Instruction/configuration reads are file observations. Reviewed configuration writes record `configured`, return `loaded: false`, and retain the existing reviewed-write/source-hash/backup protocol. Effective runtime evidence requires supported provider readback or explicit user confirmation; file presence, successful write, and generic request acknowledgment do not certify effective loading. Required security capabilities cannot pass using unknown/unsupported or mere observable-only evidence.

## Service contracts

All P3 mutation commands use request identity and revision checks where applicable. Project-scoped snapshots traverse complete indexed scopes rather than the legacy 5,000-record global state window.

| Command                                            | Result or action                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `synchronization-query`                            | Project observations, fields, native links, shared revisions/heads, source cursors, configuration evidence, and stale input comparisons |
| `sync-field-intent`, `sync-field-resolve`          | Explicit authority/local intent or checked directional decision                                                                         |
| `sync-field-push`                                  | Supported exact-profile Codex name write plus registry readback                                                                         |
| `native-link-state`, `native-root-map`             | Checked link/unlink or approved per-root workspace mapping                                                                              |
| `shared-revision-publish`                          | Immutable decision/interface/general specification revision; workflow specifications use the workflow route                             |
| `task-inputs-inspect`, `task-context-bind`         | Input revision comparison or checked inactive-task package binding                                                                      |
| `builder-reviewer-specification-publish`           | New requirements available; active attempt inputs remain unchanged                                                                      |
| `builder-reviewer-specification-restart`           | Supported interruption and new ready task; no automatic model replay                                                                    |
| `native-history-approve`                           | Explicit native dialog approval of one source/profile/session/file                                                                      |
| `native-history-reconcile`, `native-history-pause` | Checked durable reconciliation or pause of an already approved source                                                                   |

The final desktop synchronization surface is integrated by Phase 5; these commands share the existing native approval broker and coordinator service.

## Recorded verification and limits

- P3 suites: `tests/native-history-reconciliation.test.ts`, `tests/sync-reconciliation.test.ts`, and `tests/specification-updates.test.ts` — 26 tests passed across the latest focused runs (the last native-history run passed 10, and the last sync/specification run passed 16).
- Earlier combined P3/P2/native regression run passed 50 tests; earlier combined native/project/store regression run passed 62 tests. These are overlapping suites, not additive totals.
- TypeScript passed after P3 wiring. A later concurrent check observed transient Phase 4 service cases before their command-schema additions; final integrated checks remain the parent task's gate.
- Tests exercise actual encrypted temporary databases and file read/restart behavior, complete/partial records, rotation, truncation, rollback/collision handling, stable fallback repetition, legacy replay and deletion, source/session/path scope, non-resumable imports, backwards timestamps, retrieval source hashes/omissions, native-name conflict retention and exact-profile push gating, separate registry/sidebar observations, per-root trust/removal, specification restart/uncertainty gates, stale dispatch/acceptance, mandatory decisions, immutable original packages, and requested-versus-effective evidence.
- File size/history-parser/version support is intentionally bounded. Large-source incremental I/O and broader native formats, live native-side history fidelity, effective runtime reload, and visible native sidebar acceptance remain unverified or unavailable. Successful fixture execution does not certify a subscription entitlement or a live provider security capability.
