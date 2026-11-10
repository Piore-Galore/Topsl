# Whole-codebase review and fixes — 10 November 2026

A review of all product source (about 100,000 lines under `apps/` and `packages/`), followed by fixes for the findings that could be confirmed and changed safely. This record says what was fixed, how each fix was checked, and which findings remain open.

- **Base revision:** `6ccc364` on `main`. The fixes are in the working tree; nothing was committed.
- **Environment:** darwin-arm64, local only.
- **Evidence level:** local automated tests and reading. Nothing here was exercised in the Electron window, against a live provider, on a packaged build, or in remote CI.

## Method

The source was split into eleven slices (loop supervisor; coordinator engine; sessions, service and runtime; model proxy; native harness; workflows; providers, desktop main process and build tooling; domain and persistence; workspace, history and replication; renderer shell and coordinator UI; renderer screens and components). Each slice was read in full by one reviewer, which reported defects with a concrete failure scenario. Each finding was then confirmed against the code before any change. A fix got a regression test where an existing unit-level harness made that cheap; the renderer and the Electron main process have no such harness, so those fixes are verified by type-check and reading only.

## Fixed

"Test" names the regression test added or extended. "Reading" means the fix has no automated test of its own.

### Model proxy (`packages/proxy`)

| Defect | Fix | Evidence |
|---|---|---|
| An upstream body that failed mid-stream (reset socket, body timeout, cancel) threw through the stream. Clients received a cut-off answer with no terminal event; a non-streaming client got a bare 500. | `withRequestId` in `adapters.ts` turns the failed read into the stream's terminal `interrupted` error event. A failure before the first body bytes is a classified failure, recorded as cancelled when the request was cancelled. | Test: `tests/proxy-undeclared-body.test.ts` |
| A request target that is not a URL (`GET //`) threw inside the async handler of the loopback listener, before any credential check, and of the ChatGPT sign-in listener: an unhandled rejection in the proxy process. | Both listeners parse the target safely and catch anything a handler throws. | Test: `tests/proxy-service.test.ts` (loopback listener) |
| After a 401, a renewal that failed for a passing reason sent the refused token again; the second 401 marked the connection `reauthorization-required` although nothing was renewed. | `headers()` in `service.ts` answers a retryable `unavailable` and leaves the connection as it was. | Test: `tests/proxy-service.test.ts` |
| A non-streaming Messages client could receive an error body with HTTP 200 when tool-call arguments were not a JSON object. | `infer` maps that body to a failed request and records the receipt as failed. | Reading |
| A client that left while the socket was full left the handler waiting for `drain` for ever, with the receipt open and the controller held. | The wait also ends when the request is aborted. | Reading |
| The 413 for an oversized body was never delivered, because stopping mid-upload reset the connection. | A body declared larger than the limit is refused before it is read. A chunked body with no declared length is still reset. | Test: `tests/proxy-service.test.ts` |
| The ChatGPT discovery document and keys were refetched on every sign-in, revocation and refresh, because each call passed a new config object to a cache keyed by object. | The service keeps one config object. | Reading |
| A Chat upstream's `error` sent as bare text was ignored, and parallel tool calls streamed without `index` were joined into one call. | Both are read. | Test: `tests/proxy-protocols.test.ts` |

### Native harness (`packages/harness`, `apps/cli`)

| Defect | Fix | Evidence |
|---|---|---|
| The step loop spun without yielding when an open tool call could not be settled (an uncertain mutation after a restart, or a call with no recorded intention), blocking the service process. | `closeUnsettled` in `kernel.ts` records a "did not run" result for a call with no intention and pauses the attempt for reconciliation when an outcome is unknown. `recover()` keeps an already uncertain intent uncertain. | Reading; existing `tests/native-harness.test.ts` passes |
| A compaction cut could replace an assistant message and keep the results of its tool calls. | The boundary in `context.ts` is placed before the response. | Test: `tests/native-context-paths.test.ts` |
| After a compaction that published nothing, the step reused the compaction's request number and the attempt failed on a blob collision. | The step re-reads the attempt and re-checks the request budget. | Reading |
| The Git-metadata write guard matched `.git` case-sensitively and only the literal path, so `.GIT/config` or a linked folder reached the metadata on a case-insensitive file system. | The guard ignores case and is also applied to where the path really leads. | Test: `tests/native-context-paths.test.ts` |
| A path through a regular file (`README.md/x`), a link loop or an over-long name failed the tool or the attempt. | `resolveInside` rejects it as a bad path. | Test: `tests/native-context-paths.test.ts` |
| `edit_file` rewrote every non-UTF-8 byte in a file as U+FFFD; `read_file` could block a file-system thread on a named pipe. | `edit_file` refuses a file that is not UTF-8; `read_file` refuses anything but a regular file. | Reading |
| A search that timed out or was cancelled was reported as "No matches." | A run with no exit code is reported as a failed search. | Reading |
| Large tool output was cut by UTF-16 units against a byte limit, duplicating content and splitting characters. | It is cut by bytes on character boundaries. | Reading |
| A stop that arrived while a delegated child was being set up was missed. | The abort is checked after the listener is attached. | Reading |
| The context CLI decoded each socket chunk separately. | The socket is decoded as one stream. | Reading |

