# Native Topsl sessions

**Recorded:** 29 October 2026.
**Status:** Implemented on 29 October 2026 on branch `claude/native-sessions`, with fixture tests and Electron journeys against stand-in providers ([review](#review-29-october-2026), [implementation record](#implementation-record-29-october-2026)). Four-platform CI passed on [PR #38](https://github.com/Piore-Galore/Topsl/pull/38) ([record](Implementation_Status.md#native-topsl-sessions--29-october-2026)); live Claude Code and Codex routes and packaged platforms are not yet established for it.
**Related documents:** [Topsl design](Topsl_Design.md), [coordinator feature specification](Coordinator_Feature_Specification.md), [coordinator delivery and evidence](Coordinator_Teams.md), [recursive looping](Recursive_Looping.md), and [implementation status](Implementation_Status.md#native-topsl-sessions--29-october-2026).

## Summary

Make a persistent **Topsl session** the primary workspace for conversation and coordinated work. Each session owns its history, coordinators, team settings, and goals. Claude Code and Codex supply the models running underneath it.

Use the existing coordinator engine, role groups, and provider adapters. Extend automatic team organization beyond recursive loops.

## Session experience

- **New session:** choose a project, select one or more coordinators from a combined Claude Code/Codex model picker, then start talking. Show provider, model, supported effort, and availability. Default to one Auto-selected coordinator; explicitly selected coordinators stay pinned.
- **Automatic team:** coordinators select or create roles, assign available models, and begin work within existing permissions and limits. Explain each assignment in the Team pane. Users can pin individual roles or agents while leaving the rest automatic.
- **Custom team:** users define roles and instructions, then assign one or more models or Auto slots. Coordinators work within that roster; missing required roles produce an actionable configuration request.
- **Conversation:** provide an `Auto / Discuss / Work` composer setting and a visible current-goal/New-goal target. Discuss answers without launching implementation. Auto distinguishes discussion, status, steering, and new work; ambiguous intent prompts clarification.
- **Persistent workspace:** keep one transcript, an editable Team pane, goal history, and contextual plan/check/change panes. Show a shared coordinator response with expandable attributed contributions. Preserve the Atlas appearance and compact layouts.
- **Queued goals:** run one goal or loop at a time, with parallel agents inside it. New goals continue from the session's latest accepted result, including results not yet applied to the project folder. Failed or stopped work contributes no unaccepted changes.
- **Controls:** pause and stop target the current session; individual goals retain their controls. Keep direct Claude Code/Codex sessions accessible under **Provider tools**. Existing loop enablement and acceptance/apply controls remain applicable.

## Implementation and interfaces

- Promote the existing coordinator conversation into the durable session identity. Add revisioned session configuration, an ordered work queue, active-work references, and an accepted-checkpoint reference. Provider-native conversations remain linked execution records.
- Add typed session create/list/query/update, message, queue, and control commands. Carry session identity into goals, loops, assignments, and read models. Include sessions containing only discussion in navigation and restart restoration.
- Introduce session-level role settings between project defaults and goal overrides. Snapshot inherited defaults when creating a session so subsequent project edits do not silently change it. Custom and generated role definitions belong to their session unless explicitly saved as project defaults.
- Add a versioned session protocol for conversational intake and team organization. Reuse qualified coordinator routes and existing structured-output enforcement. Replace punctuation-based routing for native-session messages with structured coordinator intent.
- Preserve peer decision-making: all selected coordinators contribute and endorse work/team decisions. Allow one reconciliation round, then present unresolved alternatives to the user. The first configured coordinator prepares the shared wording from peer contributions; this gives it no additional decision authority. Discussion can report differing views without blocking.
- Extract reusable organization logic from recursive loops. Support selecting existing roles, creating roles, choosing member counts, and assigning provider-qualified models. Automatic choices fill unlocked fields; manual selections remain authoritative. Model references retain provider and runtime identity, not just a model name.
- Apply team changes at safe round boundaries. Freeze configuration and assignment revisions for each round; stale responses cannot authorize new work. Reuse existing command receipts, scheduling, isolated workspaces, integration, review, and recovery mechanisms.
- Build bounded session context from recent messages, recorded decisions, relevant goal results, and the accepted checkpoint. Retain source references for older history. Coordinators receive the same frozen context; workers receive the relevant task context.
- Backfill existing coordinator conversations and loop associations without rewriting historical messages or evidence. Resolve existing goal/loop navigation identifiers to the corresponding session and work item. Preserve ongoing legacy executions; newly submitted work follows the session queue.

## Defaults and boundaries

- An **agent** means a provider/model configuration plus role instructions; importing named native-agent profiles is outside this change.
- Automatic team setup is the default. Explicit coordinator selections require user changes or an explicitly configured fallback when unavailable.
- Retain current capacity limits, member limits, permission checks, and model-readiness requirements. Automatic organization does not expand acceptance or publication authority.
- Recursive loops remain optional work items within a session. Ordinary conversation and automatic team setup do not require enabling loops.

## Validation and documentation

- Test single and multiple coordinators, mixed providers, Automatic/Custom/hybrid teams, generated roles, unavailable pins, conflicting decisions, and isolation between sessions.
- Test discussion without goal creation, actionable questions, steering versus queued work, accepted-result continuity, session-scoped stop, configuration changes during execution, duplicate commands, restart recovery, and legacy migration.
- Run `npm run check` and `npm run test:desktop`, adding session journeys covering setup, discussion, automatic delegation, manual overrides, a second goal, and restart in both themes and compact layouts.
- Validate the new flow with actual Claude Code and Codex routes. Record fixture tests, Electron inspection, live-provider results, CI, and packaged-platform qualification separately.
- Update the canonical design and coordinator specification, README guidance, implementation status, and affected loop/team documentation in the same implementation cycle. Check relative links and run `git diff --check`; report only validation actually performed.

## Review (29 October 2026)

The plan was reviewed against the code before implementation. It fits the existing machinery: peer coordinator rounds with frozen inputs, endorsements and one reconciliation turn ([engine.ts](../packages/orchestration/engine.ts)); the loop's validated team changes ([loop-engine.ts](../packages/orchestration/loop-engine.ts)); preset goal baselines; command receipts; and layered role settings ([membership.ts](../packages/orchestration/membership.ts)). The review settled these points, which the implementation follows. Items marked *inference* are design choices the plan left open.

| Point | Decision | Why |
| --- | --- | --- |
| Session identity | The session's ID is its conversation's ID, in a new `orch-session` record. No `sessionId` field is added to documents | Messages, goals and loop runs already name the conversation, so nothing is rewritten. The store already indexes `$.sessionId` for agent sessions, so reusing that name would collide |
| Intake cost | Every session message runs one turn per selected coordinator; with two or more, acting decisions add endorsement turns for members whose answer differed, and a wording turn by the first coordinator | The plan asks every coordinator to contribute and endorse; matching answers count as implied endorsements, as in coordination rounds |
| Goal objective | New work uses the owner's own message as the goal objective; coordinators decide the intent and the team, not a rewritten objective (*inference*) | Keeps the owner's request authoritative and the goal's acceptance evidence tied to what the owner wrote |
| Work and Discuss | **Work** always acts on the composer's target (steer the running goal, or queue new work); **Discuss** never acts. **Auto** takes the coordinators' structured intent; any **clarify** asks instead of acting | The plan's mode definitions; no punctuation or phrase routing for session messages |
| Team instructions in text | An explicit owner instruction in the message ("review with Fable and Sol") still applies to the goal as owner settings once the coordinators decide the message steers or starts it | The coordinator feature's UI-01 requires the message and editor paths to agree; this is the owner's setting, not routing |
| Safe boundaries | A configuration change, or an endorsed automatic team change, waits while the active goal has a round collecting, reconciling or endorsing, then applies. An intake whose configuration changed restarts once with fresh inputs; its earlier answers cannot act | Existing rounds already go stale on any group change; waiting avoids discarding in-flight work |
| Inherited defaults | A native session captures the project policy and project-role settings when created. Conversations from before sessions keep following the project's defaults as they change | Preserves legacy behavior; new sessions are not silently changed by project edits |
| Continuity | A session goal continues from the latest accepted result through a Topsl-owned copy bound to the new goal (`continueFrom`); its coordinators read that copy. Applying such a goal still needs the project folder to match its baseline, so the earlier goal is applied first (*inference*) | The plan's continuity requirement within the existing apply check, which refuses a folder that does not match the goal's starting point |
| Loops | Loops stay optional work items. A loop created in a session's conversation is its work item; a loop start is refused while the session runs other work, and a stopped or completed run with a promoted iteration sets the session's accepted result. A loop still captures its base from the project folder | Bounded change to the loop engine; starting a loop from the session's accepted result is left open (implemented in the [follow-up](#follow-up-29-october-2026)) |
| Provider tools | The existing **Sessions** project destination is labelled **Provider tools**; its stored view value stays `sessions` | "Session" now names a Topsl session; saved navigation keeps working |
| Legacy queue | A running legacy goal holds a backfilled session's queue, so new work waits behind it | "Run one goal or loop at a time" without interrupting legacy executions |

## Implementation record (29 October 2026)

| Area | What was built | Source |
| --- | --- | --- |
| Records | `TopslSession`: revisioned configuration (coordinators as member intents, Automatic or Custom team, session roles and required roles, composer mode), a pending change, captured defaults (`inherited`, null for legacy), the automatic team with reasons and refusals, the ordered queue, the active item, the accepted result, control state and generation, and attention (**Choose**, **Configure team**, **Choose model**). `SessionIntake`: one message's coordinator round with frozen context, input digest, members, attributed contributions per phase, candidate and outcome | [sessions.ts](../packages/domain/sessions.ts) |
| Protocol | `session-v1`: intake answers (intent, reply, question, team proposal with provider-qualified models) and the shared wording, schema-enforced through `purposeOutputSchema`; answers to another input digest are kept as history and cannot act. `decidePeers`: agreement acts, clarify asks, disagreement reconciles once and then goes to the owner as alternatives; the largest group of identical proposals leads, with order only breaking ties | [session-contracts.ts](../packages/orchestration/session-contracts.ts), [contracts.ts](../packages/orchestration/contracts.ts) |
| Supervisor | Create, backfill, update (with safe-boundary pending changes), message intake, launch and collection with retries and launch adoption after a restart, endorsement and wording phases, the owner's choice of alternatives, steering, the one-at-a-time queue continuing from the accepted result, function binding per team, session pause, resume and stop (including a running loop), queue reordering and removal, saving a session role as a project default, and thread resolution for saved `goal:` and `loop:` IDs | [session-engine.ts](../packages/orchestration/session-engine.ts) |
| Settings layers | Session layers sit between project and goal scope: captured defaults replace the live project layers for native sessions, the owner's session settings carry user authority, and the automatic team fills only open fields. Coordination rounds list only the roles the session uses; roles a session defines are hidden from other sessions | [session-layers.ts](../packages/orchestration/session-layers.ts), `effective` and `freeze` in [engine.ts](../packages/orchestration/engine.ts), `visibleRoles` in [repository.ts](../packages/orchestration/repository.ts) |
| Organization | Model eligibility per purpose, owner locks, member-change limits, role definitions and automatic member intents, shared by loops and sessions; `organizeSessionTeam` validates a session proposal against the team mode, locks, limit and observed models | [organization.ts](../packages/orchestration/organization.ts) |
| Commands and service | `session-create`, `session-list`, `session-query`, `session-update`, `session-message`, `session-choose`, `session-queue`, `session-control`, `session-role-save`; the supervisor ticks after the engine and the loop supervisor, recovers after them, and lists sessions in `coordinator-threads`; `navigation-query` resolves saved thread IDs | [session-commands.ts](../packages/domain/session-commands.ts), [service.ts](../apps/service/service.ts) |
| Screens | New session page (coordinator picker, team setup, composer mode), the session view (shared responses with **Contributions**, alternatives, attention banner, **Target**, session controls, **Team** and **Work** panes beside the goal panes), the sidebar's sessions, and **Provider tools** | [project-home.tsx](../apps/desktop/renderer/coordinator/project-home.tsx), [session-thread.tsx](../apps/desktop/renderer/coordinator/session-thread.tsx), [session-panes.tsx](../apps/desktop/renderer/coordinator/session-panes.tsx), [threads.ts](../packages/domain/threads.ts) |

Validation is recorded in [Implementation status](Implementation_Status.md#native-topsl-sessions--29-october-2026).

## Follow-up (29 October 2026)

After [PR #38](https://github.com/Piore-Galore/Topsl/pull/38) merged, the gaps it left open were addressed on branch `claude/session-gaps`:

| Gap | What changed | Source |
| --- | --- | --- |
| A loop started from the project folder | A loop in a native session copies the session's latest accepted result as checkpoint 0; the folder stays the publication base | `startFrom` in [loop-engine.ts](../packages/orchestration/loop-engine.ts), `captureBase` in [loop-checkpoints.ts](../packages/orchestration/loop-checkpoints.ts), [service.ts](../apps/service/service.ts) |
| Long conversations | An intake reads only the conversation's latest messages through the store's conversation index, and references the earlier range by sequence; a session's intakes are read by conversation instead of the whole project | `contextFor` and `intakes` in [session-engine.ts](../packages/orchestration/session-engine.ts), `buildSessionContext` in [sessions.ts](../packages/domain/sessions.ts) |
| Windows session, coordinator and loop journeys skipped | The journeys' stand-in is a compiled launcher on Windows, because Topsl refuses `.cmd` launchers for structured turns | [desktop-stand-in.mjs](../scripts/desktop-stand-in.mjs) |
| No packaged evidence | The session journey runs against the unpacked package with `TOPSL_PACKAGED_APP`, and CI runs it after packaging on every platform | [desktop-session-test.mjs](../scripts/desktop-session-test.mjs), [build.yml](../.github/workflows/build.yml) |
| No live evidence | `live-loop.mjs --session` runs a session with real Codex and Claude Code coordinators: discussion, a goal on the automatic team, acceptance, and a loop in the session from that result | [live-loop.mjs](../scripts/live-loop.mjs) |

Results: [Implementation status](Implementation_Status.md#native-session-follow-up--29-october-2026).
