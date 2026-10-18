# Topsl Coordinator Feature Specification

**Revision:** 18 October 2026 — one or more models per role, with no two-member limit\
**Status:** Agreed plan. Implementation began on 18 October 2026; see [Coordinator teams](Coordinator_Teams.md) for what is built, its evidence and the open gates. The text below is the plan as written, unchanged apart from this line and line-break formatting.\
**Repository baseline:** [Piore-Galore/Topsl at c5bac8e](https://github.com/Piore-Galore/Topsl/commit/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0)\
**Supersedes:** The 17 October coordinator specification based on `489a00bdd7d919901fa2c66f96ade14b8750c2a8`.

## 1. Product decision

Topsl should provide a persistent project conversation backed by a coordinator role. A role can contain **one or more active model members**, selected automatically unless the user supplies constraints. The same model selection rules apply to coordinator, planner, implementer, reviewer, tester, integrator, researcher, documentation, and custom roles.

**Every active role supports N members, where N is any positive count within configurable limits. Two is only an example, not a product, schema, UI, workflow, or release limit.** Three, four, five, or larger teams use the same membership, execution, and completion machinery. Each role can have a different count; inactive roles need no member assignments. Practical limits come from configured team size, capacity, available models, and budgets, and must not be silently replaced by a fixed two-model ceiling.

The user's original two-model examples remain first-class configurations:

| Role | Selected members | Default collaboration |
| --- | --- | --- |
| Coordinator | Opus + Astra | Both propose and reconcile coordination decisions as peers |
| Reviewer | Fable + Sol | Both independently review the same captured candidate |
| Implementation and other needed roles | Auto | Topsl selects suitable members, count, and work allocation within the user's limits |

These names are the user's model labels. Resolve them to actual model IDs through available provider routes before execution. This repository review does not establish that all four labels are exposed by the user's installations or accounts, and this plan does not assign an unverified provider or API ID to any label.

Every required selected coordinator must contribute to its coordination round, and every required selected reviewer must contribute to its review round, for any team size. In the examples above, that means both members. A list of active members is distinct from an availability fallback list. Listing several models must never silently mean that only the first runs and the rest are on standby or alternate as solo participants.

“Any model for any role” means that Topsl imposes no provider or model-family restriction on role choice. An executable assignment still needs an available adapter, supported model settings, the user's authorized account and billing route, and the capabilities that the particular task needs. A model eligible for planning but lacking a qualified write route can still plan; write access belongs to the assignment, not the model's name.

Multiple selected members and simultaneous execution are separate settings. By default, Topsl runs peer coordination and independent review in parallel as capacity allows, using queued waves when the team is larger than the available capacity. Every required member contributes against the same frozen inputs. An explicit all-members-simultaneous policy requires enough capacity for the whole team. Sequential collaboration with handoffs remains a separate selectable mode. The UI must show queued members and must not describe them as running.

### Required outcome

The user gives Topsl a goal in one conversation. Topsl maintains the goal and its requirements, forms the appropriate role groups, delegates bounded tasks, tracks results and findings, runs checks under the existing workflow rules, and returns a synthesis with evidence. The user can steer ongoing work and change model choices at a specified scope. Those choices survive replanning, repairs, retries, and restart.

This revision makes configurable N-member roles part of the foundation and the release acceptance criteria. A working solo or pair-only coordinator is an intermediate delivery step. Full delivery includes the original two-coordinator/two-reviewer example and larger teams, including a goal with three coordinators and five reviewers, supported cross-provider and same-provider combinations, and execution in bounded waves. Those test sizes are examples, not new maximums.

## 2. Updated repository baseline

The inspected snapshot contains material work since the previous plan. The following is implemented or recorded evidence, not a claim that the proposed coordinator exists.

| Area | Current state at the inspected commit | Consequence for this plan |
| --- | --- | --- |
| Guided build and review | All four Codex/Claude provider pairings are offered. The state and command still hold one builder and one reviewer. | Reuse the workflow's candidate, check, and acceptance machinery; introduce real group state and per-member lifecycle. |
| Claude workflow stages | Owner-operated Claude Code terminal steps can build, review, repair, and hand a reply back into the workflow. | Preserve this useful route and its durable waiting/hand-back behavior. |
| Claude model choice | Terminal steps pass no model or effort and use `set-in-claude-code`. Their readiness checks trusted installation rather than an observed model catalog. | This route cannot satisfy an automatic, exact Opus/Fable assignment. Model-controlled Claude execution remains a required implementation dependency. |
| Claude transcripts | An opt-in reader can take the final reply from the bound session, retaining source provenance and falling back to paste when it cannot validate the transcript. | A transcript result is useful output evidence; current transcript provenance does not establish an exact model or a managed subagent tree. |
| Structured runtime | Codex has production structured execution and qualification. Claude's structured adapter remains restricted to fixture transport and its production route stays gated. | Add and qualify supported production routes; a selector alone cannot deliver cross-provider automation. |
| Advanced workflows | Template-specific multi-participant proposals and competing implementations already exist. Some participants already share the planner or implementer role. | Reuse participant and frozen-submission concepts. General role groups, automatic composition, and model co-coordination still need to be built. |
| Routing presets | Presets require distinct role names and concrete assignments; their summary explicitly reports no automatic ranking. | Uniqueness must move to member identity. Add group-level Auto composition. |
| Conversation sessions | Native session/account maps are keyed by provider. | Multiple same-provider models need separate member/session bindings. |
| Permissions | Auto-accept now has Off, Sandboxed, and Everything levels. Reviews remain read-only. | Selection, delegation authority, tool permission, and final acceptance must remain distinct decisions while using these existing settings. |
| Resource control | Attempts acquire leases and capacity. Default total and per-provider capacity are two; unknown native fan-out consumes the entire total budget. | Co-coordinator rounds need accounted capacity and compatible workspaces. Increasing the limit alone does not make unknown-fan-out routes parallel. |

Sources: [guided setup][s02], [workflow state and results][s03], [Claude steps][s04], [readiness][s05], [runtime manager][s06], [Claude adapter][s07], [advanced workflows][s08], [conversation identity][s09], [auto-accept][s10], [capacity][s11], and [transcript reader][s12].

### Recorded live evidence and its limits

A Codex→Codex seeded workflow on the owner's Mac reached **awaiting acceptance** at `09399be`: qualification passed, the build changed the intended file, a fresh review reported no findings, and the required check passed. The owner answered nine build permission requests. This is recorded evidence for that runtime, model, host, and small task; it is not a fresh run performed for this plan and does not establish general review quality. [Live workflow record][s13]

The 18 October Claude-team runs found transcript compatibility and permission-handling issues. In the subsequent Claude→Claude rerun at `0dc4baa`, the build and transcript hand-back succeeded, but two new `.serena` files triggered output review before the review stage could run. The latest record says no Claude-team live run has reached acceptance. The proposed feature therefore must not advertise a completed live Claude review or model-controlled Claude orchestration on the strength of the terminal workflow work. [Latest implementation status][s14] [Live sessions][s15]

Some earlier delivery paragraphs retain their historical statements that the live runs were pending. The later dated follow-up controls this baseline summary.

### Existing behavior to preserve

The current reviewer parser takes the final assistant message instead of concatenating progress and final output. Keep that rule separately for every member. Codex qualification fingerprinting now excludes the native `projects` registry while retaining the rest of the configuration; new coordinator workspaces must use that logic. Preserve the distinctions among owner-pasted, transcript-observed, and provider-reported results. [Workflow implementation][s03] [Runtime binding][s16]

The new plan must also account for actual environment outputs. Guided checks currently expose no writable-output paths, and the Claude live rerun demonstrated that native tooling can create files outside the intended change. Work allocation should declare permitted source, dependency, cache, and generated-output paths. Unexpected files retain the existing output-review gate; model agreement does not admit them automatically. [Implementation status][s14]

## 3. Role groups and membership intent

A **role definition** describes responsibility, instructions, required capabilities, permitted operations, and output contract. A **role group** contains the members assigned to that responsibility and the policy for combining their work. A **member assignment** binds one member to a concrete model execution route.

Roles have no built-in provider preference. Optional user presets can express preferences such as “prefer Astra for planning,” but those preferences are data the user can change. No code path should assume Claude coordinates or Codex implements.

### Membership choices

| User instruction or UI choice | Persisted meaning |
| --- | --- |
| “Choose the agents automatically.” | Auto selects eligible members and group size within configured bounds. |
| “Use Opus and Astra as coordinators.” | Exact two-member coordinator roster. Both are required after model-label resolution. |
| “Review with Fable and Sol.” | Exact two-member review roster. Both reports are required for that round. |
| “Include Opus as a coordinator.” | A required pinned member plus Auto composition of any permitted remaining slots. |
| “Use two reviewers; pick the models.” | Exact count of two, with automatic model assignments. |
| “Use five reviewers; include Fable and Sol.” | Exact count of five: two required pinned members and three Auto-selected members. |
| “Use three coordinators and four implementers.” | Independently sized role groups; every required member contributes under that role's collaboration policy. |
| “Use two different models.” | Hard distinct-model constraint, checked after actual identities are resolved. |
| “Prefer different providers.” | Soft diversity preference unless the user states it as a requirement. |
| “Use at most three reviewers.” | Auto membership with a maximum count of three. |
| “Use Sol first, then Fable.” | Explicit sequential collaboration. Both remain active contributors. |
| “Use Sol; fall back to Fable if unavailable.” | One active member with an explicit availability policy. |

Exact rosters cannot be enlarged, reduced, or converted into alternatives by a model-generated plan. A user can intentionally configure several sessions of the same model in one role, but that must not satisfy a request for several different models.

Keep three group selection forms: **Auto**, **Exact members**, and **Required members + Auto**. Member count, model pins, diversity requirements, and permitted degradation are independent fields. Store them outside generated plans so a replan cannot accidentally erase user intent.

Represent group membership as a collection keyed by stable member IDs, never as first/second slots. Exact membership derives its count from the full roster. Auto and Required members + Auto use configurable minimum/maximum counts, or an exact count when requested. Validate limits consistently in service commands, settings, persistence, routing, and UI. When an explicit count conflicts with a configured ceiling or the available eligible pool, retain the requested count and explain the conflict; do not truncate the list or clone a model to satisfy a distinct-model requirement. Existing template-specific assignment limits must not become the new general role-group limit.

### Scope and precedence

Resolve applicable settings in this order: task/member override, goal-role override, goal-wide policy, project-role preset, project policy, application defaults. More specific settings override only the fields they address. Mandatory authority, capability, and billing constraints remain outer boundaries at every level.

An exact roster at a scope closes that role's membership there. “Add another reviewer” creates a new roster revision; it does not silently reinterpret a closed roster as Auto. Record the source message or settings action behind each override and show which scope it affects.

“Return to Auto” needs two distinct actions: release this member's model pin, or release the entire role roster/count. The UI must make their scope clear. Reassignment uses a new assignment revision, and changes during work take effect at a defined round boundary. Completed contributions keep their original attribution.

## 4. Any model across supported providers

The selector should expose all models available through registered, authorized provider routes. It should display the provider, account/profile label where needed to disambiguate, runtime route, model display name, actual model identifier, and supported settings. Model labels are for people; execution uses the provider's actual identifier. The existing provider model contract already distinguishes catalog ID, execution model, and display name. [Provider contract][s17]

Separate these identities throughout persistence and dispatch:

| Identity | Why it matters |
| --- | --- |
| Role/profile revision | Defines what the member is asked to do. |
| Stable member ID | Distinguishes peers, including two models under one provider. |
| Provider adapter and route | Defines how Topsl can communicate with and control the model. |
| Installation revision and executable identity | Binds capability and lifecycle evidence to the actual runtime. |
| Native account/profile and billing route | Prevents an assignment from moving silently between sign-ins or payment routes. |
| Requested model ID and effort | Records the user's selection and the actual requested settings. |
| Reported effective model and effort | Records what the runtime reports, including unknown or mismatched values. |
| Session, task, and attempt | Separates conversation continuation, logical work, and each native execution. |

Use distinct names for an agent's instruction profile and a native account's profile; one `profileId` must not ambiguously represent both.

### Capability and catalog binding

Readiness should be derived from an execution purpose and the task's requirements. A coordinator needs a validated decision-output contract, a bounded context reader, usable model settings, controlled lifecycle, and the permission policy for its control workspace. A reviewer needs fresh context and access to the exact candidate. An implementation assignment needs its scoped write route. None of these requirements is a model-family whitelist.

Bind model observations to provider, route, installation revision, account/profile, observation time, and freshness policy. The current catalog check is not a complete account- and age-bound cache contract; extend it before using the catalog for Auto. Preserve unavailable or unknown pinned choices in saved configurations and explain why they cannot run. Do not replace them with a provider default. [Runtime inspection][s06] [Readiness][s05]

A changed account, model catalog, policy, or installation triggers the relevant revalidation. Recheck each member's requested and reported model/effort at session and turn start. A member whose runtime reports a different model cannot count as satisfying an exact-model request. If effective identity is not reported, show that evidence level explicitly; a strict verified-model policy must remain blocked unless the route can establish the required binding. An explicitly chosen requested-only/native-default policy may be supported as a different, clearly labelled mode.

### Current provider scope and Claude delivery dependency

The current `Provider` union and adapter registry cover Codex and Claude. Implement the revised feature against supported routes for those providers and make role selection consume an adapter/capability registry. Additional providers become available by implementing and qualifying that contract. Typing an arbitrary provider name into a setting does not create a working integration. [Provider types][s09] [Runtime manager][s06]

Keep the existing Claude terminal route as **assisted participation**. It can provide a workflow result through its existing process and provenance. It cannot be an invisible substitute for an exact automated model member because it intentionally passes no model/effort, does not inspect a model catalog, and the current transcript source has no observed-model field. [Claude steps][s04] [Transcript extraction][s12]

To deliver the named cross-provider groups, establish a supported production route that can select a concrete Claude model per member, record actual model evidence, deliver typed contributions, supply the required context/tools, handle permissions, and establish termination. Qualify that route for its actual purposes and platforms. Do not remove the current production restriction or reuse fixture transport as production. If a new API/cloud route is chosen, configure its authorization and billing explicitly; native-subscription selection must not fall through to paid API billing.

Multiple isolated accounts, remote hosts, and unrelated new provider adapters are separate integrations. The group model should accommodate them without claiming they already exist.

## 5. Automatic group composition

Auto should choose both the members and the number of members needed for the task. It should avoid creating a large team for a small request. A reasonable initial project policy starts with one coordinator for simple work and can select two, three, or more for complex planning within the role's configured count and turn budgets. Independent review can likewise use any permitted count. Resource capacity determines the schedule rather than silently reducing the selected roster. Exact user rosters always take priority over these defaults.

The selection process is concrete and auditable:

1. Interpret the goal, required result, relevant role profiles, task boundaries, and any explicit member instructions.
2. Load the applicable membership policy and the authorized provider/account pool.
3. Filter by exact pins, required capabilities, model settings, context needs, runtime readiness, and permission/billing constraints.
4. Choose count and collaboration mode within the role's bounds, preserving all required members and hard diversity requirements.
5. Rank eligible candidates using documented compatibility, availability, user preferences, and evidence from comparable completed tasks where available.
6. Resolve a concrete assignment for every selected slot and a feasible schedule under actual resource reservations.
7. Persist the roster, assignments, routing reasons, catalog/capability bindings, and the plan revision before execution.

A coordinator model may propose specialized roles or candidate assignments from the supplied catalog. The service validates them and applies the persisted constraints. It must not dispatch a model name invented by the coordinator.

### Cold start and learned preferences

Start with transparent deterministic heuristics and user-configured priorities. There is no repository evidence for a universal ranking of these models. Later performance signals can include task category, valid-result rate, acceptance evidence, retries, duration, and known usage, with provenance and enough context to avoid comparing unrelated tasks. A “no findings” review is not automatically a high-quality review.

Provider allowance and token/cost information can be incomplete, especially on native subscriptions. Show unknown values as unknown. Hard limits should use things Topsl can enforce, such as member counts, admitted turns, active reservations, delegated tasks, and repair rounds. Do not present an inferred subscription allowance as a reliable remaining balance.

### Selection explanations

Display concise reasons such as “Pinned for this goal,” “Selected automatically because this qualified route supports the required candidate reader,” or “Queued because two required members need capacity.” Explanations should cite actual constraints; they should not invent numerical confidence or model superiority.

An unavailable required member leaves the affected role waiting or blocked. Auto can choose an alternative for an unpinned slot, or follow a fallback expressly authorized for that pin, within its recorded replacement policy. A pinned primary with an authorized fallback retains its primary intent while the fallback assignment is recorded separately. Replacement creates a new roster or assignment revision. An exact mandatory roster of any size cannot shrink or substitute members without its own authorized policy; a failure must not silently change the meaning of the user's selected team.

## 6. Collaboration policies for a role

Use a small, explicit set of collaboration modes across all roles:

| Mode | Work pattern | Typical initial use |
| --- | --- | --- |
| Solo | One member completes the role's work. | Simple tasks or explicit single-model choices |
| Parallel independent | Members assess the same frozen input separately before seeing peer results. | Review, alternative plans, test design |
| Parallel partitioned | Members own distinct scoped subtasks; results are integrated afterward. | Implementation, research, documentation |
| Peer collaboration | Members contribute to a shared round, exchange substantive differences, and satisfy a decision policy. | Multiple coordinators or collaborative planning |
| Sequential stages | Members contribute in a declared order with permitted handoff. | Explicit second opinions or staged refinement |

These are collaboration defaults, not restrictions on model eligibility. A multi-model implementer group can also produce competing candidates, and a reviewer group can divide coverage if the user chooses complementary review. Label the chosen behavior accurately.

Keep completion policy separate from collaboration mode, and distinguish required participation from decision authority:

| Policy field | Meaning for N members |
| --- | --- |
| Required contribution member IDs | Members whose valid contributions must be collected; defaults to every member of an exact roster. |
| Minimum valid contributions | Additional completeness threshold, which cannot waive a named required contribution. |
| Decision electorate and endorsement threshold | The frozen members whose endorsements count and the required number or fraction, such as all N or three of five. |
| Required endorser IDs | Any members whose endorsement is mandatory in addition to the numerical decision threshold. |
| Deadlines, retries, and permitted degradation | Explicit failure policy; timeout cannot silently change the roster or threshold. |

The default for an exact coordinator roster is all required members contributing and unanimous endorsement of the shared decision. The user can select a different decision rule, including a three-of-five threshold. In that case all five may still be required to contribute, while three endorsements can admit the decision once the other conditions hold. A valid dissenting contribution satisfies participation but does not count as endorsement. A required endorser retains its explicit endorsement requirement.

Freeze the electorate and denominator with the round's assignment map. Abstentions, missing results, failures, or retries cannot reduce that denominator or give one member multiple votes. Preserve dissent in the final record. A quorum does not establish correctness or override reproducible findings, required checks, authority, or capability gates. Independent review defaults to all required reports and finding-specific dispositions for every N; it does not become a majority vote on whether a defect exists.

## 7. Multiple coordinators: peers with one decision commit

The current runtime `Coordinator` manages execution ownership and resource accounting. It is not a conversational model coordinator. Add a conversational orchestration layer while retaining one deterministic service authority that owns state transitions and dispatch. [Runtime coordinator][s18]

Any number of coordinator members can coordinate the same goal. Opus and Astra are a two-member example of this general protocol. Every selected member receives the same project state, contributes its own proposal, and participates under the configured decision policy. No member independently starts a child workflow or changes the authoritative goal graph. This keeps all required models substantively involved while preventing duplicate delegation and conflicting schedules.

### A coordination round

1. **Freeze inputs.** Capture the goal/specification revision, current plan revision, event cursor, role-group revision, selection policy, control generation, allowed operations, and available artifact references. Freeze a member-ID-to-assignment-revision map with each expected model/runtime binding. Each required peer sees the same round snapshot.
2. **Admit contributions.** Revalidate each frozen assignment, reserve feasible capacity, create separate control tasks/attempts and compatible workspaces, and launch bounded contribution turns. Initial proposals are independent.
3. **Validate proposals.** Parse each final structured contribution separately. Check action types, dependency graphs, scope, referenced artifacts, proposed bindings, budgets, and the snapshot revision. Preserve invalid output with its reason; it is not a decision.
4. **Form a candidate decision.** Deterministically combine only structured actions whose compatibility is demonstrable. Substantive conflicts go through a bounded reconciliation exchange. A selected member may prepare a draft, but that member gains no special commit authority.
5. **Endorse the same candidate.** Obtain the required contributions and endorsements under the frozen electorate, threshold, and required-endorser policy. Each response endorses or challenges the exact candidate digest, including its actions, roster, assignment map, decision policy, assumptions, and bounded authority. Matching initial proposals can supply the endorsement when they already identify that exact decision. Otherwise run short endorsement turns; preserve dissenting responses.
6. **Commit once.** After the configured policy passes, the service uses revision checks and an idempotency key to atomically commit the plan/action set and its queued plan actions. One accepted decision creates one set of logical work items.
7. **Dispatch after release.** Workers from the committed decision wait until its relevant coordinator attempts are quiescent. The scheduler then admits them under their own grants and reservations through the existing runtime dispatch boundary.

Each contribution, reconciliation, and endorsement turn releases its own lease and capacity as soon as that turn is proven quiescent. The logical round and its immutable results stay durable while no model process is running. Later reconciliation/endorsement attempts acquire their own reservations; they cannot depend on capacity retained by completed contribution turns. An idle role group holds no execution slots.

The coordination snapshot is immutable as evidence. Routine execution progress can be queued for the next round, but a change that invalidates a proposed action's preconditions must prevent that action from committing. New user scope changes, membership changes, pause/stop, and revoked authority advance the relevant revision or control generation immediately.

### Resolving disagreement

For an exact roster of N coordinators, the default requires every member's contribution and endorsement. Surface concrete disagreements and their assumptions, then allow a bounded exchange and one revised candidate. A targeted check or evidence task can help resolve a factual issue when it is authorized and admitted under the same declared decision policy.

If disagreement prevents the declared decision policy from passing, preserve the unresolved branch and present the specific choice requiring user direction. When an explicitly configured quorum passes and all participation and other gates are met, ordinary planning disagreement need not block the decision; retain the dissent and rationale. Independent subsets can proceed only after satisfying the group's policy and validating their dependency closure. Do not stop unrelated goals merely because one branch is disputed.

An additional adjudicator is an optional explicit policy or a recorded Auto allowance, for any existing team size. It is not silently introduced to overrule a pinned peer. Deadlines and retries cannot lower the decision threshold. If a required contributor or required endorser is unavailable and the policy cannot pass, show the blocked decision while allowing unaffected previously authorized work to continue.

For larger teams, collect one attributed proposal per member, assemble a shared conflict summary, and ask the relevant members to address the disputed points before publishing a common candidate. Avoid automatically scheduling a separate conversation for every pair of members. Bound discussion by the configured turn budget while retaining all required contributions and the declared decision rule.

This is an application decision protocol within one authoritative local store. It does not require a distributed consensus service. Keep the implementation focused on frozen inputs, valid contributions, a declared decision rule, revision checks, and one commit path.

### Keeping coordination efficient

Persist the conversation, goal graph, and evidence rather than keeping all coordinator processes running indefinitely. Invoke coordinator rounds for initial decomposition, substantive steering, blocked work, material findings, and final synthesis. Deterministic progress within an accepted plan does not require a fresh multi-model vote after every status event.

No coordinator turn waits synchronously for a child while retaining resources the child needs. If the product supports deliberating while workers run, configure and account for a separate control-capacity allowance. Observational status updates and user pause/stop commands remain service operations and never wait for model consensus.

## 8. Multiple reviewers and finding aggregation

Fable and Sol should review the same immutable candidate, specification revision, and declared check evidence. Each receives a separate fresh session and its own authorized reader or qualified snapshot route. With independent review selected, neither sees the other's initial report. After both reports are stored, the group may discuss disagreements.

The same rules apply to N reviewers: collect and attribute every required report, including when five or more reviewers run in several waves. No round completes after the first two reports unless those are the only required reports under an explicitly configured policy. Later-wave reviewers receive the same frozen candidate and initially cannot see earlier-wave verdicts. Group progress uses the actual count, such as “3 of 5 reviews returned.”

This requires a real completion barrier. The present workflow has one `reviewerTaskId` and one `reviewArtifactId`; a clean review can resolve prior findings and start checks immediately. Calling that existing completion function once per member would allow one member's clean report to erase another's finding or complete the stage early. Refactor aggregation before enabling multiple reviewers. [Current completion logic][s03]

### Review round and acceptance rules

Every report must name the review round, member, frozen assignment revision, attempt, candidate hash, specification revision, and output schema version. Store it immutably with its original findings and evidence. Report states include valid, invalid, inconclusive, failed, missing, and stale; only policy-eligible results satisfy required participation.

The aggregate process should:

1. Wait for every required report and any declared optional-member deadline.
2. Normalize and deduplicate overlapping findings while retaining each original observation and attribution.
3. Distinguish a substantiated finding, a disagreement, an unresolved question, and the absence of a finding.
4. Resolve finding-specific disputes through checks, reproduction, documented rationale, or an authorized user decision.
5. Produce a group completion record binding the exact roster and assignment map, candidate, included/excluded reports, finding decisions, and completion policy.
6. Run or admit the required checks and the existing acceptance path only when that group record and its other prerequisites are satisfied.

One reviewer omitting a defect is not evidence that it is fixed. A majority of clean reports cannot dismiss a reproducible defect. A timeout or malformed report from a required member is not a pass. The synthesis may identify a finding as duplicate or unsupported, but must retain the evidence and an explicit disposition.

A repaired candidate requires a new review round under the applicable roster and policy. Conservatively rerun required reviews for code changes; any future selective reuse must prove an unchanged relevant input/coverage contract and label the reuse. Do not carry an old candidate's group approval forward by changing its candidate ID. Likewise, new membership does not relabel old reports as contributions from the new members.

Checks can run early on a frozen candidate if the scheduler supports it, but early check results cannot stand in for missing reviews. The final candidate accepted must be the candidate covered by the required review group, checks, findings, and output decisions.

Separate model diversity, session freshness, and actual isolation evidence. Two models from one provider may be distinct models. Two providers do not automatically prove independent reasoning or filesystem isolation. The current provider-equality pairing note must give way to these separate facts. [Setup note][s02]

## 9. Durable records and command contracts

Extend the current encrypted store and revisioned repository operations. The following names are proposed implementation contracts, not existing records.

| Record | Essential contents |
| --- | --- |
| `CoordinatorConversation` | Project, conversation, active goal references, intake cursor, and routing context |
| `Goal` / `GoalRevision` | Objective, constraints, specification references, authority, state, control generation, and parent/related goals |
| `RoleDefinition` | Role ID, instruction/profile revision, required capabilities, output contract, and permitted operations |
| `RoleGroupRevision` | Stable group ID, scope, role ID, selection form, configurable N-member count/diversity constraints, member collection, collaboration, scheduling and completion policies |
| `MemberIntent` | Stable member ID, required/optional status, model/runtime/profile pins, soft preferences, fallback policy, and source instruction |
| `ResolvedMemberAssignment` | Exact provider/route/account/installation/model/settings tuple, role profile, qualification/catalog bindings, selection reason, and assignment revision |
| `RoleRound` | Input snapshot, candidate or goal revision, N-member roster, member-ID-to-assignment-revision/expected-binding map, required contributors, frozen decision electorate/threshold/required endorsers, control generation, policy digest, state, deadlines, and attempt references |
| `ParticipantContribution` | Member, assignment, session, task, attempt, final structured output, input binding, validation outcome, and evidence provenance |
| `DecisionCandidate` / `DecisionEndorsement` | Exact action-set digest, contributor references, each peer's response, expected state revisions, and disposition |
| `RoleCompletion` | Aggregate result, included/excluded contribution IDs, finding decisions where applicable, policy satisfaction, frozen assignment map, and exact inputs |
| `CoordinatorPlan` | Typed task graph, dependencies, role-group references, authority and budget bounds, accepted decision, and supersession links |
| `QueuedPlanAction` / `ControlEvent` | Idempotency key, expected revisions, admitted action, links to the existing execution attempt/operation intent, and pause/stop/steering fences |

Every native member execution uses the existing task/session/attempt machinery, with explicit links to group, member, and round. A retry creates a new attempt under the same logical member. A substituted model uses a new assignment revision; a different roster uses a new group revision. Old contributions remain attached to the version that produced them.

Freeze resolved assignment revisions inside each round, not only member IDs. Any assignment change starts a new round with a new binding map. A stable member ID cannot let an old model's contribution or endorsement satisfy the replacement model. When policy permits reuse of unaffected peers' evidence, record that carry-forward explicitly, check input/assignment/context compatibility, and retain the original round reference. Late superseded attempts never increase the replacement round's completion count.

### Typed results and graph boundaries

The existing task acceptance and workflow lineage are centered on code candidates. Preserve those acceptance guarantees. Introduce typed outcomes for code candidates, information artifacts, coordination decisions, and check evidence, with validated dependency edges. A research report or decision should not need a fabricated code candidate or a passing-check claim merely to unblock a task. [Task and workflow schema][s19] [Acceptance repository][s20]

A practical initial design keeps coordinator control and informational tasks at `workflowId: null`, gives them an explicit non-code completion transition, and places cross-workflow dependencies in `CoordinatorPlan`. Existing code workflows retain their candidate-bound lineage and acceptance path. An information dependency becomes eligible only after a valid artifact/result completion record, while a code dependency still needs the relevant immutable candidate or accepted result required by its consumer.

Extend the task role contract for coordinator and configurable role definitions; avoid squeezing all new purposes into `reviewer` or `native`. Deterministic check subprocesses remain check executions even when a model tester designed them.

### Atomicity, idempotence, and recovery receipts

Commands should include actor/source, affected goal/group/member, expected revisions, control generation, and a stable command ID. The service validates the entire transition in one transaction. Commit the accepted decision, plan revision, logical work items, and queued plan actions together. Persist receipts for accepted and rejected commands.

A queued plan action is a high-level admission/outbox record. Once prepared for execution, it references the existing `ExecutionAttempt`, dispatch ID, and `OperationIntent`; it is not a second native-execution ledger. Keep the current runtime boundary authoritative for final input/control checks, process dispatch, leases, lifecycle evidence, and uncertainty. Derive the queue item's execution outcome from those records instead of independently declaring a provider operation completed or reconciled. [Existing operation intent][s19] [Runtime dispatch boundary][s18]

Use an outbox-style dispatch loop so a committed queued action is claimed idempotently and linked to its concrete execution. Do not claim exactly-once native side effects. A crash after a provider process starts but before its start receipt may leave execution uncertain; recover through the existing attempt/operation-intent reconciliation, not by blindly starting it again. Repeated UI requests and duplicate provider events must not create duplicate logical work or count one contribution twice.

All scheduling entry points must consult the same goal/control fences, including existing service timers, specialist queues, repairs, checks, integration, and acceptance preparation. Enforcing cancellation only in the new orchestration class leaves old background paths able to dispatch after a stop.

## 10. Delegation, context, and multiple workers

A coordinator delegates a bounded assignment with a clear result contract. The worker brief contains the relevant goal/specification revision, role instructions, permitted outputs and paths, input artifact references, acceptance criteria, dependencies, relevant prior findings, and a concise handoff. Use the existing context package and frozen-input machinery as the foundation. [Context packages][s21]

Give each member the context required for its assignment. A worker does not automatically inherit the entire project conversation, every other member's private transcript, or another account's native session. Reports and retrieved repository text are evidence to evaluate; they do not grant permission to change the role roster, billing route, or tool authority.

Keep project memory as durable, attributed facts and decisions with source references and revision links. Summaries can reduce context size but must point to the original evidence. Native conversation IDs are useful continuation handles; they are not the authoritative source of goal state.

### Session identity and reuse

Replace provider-keyed continuation for group work with member/session records. One conversation can contain several Codex members or several Claude members without overwriting a session or account slot. Distinct member/session binding records may reference the same authorized native account/profile; separate subscriptions are not required by the group design. Each message/event links to its member and attempt as well as provider. Existing provider-keyed direct chats need an explicit compatibility path during migration. [Current conversation type][s09]

Resume a worker only when the provider, account/profile, installation, model/settings, instruction profile, workspace, purpose, and permitted context are compatible. A change requiring new authority or context starts a fresh session with a bounded handoff. Reviews start fresh for their review round and receive a new candidate-bound grant. Coordinator contribution/endorsement sessions may continue only within the validated purpose and round binding; otherwise open a fresh control session.

Do not reopen a terminal task state to obtain reuse. Create linked follow-up tasks/attempts while preserving terminal history and the relationship to the earlier member.

### Parallel implementation and integration

Multiple implementers either receive independent task scopes or produce separate candidate alternatives. Concurrent writers use distinct approved workspaces/worktrees or captured copies; they do not edit the same checkout simultaneously. Plan shared interfaces and dependencies before dispatch, integrate candidate changes through a controlled workspace, then review and check the resulting candidate.

Several integrator models may propose merge/conflict resolutions, but only one admitted operation writes the integration workspace at a time. Keep the reasoning group separate from the serialized write operation. A model tester can design or implement tests while deterministic execution supplies check evidence.

Native provider subagents may exist beneath a member. Record parent/child links when observable and maintain the runtime's declared fan-out policy. A native sidechain transcript is not automatically another Topsl role member. The coordinator's explicit membership roster and the native process tree are different structures.

## 11. Runtime purpose, tools, and workspace ownership

The existing runtime largely selects behavior through edit/review mode. Topsl tools are installed only on fresh review sessions, and review mode can select the candidate-review output schema. Coordinator output must not be parsed as a candidate review merely because its filesystem access is read-only. [Runtime preparation][s06] [Prepared turn contract][s17]

Introduce an explicit execution purpose, separate from filesystem permission mode. Initial purposes should cover coordinator contribution, coordinator reconciliation/endorsement, information work, implementation, candidate review, and direct chat. Each purpose selects its output schema, tool contract, context grant, freshness/reuse rules, and readiness requirements.

A minimal coordinator contract returns typed proposals and decisions. Read tools can expose authorized goal state, task status, artifact metadata, and bounded content. Model calls that request delegation or a plan change become validated proposals; they do not bypass the group's decision policy or call an arbitrary service method. Bind tool calls to member, attempt, session/thread/turn, round, and scope, with a receipt for accepted or refused calls. Revoke grants at the end of their validity boundary.

Keep candidate-reader tools scoped to the immutable candidate. A coordinator's broader project-state reader must be a separate permission contract, not an extension of a review grant through unchecked identifiers. Existing Claude terminal reviews use a read-only candidate copy rather than Codex's reader; preserve that distinction and qualify any new managed Claude reader separately. [Workflow review routes][s03]

### Control workspaces and lease release

Current attempts acquire a workspace lease even for read-only execution. Two coordinators cannot simply share the project checkout, and two reviewers cannot assume a shared snapshot path admits concurrent attempts. Initially give each member a distinct controlled workspace/copy with read-only access to its bounded inputs. A future compatible read-lease model needs an explicit ownership design and tests before replacing this approach. [Runtime ownership acquisition][s18]

Control turns must not hold the canonical project writer lease while waiting for workers. Release resources only after the owned process/descendant state is observed to be quiescent or explicitly reconciled. A logical result arriving is not itself proof that native processes have ended.

Preserve the current Claude edit hold across terminal closure until hand-back or confirmed cancellation. It is currently project-scoped and can block writers even in another workspace. Parallel assisted Claude editing therefore needs an explicit canonical-workspace ownership redesign; deleting or narrowing that hold to make parallelism appear to work would weaken existing behavior. [Claude hold and completion][s03] [Service terminal integration][s22]

## 12. Capacity, authority, permissions, and limits

Every active coordinator, reviewer, implementation member, and known native descendant counts toward capacity. Group membership count, active model calls, and reserved capacity are separate measurements.

Configure roster size N separately from the maximum simultaneously active members W. N may exceed W. The default capacity-bounded schedule admits waves as reservations become available: five required members with two eligible slots can run 2 + 2 + 1 against the same frozen round inputs. Keep the complete roster throughout, retain every required result, and withhold initial peer contributions until the initial collection stage is complete. This preserves independent proposals/reviews even when members start at different times.

The current budget defaults to total two and per-provider two. An unknown-fan-out attempt reserves the entire configured total, even if the user raises that total. Two such attempts cannot run concurrently under the existing policy. Parallel groups therefore need routes with qualified disabled/bounded native fan-out or a separately designed accounting policy with honest evidence. An explicit unknown-fan-out approval alone does not turn the current reservation into one slot. [Concurrency implementation][s11]

With enforced zero native children, a two-member launch wave can fill a two-slot budget regardless of whether the role contains two, five, or more members. After those turns are quiescent, release their reservations and admit the next eligible wave. Coordination and review can also use capacity in separate phases. Same-provider limits, actual reservation weights, and workspace constraints still apply.

For ordinary capacity-bounded scheduling, atomically reserve each launch wave without holding slots for members that remain queued. Reserve all N members together only when the user explicitly requires the entire group to run simultaneously. Detect impossible strict-simultaneity configurations before starting and offer capacity-bounded waves as a visible policy change. A group larger than current execution width is valid under the default policy. Do not silently discard members, change collaboration to staged handoffs, or let partial reservations deadlock.

If a launch wave or strict simultaneous cohort partly fails to start, release reservations proven never to have spawned. Successful members of an ordinary wave may continue under the round's policy; their completion does not waive a failed required peer. Interrupt started peers when an explicit simultaneity requirement can no longer be met, and release their resources only after observed quiescence. A possibly started process retains its uncertain attempt, lease, and capacity. Clean up unused reservations rather than leaving undispatched members holding capacity indefinitely.

Worker scheduling width should be a separate setting from reservation weight. “Run one worker at a time” must not be implemented by lowering the current workflow budget to one, which can make an unknown-fan-out route unable to start at all. Add fairness between goals and prevent repeated coordinator rounds from starving admitted workers.

### Authority and existing permission settings

Automatic model selection determines who performs work. A delegation grant determines what work may be admitted. Native permissions determine what that execution can do. Candidate acceptance determines which reviewed output is accepted. Model agreement satisfies none of the other decisions by itself.

Carry the user's existing scope and authorization forward so routine authorized delegation does not repeatedly ask for confirmation. Apply the current auto-accept level and qualified permission behavior per execution, recording what was requested and what the runtime reported. Reviews remain read-only; coordinator control turns also retain their limited control-workspace purpose. Auto-accept Everything must not turn a coordination proposal into permission to edit the repository or accept a candidate. [Auto-accept implementation][s10]

Bind a goal grant to permitted task kinds and workspaces, provider/account/billing pool, output/check scope, member/count bounds, maximum turns, delegated tasks, repair rounds, and expiration/control generation where applicable. Broader work needs the corresponding user action. Existing final candidate acceptance and output-review gates remain applicable; the coordinator can prepare the evidence and request only the actual outstanding decision.

Use configurable ceilings rather than hidden unbounded debate: per-goal model turns, per-round reconciliation turns, role members, total delegated tasks, active reservations, and repair rounds. Start with one bounded shared reconciliation exchange and one revised candidate for disputed decisions, at any team size, and retain the existing workflow's configured repair limit. Before execution, validate that the turn allowance can cover the selected required members and protocol stages; do not exhaust it on the first members and then declare the rest optional. Usage displays should attribute every contribution, retry, synthesis, and check without inventing native subscription prices.

## 13. Steering, pause, stop, and restart

Persist a routing decision for each user message: answer/status request, update to an existing goal, new goal, or split/related goal. A new unrelated request must not cancel existing work. “Stop everything” applies across the project; “pause this goal” has the named scope. Explicit controls should be available in the UI independently of natural-language interpretation.

Steering updates the affected specification, roster, or constraints and advances the relevant control generation before another action is admitted. An ordinary question can receive an answer while authorized work continues. A late contribution from an old round stays as historical evidence and cannot satisfy the revised round.

| Control | Required behavior |
| --- | --- |
| Pause goal/group | Fence new actions immediately; interrupt relevant active members where required; report pausing until quiescence is established. |
| Stop goal/group | Revoke future dispatch, cancel queued plan actions, stop active native work through its route, and preserve results/uncertainty. |
| Stop member | Stop the named member and reevaluate group completeness without pretending the missing contribution passed. |
| Change model or roster | Preserve intent and history, create the relevant revision, and apply it at a defined boundary with any required re-review. |
| Resume | Revalidate authority, assignments, inputs, qualification, and resource ownership before starting new work. |
| Restart Topsl | Recover durable state and pending decisions; reconcile actual native execution before replaying dispatch. |

Pause/stop includes currently running coordinator peers as well as workers, reviewers, repairs, checks, and integration. A delayed endorsement cannot resurrect a stopped plan. Model consensus is never required to obey the user's control action.

For managed routes, use observed lifecycle evidence and existing interruption/escalation behavior. Unknown surviving processes retain uncertain state, leases, and capacity. Never expire an uncertain lease into reassignment merely because a timer elapsed.

For assisted Claude steps, preserve the distinction between a logical step waiting for the owner and an actual native terminal attempt. The existing recovery path preserves waiting logical steps, and an opened build/repair can require the owner's stopped confirmation before hand-back or cancellation. A coordinator cannot synthesize that confirmation. Fully automatic completion requires a separately qualified lifecycle contract. [Recovery implementation][s18] [Claude step controls][s22]

When a required member fails, retain its failure and any successful peer results under the frozen round. Retry within the declared allowance. If replacement or degradation is authorized, create the required roster/assignment revision and re-evaluate compatible contributions explicitly. An exact pinned roster of any size waits or blocks when its required participation cannot be completed, while unrelated authorized work continues. A decision quorum does not waive a missing required contribution.

## 14. User experience

The project conversation is the primary place to give a goal and follow progress. Put the active role setup beside it, with compact sections such as **Coordinators: Opus + Astra**, **Reviewers: Fable + Sol**, and **Implementation: Auto**. Expand the relevant roles as they become active; avoid requiring the user to configure every possible role before starting.

Each role section supports Add member, Remove member, model search across providers, Auto or pinned settings, exact/maximum count, collaboration mode, and completion policy. Show model options unsupported by the selected route as unavailable with a useful reason, while preserving saved pins. A user's natural-language selection should produce the same persisted settings as the UI.

The editor must support adding a third, fourth, fifth, or later member without changing modes or creating a second role. Render a searchable, scrollable member collection with a visible total and per-member controls. Keep all members accessible at compact window sizes and through keyboard navigation; do not build the screen around two fixed model columns. Display completed, running, and queued counts separately, such as “3 of 5 reports returned; 2 running.” Expose team size, execution width, and decision policy as separate settings.

### During execution

The goal view should show the accepted plan, tasks and dependencies, each active role group, and its progress. Useful states include “Both coordinators preparing proposals,” “Reconciling one planning disagreement,” “1 of 2 reviews returned; waiting for Sol,” and “Fable is unavailable; this review is incomplete.” Derive these labels from persisted state and actual attempts.

A member card should show its role, requested model, effective model when observed, provider/route, Auto or pinned status, selection reason, queued/running/waiting/failed state, and a link to that member's contribution or transcript. Keep group progress separate from member progress. Display retained disagreement and the aggregate conclusion together so synthesis does not conceal which member said what.

Use task and group controls for follow-up, scoped reassignment, pause, stop, and retry. Preserve existing Claude step cards where a group explicitly uses assisted participation. Their terminal opening, stopped confirmation, paste/transcript hand-back, and evidence labels remain visible.

### Completion

The coordinator group returns a concise synthesized result referencing the actual artifacts, checks, review reports, unresolved findings, and decisions. The user can expand individual contributions. For code work, the completion view identifies the exact candidate awaiting acceptance and its review-group evidence. For informational work, it identifies the produced artifact and its limitations without inventing code verification.

A status answer can be rendered by the service from recorded facts. A substantive final synthesis follows the group's declared policy and retains contributor attribution. A visually unified reply must not erase the underlying members' contributions or pretend every claim was independently endorsed.

## 15. Repository implementation map

The paths below separate existing extension points from proposed new modules. Final names can follow repository conventions; the ownership boundaries are the important part.

| Area | Existing extension points | Proposed work |
| --- | --- | --- |
| Domain and commands | `packages/domain/workflow.ts`, `types.ts`, `commands.ts`, `workflow-drafts.ts` | Role definitions/groups, member identity, typed non-code completion, round schemas, versioned settings and commands |
| Model routing | `packages/providers/contract.ts`, `readiness.ts`, `runtime-binding.ts`; routing presets in `packages/workflows/advanced.ts` | Purpose-based capabilities, account-bound catalogs, concrete per-member assignments, group Auto composition |
| Native runtime | `packages/runtime/manager.ts`, `coordinator.ts`, `concurrency.ts`; provider adapters | Purpose-specific schemas/tools, member-keyed sessions, controlled workspaces, group reservation and lifecycle accounting |
| Orchestration | New `packages/orchestration/` modules | Intake, goals, role resolution, round supervision, proposal/reconciliation protocol, plan commits and scheduling |
| Persistence | `packages/persistence/repositories/coordination.ts` and the current store | Revisioned groups/rounds/contributions, queued actions linked to existing operation intents, control fences, recovery and migrations |
| Review and build | `packages/workflows/builder-reviewer.ts`, `parallel-specialists.ts`, `advanced.ts`, candidate/check machinery | Per-member state, review aggregation barrier, isolated multi-implementation and controlled integration |
| Context | `packages/context/packages.ts` and existing manifests | Common round snapshots, per-member grants, attributed handoffs and typed artifact references |
| Service | `apps/service/service.ts` | Goal/group commands and views, atomic admission, integration with all existing dispatch/control paths |
| Desktop | `apps/desktop/renderer/coordination.tsx`, `workflow-setup.tsx`, workflow/member panels | Cross-provider member chips/selectors, team progress, attributed reports, disagreements and scoped controls |
| Documentation | Canonical design, implementation status, relevant workflow/provider plans and acceptance records | Keep proposed, implemented, fixture, actual UI, live-provider, and packaged evidence separate |

Existing file references: [domain commands][s23], [draft settings][s24], [parallel specialists][s25], [desktop coordination][s26], and the sources cited in the baseline. Documentation changes should follow the repository's requirement to update design and evidence with behavior-changing work. [Repository instructions][s01]

## 16. Delivery sequence and exit criteria

Implement this as small reviewable changes with early multi-member contracts. The automatic Claude route is a critical dependency for the user's named cross-provider example, so start its feasibility and contract work early rather than leaving it as a post-release enhancement.

### Phase 0 — Rebase the design and prove runtime contracts

Update the canonical design and implementation status against this snapshot. Define N-member role collections, role/member/round identities, purpose-specific output and tool contracts, model-identity evidence, result kinds, contribution versus decision policies, and resource assumptions. Establish the supported production path for exact-model Claude execution without changing current assisted behavior.

**Exit:** Reviewed contracts and capability matrix for both current providers, explicit unresolved route gaps, and a provider-neutral contract harness. Fixture success is labelled as such; unsupported production routes stay gated.

### Phase 1 — Persist groups, assignments, and migrations

Add N-member role groups, exact/Auto/required-plus-Auto membership, configurable count bounds, stable members, round/contribution records, typed outcomes, settings commands, and member/session associations. Extend routing presets to allow repeated role names with unique member IDs. Keep membership intent separate from generated plans and avoid pair-specific fields or transitions.

Migrate the one-member structure of existing builder/reviewer drafts and presets into singleton groups. Preserve genuinely selected model/runtime values and their known intent; empty fields remain unresolved, and an untouched default must not be relabelled as an explicit user pin. If old records lack enough intent provenance, preserve the value with unknown/legacy provenance and require ordinary selection resolution before execution. Preserve unknown model values and terminal Claude's native-default meaning. Keep completed workflows and acceptance records immutable; use a compatibility reader for historical state. Let existing in-flight workflows finish under their versioned engine or migrate only at a quiescent boundary with explicit checks. Do not reinterpret an active accepted decision during migration.

**Exit:** Saved solo behavior retains its meaning; one-, two-, three-, and five-member groups retain distinct member/session identities, including same-provider members sharing an account; roster/model settings survive restart and round changes. Configured maximums and changes to those maximums work consistently without a hidden two-member ceiling.

### Phase 2 — Resolve Auto and qualify model-controlled routes

Implement purpose-based readiness, catalog freshness/account binding, concrete member assignment, group count/ranking policy, exact pin preservation, unavailable-model states, and per-member requested/effective setting validation. Implement the supported automatic Claude path and qualify the relevant purposes, including lifecycle and fan-out behavior needed for parallel work.

This phase can proceed alongside orchestration and review work against shared contracts and stand-ins. The final cross-provider release remains gated on actual route evidence.

**Exit:** Every eligible catalog model can be assigned to every role whose requirements its route satisfies; exact groups never substitute native defaults; capability/model mismatches prevent the affected attempt from satisfying the role. Cross-provider automatic execution has purpose-specific qualification evidence before it is presented as available.

### Phase 3 — Durable coordinator conversation and shared decisions

Build intake/goal state, the task graph, bounded control turns, common snapshots, separate contributions, reconciliation, exact-decision endorsements, one transactional commit, and the dispatch loop. Add goal control generations and apply them to existing scheduling paths. Support at least three coordinators and a five-member decision-policy case through this phase's tests, even if solo and two-member paths are delivered first internally.

**Exit:** N required models contribute to one goal plan and create one admitted task graph. Test both unanimous decisions and a three-of-five endorsement policy after all required contributions; retain dissent and block when required participation is missing. Stale/conflicting/duplicate proposals cannot duplicate work; a crash does not blindly replay an uncertain native start; pause/stop works without consulting models. Information-only goals complete without fabricated code candidates.

### Phase 4 — Review groups and worker execution

Refactor review completion before enabling multiple reviewer selectors. Add candidate-bound reports, required-member barriers, finding aggregation and explicit disposition, repair/re-review, per-member candidate access, and aggregate acceptance evidence. Reuse existing parallel specialist/candidate mechanisms for partitioned work and serialized integration.

**Exit:** Independent review retains every required result for two-, three-, and five-member teams; four clean reports cannot erase the fifth reviewer's substantiated finding; no missing required reviewer is counted as a pass. A three-member implementation or custom-role group demonstrates that generalized membership also works beyond coordination/review. Integrated code is checked and reviewed as the actual final candidate. Resource and workspace tests establish feasible parallel execution, bounded waves, and honest queuing.

### Phase 5 — Product UI, steering, and end-to-end evidence

Deliver the role-team UI, mixed Auto/pins, user-message overrides, member attribution, group progress, disagreement handling, cancellation/restart views, and compatibility with current assisted Claude cards. Validate the actual desktop journeys and record bounded live-provider runs against observed model IDs and installations.

**Exit:** Full goals work with supported managed routes for the original two-model examples and for larger teams, including three coordinators/five reviewers and five-member roles scheduled in waves. Same-provider and cross-provider choices preserve member identity; every required model participates; errors and disagreements remain visible; existing manual workflows still work. The user's labels may be mapped to actual catalog IDs only when observed and available. A pair-only implementation does not satisfy this release gate.

### Evidence and release labels

Record fixture protocol tests, actual Electron/UI tests, live-provider runs, host/runtime/model/permission details, and packaged-platform verification separately. A fixture Opus/Astra label is not live evidence for those models. A successful solo Codex workflow cannot stand in for the revised multi-model requirement. If a production provider route remains unavailable, describe the result as partial and identify that specific missing capability.

This plan rewrite performed source/document review only. It did not run Topsl, authenticate providers, submit paid model turns, or implement the feature. The acceptance scenarios below are requirements for future delivery.

## 17. Acceptance scenarios

Prioritize tests that distinguish correct group semantics from superficially array-valued selectors. Extend existing meaningful workflow/runtime/UI suites; avoid duplicating tests that merely mirror field definitions.

| ID | Scenario | Required result |
| --- | --- | --- |
| RG-01 | Any qualified model selected for coordinator, reviewer, implementer, or another role | Eligibility follows task/runtime capabilities, with no provider-role restriction. |
| RG-02 | Exact Opus+Astra coordinator roster | Both independently attributed members contribute; neither becomes fallback or permanent privileged leader. |
| RG-03 | Exact Fable+Sol review roster | Both review the same candidate; group completion waits for required valid reports. |
| RG-04 | Two members under one provider and the same authorized native account/profile | Separate sessions and member-specific binding records, attempts, outputs, and model checks; no provider-map overwrite or unnecessary second account. |
| RG-05 | Auto count and models | Resolved group respects count, capacity, capability and authorized provider/account constraints, with a recorded reason. |
| RG-06 | Required member plus Auto | The pin survives while other slots can be filled automatically within the permitted roster policy. |
| RG-07 | Replan, repair, retry, restart | Exact membership and count survive; history and assignment revisions remain accurate. |
| RG-08 | Unknown, ambiguous, or unavailable model label | Preserve the choice and show unresolved/unavailable state; no invented model ID or native-default substitution. |
| RG-09 | Runtime reports different model/effort | The affected exact-model assignment cannot satisfy its role; peers' valid evidence does not cover it. |
| RG-10 | Existing assisted Claude step | Hand-back still works with original provenance; it cannot satisfy a strict managed exact-model pin. |
| RG-11 | Pinned primary with an explicitly authorized fallback | Primary intent persists; only the authorized fallback is used, under a separately attributed assignment revision. |
| RG-12 | Same member ID reassigned to another model during a round | A new round freezes the new assignment map; old-model contributions/endorsements cannot count as the replacement model, and compatible peer reuse is explicit. |
| RG-13 | Three-, five-, and configured-maximum member groups in any role | All members persist, route, execute, and remain visible; no schema, service, storage, or UI silently truncates after two. |
| RG-14 | Exact five-reviewer count with Fable and Sol pinned | Three remaining members are selected automatically; all five remain in the round and survive replanning/restart. |
| RG-15 | Count above a configured limit, followed by a valid limit increase | Preserve the requested count and explain the initial conflict; the raised limit enables the valid roster without a fixed two-member ceiling. |
| CO-01 | Two compatible coordinator proposals | Peers endorse the same action-set digest; one transaction creates one plan and one set of queued actions linked to the existing runtime intents. |
| CO-02 | Conflicting coordinator proposals | Bounded reconciliation preserves the disagreement; unresolved material decisions do not dispatch. |
| CO-03 | User steering during endorsement | Old revisions cannot commit; unaffected authorized work retains its valid scope. |
| CO-04 | Required coordinator fails | Role waits/blocks or follows an explicitly authorized policy; quorum is not silently reduced. |
| CO-05 | Duplicate message/event or crash around dispatch | No duplicate logical task; uncertain native execution is reconciled before retry. |
| CO-06 | Five valid required coordinator contributions, three endorsements, explicit three-of-five policy | One decision can commit if other gates pass; the two dissenting contributions remain attributed and the denominator stays five. |
| CO-07 | Three endorsements but one of five required contributions missing | The quorum cannot waive required participation; no decision commits until the declared policy is satisfied. |
| CO-08 | Five-member vote with an abstention, duplicate retry, or required endorser dissenting | No denominator shrinkage or duplicate vote; an unmet required endorsement blocks the decision. |
| RV-01 | One review clean, one substantiated finding | Finding remains actionable; clean report cannot resolve it by omission. |
| RV-02 | Required report missing, invalid, or inconclusive | Review is incomplete; no automatic pass or final acceptance. |
| RV-03 | Overlapping/conflicting findings | Deduplication retains original evidence; dispositions are candidate- and finding-specific. |
| RV-04 | Candidate or specification changes | Old review completion becomes stale; the applicable required roster re-reviews the new input. |
| RV-05 | Model diversity versus independence | UI distinguishes model identity, fresh sessions, complementary coverage, and actual isolation evidence. |
| RV-06 | Five reviewers: four clean reports and one substantiated defect | The defect remains actionable; a clean majority cannot resolve it by omission or vote. |
| RV-07 | Five required reviewers with only the first two or four reports returned | Review remains incomplete, with exact completed/running/queued counts and no pair-based early completion. |
| EX-01 | Contribution, reconciliation, endorsement, then workers under a full two-slot budget | Each completed turn releases resources after quiescence; later stages acquire fresh reservations without a parent/child or inter-stage deadlock. |
| EX-02 | Unknown native fan-out under raised capacity | Existing full-budget weight is preserved; UI does not falsely show simultaneous execution. |
| EX-03 | Feasible two-member parallel round | Qualified bounded routes and distinct compatible workspaces run concurrently with accurate accounting. |
| EX-04 | Multiple implementation members | Separate workspaces/candidates, controlled integration, and review/checks of the integrated candidate. |
| EX-05 | Pause/stop/restart with active and uncertain members | All applicable dispatch paths honor fences; uncertainty retains leases/capacity; no stale endorsement restarts work. |
| EX-06 | Opened assisted Claude build is cancelled | Native exit/stopped confirmation and current edit-hold rules are preserved. |
| EX-07 | Auto-accept and coordination together | Existing editing policy works; read-only roles and final candidate acceptance retain their distinct rules. |
| EX-08 | Information or planning goal | Valid typed artifact/decision completes without a fabricated code candidate or check result. |
| EX-09 | Atomic cohort reservation followed by partial startup failure | Never-spawned reservations are released; started peers are stopped when needed; uncertain processes retain leases/capacity and are not duplicated. |
| EX-10 | Five members with execution width two and capacity-bounded scheduling | Admit waves of 2 + 2 + 1, preserve the full roster and frozen input, keep initial contributions independent, and count every required result. |
| EX-11 | Strict all-five-simultaneous policy with capacity for two | Keep the roster intact and show the capacity conflict; do not silently claim simultaneity or change policy. |
| EX-12 | Three-member implementation or custom-role group | The general membership, identity, lifecycle, completion, and workspace rules apply without coordinator/reviewer special cases. |
| UI-01 | Add/remove/pin/Auto through UI and conversation | Identical scoped membership semantics and clear member/group progress. |
| UI-02 | Add and edit a fifth member in a compact window | All members remain reachable and individually configurable; the role is not split into pairs and counts reflect actual state. |
| MG-01 | Legacy singleton drafts/history/in-flight work | Saved meaning retained, past evidence unchanged, and active engine versions handled deliberately. |
| E2E-01 | Three coordinators, Auto workers, five reviewers | All required members participate, one plan is admitted, all five required reviews are evaluated, and one acceptance path remains authoritative. |
| E2E-02 | Feasible managed parallel configuration for the two coordinator and two reviewer groups | Initial coordinator contribution attempts overlap, and reviewer attempts overlap in their later phase, confirmed by lifecycle evidence; a sequential run is labelled and does not substitute for this proof. |
| E2E-03 | Five coordinators and five reviewers with two active member slots | Each role completes in bounded waves with all required contributions, correct decision/review barriers, preserved independence, and one authoritative plan/acceptance path. |
| E2E-04 | Feasible managed parallel configuration with three or more members in a role | Observed attempts overlap within configured capacity; the larger roster is preserved and every required result is attributed, with no pair-only execution path. |

## 18. Example target behavior and implementation handoff

For “Add the coordinator feature; coordinate with Opus and Astra, review with Fable and Sol,” Topsl first resolves those four labels to available exact model bindings. It preserves the two exact rosters and leaves unspecified roles on Auto. Any unavailable binding is shown before its role can execute.

Opus and Astra then receive the same goal snapshot and prepare separate proposals. They agree the task breakdown, any disputed architectural decision, and the delegation scope through their declared peer policy. The service commits their common plan once. Their turns end and release capacity before the assigned workers begin.

Auto-selected implementation members work on scoped tasks in compatible workspaces. Topsl integrates the results into a captured candidate. Fable and Sol each review that candidate independently. If Fable finds a reproducible defect and Sol reports none, the defect remains; the plan can admit a bounded repair and a new required review round. If one reviewer is unavailable, Topsl reports the incomplete review rather than treating one result as both.

When required reviews, findings, checks, and output decisions are satisfied, the coordinator group provides the result with links to the contributions and final candidate. The user's original model choices remain visible throughout.

The same interaction can request “Use three coordinators; include Opus and Astra. Use five reviewers; include Fable and Sol.” Topsl resolves the two pinned coordinators plus one Auto member, and the two pinned reviewers plus three Auto members. All required members participate. With two eligible execution slots, the reviewer group runs in waves of 2 + 2 + 1 while keeping the same candidate and independent initial reviews. A five-coordinator team uses the same machinery, with all five contributions and the configured unanimous or quorum decision rule.

Start implementation with the shared domain/purpose contracts and the exact-model Claude route investigation in Phase 0. Build configurable N-member teams into every subsequent stage. Release requires the larger-team and wave scenarios in E2E-01/E2E-03, feasible parallel evidence in E2E-02/E2E-04, and actual provider evidence. The numbers in these scenarios are coverage cases, not role-size limits.

## Source index

All repository links below are pinned to the inspected commit. They establish the baseline; proposed record names, defaults, protocols, and phases are design decisions in this document.

- [S01 — Repository instructions][s01]
- [S02 — Guided workflow setup and provider pairing note][s02]
- [S03 — Builder/reviewer state, Claude integration, and review completion][s03]
- [S04 — Claude step types, native-default model, and transcript provenance][s04]
- [S05 — Role readiness and terminal-step readiness][s05]
- [S06 — Runtime manager, catalog inspection, schemas, tools, and permissions][s06]
- [S07 — Claude adapter and fixture transport restriction][s07]
- [S08 — Advanced participants and explicit routing presets][s08]
- [S09 — Provider, conversation, and run types][s09]
- [S10 — Auto-accept levels and editing policy][s10]
- [S11 — Capacity, unknown native fan-out, and reservation recovery][s11]
- [S12 — Claude transcript validation and final-reply extraction][s12]
- [S13 — Claude workflow delivery and live-run records][s13]
- [S14 — Implementation status and latest dated follow-ups][s14]
- [S15 — Live provider sessions and their limits][s15]
- [S16 — Runtime qualification fingerprint binding][s16]
- [S17 — Provider capabilities, catalog, prepared turns, and model evidence][s17]
- [S18 — Runtime coordinator, leases, attempts, and recovery][s18]
- [S19 — Task, workflow, and session schemas][s19]
- [S20 — Coordination repository transitions and acceptance][s20]
- [S21 — Context packages and input capture][s21]
- [S22 — Service scheduling and Claude terminal/hand-back controls][s22]
- [S23 — Command schemas and assignment cardinality][s23]
- [S24 — Existing workflow drafts][s24]
- [S25 — Parallel specialist workflows][s25]
- [S26 — Desktop coordination view][s26]

[s01]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/AGENTS.md
[s02]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/apps/desktop/renderer/components/workflow-setup.tsx
[s03]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/workflows/builder-reviewer.ts
[s04]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/domain/claude-steps.ts
[s05]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/providers/readiness.ts
[s06]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/runtime/manager.ts
[s07]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/providers/claude.ts
[s08]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/workflows/advanced.ts
[s09]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/domain/types.ts
[s10]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/domain/auto-accept.ts
[s11]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/runtime/concurrency.ts
[s12]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/history/claude-transcript.ts
[s13]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/docs/Claude_Workflows_Plan.md
[s14]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/docs/Implementation_Status.md
[s15]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/docs/Live_Provider_Sessions.md
[s16]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/providers/runtime-binding.ts
[s17]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/providers/contract.ts
[s18]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/runtime/coordinator.ts
[s19]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/domain/workflow.ts
[s20]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/persistence/repositories/coordination.ts
[s21]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/context/packages.ts
[s22]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/apps/service/service.ts
[s23]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/domain/commands.ts
[s24]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/domain/workflow-drafts.ts
[s25]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/packages/workflows/parallel-specialists.ts
[s26]: https://github.com/Piore-Galore/Topsl/blob/c5bac8ecae89c9b2fa16e220c11f6ae2a36deca0/apps/desktop/renderer/coordination.tsx