### Sessions, service and runtime

| Defect | Fix | Evidence |
|---|---|---|
| Deleting a conversation whose run was uncertain removed the run and left its workspace lease and concurrency slot held with nothing to reconcile. | `history-delete` in `apps/service/service.ts` refuses until the run is reconciled. | Reading |
| A runtime that never answered `turn/interrupt` was never force-stopped, because the grace timer was armed only after the request returned. | The timer is armed even when the request fails (`packages/runtime/manager.ts`). | Reading |
| An approval request still in the pipe when a run ended turned the finished run back into a waiting one. | It is declined. | Reading |
| A failed model or account refresh marked a connected runtime `incompatible`, and both branches wrote back a stale installation record. | Only a failed connection downgrades it; the current record is saved. | Reading |
| Resume bumped the session's control generation, which ended an intake opened while the session was paused. | Only pause bumps it. | Reading; existing `tests/native-sessions.test.ts` passes |
| A stop or pause during a coordinator turn's launch left that turn running unobserved and started the rest of the wave. | `launch()` in `session-engine.ts` interrupts the new turn and starts no further member. | Reading |
| An endorsement of an earlier candidate counted for a new one; a failed tick wrote a stale intake over saved progress; a replayed decision queued a second work item. | Endorsements are matched to the candidate's digest; the tick saves onto the current record; one item per intake. | Reading |

### Coordinator engine

| Defect | Fix | Evidence |
|---|---|---|
| Any goal message with a sentence such as "Use React hooks." pinned an exact reviewer roster to a label no model has, and the goal later waited in review for ever. | A bare "Use X" is a roster instruction only before a fall-back clause (`membership.ts`). | Test: `tests/membership-parsing.test.ts` |
| Model names with a version number ("GPT-5.5") were cut at the period. | A period ends a clause only before white space. | Test: `tests/membership-parsing.test.ts` |
| One copy record that could not be processed stopped every goal, loop and session from advancing, silently: `driver.sync()` ran outside any catch and rewrote an immutable capture record. | The capture record is written once per attempt, and the tick catches a failed sync. | Reading |
| A waiting task, and a goal whose coordinators or reviewers could not start, were saved again on every 500 ms tick. | They are saved only when the detail changes. | Reading |
| Deciding a finding back to an earlier combination of dispositions failed on an immutable collision. | The completion recorded for that combination is reused. | Reading |
| A coordinator could name a task `repair-…`, a prefix the engine treats as its own repair; a project-wide stop relabelled completed goals as stopped, and a completed goal could be steered. | The prefix is refused in a plan; both paths use `endedGoalStates`. | Reading |

### Loop supervisor

| Defect | Fix | Evidence |
|---|---|---|
| A team proposal that created a role and set its members in one go threw on every tick and left the iteration in `organizing`. | The role's purpose is taken from the proposal, and a proposal that cannot be evaluated is recorded as rejected. | Reading; existing optimizer tests pass |
| `wait()` wrote `waiting` over a stop or pause that arrived during its awaits; a stopped run is no longer ticked, so it stayed `waiting`. | It re-reads the run and returns when control changed. | Reading |
| Contribution and assessment records were rewritten with a new time when a tick was re-entered, and collided. | Each is recorded once. | Reading |
| "Use exactly four active roles" and "Always keep an accessibility role" were also added as required goals. | They are instructions, not goals. | Test: `tests/loop-steering-phrases.test.ts` |
| Pause then Resume on a completed run produced an active run that nothing ticks. | A completed run is not paused. | Reading |
| The project's head revision was read by hand from `.git/HEAD` and a loose ref file, so it was null in a linked work tree and after `git pack-refs`. | `gitHeadRevision` asks Git. | Test: `tests/git-status-renames.test.ts` |

### Workflows

| Defect | Fix | Evidence |
|---|---|---|
| A check whose program could not be started (not executable, missing interpreter) ended `uncertain` with nothing to reconcile and held the workspace's check lock for good. | A spawn with no process ID is not counted as spawned, so the execution ends `error` and the lock is released. | Reading; existing check tests pass |
| A folder that could not be captured after a build was captured again every 500 ms, for ever, with nothing shown. | The workflow is saved as `blocked` with the reason. | Reading |
| One queued specialist that could no longer start failed the tick on every pass and starved every entry behind it. | The entry is removed and the reason recorded. | Reading |
| A combined check's result wrote over a `blocked` stage set while it ran. | The result is dropped unless the stage is still `checking` for the same candidate. | Reading |
| `git status -z` renames were misparsed, and staged renames were missing from the staged-deletion list. | The origin field is consumed; the diff runs with `--no-renames`. | Test: `tests/git-status-renames.test.ts` |

