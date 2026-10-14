# Coordination Phase 1

Implemented on the reconciled local v0.1.1 checkout on 14 October 2026. The pre-existing macOS packaging edits were preserved. No branch, commit, push, provider installation, or model turn was performed for this phase.

The service now represents workspaces, workflows, tasks, multiple agent sessions, execution attempts, artifacts, verification, operation intents and evidence separately from conversation history. State transitions and expected revisions are validated. A native completed turn becomes a **submitted** task; it does not constitute review, verification or user acceptance. Requested and effective models remain separate, and missing effective-model evidence stays unconfirmed.

## Persistence and migration

Encrypted SQLite schema 3 adds indexed coordination foreign-key projections and dedicated transactional coordinator/lease tables. Critical repository reads use scoped Store pagination/iteration; neither migration nor recovery depends on the legacy 5,000-record state window.

Schema upgrades use `migrateWithBackup`: checkpoint WAL, switch to the supported rollback journal, hold an exclusive transaction, copy the complete encrypted main database before changing schema, reopen the backup with its key, and check integrity and the old schema version. Failed migrations roll back. Supported backups can be restored to a **new** destination through `restoreMigrationBackup`; restoration never overwrites the current vault or silently downgrades it. Pair a restored database with an application supporting its recorded schema. Unsupported newer schema versions are rejected before writes.

The legacy mapping preserves project IDs, native session IDs, original usage facts, context hashes and deletion tombstones. Runs become historical tasks/attempts without invented objectives, code revisions, accepted outcomes, effective models or context delivery. Unknown account/profile/runtime continuity remains unknown and non-resumable. A migrated session cannot regain trust merely through the legacy conversation session map. Context snapshots retain their original bytes/hash and explicitly unknown completeness. Deleting a conversation removes its coordination derivatives and their revisions along with the original history and retains the reimport tombstone. Backups have a separate retention/deletion boundary.

## Ownership and native runtime

`Coordinator` acquires the database-backed profile owner before RuntimeManager recovery can alter active records. A second coordinator fails safely while the owner is present or unobservable. A vanished process permits startup ownership recovery; a present/reused PID remains conservative. Heartbeat expiry never proves a process stopped.

`WorkspaceOwnership` uses canonical realpath and host/device/inode directory identity. Symlink and filesystem case aliases contend for the same writer row; different approved directories can own distinct leases beneath one logical project. Acquisition, dispatch ownership and generations are transactional. Expired, uncertain or quarantined leases cannot be reassigned automatically. An ordinary lease release checks owner and generation. Explicit reconciliation retains the prior owner/generation and the evidence of resolution.

Legacy structured runs and native terminals enter this same lease boundary before spawn. A refused alias start rolls back its task/attempt creation. Dispatch intent is recorded before a billable turn. Native completion, cancellation and kill requests do not themselves release ownership: normal release waits for the bound child process exit. Uncertain attempts and dispatches remain blocked pending explicit native reconciliation and are never replayed automatically. Profile identity includes the effective canonical Codex home, so a profile change cannot silently resume private session history.

This is exclusive **Topsl-managed** ownership, not a complete sandbox. Native descendants, external applications, editors and shared Git metadata remain outside full enforcement. No independence claim follows from a worktree, prompt or read-only protocol request. Security capabilities with only fixture/source evidence remain unknown for live use and required unsupported capabilities block dispatch.

## Adapter and service APIs

- `packages/providers/contract.ts`: provider connection, capability facts, prepared turn, normalized events/approvals, account and session evidence.
- `CodexAdapter`: preserves existing app-server initialization, native subscription requirement, account binding, start/resume, read-only/workspace-write requests, digest-bound approvals, streaming messages, usage snapshots and interrupt behavior. Payloads entering domain state are validated. Unreported models remain unconfirmed.
- `CoordinationRepository`: `ensureWorkspace`, `createWorkflow`, `createTask`, `transitionTask`, `transitionWorkflow`, `prepareAttempt`, `bindSession`, `transitionAttempt`, `recordIntent`, `updateIntent`, `artifact`, `verification`, `invalidateCandidate`, scoped `page` and `all`.
- `Coordinator`: `beginLegacy`, `beginAttempt`, `attemptForRun`, `attachExecution`, `bindRunSession`, `recordDispatch`, `acknowledge`, `syncRun`, `confirmStopped`, `reconcileRun` and project `snapshot`.
- `RuntimeManager.start(..., execution?)`: optional prepared attempt/fresh-session binding, with injected provider adapters and shared coordinator. Existing native terminal routes remain usable.
- Service commands: project-scoped coordination page/query, task inspection, workflow/task creation, revision-bound task transition/start. Mutation request IDs bind a digest and durable result; repeated pending/unknown requests do not redispatch.

A session has at most one active/uncertain turn. A retry creates another attempt. Candidate-consuming dependencies require either accepted upstream work or an explicit immutable candidate reference. Acceptance requires current candidate-specific passed verification artifacts. Repaired workflows may retain cancelled historical tasks only through an immutable, acyclic, same-workflow supersession chain ending in accepted work on the current candidate. Candidate invalidation preserves historical evidence and blocks current acceptance.

## UI foundation

Activity provides a project-scoped task list and inspector with ownership, role/provider, session visibility, requested/effective model, code/context basis, source identity and acceptance state. Its refresh has per-operation pending/error state. Full event subscriptions, large-history virtualization, richer workflow actions and product visual acceptance are handled by later phases.

## Recorded verification

- `npm run typecheck`: passed.
- `npm test -- tests/coordination.test.ts tests/runtime.test.ts tests/store.test.ts`: **36 tests passed, 3 files**.
- Earlier focused runtime/store/context-pagination run: **34 passed, 3 files**.
- New coordination cases cover encrypted legacy migration/backup restore, fault rollback/newer schema rejection, deletion derivatives/tombstones, duplicate coordinator rejection before recovery, unknown startup dispatch, alias collision and no orphan attempt, expiry with a live bound process, separate workspace leases and generation fencing, transition/dependency rejection, multiple session bindings/single-session turn exclusion, unknown legacy resume rejection, and child-exit-based release with submitted rather than accepted completion.

These are deterministic local fixture checks on the available macOS environment. Live Codex/Claude model execution, native descendant containment, Windows/Linux runtime and filesystem behavior, release packaging, visual compact-layout acceptance and the complete builder–reviewer workflow were not established by Phase 1. Integrated full checks and desktop acceptance must be recorded after all dependent phase changes land.
