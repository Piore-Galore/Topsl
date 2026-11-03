# Session-first UX cleanup and CLI-only integration

**Recorded:** 30 October 2026.
**Status:** Implemented on 30 October 2026 as `bb98fa5` on branch `claude/windows-qualification` ([pull request 43](https://github.com/Piore-Galore/Topsl/pull/43)), with fixture tests and Electron journeys against stand-in providers ([review](#review-30-october-2026), [implementation record](#implementation-record-30-october-2026), [validation](#validation-30-october-2026), [CI follow-up](#ci-follow-up-30-october-2026)). Live-provider evidence for this change is not established; packaged and other-platform evidence is limited to the pull request's CI.
**Related documents:** [Topsl design](Topsl_Design.md), [implementation status](Implementation_Status.md), [project synchronization](Project_Synchronization.md), [native Topsl sessions](Native_Sessions_Plan.md), and [recursive looping](Recursive_Looping.md).

## Summary

Keep Topsl’s Atlas appearance while making sessions the primary workspace. Remove redundant navigation, desktop-app management, automatic project discovery, and native project synchronization. Add explicit export imports in Settings, with searchable history and continuation into a new Topsl session.

Preserve existing projects, conversations, running work, and historical evidence. Older builder–reviewer workflows remain available under **Advanced workflows**.

## 1. Simplify the everyday experience

- **Navigation:** retain New session, Projects, the project/session tree, Providers, and Settings. Replace the expanded Project tools list with a project menu containing All sessions, Project settings, Provider tools, and Advanced workflows.
- **Project entry:** clicking a project resumes its last viewed session. Fall back to its newest session, then the New session composer. Opening tools or New session does not overwrite the remembered session.
- **Complete history access:** All sessions provides search and pagination, including older sessions and existing standalone loops. Replace the current “older” link that leads to another truncated list.
- **Composer-first creation:** show the message box immediately, with compact coordinator and team summaries. Default to one Auto coordinator and an Automatic team. Keep Auto/Discuss/Work visible; place model customization, goal kind, and required checks behind explicit controls.
- **Session details:** consolidate header destinations into **Work** (active work, plan, queue, history), **Team** (session configuration and clearly scoped goal overrides), and **Results** (review, checks, changes). Contextual links select the relevant work item automatically.
- **Reduce repetition:** replace repeated role editors and task lists in the transcript with summaries linking to their canonical pane. Keep blockers, unresolved choices, acceptance, and apply actions visible. Move individual goal controls into Work; retain clearly labelled session controls.
- **Secondary tools:** consolidate older workflows, context, workspaces, and activity under Advanced workflows. Provider tools retains direct CLI chats, terminals, and provider history. Project settings owns folder management, defaults, limits, and project-wide controls.
- Remove permanent “Ready,” successful freshness banners, vault-unlocked furniture, and repeated explanatory paragraphs. Preserve actionable loading, stale-data, error, and recovery states. Delete obsolete components and unused styles after their responsibilities are relocated.

## 2. Retire desktop and native-discovery features

- Rename Applications to **Providers**, containing only Codex CLI and Claude Code CLI. Retain CLI discovery, version checks, trust, authentication, qualification, installation, and updates.
- Remove desktop catalog entries, installation detection, application-bundle scanning, release checks, installers, launch actions, folder deep links, and desktop-targeted handoffs.
- Existing or explicitly selected CLI executables remain usable even when located inside an application bundle. Treat these as externally managed; remove updates that target their parent application.
- Remove automatic project-folder discovery and Codex project-registry synchronization, including timers, metadata readers, registry commands, alternate native-name write paths, and synchronization UI.
- Projects become a local catalog: Add folder, Rename, Move up/down, Copy path, Trust, and Relink. Preserve canonical-folder deduplication and folder validation before execution.
- Remove external-history source observation controls and commands. Importing a file creates a finite snapshot with no continuing connection to its source.
- Retain explicit collection of output from Topsl-created provider runs, including existing Claude workflow handback.

**Upgrade behavior:** run an idempotent migration before background services or recovery can perform retired operations. Preserve project identities, names, displayed order, trust, histories, and execution records; disable discovery/synchronization preferences and history-source records. Retire pending desktop operations and reject stale commands or approvals. Preserve uncertain historical operations without replaying them.

## 3. Import exports and continue in Topsl

Add **Settings → Imports** with explicit project and provider selection.

- Accept one `.md`, `.txt`, `.json`, `.jsonl`, or `.ndjson` file per import, up to the existing 30 MB limit. ZIP archives are outside this change.
- Preview the captured file, detected format, message/text count, warnings, and duplicate status before importing. Commit exactly the previewed bytes.
- Recognize supported transcript/message structures. Preserve other readable content—including unrecognized JSON—as an attributed reference, without inventing speakers or silently dropping content. Reject binary input.
- Store the original text and provenance in encrypted storage and index it for project history search. Native session IDs and recorded folders are historical metadata; missing or different folders do not prevent import or create projects.
- Deduplicate by project, provider, and content hash, independent of filename. Changed exports create separate immutable references.
- **Continue in Topsl** opens New session with a visible, removable reference attachment and an empty composer. The user’s next message starts the session; importing alone starts no model work.
- Keep imported context separate from the owner’s request, permissions, team configuration, and accepted code results. Show its source and any omissions.
- Reuse existing handoff limits for structured excerpts: newest 30 messages, 12,000 characters per message, 150,000 total. Unstructured exports use the first 150,000 characters with explicit omission reporting. Keep the complete source available for viewing and search.
- Freeze the reference into session intake, goal planning, worker/reviewer rounds, and session-loop context. Retries and restart reuse that snapshot. Deleting the original import preserves context already copied into existing sessions, with that boundary stated in the deletion UI.

## 4. Navigation, imports, and loop interfaces

- Extend `navigation-query` with optional `projectId`; persist a last-viewed session per project. Preserve global restart restoration and legacy `goal:`, `session:`, and `loop:` identifiers.
- Add `project-threads-page { projectId, cursor?, limit, query? }`, returning threads, total, and next cursor. Keep sidebar attention indicators independent of pagination.
- Add local project rename/reorder commands with stale-state checks and persistent ordering.
- Add `history-import-preview` and `history-import-commit`; extend `session-create` with an optional validated `referenceId`. The service constructs context from stored references.
- Create Goal and Endless loops through **Work → Create loop**, using the existing `loop-create` command with the session’s conversation ID. Preserve explicit Review and start, accepted-result continuity, and existing standalone-loop access.
- Loop details include Back to session. Draft loops clearly show Awaiting start and their queue position.
- Extend session Pause/Resume/Stop to active loops. Starting or resuming a loop requires a running parent session and valid queue position. Resume never starts an unreviewed draft.
- Removing a queued loop stops its underlying draft; stopping a session also stops queued drafts. Serialize admission and controls per session, preserve command idempotency, and reconcile interrupted operations after restart.
- Map retained old navigation destinations to their replacement sections. Retired synchronization destinations lead to Project settings with a concise retirement notice.

## 5. Validation and documentation

- **UX:** verify composer-first creation, custom teams, per-project resume, rapid project switching, more than 200 sessions, contextual Results navigation, keyboard access, focus restoration, and active terminal preservation.
- **Retirement:** upgrade profiles containing enabled synchronization, desktop installations, pending plans, and native links. Assert no retired metadata reads, registry calls, desktop checks, launches, or installer actions occur after upgrade.
- **Imports:** cover every supported extension, fallback text, duplicates, changed files, preview/commit consistency, missing original folders, attribution, omissions, search, cross-project rejection, deletion, and restart. Verify imported instructions remain reference material throughout execution.
- **Loops:** cover explicit start, queue ordering/removal, session and item controls, concurrent admission, checkpoint continuity, and restart recovery.
- Run `npm run check` and `npm run test:desktop`; inspect actual Electron journeys in Paper and Night at desktop and compact sizes. Report synthetic-provider, live-provider, packaged-platform, and CI evidence separately.
- Update README, canonical design, implementation status, project synchronization, and affected session/loop documentation in the same implementation cycle. Preserve dated evidence as historical records; verify relative links and `git diff --check`.

## Review (30 October 2026)

The plan was reviewed against the code before implementation. It fits the existing machinery: the session supervisor's queue and controls ([session-engine.ts](../packages/orchestration/session-engine.ts)), the loop supervisor's start guards ([loop-engine.ts](../packages/orchestration/loop-engine.ts)), command receipts, the encrypted document store with its message search index ([store.ts](../packages/persistence/store.ts)) and the handoff limits ([history.ts](../packages/workspace/history.ts)). The review settled these points, which the implementation follows. Items marked *inference* are choices the plan left open.

| Point | Decision | Why |
| --- | --- | --- |
| Where an import's text lives | A committed import is a `history-reference` record, its exact text a separate `history-reference-source` record, and its searchable content the messages of conversation `import-ref:<id>`. A preview keeps the decoded text in a `history-import-preview` record for 30 minutes; commit re-parses that text, never the file | All in the SQLCipher store; the commit cannot read different bytes than the preview showed |
| Readable content that is not a message | Stored as messages with a new role `reference` (no speaker), in 20,000-character chunks, so the whole file is searchable (*inference*) | The plan forbids inventing speakers and silently dropping content |
| Deduplication | Project, provider and SHA-256 of the file bytes; the file name plays no part | The plan's rule; changed content is a separate import |
| Recognized structures | Codex and Claude Code session JSON Lines, generic `{role, content}` messages (JSON or JSON Lines), ChatGPT `mapping` exports, Claude `chat_messages` exports, and Markdown with one speaker heading per message (at least two, including a user) (*inference*) | Common export shapes; anything else stays reference text with a warning |
| A session's copy | Frozen once at `session-create` into an immutable `session-reference` record keyed by the session. The session, its intakes (`context.reference`), its goals (`goal.reference`) and loop round contexts carry only its ID and digest, so input digests cover it; prompts append its text as a labelled block | Keeps session and goal reads small; retries, restart and deletion of the import leave the copy unchanged |
| Excerpt of a structured import | Recognized messages only, within the handoff limits; the size of non-message content is reported as an omission (*inference*) | Tool calls and metadata are rarely useful context and would crowd out messages |
| Prompt placement | Intake (initial and reconciliation), goal coordination, work and review prompts, loop coordinator prompts and loop child goals; endorsement and wording prompts omit it (*inference*) | Those two judge an exact candidate or word a reply already decided |
| Retired source-bound import | `history-import` and the native history reconciler are removed; messages already imported stay | The plan's finite-snapshot rule |
| Last viewed session | `preference/navigation.lastThreads[projectId]`, saved only while a session or loop of that project is open in the session workspace; validated against the project on read, falling back to the newest thread | Opening tools or New session must not overwrite it |
| Retired destinations | Overview → Advanced workflows · Activity; Tasks → Builder–reviewer; Changes → Candidate review; Context → Context; History → Provider tools; Synchronization → Project settings with a notice | The plan's mapping; values stay valid in `navigation-save` |
| Project order | `preference/project-order` with a revision; the upgrade saves the order Projects showed, and a new project goes first | Matches the earlier newest-first default |
| CLI inside an application bundle | Owner `external`, its own management unit, no update check or plan | The plan's "externally managed" rule |
| Loop admission | A loop of a native session starts only while the session runs, while its work item is queued, first among waiting work, with nothing running; it resumes only while the session runs. A draft at the head of the queue holds later work until it is started or removed, as before (*inference*) | The plan's "valid queue position"; keeps the one-at-a-time queue |
| Serialization | A per-session promise chain in the supervisor runs queue changes, session controls, the scheduler and (through the service) `loop-create`, `loop-start` and `loop-control` for that session one at a time, and brings the queue up to date inside each | A start and a removal of the same draft cannot both win |
| Restart | The supervisor's tick stops the run of any cancelled loop item and pauses a running loop of a paused session, with deterministic command IDs | Finishes controls a restart cut off without replaying others |
| Session resume | No longer interrupts the session's open intakes (the earlier code did, describing them as paused) | A defect found while extending controls to loops |
| Freshness | Shown only for stale, failed or disconnected reads, with Retry | The plan removes successful freshness banners |
| Sidebar bound | Each project lists its 8 newest threads and at most 8 more that wait on the owner; its count badge covers every waiting thread, and **All N sessions** opens the rest. Before, every waiting thread was listed (*inference*) | With hundreds of sessions waiting, an unbounded list made the sidebar unusable; All sessions now reaches every thread |

## Implementation record (30 October 2026)

| Area | What was built | Source |
| --- | --- | --- |
| Navigation | `projectDestinations` (session workspace, All sessions, Project settings, Provider tools, Advanced workflows), retired values and their sections; `navigation-query { projectId }`; `project-threads-page` | [navigation.ts](../packages/domain/navigation.ts), [commands.ts](../packages/domain/commands.ts), `navigation-*` and `project-threads-page` in [service.ts](../apps/service/service.ts) |
| Sidebar and shell | New session, Projects, the project tree with a per-project menu (keyboard: arrows, Escape returns focus) and the current destination, Providers and Settings; a project opens at its last viewed session; rapid switching keeps the last choice; the status line only while operations are pending | [workbench-sidebar.tsx](../apps/desktop/renderer/components/workbench-sidebar.tsx), [main.tsx](../apps/desktop/renderer/main.tsx), [coordination.tsx](../apps/desktop/renderer/coordination.tsx) |
| Screens | All sessions, Project settings, Advanced workflows, Providers, Settings → Imports, Provider history | [screens/](../apps/desktop/renderer/screens/) |
| Sessions | Composer-first New session with coordinator and team summaries, the attached reference card; Work (now, plan, queue with loop positions, history, Create loop), Team (session team, one-goal overrides) and Results (review, checks, changes); goal cards reduced to a team line and the decisions waiting on the owner | [project-home.tsx](../apps/desktop/renderer/coordinator/project-home.tsx), [session-thread.tsx](../apps/desktop/renderer/coordinator/session-thread.tsx), [work-pane.tsx](../apps/desktop/renderer/coordinator/work-pane.tsx), [goal-card.tsx](../apps/desktop/renderer/coordinator/goal-card.tsx) |
| Loops | Back to session, Awaiting start with queue position; admission and resume guards, session controls reaching loops, draft removal, serialization and restart reconciliation | [loop-thread.tsx](../apps/desktop/renderer/coordinator/loop-thread.tsx), `loopAdmission`, `serial`, `reconcileLoops` in [session-engine.ts](../packages/orchestration/session-engine.ts), `resumeGuards` in [loop-engine.ts](../packages/orchestration/loop-engine.ts) |
| Imports | Parser, excerpt and prompt block; preview, commit, list, read, excerpt and delete; `session-create { referenceId }` | [imports.ts (history)](../packages/history/imports.ts), [history-imports.ts](../packages/domain/history-imports.ts), [imports.ts (workspace)](../packages/workspace/imports.ts), [import-commands.ts](../packages/domain/import-commands.ts) |
| Retirement | CLI-only catalog and discovery; lifecycle refuses retired and bundle-owned updates; local project catalog with rename, move and availability; the upgrade migration; retired commands, timers, UI and the Codex registry, deep-link and source-observation modules removed | [catalog.ts](../packages/domain/catalog.ts), [discovery.ts](../packages/applications/discovery.ts), [lifecycle.ts](../packages/applications/lifecycle.ts), [projects.ts](../packages/workspace/projects.ts), [native-retirement.ts](../packages/persistence/migrations/native-retirement.ts), [Local projects](Project_Synchronization.md) |

Removed files: `packages/workspace/codex-projects.ts`, `packages/workspace/project-opening.ts`, `packages/history/reconcile.ts`, `apps/desktop/renderer/screens/project-overview.tsx`, `apps/desktop/renderer/components/synchronization-summary.tsx`, and the tests and fixture that covered only them (`codex-projects`, `codex-projects-native`, `native-history-reconciliation`, `campaign-history-projects-pj`, `fixtures/projects.cjs`).

## Validation (30 October 2026)

Host: macOS 27.0.1 arm64, Node 26.0.0, Electron 44.4.5. Revision: `3adca67` on branch `claude/windows-qualification` plus the uncommitted working tree of this change. Everything below ran against fixtures and local stand-in providers; no live provider route, account or model turn was used.

| Command | Result |
| --- | --- |
| Baseline before any change: `npm test` in a clean worktree of `3adca67` | Passed: 1216 tests and 6 skipped in 87 files (3 skipped) |
| `env -u ANTHROPIC_BASE_URL npm run check` | Passed: TypeScript; 1203 tests and 5 skipped in 88 files (2 skipped); 18 release checks; the build (with the existing renderer chunk-size warning) |
| `env -u ANTHROPIC_BASE_URL npm run test:desktop` | Passed, after `npm run check` rebuilt the app: the main desktop journey and its encrypted restart, the coordinator, Atlas, loop and session journeys |
| After those runs, the sidebar bound above: `npm test -- tests/navigation.test.ts tests/coordinator-threads.test.ts`, `npm run build` and `npm run test:desktop -- scripts/desktop-atlas-test.mjs` | Passed: 14 tests; the Atlas journey with 206 waiting sessions |
| `git diff --check`, relative links and anchors of the changed documents | Clean |

The test count differs from the baseline because the suites for retired features (`codex-projects`, `codex-projects-native`, `native-history-reconciliation`, `campaign-history-projects-pj`, the discovery and registry parts of `projects`, `sync-reconciliation` and `specification-updates`, and two desktop-specific lifecycle tests) were removed or replaced. New and rewritten suites:

| Suite | What it establishes |
| --- | --- |
| `tests/history-imports.test.ts` (14) | Every supported extension and structure, unrecognized JSON and text kept without invented speakers, binary/invalid/empty/oversized/unsupported files refused, excerpt limits and omissions, the prompt block's labels, preview needing the native file choice, commit of exactly the previewed bytes after the file changed, single-use previews, deduplication by content regardless of file name, separate imports for changed content, another provider or project, search in project history and Imports, cross-project refusals (read and `session-create`), deletion needing native confirmation and keeping a session's frozen copy across a restart, and renderer commands that cannot name a file |
| `tests/session-references.test.ts` (2) | The frozen import in intake, coordination, implementation and review prompts with the same digest, the objective unchanged, the copy unchanged after deleting the import and after a supervisor restart; sessions without an import keep their earlier context shape |
| `tests/session-loops.test.ts` (4) | Work → Create loop queues drafts; start refused out of queue order, while the session is paused or while other work runs; Resume never starts a draft; session Pause/Resume reach the running loop and a loop cannot resume in a paused session; removing a draft and stopping the session stop drafts; a loop only in a session of its own project; a concurrent start and removal of one draft never both succeed; a repeated command acts once; a restart finishes an interrupted removal and pause and repeats nothing |
| `tests/native-retirement.test.ts` (2) | An earlier profile with discovery and Codex synchronization on, desktop and bundled installations, pending, uncertain and unused desktop operations, a lock, a history source and a pending name push: the migration keeps projects, names, trust, the displayed order and history, retires the rest once, and a started service emits no native launch, adds no discovery source or registry observation, refuses the stale approval and the bundled CLI's update, and leaves the uncertain job uncertain |
| `tests/navigation.test.ts` (4) | Retired destinations open their replacements; per-project last viewed session, newest fallback and New session; tools and New session leave it alone; another project's thread is never remembered; legacy `goal:` IDs; All sessions paging through 205 sessions and searching titles |
| `tests/projects.test.ts` (16) | One project per folder through links, newest first; rename with a stale-name check and name validation; move with a stale-order check and persistence; missing and moved folders, relink and refusals; retired commands rejected by the schema; service consent, rename and move |

The five Electron journeys exercise the new screens through the UI: the main journey (Providers with two CLIs; Add folder, Rename and Move with native metadata untouched; Settings → Imports preview, import, search and Continue in Topsl with the reference removed; provider history search and handoff; 100,000 imported messages; older workflows under Advanced workflows; restart keeping names, order and imports), the Atlas journey (every destination in Paper and Night at 1280 × 880 and 560 × 720, one heading and one current location each, contrast, per-project resume and rapid switching, the project menu by keyboard with focus returned, All sessions past 200 sessions by pages and search, terminal continuity and restart), the session journey (composer-first New session, Work with goal controls, Team, Results, All sessions, restart), the coordinator journey (role defaults in Project settings, goal controls in Work, the one-line team summary) and the loop journey (loops created through Work in three sessions, Awaiting start with queue position, Back to session, restart, publication, Endless monitoring, Stop with the feature off).

Defects found and fixed during validation: a start and a removal of the same loop draft could both succeed because the session's queue did not reflect a just-started loop until the next tick; session controls could try to pause or resume a loop already stopping; Settings → Imports used the shell's project fence, which discarded a preview for a project other than the selected one; and the sidebar listed every session waiting on the owner, which the Atlas journey's 206 waiting sessions showed.

Selected captures: [ui-evidence/2026-10-30-session-first](ui-evidence/2026-10-30-session-first/).

**Not established.** Live Codex and Claude Code routes, packaged builds, remote CI and other operating systems did not run this change. Screen-reader and IME acceptance remain open. The auxiliary harnesses `scripts/campaign-ui-test.mjs` and `scripts/campaign-packaged-test.mjs` still target retired screens and were not updated or run; `scripts/round2-ui-test.mjs` and `scripts/desktop-usage-test.mjs` were updated but not run.

### CI follow-up (30 October 2026)

The working tree above was committed as `bb98fa5` and opened as [pull request 43](https://github.com/Piore-Galore/Topsl/pull/43). The first GitHub run on `bb98fa5`:

| Workflow and job | Result |
| --- | --- |
| Compile Topsl on Linux x64 and macOS Intel | Passed |
| Compile Topsl on macOS Apple silicon | Failed in **Desktop acceptance smoke**. After the loop journey's restart, its click on **← Back to session** with the Organization pane open timed out because the pane's role list received the click. Later steps were skipped. |
| Compile Topsl on Windows x64 | Failed in **Typecheck, integration tests, and application build**: 1 of 1,208 tests. Cleanup after the restart case in `tests/history-imports.test.ts` hit `EBUSY` deleting `history.sqlite-wal`. Later steps were skipped, so no Windows desktop journey ran. |
| Round 2 lifecycle stress on macOS Apple silicon, macOS Intel and Linux x64 | Passed (Windows x64 was still running when this was recorded) |

[Pull request 42](https://github.com/Piore-Galore/Topsl/pull/42) merged `bb98fa5` into its branch. Its session reported the same two failures, plus one in its Compile Topsl run on Linux x64 that passed on pull request 43. After the restart, the loop journey's `openRun` timed out looking for the running loop in its session's Work. That job's log was not read here; the failure was reproduced locally (below).

**Causes and fixes.**

- **Back to session (macOS Apple silicon).** The loop page's back link stretched across the whole header, and Playwright clicks an element's center. Below 1200 px a run's pane overlays the right side of the page, so it covered that center but not the visible text. After the restart the window takes the app's default 1280 × 880, which the runner's screen evidently narrowed below 1200 px. That is inferred: the runner's screen size was not read.
  - The link now sits in a full-width row but responds only over its own text ([loop-thread.tsx](../apps/desktop/renderer/coordinator/loop-thread.tsx), [atlas.css](../apps/desktop/renderer/atlas.css)).
  - The journey now sets 1024 × 768 after the restart, so every runner checks the overlaid layout ([desktop-loop-test.mjs](../scripts/desktop-loop-test.mjs)).
- **EBUSY (Windows x64).** The test's cleanup closed the first service and removed the folder while the reopened service that shared it still held the database open. macOS and Linux allow deleting an open file; Windows does not. Cleanup now closes every service before removing any folder ([history-imports.test.ts](../tests/history-imports.test.ts)).
- **A running loop missing from Work (pull request 42, Linux x64).** This is a product defect, not only a test gap. Starting a loop marked its queue item running but never made it the session's active work. Work shows the active item under **Now** and lists only waiting and settled items, so a started loop appeared nowhere in Work until it settled. The journey reached Work only when the run's page was not yet showing after the restart, which is a timing difference between runners.
  - The session's `sync` now makes a started loop the active work when no goal is ([session-engine.ts](../packages/orchestration/session-engine.ts)). Scheduling already waited for any running item, so nothing else starts differently.
  - `tests/session-loops.test.ts` asserts the started loop is the active work.
  - The journey's `openRun` also looks under **Now** ([desktop-loop-test.mjs](../scripts/desktop-loop-test.mjs)).

**Local verification** on the host above:

| Command | Result |
| --- | --- |
| Before the fix: `env -u ANTHROPIC_BASE_URL node scripts/desktop-loop-test.mjs` with the viewport after the restart temporarily forced to 1024 × 700 | Failed with the same message as CI |
| The same at 1100 × 760, and with the viewport before the restart at 1100 × 900 | Passed: at 1100 px the button's center lay just left of the overlay |
| After the back-link fix, the same at 1024 × 700 | Passed |
| `env -u ANTHROPIC_BASE_URL npm test -- tests/history-imports.test.ts` | Passed: 14 tests. macOS does not lock open files, so this does not exercise the Windows failure. |
| Before the Work fix: the loop journey with `openRun` temporarily forced to go through Work every time | Failed after the restart with the locator pull request 42 reported. With only the journey's locator widened to **Now**, it still failed, which exposed the product defect. |
| After the Work fix, the same forced run | Passed |
| `npx tsc --noEmit -p .`, `npx prettier --check` on the changed files, and `env -u ANTHROPIC_BASE_URL npm test -- tests/session-loops.test.ts tests/session-references.test.ts tests/history-imports.test.ts` | Clean; 20 tests passed |
| `env -u ANTHROPIC_BASE_URL npm run test:desktop` with the back-link fix, before the Work fix | Main (with encrypted restart), coordinator, Atlas and loop journeys passed. The session journey then stalled: after its restart the app did not exit when the journey closed it, so the run was stopped after three hours. Run alone afterwards, `node scripts/desktop-session-test.mjs` passed. The stall's cause is not established. |
| `env -u ANTHROPIC_BASE_URL npm run check`, then `env -u ANTHROPIC_BASE_URL npm run test:desktop`, with all three fixes | Passed: TypeScript; 1203 tests and 5 skipped in 88 files (2 skipped); 18 release checks; the build. Then all five desktop journeys, the session journey included. |

The GitHub run on the fix commit is not recorded here; pull request 43 shows it.