### Persistence

| Defect | Fix | Evidence |
|---|---|---|
| A search word with no letter or digit ("->", "&") emptied the whole result. | Such words are dropped from the full-text query. | Test: `tests/store.test.ts` |
| Unreferenced blobs were reclaimed 100 per launch while counting against the vault's size limit. | They are drained at start (up to 20,000). | Reading |
| `updateIntent` erased the recorded provider reference on any state change that named none. | The recorded reference is kept. | Reading |

### Workspace and history

| Defect | Fix | Evidence |
|---|---|---|
| Configuration files were decoded lossily: a non-UTF-8 byte was written back as U+FFFD, and a BOM stopped every JSON edit. | Bytes are decoded strictly; a file that is not UTF-8 is refused; the BOM is ignored for validation and kept on write. | Test: `tests/campaign-config-usage.test.ts` |
| Applying a configuration edit left the file at mode 0600; a dangling symbolic link was replaced by a regular file. | The existing mode is kept; any symbolic link is refused. | Test: `tests/campaign-config-usage.test.ts` |
| An import with an out-of-range numeric timestamp was rejected whole. | Micro- and nanosecond values are scaled; an invalid one is left out. | Test: `tests/history-imports.test.ts` |
| The Imports search looked only at the newest 500 matches of the whole project; expired previews were purged only by the next preview; a vanished transcript folder raised a raw error; a warning named the wrong order. | Each import is searched in its own conversation; previews are purged at start and on list; the reader returns its failure result; the warning says file order. | Test: `tests/history-imports.test.ts` (wording); reading for the rest |

### Desktop main process, lifecycle and providers

| Defect | Fix | Evidence |
|---|---|---|
| A failed or timed-out service start left the worker alive, and a retry forked a second service on the same database. | The failed worker is stopped, and handlers act only for the current worker (`apps/desktop/main.ts`). | Reading |
| A second instance went on to register its start-up after `app.quit()`. | It exits at once. | Reading |
| A cancel during an update job's running-state probe was overwritten by `waiting-for-idle`, and the update later ran. | The stored job is re-read before the write. | Test: `tests/lifecycle.test.ts` |
| A download interrupted by closing Topsl became `uncertain`, could not be cancelled, and kept its installation locked. | It is settled as failed and the lock released. A package-manager job still stays `uncertain`. | Test: `tests/lifecycle.test.ts` |
| On Linux, `affectedProcesses` always answered "nothing running". | It resolves `/proc/<pid>/exe` and answers "unknown" when it cannot. | Reading; not run on Linux |
| The Claude tool server decoded its request body per chunk. | The request is decoded as one stream. | Reading |
| The release workflow did not launch the packages it publishes, although its comment said it ran the same steps as the build workflow. | The two packaged-journey steps are added. | Reading; not run in CI |

### Renderer

All by reading and type-check; none was exercised in the window.

- **Projects:** "Open terminal" on a card for a project other than the selected one was dropped with no feedback (`main.tsx`).
- **In-flight commands:** commands that name their target by attempt, connection or route shared one key per type, so a second action was dropped. The key now includes those fields.
- **Native tasks:** the screen re-queried its state in an endless loop while mounted; overlapping journal reads were dropped; steering text and the change preview were cleared on failure.
- **Loaded history:** older chats and older transcript pages were thrown away by the next project refresh.
- **Double submission:** the loop composer and the Create loop form had no single-submission guard.
- **Command runner:** a command that succeeded was reported as failed when only the follow-up refresh failed; a late result from an unmounted project's page opened its thread under another project.
- **Forms:** empty check arguments were captured; the members-per-role limit was written on every blur and an empty box was sent as 0; the "external writes stopped" attestation carried over to the next handoff; "load more" used the unsubmitted search text; a model ID was not trimmed for the suggested route name.
- **Smaller:** Start before an attached import had loaded; a check's Run button removed after a declined run; "Add goal" cleared before it settled; a failed task inspection left a permanent "Loading…"; a late diff replaced the selected finding's diff.

## Second pass: open findings fixed the same day

The first pass left a list of open findings. The owner asked for them to be worked through; these were fixed in a second pass. Evidence is as above: a named test, or reading.

