# Coordinator teams: delivery and evidence

**Plan:** [Coordinator feature specification](Coordinator_Feature_Specification.md) (revision of 18 October 2026).\
**Recorded:** 18 October 2026, on the branch after `c5bac8e`. Required checks, per-file conflict choices and applying to the project folder were added the same day on branch `coordinator-checks` after `989be61` ([follow-up](#follow-up-checks-conflict-choices-and-applying-18-october-2026)).\
**Scope:** What the coordinator feature implements, how it was verified, and which release gates remain open. Fixture protocol tests, service tests with a stand-in runtime process, actual Electron UI journeys, live provider runs and packaged platforms are separate results here, as [AGENTS.md](../AGENTS.md) requires.

## Summary

Topsl now has a persistent project conversation backed by role groups with any number of members. A goal is planned by a coordinator group, delegated as a typed task graph, worked by role groups in Topsl-owned snapshot copies, integrated into one candidate, reviewed by a review group behind a completion barrier, and accepted by the owner through one confirmation. Every role (coordinator, planner, implementer, reviewer, tester, integrator, researcher, documentation, or a custom role) uses the same membership, selection, round, completion and scheduling machinery. Nothing in the schemas, service, persistence or screens limits a role to two members; the only ceiling is the configurable members-per-role policy (default 8, at most 64).

The release gates the plan sets are **not** met: no live provider run has used the feature, Claude's managed structured route stays gated, and no production route yet qualifies the bounded native fan-out that parallel waves need. The feature is therefore a **partial** delivery in the plan's terms. The named Opus, Astra, Fable and Sol labels have been exercised only as fixture catalog entries, which are not evidence for those models.

## What is built

| Area | Implementation | Source |
| --- | --- | --- |
| Role groups and members | Roles, groups, member intents keyed by stable member IDs, three selection forms (Auto, Exact members, Required members + Auto), exact or minimum/maximum counts, distinct-model and distinct-provider constraints, explicit fallbacks, collaboration mode, scheduling, execution width, completion and decision policy, requested-only versus verified model evidence | [role-groups.ts](../packages/domain/role-groups.ts), [roles.ts](../packages/orchestration/roles.ts) |
| Scope precedence | Application defaults, project policy, project-role settings, goal-wide policy, goal-role override and task override, each overriding only the fields it sets. A change at the same scope merges by default; the role editor saves the whole scope (replace). An exact roster closes membership at its scope; "Return to Auto" releases one member's pin or the whole role's roster and count. An owner count above an owner maximum set at the same or a narrower scope is a named conflict: the requested count is kept and the role is blocked until one is changed. A count set at a narrower scope than the maximum supersedes it (*20 October 2026, D-25*) | [membership.ts](../packages/orchestration/membership.ts) |
| Conversation instructions | Messages such as "coordinate with Opus and Astra, review with Fable and Sol", "use five reviewers; include Fable and Sol", "use three coordinators and four implementers", "use at most three reviewers", "use two different models", "prefer different providers", "use Sol first, then Fable" and "use Sol; fall back to Fable if unavailable" produce the same persisted settings as the editor, recorded with the source message | `parseMembership` in [membership.ts](../packages/orchestration/membership.ts) |
| Auto selection | Filters authorized routes by purpose readiness, catalog freshness and account binding, pins and effort support; chooses a count within bounds (one for a simple goal, two for complex work, never fewer than the pinned members); ranks by member preferences, soft diversity and stable order; records a reason per member. Pins are never replaced by a provider default; an unknown or ambiguous label stays unresolved; Auto never clones a model to satisfy a distinct-model requirement; an exact roster never shrinks | [selection.ts](../packages/orchestration/selection.ts) |
| Assignments | Each member resolves to an exact provider, route, installation revision, executable identity, native account and profile, billing route, model and effort. Any change of that tuple is a new assignment revision; rounds freeze assignment revisions, not only member IDs | `upsertAssignment` in [repository.ts](../packages/orchestration/repository.ts) |
| Execution purposes | Coordinator contribution, coordinator endorsement, information, implementation, candidate review and direct chat, separate from read-only or edit mode. Each purpose has its own readiness requirements and output contract; a read-only coordinator's output is never parsed as a candidate review | [roles.ts](../packages/orchestration/roles.ts), [contracts.ts](../packages/orchestration/contracts.ts), `purposeReadiness` and `assertCoordinatedReady` in [manager.ts](../packages/runtime/manager.ts) |
| Coordination rounds | Frozen inputs (goal, plan and control revisions, roster digest, event cursor), independent initial proposals, validation of every proposal (actions, roles, grant, dependency cycles, partitions per member, delegated-task budget, snapshot digest), deterministic combination only where compatibility is demonstrable (proposals for one action key that agree on kind, role, dependencies, permitted outputs and partition scopes combine, with their wording merged: first title, attributed briefs, union of acceptance criteria; *21 October 2026*), one bounded reconciliation, exact-candidate endorsements (a proposal that already names the exact action set supplies its member's endorsement; a merged candidate matches no proposal, so every member endorses or challenges it explicitly), a frozen electorate and threshold, required endorsers, and one transactional commit keyed by the decision digest | [engine.ts](../packages/orchestration/engine.ts), [policy.ts](../packages/orchestration/policy.ts), `combineProposals` in [contracts.ts](../packages/orchestration/contracts.ts) |
| Disagreement | Unresolved conflicts never dispatch. A conflict is a structural difference for one action key, or wording too long to merge within the action limits; wording alone is not. After the bounded exchange the round waits for the owner, who chooses one attributed proposal; other proposals and dissent stay recorded | `chooseBranch` in [engine.ts](../packages/orchestration/engine.ts) |
| Work and integration | Plan actions are an outbox: each admitted action freezes a work round for its role group, partitioned (one partition per member) or independent. Each implementation member runs in its own writable copy of the goal's frozen Git baseline; Topsl captures its candidate and refuses files outside its permitted outputs (unexpected files keep the output-review gate). Member candidates integrate in one controlled copy, which Topsl keeps under the profile folder (`orchestration-integrations`) so checks can prove the candidate unchanged; a file changed differently by two members is a conflict for the owner, never a textual merge | [runtime-driver.ts](../packages/orchestration/runtime-driver.ts) |
| Conflict choices | Each conflict names the path and every member version (member, task, candidate). `orchestration-conflict-resolve` records the owner's choice of one member's whole version per path, as parallel specialists' integration resolutions do; partial choices keep the goal blocked on the rest. The next integration uses the chosen versions, produces a new candidate and a new required review; a choice applies only to the candidates it was made for | `resolveConflicts`, `finishPlan` in [engine.ts](../packages/orchestration/engine.ts); `integrate` in [runtime-driver.ts](../packages/orchestration/runtime-driver.ts) |
| Required checks | A code goal carries check definitions, given with the message (`checks`) or with `orchestration-checks-set` until a work round freezes. The check protocol is bound at the goal's baseline (`bindCheckInputs`), so a member cannot change the tests, check configuration or referenced scripts a check reads. Once the review group is satisfied the goal is **Checking**: `orchestration-checks-preview` creates check plans for the exact integrated candidate on a tester task, and `orchestration-check-apply` runs one after the same native confirmation and trusted digest as Build and review, through `previewCheck`/`executeCheck`. Only current, uninvalidated evidence for that task, candidate and revision counts; a stopped goal's checks are fenced | `setChecks`, `previewChecks`, `runCheck`, `checkStatus` in [engine.ts](../packages/orchestration/engine.ts); [verification.ts](../packages/workflows/verification.ts), [check-executions.ts](../packages/workflows/check-executions.ts) |
| Review groups | Every required reviewer reviews the same frozen candidate in a fresh session with its own read-only copy and scoped candidate reader. The review completes only when every required report is valid; overlapping findings deduplicate while keeping every observation and the reviewers who did not mention it; a finding stays blocking until the owner records a finding-specific disposition with a rationale, or a bounded repair produces a new candidate that a new required round reviews | `completeReview`, `decideFinding`, `repair` in [engine.ts](../packages/orchestration/engine.ts) |
| Scheduling | Team size N is separate from execution width W. Capacity-bounded waves start only when the previous wave has finished (five members at width two run 2 + 2 + 1); a wave is reserved whole or not at all, and queued members hold nothing. Strict all-at-once scheduling beyond capacity blocks visibly with the roster intact; a strict cohort that partly fails to start interrupts its started peers and releases never-started members. A route with unknown native fan-out still reserves the whole budget | [schedule.ts](../packages/orchestration/schedule.ts) |
| Controls | Pause, stop, resume, stop member and restart round are service operations that never consult a model. Pause and stop advance the goal's control generation and interrupt active members; uncertain executions keep their leases and capacity. Steering advances the goal revision, so earlier coordination candidates cannot commit, and admitted work keeps its scope. A late result from an ended round is kept as stale history. A status question (`routing: "status"`, or a message such as "What is the status?" under `auto`) reports on the active goal, or on the conversation's latest goal when none is active, and never creates a goal (*20 October 2026, D-13*) | `controlCommand`, `steer` in [engine.ts](../packages/orchestration/engine.ts) |
| Recovery | Each launch is recorded before dispatch; after a restart the engine adopts the recorded attempt instead of starting another, and never replays an uncertain native start. Repeated commands with the same command ID return the first receipt | `recover`, `receipt` |
| Information goals | Plans of information tasks complete with attributed artifacts and a service-rendered synthesis, with no candidate or check | `finishPlan` in [engine.ts](../packages/orchestration/engine.ts) |
| Acceptance | One acceptance path: the owner confirms in Topsl's native dialog the exact candidate covered by the satisfied review completion and, when the goal has required checks, current passing evidence for each of them on that candidate. The digest covers the review, finding dispositions, tester task and check results; a stale digest is refused. Acceptance records the decision only | `accept`, `acceptanceDigest` in [engine.ts](../packages/orchestration/engine.ts); [main.ts](../apps/desktop/main.ts) |
| Applying to the project folder | `orchestration-apply` writes the accepted candidate's changed files into the project folder after a native dialog that lists the folder, Git commit and every file. The review is refused before any dialog when the folder has uncommitted or untracked changes, no longer matches the goal's baseline (commit, tracked files or contents), was relinked, or is not Git; the driver checks again immediately before writing. The intent is recorded first; each written file is read back and hashed. A refusal is recorded and can be retried; an apply that may have written is **uncertain** and is never repeated; an applied candidate cannot be applied again. Nothing is staged or committed | `applicationReview`, `apply` in [engine.ts](../packages/orchestration/engine.ts); `applyPreview`, `apply` in [runtime-driver.ts](../packages/orchestration/runtime-driver.ts) |
| Service and screens | `orchestration-*` commands, a runtime-backed driver over existing tasks, attempts, sessions, leases, the concurrency budget and context grants, and, since 28 October 2026, coordinator conversations listed per project ([follow-up](#follow-up-conversations-as-threads-28-october-2026); before that a **Coordinator** section in the project overview): conversation, compact team lines ("Coordinators: Opus + Astra"), an N-member role editor with cross-provider model search, a model picker and typed model ID pins ([follow-up](#follow-up-role-editor-model-picker-27-october-2026)), per-member pin/Auto/required/remove and visible totals, round progress with member cards (requested and effective model, route, Auto or pinned, reason, state), endorsements, branch choice, findings with dispositions, required-check fields for new goals and for a goal before implementation, check results with **Prepare checks** and one **Run …** button per plan, conflict choices per file, **Apply to project folder…** with the recorded outcome, and goal controls | [orchestration-commands.ts](../packages/domain/orchestration-commands.ts), [service.ts](../apps/service/service.ts), [coordinator/](../apps/desktop/renderer/coordinator/) |
| Compatibility | Build and review drafts and routing presets are read as singleton groups without rewriting them: an untouched default stays an Auto slot with legacy provenance, and a Claude Code step keeps its native-default meaning as assisted participation, which cannot satisfy a managed exact-model member. Routing presets now key uniqueness by member identity, so one role can hold several members. Existing Build and review workflows keep their single builder and reviewer and their Claude Code steps unchanged; direct chats keep their provider-keyed sessions | `legacyDraftGroups`, `presetGroups`; `savePreset` in [advanced.ts](../packages/workflows/advanced.ts) |

### Persisted records

All records live in the existing encrypted store as documents, with immutable revisions where they change.

| Plan record | Store kind |
| --- | --- |
| `CoordinatorConversation`, messages with routing | `orch-conversation`, `orch-message` |
| `Goal` / goal revisions | `goal`, `goal-revision` |
| `RoleDefinition` (custom roles) | `role-definition` |
| `RoleGroupRevision`, `MemberIntent` | `role-group` (immutable per scope and revision) |
| `ResolvedMemberAssignment` | `member-assignment`, `member-assignment-revision` |
| `RoleRound` | `role-round`, `role-round-revision` |
| `ParticipantContribution` | `role-contribution` |
| `DecisionCandidate`, `DecisionEndorsement` | `decision-candidate`, `decision-endorsement` |
| `RoleCompletion`, finding dispositions | `role-completion`, `review-findings` |
| `CoordinatorPlan`, `QueuedPlanAction` | `coordinator-plan`, `plan-action` |
| `ControlEvent`, command receipts | `control-event`, `command-receipt` |
| Member/session bindings, launch records, task-to-goal bindings | `member-session`, `orchestration-launch`, `orchestration-task-goal` |

Member executions are ordinary tasks and attempts. Coordinator and information tasks have `workflowId: null`, the new task roles `coordinator` and `information`, and complete through a non-code result (`submitted`), never through candidate acceptance. The scoped candidate reader accepts a reviewer task with no workflow only through its explicit goal binding.

## Capability matrix

| Purpose | Requirements | Codex structured route | Claude structured route | Claude Code terminal step |
| --- | --- | --- | --- | --- |
| Coordinator contribution, endorsement, information | structured turn, native subscription, process lifecycle, fresh session, read-only | Eligible when the runtime qualification passes these for the current binding | Gated: production readiness reports `authentication-route-unapproved`; the adapter's structured transport is fixture-only | Not a coordinator member; assisted participation stays in Build and review |
| Candidate review | the above plus candidate reader | Eligible after qualification, as for Build and review | Gated | Build and review only |
| Implementation | structured turn, native subscription, process lifecycle, workspace write | Eligible after qualification | Gated | Build and review only |
| Parallel waves of width above one | the route's capability `native-fanout-disabled` | Not produced by the current qualification, so each member reserves the whole budget and members run one at a time | Gated | — |

The cross-provider examples in the plan therefore cannot run as automated groups today: any Claude member resolves as unavailable with the readiness blocker as its reason, and is not substituted.

## Phase status

| Phase | Exit criteria | Status on 18 October 2026 |
| --- | --- | --- |
| 0 — Contracts | Contracts and capability matrix for both providers, explicit route gaps, provider-neutral harness | Met for contracts, matrix and harness ([scripted driver](../tests/orchestration-fixture.ts)). The exact-model production Claude route is **not established**: no supported production route exists in the repository, and none was added |
| 1 — Persistence and migration | Solo meaning kept; 1, 2, 3 and 5 members keep distinct identities, including two members on one account; settings survive restart and round changes; limits work without a hidden ceiling | Met in fixture and service tests. Old records are read through compatibility readers rather than rewritten |
| 2 — Auto and model-controlled routes | Every eligible catalog model assignable to every role its route satisfies; no native-default substitution; mismatches cannot satisfy a role; cross-provider qualification before presentation | Met for selection, freshness and account binding, and mismatch handling. Not met for qualified cross-provider automatic execution (Claude gated) |
| 3 — Coordinator conversation and decisions | N contributions, one plan; unanimous and three-of-five decisions; dissent retained; missing participation blocks; no duplicate work; no blind replay; controls without models; information goals | Met in fixture tests, and for two coordinators through the service with the stand-in runtime |
| 4 — Review groups and workers | Barrier for 2, 3 and 5 reviewers; four clean reports cannot erase a fifth's finding; three-member implementation group; integrated candidate reviewed; waves and honest queuing | Met in fixture tests; two reviewers, two implementers and integration through the service with the stand-in runtime. Required checks on the integrated candidate, per-file conflict choices and applying the accepted candidate were added in the [follow-up](#follow-up-checks-conflict-choices-and-applying-18-october-2026), verified in fixture and service tests |
| 5 — Product UI and end-to-end evidence | Full goals on managed routes for the original examples and larger teams; live runs against observed models | **Not met.** An actual Electron journey against a qualified Codex stand-in now covers UI-01, UI-02 and one goal from the conversation to acceptance ([journey record](#electron-journey-18-october-2026)). No live provider run, no larger-team Electron goal and no packaged-platform run was performed |

## Acceptance scenarios and their evidence

"Fixture" means [orchestration.test.ts](../tests/orchestration.test.ts) with the scripted driver. "Service" means [orchestration-service.test.ts](../tests/orchestration-service.test.ts): the real service, runtime manager, attempts, leases, budget, copies, capture and integration, with a Codex stand-in process ([codex-orchestration.cjs](../tests/fixtures/codex-orchestration.cjs)). "Electron" means [desktop-coordinator-test.mjs](../scripts/desktop-coordinator-test.mjs): Topsl's own screens in Electron with a synthetic profile, against a Codex stand-in registered and qualified as a runtime ([codex-desktop-coordinator.cjs](../tests/fixtures/codex-desktop-coordinator.cjs)). None of these contacts a model.

| ID | Evidence |
| --- | --- |
| RG-01, RG-05 | Fixture: "any qualified model for any role; Auto respects count and capability" |
| RG-02, RG-03, CO-01 | Fixture: "Opus + Astra coordinate, Fable + Sol review"; Service: two coordinators and two reviewers to acceptance |
| RG-04 | Fixture: "two members of one provider and one account"; Service: distinct `member-session` records |
| RG-06, RG-14 | Fixture: "five reviewers with two pins fill three Auto slots"; E2E-01 test |
| RG-07, RG-12 | Fixture: "rosters survive restart and replan; reassignment mid-round freezes a new assignment map" |
| RG-08 | Fixture: unknown, ambiguous and stale labels; "assisted or unresolved required members block the role" |
| RG-09 | Fixture: model-evidence unit test and the goal-level mismatch test |
| RG-10 | Fixture (assisted pins); the Build and review Claude Code step suites are unchanged |
| RG-11 | Fixture: explicit fallback with retained primary intent |
| RG-13, RG-15 | Fixture: twelve members kept above a limit of eight, valid once the limit is raised; three- and five-member goals |
| CO-02 | Fixture: conflicts reach owner choice; repeated choice commits once |
| CO-03, EX-05 | Fixture: steering during endorsement; pause, resume and stop |
| CO-04, CO-07 | Fixture: a failing required coordinator blocks a two-of-three rule |
| CO-05 | Fixture: duplicate command IDs; launch adopted after a simulated crash |
| CO-06, CO-08 | Fixture: three-of-five with two challenges commits, denominator five; duplicate votes, wrong digests and required-endorser dissent |
| RV-01, RV-06 | Fixture: four clean reports and one finding block; repair is re-reviewed by all five |
| RV-02, RV-07 | Fixture: "3 of 5 reviews returned; 1 running; 1 queued"; an invalid required report keeps the review incomplete |
| RV-03 | Fixture: deduplication keeps observations and silent reviewers |
| RV-04 | Fixture: a changed candidate makes the review stale |
| RV-05 | Partly: member cards show model, route and selection; reviewer copies and fresh sessions are recorded. No isolation is claimed beyond that |
| EX-01, EX-02 | Fixture: unknown fan-out runs one member at a time; stages release capacity between turns |
| EX-03 | Service with a stand-in that declares bounded fan-out only; no production route qualifies it |
| EX-04, EX-12 | Fixture: three-member partitioned implementation; Service: two implementers integrated |
| EX-06 | Unchanged Build and review behavior ([claude-steps.test.ts](../tests/claude-steps.test.ts)) |
| EX-07 | Partly: coordinator purposes run read-only and implementation copies are separate from the project folder; auto-accept applies through the runtime as before. No dedicated test |
| EX-08 | Fixture: information goal |
| EX-09, EX-10, EX-11 | Fixture: strict cohorts and waves |
| UI-01 | Fixture: instruction parsing matches editor settings. Electron: pinning three reviewers, removing one, returning one to Auto, and the plan's "coordinate with Opus and Astra, review with Fable and Sol" save the same settings through the role editor (project defaults) and through conversation messages (the goal), with no conflicts; the whole role returns to Auto from the editor; the goal's team lines, round progress and member cards follow the changes, and both paths' settings survive a restart |
| UI-02 | Electron: in a 560 × 720 window, a third, fourth and fifth reviewer are added and the fifth made optional and returned to Auto by keyboard alone; the list stays one role of five, the totals read "5 members listed of 5" with the exact count 5, every member's controls scroll into view, and the page does not scroll sideways |
| MG-01 | Fixture: legacy drafts and presets; existing suites for in-flight Build and review workflows |
| E2E-01, E2E-03 | Fixture only. The Electron journey runs a two-coordinator, two-reviewer goal to acceptance, which is not these scenarios' larger teams |
| E2E-02, E2E-04 | Not met: needs a production route with qualified bounded fan-out and live lifecycle evidence |
| Required checks (follow-up) | Fixture: "CK-01: acceptance needs the review group and current passing evidence for every required check on the exact candidate" and "CK-02: checks belong to code goals, have distinct IDs and are fixed once implementation starts; stopping fences them". Service: "a required check runs against the exact integrated candidate, gates acceptance, and the accepted candidate is applied to a clean folder" runs a real check process through check plans, the trusted digest and a tester task |
| Conflict choices (follow-up) | Fixture: "CF-01: the owner chooses one member's version per conflicting file; the result is integrated and reviewed again". Service: "two implementers' different versions of one file conflict; the owner's per-file choice is integrated and reviewed" |
| Applying (follow-up) | Fixture: "AP-01" (digest, dirty-folder refusal, no second apply) and "AP-02" (uncertain outcome is not retried). Service: the required-check test above refuses an untracked file and a new commit, then writes `file.ts` into the real Git folder without committing |

## Limits and open gates

- **Live providers.** No live provider run, paid turn or real runtime used this feature. For the Claude Code workflow runs, the owner chose on 18 October 2026 to stop the live runs ([Claude workflows plan](Claude_Workflows_Plan.md#step-5-follow-up-the-claude-with-claude-rerun-18-october-2026)); this feature was not run live either.
- **Claude managed route.** Still gated; this work did not add or qualify a production Claude structured route, and did not reuse the fixture transport. *Follow-up, 19 October 2026:* by the owner's decision, the route is now implemented behind **Settings → Claude Code structured route** and a Claude runtime qualification ([Implementation status](Implementation_Status.md#claude-structured-route--19-october-2026)); one live mixed Claude and Codex loop has completed with it.
- **Parallel execution in production.** Codex qualification does not produce `native-fanout-disabled`, so every managed member reserves the whole budget and members run one at a time. The screens show them as queued.
- **Failing checks have no automatic repair.** A failing or erroring required check keeps the goal in **Checking**; rerun it on the same candidate, or steer the goal to replan. A bounded repair round is driven by review findings only.
- **One check from the screen.** The service takes up to 20 check definitions per goal; the Coordinator section's form sets one. Checks run one at a time from the screen and are not started automatically.
- **Integration copies are kept.** Each integrated candidate keeps its source copy under the profile's `orchestration-integrations` folder so checks can prove it unchanged; Topsl does not remove these copies yet. Removing one only makes checks on that candidate fail closed.
- **Applying writes, it does not commit.** Applying refuses any uncommitted or untracked change in the folder, including unrelated ones, and does not stage, commit or push. Ignored files are not inspected. Native tools that watch the folder may react to the write.
- **Git projects only for code goals.** The baseline snapshot needs a Git checkout; a non-Git folder has no implied file selection. Coordinator turns in a non-Git project get the brief alone.
- **Coordinator context.** Coordinators receive the frozen goal, constraints, rosters and completed results in their prompt, and a read-only copy of the baseline. There is no separate project-state reader tool yet.
- **Not implemented from the plan.** An optional adjudicator, independent plan subsets proceeding while another branch is disputed, deliberation while workers run, learned performance preferences, cross-goal fairness beyond the shared budget, and a model-written final synthesis (the synthesis is rendered from recorded facts).
- **Screens.** Exercised in Electron against a Codex stand-in only ([journey record](#electron-journey-18-october-2026)): the role editor, conversation, controls, round progress, member cards and acceptance. Branch choice, findings with dispositions, repair, information goals, larger teams in a running goal, and the check, conflict-choice and apply controls from the [checks follow-up](#follow-up-checks-conflict-choices-and-applying-18-october-2026) and their native dialogs were not exercised on screen.

## Validation record

Recorded on 18 October 2026 on macOS (Darwin 27), Node from the repository's Electron runtime, in this checkout after `c5bac8e`. This session's shell exported `ANTHROPIC_BASE_URL`, which Topsl's subscription-only preflight refuses, so the tests ran with that variable unset, as a clean launch environment would have it.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `env -u ANTHROPIC_BASE_URL node scripts/test.mjs tests/orchestration.test.ts` | 31 tests passed |
| `env -u ANTHROPIC_BASE_URL node scripts/test.mjs tests/orchestration-service.test.ts` | 2 tests passed |
| `env -u ANTHROPIC_BASE_URL node scripts/test.mjs tests/advanced-workflows.test.ts tests/provider-readiness.test.ts tests/workflow-service.test.ts` (with the two files above) | 66 tests passed across the five files, including the member-identity preset test |
| `env -u ANTHROPIC_BASE_URL npm test` | 462 passed, 4 skipped, 25 failed. All 25 failures are in [environments.test.ts](../tests/environments.test.ts) and [round2-acceptance.test.ts](../tests/round2-acceptance.test.ts), and the same 25 fail on an untouched checkout of `c5bac8e` on this host: those tests look for `npm-cli.js` beside the Electron binary, which this machine's Electron install lacks |
| `npm run build` | Passed (renderer chunk-size warning from Vite) |
| `git diff --check`, trailing-whitespace scan of new files, relative-link check of changed docs | Clean |

Not run: `npm run test:release`, the desktop test runner (`npm run test:desktop`), packaging, and any live provider session.

## Follow-up: checks, conflict choices and applying (18 October 2026)

**Scope.** Closes three limits recorded above on the same day: coordinator goals now run required checks against the exact integrated candidate and acceptance requires their current passing evidence; an explicit, natively confirmed step applies the accepted candidate to the project folder; integration conflicts get a per-file choice of one member's version. Built on branch `coordinator-checks` after `989be61`.

**Decisions.**

- Checks run after the review group is satisfied, as in Build and review, so the goal state **Checking** sits between **Reviewing** and **Awaiting acceptance**. Checks are fixed once a work round freezes, because their protocol is bound at the goal's baseline.
- The integrated candidate's source copy is kept so the existing check machinery can prove the candidate unchanged; the earlier implementation removed it after capture.
- Applying is separate from acceptance and needs its own confirmation. It requires a Git folder with no uncommitted or untracked changes that still matches the baseline, so the write never mixes with other work. A refusal is recorded and retryable; a possibly partial write is recorded as uncertain and is not retried.
- Conflict choices do not need a native dialog, unlike parallel specialists' integration plans: they write only a Topsl-owned copy, and the result is reviewed and checked again before acceptance.

**Validation.** macOS (Darwin 27), Node from the repository's Electron runtime, in the `coordinator-checks` worktree, with `ANTHROPIC_BASE_URL` unset.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `env -u ANTHROPIC_BASE_URL node scripts/test.mjs tests/orchestration.test.ts` | 36 tests passed (31 earlier, plus CK-01, CK-02, CF-01, AP-01 and AP-02) |
| `env -u ANTHROPIC_BASE_URL node scripts/test.mjs tests/orchestration-service.test.ts` | 4 tests passed (2 earlier, plus the required-check-and-apply and per-file conflict tests) |
| `env -u ANTHROPIC_BASE_URL npm test` | 494 passed, 4 skipped, 0 failed across 50 files. The 25 [environments.test.ts](../tests/environments.test.ts) and [round2-acceptance.test.ts](../tests/round2-acceptance.test.ts) failures recorded above did not occur in this run; the cause of the difference was not investigated |
| `npm run build` | Passed (renderer chunk-size warning from Vite) |
| `git diff --check`, relative-link check of changed docs | Clean |

The service tests ran a real check process (`node -e` reading `file.ts`) through `previewCheck`, the trusted digest and `executeCheck` on a tester task, refused an apply for an untracked file and for a new commit, and wrote `file.ts` into a real Git folder without committing. The conflict test used the stand-in's opt-in `[distinct versions]` marker so two implementers write different versions of `file.ts`.

Not run: the desktop test runner, an actual Electron session (the new controls and the check, acceptance and apply dialogs were not exercised), packaging, and any live provider session.

## Electron journey (18 October 2026)

A follow-up to the validation record above, on branch `coordinator-journeys` after `989be61`, macOS 27.0.1 arm64, Electron 44.4.5, with `ANTHROPIC_BASE_URL` unset. It is Electron UI evidence against a stand-in only: no model, account or live runtime was contacted, the Opus, Astra, Fable and Sol labels are the stand-in's catalog entries, and no packaged build was used.

### What the journey does

[desktop-coordinator-test.mjs](../scripts/desktop-coordinator-test.mjs) starts Topsl in Electron with a temporary profile and a Git project, and registers, trusts, connects, catalogs and qualifies the stand-in [codex-desktop-coordinator.cjs](../tests/fixtures/codex-desktop-coordinator.cjs) through typed IPC (the main desktop test covers the same steps through the setup screen). The stand-in is the qualification suite's scripted app-server ([codex-qualify.cjs](../tests/fixtures/codex-qualify.cjs)) that also answers coordinator turns as the service tests' stand-in does ([orchestration-answers.cjs](../tests/fixtures/orchestration-answers.cjs)), each turn after 1.2 seconds so a round can be watched and paused. Everything after that goes through the **Coordinator** section of the project **Overview**:

| Step | Through the screens | Checked |
| --- | --- | --- |
| Routes | — | Every coordinator purpose reports ready for the qualified stand-in |
| UI-01 conversation | Send "Change the value to two in file.ts.", **Pause** the goal, then steer it with "Review with Astra, Sol and Fable", "Review with Astra and Sol" and "Use two reviewers; include Astra" | The goal's team line follows each message |
| UI-01 editor | **Project role defaults → Reviewers → Edit**: Exact members, add Astra, Sol and Fable; **Remove** Fable; **Return to Auto** on Sol; **Save reviewers** after each | After each pair, the project defaults (editor) and the goal (conversation) hold the same form, total, pins and Auto slots, with no conflicts |
| UI-01 whole role | **Return whole role to Auto** | The saved role is Auto and the editor shows "Reviewers: Auto" with an empty list |
| Plan example | "Coordinate with Opus and Astra, review with Fable and Sol" as one message; the same through the editor for both roles | Same settings for both roles on both paths; team lines read "Coordinators: Opus + Astra" and "Reviewers: Fable + Sol" |
| Goal run | **Resume** | The coordinator round shows two member cards (requested Opus and Astra, codex) and a "2 of 2" decision rule while it runs; the goal reaches **Awaiting acceptance**; the review round shows the service's progress text and two pinned member cards with effective models `fixture-fable` and `fixture-sol` |
| Acceptance | **Accept candidate…** | Topsl's native dialog ("Accept this reviewed candidate?", buttons Cancel and Accept candidate) names the goal, the review group and that no required checks ran; the goal shows **Accepted**; the project folder is unchanged |
| UI-02 | Window 560 × 720; from the model search, by Tab, Shift+Tab, Enter and Space only: add Fixture, Opus and Astra to the two reviewers, clear the fifth's **Required**, **Return to Auto** on it, **Save reviewers** | One list of five; "5 members listed of 5", exact count 5 and no smaller "At most" beside it; the first four stay required; each member's controls scroll into view; no sideways scroll; the saved role holds all five members with no conflicts |
| Restart | Reopen the same profile | Project defaults, the goal's rosters and its accepted state are unchanged |

Screenshots are written to `test-results/coordinator-*.png` (not committed).

### Defects found and fixed

| Defect | Effect before the fix | Fix |
| --- | --- | --- |
| Goal progress made by the background tick was not published | The service reached "awaiting acceptance", but the screen stayed on "1 of 2 reviews returned; 1 running" until some other change arrived | `tick` in [engine.ts](../packages/orchestration/engine.ts) notifies when it wrote anything |
| **Return to Auto** on a member of an exact roster saved an exact roster with an open slot | The editor and the conversation disagreed (exact versus Required members + Auto), and the service flagged the saved role ("has no model choice") | The editor now does what the service's release does: the role becomes Required members + Auto with the roster's count (then `coordinator-teams.tsx`; since 28 October 2026 [role-editor.tsx](../apps/desktop/renderer/coordinator/role-editor.tsx)) |
| **Return whole role to Auto** left the editor showing the released roster | A later save would bring the released members back | The editor resets to Auto after the release succeeds |
| The editor showed and saved the derived "At most" beside an exact count | Five reviewers read "Exact count 5" beside "At most 3" | "At most" is hidden and not saved while an exact count is set, as a conversation message saves it |

Reverting only the editor changes made the journey fail at the Return to Auto comparison (`form` "exact" instead of "required-plus-auto"); before the `tick` change it failed waiting for **Awaiting acceptance** while the service already held that state.

### Commands and results

| Command | Result |
| --- | --- |
| `env -u ANTHROPIC_BASE_URL npm run build` | Passed (renderer chunk-size warning from Vite) |
| `env -u ANTHROPIC_BASE_URL npm run test:desktop` | Passed: the main desktop harness and its encrypted restart, then the coordinator journey |
| `env -u ANTHROPIC_BASE_URL node scripts/test.mjs tests/orchestration.test.ts tests/orchestration-service.test.ts tests/runtime-qualification.test.ts` | 47 tests passed across the three files |
| `env -u ANTHROPIC_BASE_URL npm run typecheck` | Passed |
| `env -u ANTHROPIC_BASE_URL npm test` | 487 passed, 4 skipped, none failed (47 files passed, 3 skipped). The 25 failures in environments and Round 2 acceptance recorded above did not occur in this worktree, whose `node_modules` is a symbolic link to the main checkout's; the cause was not investigated |
| `git diff --check`, Prettier on changed code, relative-link check of changed docs | Clean |

### Not covered

Branch choice, findings and dispositions, repair, information goals, stop and steering of a running goal on screen, larger teams in a running goal (E2E-01, E2E-03), Claude members, Linux and Windows (the journey skips Windows, where the stand-in's shell wrapper cannot run), CI, packaged builds and live providers.

## Follow-up: engine prerequisites for Recursive Looping (19 October 2026)

[Recursive Looping](Recursive_Looping.md) runs each iteration as an ordinary coordinator goal. Its prerequisites changed the engine for every goal ([§11 there](Recursive_Looping.md#11-coordinator-engine-changes-rl-0)):

- **Planning sees the resolved roster.** The coordinator prompt now lists each role's resolved members (and how many cannot run now) instead of the configured minimum, so a complex goal's two Auto implementers are planned as two. A partitioned task whose roster changed after planning, or whose partitions would drop a required member, blocks with a replan request instead of trimming members. Three scripted plans in [orchestration.test.ts](../tests/orchestration.test.ts) that encoded the old count now read the roster from the prompt ([rosterPlan](../tests/orchestration-fixture.ts)).
- **Fencing.** Rounds freeze role-definition revisions; a role redefined while its plan is being decided makes that round stale.
- **Purpose compatibility.** An implementation action must go to an implementation role and an information action to an information role; an action for a role with no runnable member is invalid.
- **Dependency handoff.** A dependent task gets a typed bundle of its predecessors' results; a code task starts from an assembled baseline with its predecessors' changes, and final integration uses that ancestry.
- **Function bindings, repair and integration.** Coordination, review and repair use a goal's function bindings (the built-in roles by default). Repair can be driven by failing checks or unmet criteria, and overlapping changes can go to an integration task. The single-goal conversation still offers only finding repair and per-file choices; loops use the rest automatically.
- **Owner authority first.** A role-group revision written by anything other than the owner fills only fields no owner setting fixes, at any scope.
- **Protocol on every turn.** Member turns carry `protocol` (`coordinator-v1` here), which with the purpose selects the runtime's output schema.

Verified by [loop-prerequisites.test.ts](../tests/loop-prerequisites.test.ts) (resolved roster, TM-06, TM-07, TM-08, CP-07, protocol), the unchanged [orchestration.test.ts](../tests/orchestration.test.ts) and [orchestration-service.test.ts](../tests/orchestration-service.test.ts), and the coordinator Electron journey, which now opens behind the **Run mode** selector (Single goal). Results: [Implementation status](Implementation_Status.md#recursive-looping--19-october-2026).

## Follow-up: role editor model picker (27 October 2026)

**Problem.** The owner reported that searching for models to add to a role did not work. The editor's search only filtered a list of **Add …** buttons built from the observed model catalogs (`snapshot.routes[].models`). When no catalog was loaded (a Codex runtime not yet inspected, a catalog made stale by a runtime update, or Claude Code, which has no model list and keeps only models a qualification saw), every search showed "No observed model matches" and offered no way to add a model by name or ID. The search also matched the whole text as one string, so "opus claude" found nothing.

**Change** (then `coordinator-teams.tsx`; the editor and these helpers are in [role-editor.tsx](../apps/desktop/renderer/coordinator/role-editor.tsx) since 28 October 2026):

- **Model picker.** The button list is replaced by a **Model** dropdown of the observed options, grouped by provider and narrowed by the search, with **Add selected model**. Options unsupported by the role's route stay listed and say "unavailable now", with the reason shown when picked. A search that narrows to one model selects it.
- **Word search.** `filterModelOptions` matches every word of the search against provider, name and model ID, ignoring case.
- **Typed model ID.** When the search matches no observed model, `typedModelPin` offers **Pin model ID …** with an optional provider. The pin carries only `model` (and `provider`), so selection keeps it unresolved with "not in any observed catalog" until a catalog or Claude qualification observes that ID; nothing is substituted (RG-08, [selection.ts](../packages/orchestration/selection.ts)).
- **Empty catalog message.** With no catalog at all, the editor says to inspect a Codex runtime or qualify Claude Code, or to pin a typed ID.

**Verification (cloud container, Linux, 27 October 2026).** `npx tsc --noEmit` passed. `npx vitest run tests/role-model-search.test.ts tests/orchestration.test.ts` passed (2 files, 50 tests); [role-model-search.test.ts](../tests/role-model-search.test.ts) covers word search, typed pins with and without a catalog, schema validity, and no typed pin for an observed exact model, blank text or several words. `node scripts/build.mjs` built. The [coordinator journey](../scripts/desktop-coordinator-test.mjs) now adds members through the picker, and UI-02 types each model ID into the search and presses **Add selected model** by keyboard. That journey was **not run** here: Electron's native module rebuild could not download headers through this environment's proxy. It still needs a run on CI or the owner's Mac, and the picker has not been inspected in the running app.

## Follow-up: conversations as threads (28 October 2026)

**Problem.** The owner asked for the coordinator to work like Claude Code projects: each piece of work its own conversation, listed under its project. The service kept any number of conversations per project, but the screen used only `snapshot.conversations[0]`. Loop runs create a conversation of their own (`loop-create`), so after a loop was created first, Single-goal messages could be posted into that loop's conversation. In a conversation, any text that was not a status question, a control or a steering phrase ("also", "change", …) started a new parallel goal, so a follow-up such as "make it blue too" did not reach the goal it was about. Loop steering recorded nothing in the run's conversation.

**Design.** A *thread* is one coordinator conversation and its goals (`goal:<conversationId>`) or one loop run (`loop:<runId>`), described in [threads.ts](../packages/domain/threads.ts). A new goal thread starts with its own conversation; follow-ups in it are about that thread's latest goal.

**Service changes (Phase 1, no screen change):**

| Change | Behavior | Source |
| --- | --- | --- |
| `follow-up` routing | `orchestration-message` accepts `routing: "follow-up"`. The target is the named goal or the conversation's latest goal, ended or not. Controls are matched first ("stop everything", and "pause this goal" or "resume" only for a goal that has not ended); a status phrase, or a question while the goal runs, is a status request; anything else steers a running goal (`update-goal`) or, once the goal is stopped, accepted or completed, starts a related goal that keeps the parent's kind and required checks. `auto` routing is unchanged and now lives in `classifyMessage` | [routing.ts](../packages/orchestration/routing.ts), `post` in [engine.ts](../packages/orchestration/engine.ts) |
| `orchestration-conversation-start` | Creates a conversation titled from the first line of the message and posts it as a new goal. The conversation and the message keep their own receipts under the command ID, so a retry returns the same thread and goal | `startConversation` in [engine.ts](../packages/orchestration/engine.ts) |
| Thread notes | `note` records an unrouted message under its own receipt. Loop runs use it: `loop-create` records the owner's goals or priorities, and `loop-message` records the owner's text and then a short service note of what it changed (routing kind `loop-steer`) | `note` in [engine.ts](../packages/orchestration/engine.ts); `message`, `steeringNote` in [loop-engine.ts](../packages/orchestration/loop-engine.ts) |
| `coordinator-threads` | For each listed project: its threads newest first, the total, and how many need the owner. A conversation with no ordinary goal is not listed; a loop's conversation is that loop's thread, and ordinary goals recorded in it (the earlier `conversations[0]` defect) still appear as a goal thread. Threads waiting on the owner are listed past the limit. Attention: blocked → Decide, checking → Run checks, awaiting acceptance → Accept, an accepted code goal not yet applied → Apply (Check folder when uncertain); a loop not started → Review and start, and loop waits for input, authorization, allowance, a pinned model or reconciliation | `summarizeThreads`, `goalAttention`, `loopAttention` in [threads.ts](../packages/domain/threads.ts); `threadFacts` in [engine.ts](../packages/orchestration/engine.ts); `list` in [loop-engine.ts](../packages/orchestration/loop-engine.ts) |
| Thread queries | `orchestration-query` takes an optional `conversationId` and then returns only that conversation and its goals | `view` in [engine.ts](../packages/orchestration/engine.ts) |
| Navigation | `navigation-save` stores an optional `threadId`; `navigation-query` returns it, or `null` for older records and values that are not thread IDs | [service.ts](../apps/service/service.ts) |

Loop steering that only sets a provider exclusion, a kept role or an active-role count now reports `membership` instead of `none`, so its note says the team settings changed.

**Verification (macOS arm64, 28 October 2026).** `npx tsc --noEmit -p .` passed. `npm test -- tests/coordinator-threads.test.ts` passed (10 tests): auto routing unchanged, follow-up steering and continuation with the parent's kind and checks, no control on an ended goal, `startConversation` and `note` once per command, a filtered view, attention labels, thread ordering including a loop-owned conversation that holds an ordinary goal, and a loop thread whose replayed steering message adds exactly one owner message and one service note. `npm test -- tests/navigation.test.ts tests/orchestration.test.ts tests/campaign-teams-auto.test.ts tests/recursive-loops.test.ts tests/loop-service.test.ts tests/orchestration-service.test.ts tests/loop-prerequisites.test.ts` passed (7 files, 150 tests), including the D-13 status cases. That record covers Phase 1 alone; the screens below use these commands.

**Screens (Phases 2 and 3)** ([coordinator/](../apps/desktop/renderer/coordinator/), [workbench-sidebar.tsx](../apps/desktop/renderer/components/workbench-sidebar.tsx), design in [Topsl_Design §20.4](Topsl_Design.md#204-main-window)):

| Screen | Behavior | Source |
| --- | --- | --- |
| Sidebar | **+ New conversation**; each project expands to its threads from one batched `coordinator-threads` read, re-read only for projects whose conversations, goals or loop runs changed (debounced). A thread row shows its kind and, when it waits on the owner, the attention label; a project shows how many threads wait on the owner. The selected project's **Project tools** hold the seven other destinations. The project `<select>` is retired | `useThreadIndex`, `changedThreadProjects` in [threads.ts](../apps/desktop/renderer/state/threads.ts) |
| New conversation | The project's home (the Coordinator destination with no thread): Run mode, one composer (**Send** or **Create run**), **Options** (goal kind, required check; loop check, automatic checks, reserved slots, allowance), readiness, recent conversations, **Project role defaults** with the role editor (now with **Close**), and **Stop everything** under **Project controls**, away from Send. Send uses `orchestration-conversation-start` and opens the new thread; Create run opens the run's thread | [project-home.tsx](../apps/desktop/renderer/coordinator/project-home.tsx) |
| Goal thread | Header with the thread's title and state, the latest goal's **Pause/Resume** and **Stop goal**, and pane toggles. The transcript lists the owner's and service's messages; each goal's card, the coordinators' turn, follows the latest message about that goal and shows its state, team lines with **Change**, current round progress, the coordinators' answer, and only the decisions waiting on the owner (choose a proposal, restart a round, conflict choices, open findings with **Start a bounded repair**, **Prepare checks** and **Run …**, **Accept candidate…**, **Apply to project folder…**). The latest plan's tasks are pinned above the composer, which sends `follow-up` and says what sending will do. Panes: Team (goal roles and the role editor), Plan (plan and rounds with member cards and endorsements), Review (findings, each with its own rationale; the shared rationale field is gone), Checks, Changes | [goal-thread.tsx](../apps/desktop/renderer/coordinator/goal-thread.tsx), [goal-card.tsx](../apps/desktop/renderer/coordinator/goal-card.tsx), `threadTimeline`, `planTasks` in [thread-view.ts](../apps/desktop/renderer/state/thread-view.ts) |
| Loop thread | Header with **Review and start**, **Pause/Resume**, **Stop**, wait reason and pane toggles. The transcript interleaves the owner's notes and the service's steering notes with each iteration as the coordinators' turn, then the current iteration and cards for a run not yet started, coordinators' questions and an accepted checkpoint not yet published. The composer sends `loop-message` and is disabled while the feature is off. Panes: Goals, Checkpoint (export reports in the pane instead of an `alert()`), Organization, Iterations, Backlog (Endless), Usage, keeping their earlier region names | [loop-thread.tsx](../apps/desktop/renderer/coordinator/loop-thread.tsx), [loop-panes.tsx](../apps/desktop/renderer/coordinator/loop-panes.tsx), `loopTimeline` |
| Layout | The pane sits beside the transcript from 1200px and overlays it below; the composer and task list stay at the bottom of the transcript; the whole sidebar scrolls so its bottom links never cover the tree. Composer drafts are kept per thread for the window's life (`useDraft`); unsaved role-editor changes are lost when another thread opens | [atlas.css](../apps/desktop/renderer/atlas.css), [drafts.ts](../apps/desktop/renderer/state/drafts.ts) |
| Navigation | Selecting or adding a project opens its New conversation page. The open thread is saved and restored; the top bar reads "Project / thread title" or "Project / New conversation"; the palette's coordinator entry is **New conversation →** | [main.tsx](../apps/desktop/renderer/main.tsx) |

Unchanged: every native confirmation (check runs, acceptance, applying, loop start and publication) and its wording; the accept dialog still shows its review and check details as recorded JSON.

**Verification of the screens (28 October 2026).** Electron UI evidence against the stand-in runtime and synthetic profiles only; no live provider, packaged build, Windows run or remote CI is covered here. The [coordinator journey](../scripts/desktop-coordinator-test.mjs) now starts the goal from the New conversation page, steers it in its own conversation, edits project defaults on the home page and returns through the sidebar, reads round member cards from the **Plan** pane, accepts through the native dialog, checks that the sidebar marks the accepted goal **Apply**, and checks that a restart reopens the conversation; UI-02 runs unchanged on the home page's editor at 560 × 720. This is also the first run of the journey since the [model picker](#follow-up-role-editor-model-picker-27-october-2026). Name changes are recorded in [TEST-DECISIONS](testing/TEST-DECISIONS.md#coordinator-conversations-journey-names--28-october-2026). Screenshots: [ui-evidence/2026-10-28-conversations](ui-evidence/2026-10-28-conversations/).

| Command (macOS 27.0.1 arm64, Node 26.0.0, Electron 44.4.5; branch `claude/coordinator-conversations` after `c6d8e38` plus the uncommitted screens) | Result |
| --- | --- |
| `env -u ANTHROPIC_BASE_URL npm run check` | Passed: typecheck; 1182 tests passed and 5 skipped in 86 files (3 skipped); 18 release checks; build. The existing renderer chunk-size warning remains |
| `env -u ANTHROPIC_BASE_URL npm run test:desktop` | Passed all four default journeys: main, coordinator, Atlas and loop |
| `env -u ANTHROPIC_BASE_URL node scripts/campaign-ui-test.mjs` | Passed 31 of 31 steps. A first run with `ANTHROPIC_BASE_URL` left set failed only UI-04, because Topsl refuses a native terminal in that environment |
| `node scripts/round2-ui-test.mjs` | Passed (run with `ANTHROPIC_BASE_URL` set; the fixture starts no provider) |
| `env -u ANTHROPIC_BASE_URL npm run test:desktop -- scripts/desktop-loop-test.mjs` | Passed again after the loop thread stopped listing the running iteration twice, the last renderer change |

**Not established:** live providers; Windows, where the coordinator and loop journeys skip; four-platform CI; packaged builds; and behavior with many projects or long conversations. Messages are still read per project and filtered per conversation, so a per-conversation read may be needed for large projects.