| Area | Defect | Fix | Evidence |
|---|---|---|---|
| Coordinator engine | A stop or pause during a wave's launch did not stop that wave; the launching member was saved as `running` in the stopped round and the rest of the wave started. | `launch()` in `engine.ts` reloads the goal and round before each launch and after each `driver.launch`; on a halt the new attempt is interrupted and no further member starts. | Test: `tests/orchestration.test.ts` |
| Coordinator engine | `finishPlan` and `dispatch` wrote `reviewing` or `blocked` after an await without re-reading the goal, so a stopped goal was flipped back. | They return unless state, control generation and revision are unchanged. | Reading |
| Coordinator engine | "Assignment changed after the round froze" rewrote the round twice per tick for ever; a round whose task had left the plan after a replan threw on every tick and wedged the goal. | Both rounds are now stale, so they are retired and, where the task still exists, refrozen. Admitted work is not carried into the new plan: it is retired and the new plan runs the task again. | Reading |
| Agent jobs | A job mirrored a recoverable `blocked` action as terminal; the delegated-task grant was checked only when a job was requested. | A blocked job follows its action when it recovers; the grant is checked again at admission. | Test: `tests/agent-jobs.test.ts` (first part) |
| Loop supervisor | After two blocked decision rounds a run re-entered the same wait on every wake-up. | The blocked rounds are marked stale when the wait is entered, so the wake freezes a fresh round. | Reading |
| Loop supervisor | A refused repair or integration was replayed on every tick under the same command ID. | The iteration is rejected (`integration` or `product-defect`). | Reading |
| Loop supervisor | The "approaches failed" blocker returned at once after the edit or unblock its message asks for. | Only rejections after the goal's latest owner edit or unblock are counted. | Reading; `tests/campaign-loops-state.test.ts` passes |
| Loop supervisor | A Stop issued while `start()` captured the base was overwritten and the run started. | The run is re-read inside the transaction. | Test: `tests/recursive-loops.test.ts` |
| Loop supervisor | Iterations that ended as no-work, completed or stopped were never settled, so their turns were missing from token totals and outcome records, and a stopped iteration's baseline copy was kept. | Each of the three paths settles the iteration once. A crash between the state change and the settlement loses that one settlement. | Test: `tests/recursive-loops.test.ts` (GL-04, ST-01/ST-02) |
| Sessions | A Stop or Pause while the next goal's baseline was prepared was ignored, and the goal was created. | `schedule()` re-reads the session after the await. A Stop during the later goal creation is still not covered. | Test: `tests/native-sessions.test.ts` |
| Runtime | Reconciling an uncertain run trusted any live process with the recorded PID, so after a reboot the run could never be reconciled. | `reconcile` identifies the process: a run from before this boot cannot own it, and otherwise the installation's executable is compared. Where the executable cannot be identified (a script, or unknown), the refusal is kept. | Test: `tests/runtime.test.ts` |
| Service worker | A failed start left a half-started service that refused a retry as "already initialized". | The service is closed and cleared. | Reading |
| Desktop | Cmd+Q and the "Quit Topsl" menu item skipped the "Close Topsl while work is active?" confirmation. | The menu item runs the same check and confirmation as the window close. Programmatic quits and signals stay non-interactive, as the packaged journey and `npm run dev` need; the Dock's Quit still skips the confirmation. | Reading |
| Workflows | A check execution that crashed before its process was started was recovered as `uncertain` and held the workspace's check lock for good. | `recover()` in `check-executions.ts` marks it `error`, releases the lock and queues clean-up. Executions already made `uncertain` by an earlier restart are not repaired. | Test: `tests/campaign-checks-parallel.test.ts` |
| Workflows | The review copy of a build was left in the temporary folder on most paths where a review did not complete. | `removeReviewCopy` in `builder-reviewer.ts` removes it when a review attempt is abandoned. The copy is kept while the attempt is `uncertain`. | Test: `tests/builder-reviewer.test.ts` (failed dispatch); reading for the other paths |
| Workflows | Full permission bits were compared where the rest compares only the exec bit, so a protected file rewritten with the same bytes refused every check. | Only the exec bit is compared. | Test: `tests/protected-check-inputs.test.ts` |
| Advanced workflows | A dispatch that threw left a `prepared` attempt that could not be dispatched again, captured or checkpointed. | The attempt is failed, its task blocked and the workflow saved `blocked`. | Reading |

## Third pass: the rest of the open list

The owner asked for the remaining open findings to be worked through as well. Evidence is as above: a named test, or reading.

**Persistence and domain**

- Provider budgets were computed from the newest 5,000 runs and usage facts of all projects. `providerBudgets` now walks both newest-first through the new `Store.newestFirst` and stops at the start of the earliest budget period. Test: `tests/store.test.ts`.
- `deleteConversation` scanned the `events` table and all usage documents once per run. It now uses one statement each; what is deleted is unchanged. Test: `tests/store.test.ts`.
- Capture summed the whole vault once per 64 KiB chunk. It reads the total once per capture and adds what it stages. Reading; the existing limit tests pass.
- A crashed capture recorded under another hostname was never recovered. One older than 24 hours is now treated as dead. Test: `tests/blob-recovery.test.ts`.
- Renderer-facing schemas in `advanced-inputs.ts`, `commands.ts` and `sessions.ts` gained size bounds. Reading.
- A rolling allowance update could never clear `limitReached`. It now clears when the update carries a window and no known window is at 100 percent. Test: `tests/provider-allowance.test.ts`.

**Providers**

- A Claude run recorded no process ID. `startTurn` sets it and the manager records it and attaches the execution. Test: `tests/claude-route.test.ts`.
- A stdin or spawn error pre-empted the launch-failure classification. `close` now decides. Test: `tests/claude-route.test.ts`.
- On Windows the extension-less shim was a discovery candidate. Only `.exe` and `.cmd` are. Test: `tests/discovery.test.ts`; not run on Windows.

**Native harness and proxy**

- A mutation tool's file-system error paused the attempt as uncertain, and an error while computing the expectation failed the attempt. The expectation is carried into the failure path, and both are failed tool results. Reading.
- An edit that could not apply recorded `after: null`, which a later reconcile could match as applied. Reading.
- The MCP child's stdin had no error listener; a server request could be taken for a response to a pending request with the same ID; Stop waited for the tool timeout. Test: `tests/native-mcp-recovery.test.ts`.
- The search fallback ignored the glob, the stop signal and any deadline. Reading.
- `CLAUDE.md` containing `@AGENTS.md` included it twice; the attempt cursor skipped rows with the same timestamp; a quota wait with no quota owner was stored under a key nothing read. Reading.
- A chunked request body over the limit reset the connection before the 413. The proxy answers 413 and discards the rest. Test: `tests/proxy-service.test.ts`.

**Supervisors**

- `decideFinding` on an ended goal rewrote the goal's state, and wrote the findings and the completion separately. It refuses an ended goal and uses one transaction. Test: `tests/campaign-teams-auto.test.ts` (the guard).
- A Stop or Pause while a session's goal was being created was ignored. The new goal is stopped, or paused so that Resume continues it. Test: `tests/native-sessions.test.ts`.
- After the owner chose an alternative, later prompts still said the decision awaited the owner. Reading.
- A suspended loop run with a recovery problem became a wait that the next tick left. It stays suspended. Reading.
- A pause during `prepare` led to a second child goal on resume. `prepare` adopts the existing child. Reading.
- A loop goal could depend on an unknown goal and never become eligible. Unknown IDs are refused on add and edit; a dependency removed later blocks the goal with a reason. Test: `tests/recursive-loops.test.ts` (refusal).
- A provider limit whose retry time had passed still held a loop run. Test: `tests/recursive-loops.test.ts`.
- The checkpoint ownership test accepted a root on another Windows drive. Reading; not run on Windows.

**Workflows, workspaces and replication**

- A finding raised on an earlier candidate could not be decided but kept blocking. Any finding of the workflow can be decided. Test: `tests/campaign-build-review.test.ts`.
- An advanced-workflow check preview cloned the baseline, which had no blob references and collided on a second candidate. It binds the stored baseline, keyed by candidate where the baseline is the candidate. Reading; the existing tests pass.
- Removing a snapshot workspace ignored a `.git` folder an agent had created. Only a work tree's `.git` file is skipped. Test: `tests/parallel-workspaces.test.ts`.
- Resolving one replication conflict stranded another on the same record; revoking the last device of a project with no owner left it paused for good. Test: `tests/replication.test.ts`.

**Renderer** (reading and type-check only)

- Parallel activity stored an empty conflict resolution and shared resolutions across workflows.
- Native tasks: the model-request limit is clamped to the schema's bounds; a check line is split at the first colon followed by a space, and a line that cannot be used blocks Start with a message; the MCP network field is cleared after an admit.
- The sessions list did not update live once more than one page was loaded.

## Fourth pass: the owner's decisions

Six items were left for the owner. The owner chose one option for each, and they were implemented as follows.

- **Replans carry unchanged admitted work.** When a new plan revision is committed, an admitted action whose task, and every task it depends on, is unchanged keeps its round in the new plan and is not counted or run again. A changed task's round is retired at once and the new plan runs it. Repair and job tasks are not carried. Test: `tests/orchestration.test.ts` (unchanged task, changed task; a changed dependency has no test of its own).
- **Codex turn usage is the thread total minus the turn's starting total** (`packages/providers/codex.ts`), falling back to the last request when a notification has no total or the total falls below the baseline. The schema generated from the installed Codex 0.163.0 (`codex app-server generate-json-schema`) shows `total` and `last` are both required, and has no descriptions; that `total` is cumulative for the thread is an assumption, not verified with a live turn. Test: `tests/runtime.test.ts`.
- **A loop run with a recovery problem is held suspended** whether the service closed cleanly or crashed, and Resume is refused while the problem remains. Child goals already running are not paused by the hold. Test: `tests/recursive-loops.test.ts`.
- **Role-group settings are bounded on the commands** (`orchestration-group-set`, `orchestration-policy-set`, `loop-override-set`, `session-create` and the session configuration patch): rosters and ID lists up to 64 entries, a count threshold up to 64, and a fraction whose numerator is not above its denominator. The member-count fields (`count`, `minCount`, `maxCount`, `executionWidth`) are deliberately left unbounded: a count above the limit is accepted and reported as a policy conflict, which `tests/campaign-teams-auto.test.ts` (TEAM-02 §6.1) pins. The shared schemas that read stored documents are unchanged. Test: `tests/orchestration.test.ts`.
- **Migration backups are pruned to the pre-upgrade copies of the last two upgrades.** At the end of a successful open, the backups of that open's intermediate schema steps are deleted and its first backup, the vault as it was before the upgrade, is kept; then the two newest backups of the vault are kept and older ones deleted. A failed open prunes nothing. Test: `tests/store.test.ts`.
- **An identical rewrite of an immutable record is accepted** when it differs only by a property set to undefined. `stable()`, `hash()` and every stored digest are unchanged. Test: `tests/store.test.ts`.

## Fifth pass: the remaining items

The owner chose an option for each item still open after the fourth pass. These were implemented; the rest of the choices were to leave the item as it is, and are listed under "Left as they are".

- **Migration backups carry an upgrade ID.** A backup is now named `<vault file name>.schema-<n>.backup-<uuid>.upgrade-<upgrade uuid>`; every backup written during one open shares the upgrade ID. After a successful open, each upgrade keeps its lowest-schema backup (the vault as it was before that upgrade), the two newest upgrades are kept, and older ones are deleted. An upgrade that failed partway keeps all its backups until a later open succeeds; it is then pruned like any other. A backup with the earlier name counts as an upgrade of its own. Test: `tests/store.test.ts`.
- **A loop run held for recovery pauses its child goals.** Resume, once the revalidation passes, resumes them; Stop stops them. Test: `tests/recursive-loops.test.ts`.
- **A completed task is carried across a replan only when its dependencies are unchanged too**, as an admitted task already was. Test: `tests/orchestration.test.ts`.
- **Check executions left `uncertain` by an earlier version are repaired at start** when the stored record proves the process was never dispatched: no resources were allocated, or the failure phase is still `environment` with the environment instance ready and its preparation quiescent. Such a record becomes `error`, its lock is released and clean-up is queued. Test: `tests/campaign-checks-parallel.test.ts` (the first proof only).
- **The proxy honours `earliestRefreshAt`.** A token inside the refresh margin that has not expired is not refreshed before that time; an expired or just-rejected token is refreshed regardless. The meaning of the field rests on its name and the comment in `credentials.ts`; its wire format is not documented, and the parser accepts four shapes. Test: `tests/proxy-service.test.ts`.
- **Dead code deleted.** `refreshStoredChatGpt`, `normalizeUsage` and `releaseOwner`, with the tests that existed only for the first two.

## Live check of Codex usage — 11 November 2026

The fourth pass computed a Codex turn's usage as the thread's `total` minus the turn's starting total, on the unverified assumption that `total` is cumulative. With the owner's go-ahead, one live turn was run against the installed Codex 0.163.0 (`codex app-server`, model `gpt-6.1-sol` as Codex reported it, read-only sandbox, an empty scratch folder holding one text file, the owner's own sign-in). This is one turn on one machine, not a provider qualification.

- **What was run:** [probe.mjs](live-evidence/codex-usage-2026-11-11/probe.mjs), a standalone script that starts one thread and one turn, declines every approval request, and records only `thread/tokenUsage/updated` numbers and the names of the notifications it saw.
- **What it showed:** the turn made four model requests and sent four usage notifications ([usage-notifications.json](live-evidence/codex-usage-2026-11-11/usage-notifications.json)). `last` held one request each time (20,198, 20,430, 28,652 and 28,764 total tokens). `total` grew by exactly `last` each time: 20,198, 40,628, 69,280 and 98,044. On the fresh thread the first `total` equalled the first `last`.
- **Conclusion:** `last` is one model request and `total` accumulates over the thread, so the earlier reading of `last` alone would have recorded 28,764 tokens and 68 output tokens for a turn that used 98,044 and 452. The new computation is right for this case.
- **Across turns (second run, same day):** [probe-two-turns.mjs](live-evidence/codex-usage-2026-11-11/probe-two-turns.mjs) ran two one-request turns on one thread ([usage-two-turns.json](live-evidence/codex-usage-2026-11-11/usage-two-turns.json)). After the first turn `total` was 23,358 tokens; the second turn's `last` was 23,383 and its `total` 46,741, their sum. So `total` carries across turns, and the second turn's baseline (`total` minus `last` at its first notification) is the first turn's total, as the code assumes.
- **Not shown:** what `total` does after a compaction or on a resumed thread was not observed; the code falls back to `last` when `total` drops below the turn's baseline.

## Owner action for a check that cannot be verified — 11 November 2026

A check execution left `uncertain` with no process ID, where nothing stored proves whether a process was started, could not be reconciled and kept its workspace's check lock. Topsl does not guess, so the owner now settles it: **Mark as not running** (`check-execution-mark-not-running`) appears on such an execution in the workflow evidence view in place of the reconcile control. The main process asks for confirmation in a native dialog; the service refuses the command without that confirmation. The execution is then recorded as `error` and ineligible, with the time of the owner's attestation and the statement that Topsl verified nothing; the workspace lock is released and clean-up is queued. An execution that recorded a process ID still goes through the existing reconciliation, which is unchanged. Evidence: `tests/campaign-checks-parallel.test.ts` covers the method, the schema and the service's approval requirement; the dialog and the button were not exercised.

## In the built app — 11 November 2026

Until this point nothing had been exercised in the Electron window. Two things were then run on darwin-arm64 against the built working tree, with temporary test profiles and stand-in provider executables; no model call was made.

**The desktop acceptance journey** (`npm run test:desktop`, eight scripts). The first run failed at `scripts/desktop-test.mjs:876`: the stand-in runtime stayed `native-only`. The same script failed the same way on the base commit `6ccc364` in a separate work tree. The cause was the shell: it exported `ANTHROPIC_BASE_URL`, the scripts passed the environment to Electron, and Topsl refuses a provider launch while a billing variable is set. With the variable removed all eight scripts passed, run one at a time. `scripts/desktop-test-runner.mjs` now removes the billing variables itself, as `scripts/test.mjs` already did for the unit suite. A final `npm run test:desktop` through that runner, from the same shell, passed all eight scripts.

**A walk through four of the fixes**, driven by a throwaway Playwright script that counted the commands reaching the main process:

| Fix | What was done | Observed |
|---|---|---|
| Native tasks re-query loop | Opened a project's Native tasks view and counted commands for six seconds. | One `native-state` command, and one `navigation-save`. |
| "Open terminal" on another project's card | Two projects, the first selected; clicked "Open terminal" on the second, with a terminal stand-in. | The app switched to the second project with the terminal open in its folder. |
| Quit menu confirmation | Stubbed the message box and `app.quit` in the main process and called the "Quit Topsl" item's handler. | Idle: no dialog, one quit. With a stand-in run waiting on an approval: the "Close Topsl while work is active?" dialog, and no quit after Cancel. |
| Older transcript pages survive a refresh | Imported a 200-message conversation, clicked "Load older messages" twice, then sent a window focus event and made a project change. | The transcript stayed at 201 rows through both refreshes. |

The last check found one more defect, present before the review: an older page was appended after the newer one, so with messages that share a timestamp the older rows appeared at the bottom. `apps/desktop/renderer/components/transcript.tsx` now puts an older page ahead of what is shown. After a rebuild the same check showed rows in order. A double click on Send in the Provider tools composer produced one `run-start`; the loop and session composers were not exercised.

**A second walk-through, the same day**, on the committed branch with the same method:

| Fix | What was done | Observed |
|---|---|---|
| Native tasks form | Typed empty, 0, 9999 and 2.5 into "Model requests"; started with the check lines `npm run test:unit`, `lint: npm run lint` and `: cmd`; sent steering text one character over the limit. | Clamped on blur to 50, 1, 500 and 3. One `native-start` with checks named `npm run test:unit` and `lint`. `: cmd` blocked Start with a message and sent nothing. The refused steering text stayed in the box. |
| "Members per role limit" | Focus and blur unchanged; cleared and blurred; changed to 9 and blurred. | No command, no command with the value restored, and exactly one `orchestration-policy-set`. |
| Connections | "Test route" on two routes of one connection while the first was in flight; a model ID typed with a trailing space. | Both `connection-test` commands reached the main process. The suggested route name had no trailing hyphen. |
| Session and loop composers | A double click on Send, and on "Start session"; an over-long goal and then a valid one in "Add goal". | One `session-message`, one `session-create`, one `loop-message`. The refused goal stayed in the box; the valid one was added and the box cleared. |
| History and Imports paging | Submitted a search, typed other text without submitting, clicked "load more". | The next page was requested for the submitted query in both screens. |
| Sessions list | 55 sessions, both pages loaded, then a new session. | It appeared at the top; no row was lost or repeated. |

The "Mark as not running" button and its dialog were not exercised: getting an uncertain check with no process ID onto the screen needs a service kill mid-run, which was more set-up than the walk-through allowed. One thing seen and left alone: when a command is refused for length, the alert shows the raw validation JSON, not a sentence.

Still not exercised in the window: the "Mark as not running" dialog and button, a few smaller renderer fixes (parallel activity, assisted handoff, workflow evidence, advanced workflows), and anything with a live provider or a packaged build.

## Not fixed

Nothing from the review remains open except the items below, and what the live Codex check did not observe (`total` after a compaction or on a resumed thread).

### Left as they are, by the owner's choice

- **The Dock's Quit** skips the "work is active" confirmation. It cannot be told apart from the programmatic quits the packaged journey and `npm run dev` rely on; Cmd+Q and the menu item ask.
- **`stable()` sorts keys by locale.** No collision is reachable today, and changing it would mean migrating every stored digest.
- **The sessions list pages by offset**, so a row can be fetched twice after a live refresh; duplicates are dropped.
- **A review copy is kept while its attempt is uncertain**, because the reviewer may still be reading it.

## Validation

Commands run on 10 November 2026 on darwin-arm64.

**Before any change, at `6ccc364`:**

- `npx tsc --noEmit`: no errors.
- `npm test`: 103 test files passed, 3 skipped; 1,445 tests passed, 6 skipped.
- `npm run test:release`: 18 passed.

**After the changes:**

- `npm run check` (type-check, `npm test`, `npm run test:release`, `npm run build`): exit 0.
  - `npx tsc --noEmit`: no errors.
  - `npm test`: 107 test files passed, 3 skipped; 1,468 tests passed, 6 skipped. The four new files are `tests/native-context-paths.test.ts`, `tests/membership-parsing.test.ts`, `tests/loop-steering-phrases.test.ts` and `tests/git-status-renames.test.ts`.
  - `npm run test:release`: 18 passed.
  - `npm run build`: built the desktop, service, CLI and renderer bundles.
- `git diff --check`: clean.

**After the second pass:**

- `npm run check`: exit 0. `npx tsc --noEmit` reported no errors; `npm test` passed 107 test files with 3 skipped, and 1,476 tests with 6 skipped; `npm run test:release` passed 18; `npm run build` built all four bundles.
- `git diff --check`: clean.

**After the third pass:**

- `npm run check`: exit 0. `npx tsc --noEmit` reported no errors; `npm test` passed 107 test files with 3 skipped, and 1,493 tests with 6 skipped; `npm run test:release` passed 18; `npm run build` built all four bundles.
- `git diff --check`: clean.
- `tests/environments.test.ts` passes under `npm test`. Run directly with `node scripts/test.mjs`, outside npm, it fails to find npm; that is how the test locates npm, not a change made here.

**After the fourth pass:**

- First run of `npm run check`: one failure, `tests/campaign-teams-auto.test.ts` TEAM-02 §6.1, because the new command bounds refused a member count of 65. The bound on the count fields was removed.
- Second run of `npm run check`: exit 0. `npx tsc --noEmit` reported no errors; `npm test` passed 107 test files with 3 skipped, and 1,501 tests with 6 skipped; `npm run test:release` passed 18; `npm run build` built all four bundles.
- `git diff --check`: clean.
- After the backup rule was changed to keep the pre-upgrade copy: `npm run check` exit 0, with 107 test files passed and 3 skipped, 1,502 tests passed and 6 skipped, 18 release tests passed, and all four bundles built.

**After the fifth pass:**

- `npm run check`: exit 0. `npx tsc --noEmit` reported no errors; `npm test` passed 107 test files with 3 skipped, and 1,508 tests with 6 skipped; `npm run test:release` passed 18; `npm run build` built all four bundles.
- `git diff --check`: clean.

**Final state, 11 November 2026** (after the owner action, the dead-code removal and the transcript ordering fix):

- `npm run check`: exit 0. `npx tsc --noEmit` reported no errors; `npm test` passed 107 test files with 3 skipped, and 1,509 tests with 6 skipped; `npm run test:release` passed 18; `npm run build` built all four bundles.
- `npm run test:desktop`: exit 0, all eight scripts.
- `git diff --check`: clean.

**Limits:**

- Apart from the four fixes walked through in the built app and the two live Codex sessions above, the fixes were not exercised in the Electron window or with a live provider, and none on a packaged build. Most renderer and `apps/desktop/main.ts` changes rest on type-check and reading.
- The Linux branch of `affectedProcesses` and the added release workflow steps were not run.
- Remote CI has not run on these changes, so the Windows and Linux branches are unverified.
