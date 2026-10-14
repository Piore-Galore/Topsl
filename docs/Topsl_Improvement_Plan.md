# Topsl Improvement Plan

## Multi-model orchestration, reliable project synchronization, and a clear user interface

**Document version:** 1.0  
**Prepared:** 14 October 2026  
**Repository:** `Piore-Galore/Topsl`  
**Reviewed baseline:** `2c6318d5d3d459086a5a796f82637c5db56c1994` — v0.1.1 pilot rebuild  
**Status:** Proposed implementation plan; no repository changes have been made.  
**Review boundary:** Based on the repository source review and the agreed product direction. The baseline branch was checked again while preparing this document. The application, test suite, and live provider execution were not run for this plan.

> Evolve Topsl from a shared launcher and history interface into a provider-neutral coordinator: one coherent project, explicit agent responsibilities, controlled code ownership, versioned context, and evidence-backed completion.

## Contents

1. [Product direction and scope](#1-product-direction-and-scope)
2. [Repository findings and targeted changes](#2-repository-findings-and-targeted-changes)
3. [Synchronization contract](#3-synchronization-contract)
4. [Target architecture and domain model](#4-target-architecture-and-domain-model)
5. [Multi-model workflow behavior](#5-multi-model-workflow-behavior)
6. [Context, history, and configuration](#6-context-history-and-configuration)
7. [Workspace ownership and integration](#7-workspace-ownership-and-integration)
8. [Provider adapters and native applications](#8-provider-adapters-and-native-applications)
9. [User interface and information architecture](#9-user-interface-and-information-architecture)
10. [Persistence, events, and recovery](#10-persistence-events-and-recovery)
11. [Implementation phases](#11-implementation-phases)
12. [Repository change map](#12-repository-change-map)
13. [Migration and rollout](#13-migration-and-rollout)
14. [Acceptance and fault-injection tests](#14-acceptance-and-fault-injection-tests)
15. [Operational targets and proposed defaults](#15-operational-targets-and-proposed-defaults)
16. [First release demonstration and completion criteria](#16-first-release-demonstration-and-completion-criteria)
17. [Source references](#17-source-references)

---

## 1. Product direction and scope

### 1.1 Desired experience

The user submits a feature request once. Topsl can assign different models to architecture, implementation, independent testing, review, debugging, and integration. It preserves which project, code revision, instructions, and evidence each agent used.

The user should always be able to answer:

- What is the objective, and who is responsible for each part?
- What code and context is each agent using, and what can it change?
- What needs attention, what has been verified, and what is still uncertain?

The first complete workflow is **Codex implementation → Claude review → bounded repair → verification → user acceptance**. The reverse assignment must use the same architecture. Neither provider is permanently the planner, writer, reviewer, or coordinator.

### 1.2 Preserve the existing foundation

Improve the current repository incrementally. Retain the Electron/TypeScript application, encrypted local storage, trust boundaries, executable identity checks, attributed history, reviewed configuration writes, and conservative recovery behavior. These foundations are already represented in the pilot implementation. [R1]

Retain the simple retro-terminal visual direction, with readable typography, Paper/Night/System themes, and keyboard-first operation. Do not turn ordinary use into a wall of terminals or technical logs.

### 1.3 Product boundaries

| Included in the core upgrade | Deferred or explicitly bounded |
|---|---|
| Logical projects, workspaces, tasks, agent sessions, and execution attempts | Cloud-first infrastructure or a compulsory hosted service |
| Cross-provider builder–reviewer workflows | Autonomous deployment or automatic acceptance of model-written code |
| Versioned context and supported native history reconciliation | A universal provider-native transcript format or shared hidden model memory |
| Workspace ownership and controlled parallel work | Claims that worktrees alone enforce security |
| Capability-aware model, tool, permission, and usage displays | Unverified promises that every native desktop feature is remotely controllable |
| A precise synchronization panel and actionable task UI | Rewriting private native databases, authentication stores, or sidebar caches |
| A later optional cross-device layer | Synchronizing live database/WAL files between devices |

Cross-device and remote-host support remain part of the longer-term design, but must not delay a reliable same-machine workflow.

---

## 2. Repository findings and targeted changes

These are source-level observations at the reviewed commit, not claims of failures reproduced in a running application.

| Finding | Source | Required improvement |
|---|---|---|
| `RuntimeManager.start()` uses project-wide busy exclusion, including for a requested review. | `packages/runtime/manager.ts` [R3] | Move execution ownership to an approved workspace. Preserve exclusive writers and allow separate isolated workspaces under one project. |
| `Conversation.nativeSessions` can hold one session identifier per provider. | `packages/domain/types.ts` [R2] | Introduce one-to-many session bindings, execution attempts, task links, and fork/retry lineage. |
| Structured execution is Codex-specific; Claude uses native terminals and explicit imports. | Runtime and implementation status [R1], [R3] | Add a capability-checked structured Claude route, retaining explicit native fallback. |
| Handoff generation selects and truncates recent user/assistant messages. | `packages/workspace/history.ts` [R4] | Extend immutable snapshots into structured context packages with revisions, evidence, and omission reports. |
| A context grant is keyed by project hash; a subsequent grant for the same project replaces its token. | `packages/workspace/context.ts` [R5] | Use unique per-agent/per-attempt grants with separate revocation and a scoped visibility policy. |
| Context history/search is project-scoped rather than independent-review-scoped. | `packages/workspace/context.ts` [R5] | Enforce artifact/message visibility in retrieval and workspace access. |
| `Store.list()` limits each kind to 5,000 records before callers apply project/conversation filters. | Store, context, and history [R4], [R5], [R6] | Replace critical reads with indexed, project-scoped, cursor-paginated queries. |
| The service emits full application state after changes; the renderer tracks one selected session and a global `busy` boolean. | Service and renderer [R7], [R8] | Add scoped subscriptions, stream deltas, per-operation pending state, and multiple visible tasks. |
| Native registry synchronization and visible desktop synchronization are deliberately different. | Synchronization documentation and adapter [R9], [R10] | Preserve the distinction and show it consistently across all synchronization dimensions. |
| The current UI provides useful project trust, folder opening, and native management controls. | `apps/desktop/renderer/projects.tsx` [R11] | Keep these controls, but organize them around logical projects and their workspaces. |

**Priority correction:** fix context grants and scoped history queries before introducing concurrent agents. Otherwise, concurrency would magnify existing architectural limitations.

---

## 3. Synchronization contract

### 3.1 Define “perfect synchronization” precisely

The target is not that every application shows identical content at every instant. The target is:

> Within Topsl-managed work, project identities, inputs, deliverables, and acceptance evidence are explicitly versioned. All supported replicas converge through recorded reconciliation. Conflicts, stale observations, unsupported capabilities, and external activity are visible rather than silently treated as synchronized.

Use different consistency rules for different data:

| Data | Authority | Consistency rule |
|---|---|---|
| Workflow definition, task state, workspace leases | Topsl coordinator | Transactional local updates with revision checks. |
| Native account, native session, reported model and usage | Provider runtime | Observed facts with source and freshness; never synthesized to fill a gap. |
| Files in an execution workspace | That workspace and its approved owner | One managed writer; detect outside changes; capture exact task inputs and outputs. |
| Shared requirements and decisions | Approved Topsl project records | Immutable revisions and explicit delivery boundaries. |
| Native project membership and presentation | Relevant native application | Supported synchronization or observation only; unsupported presentation remains unverified. |
| Optional replicas on other devices | Explicit replication protocol | Eventual convergence with conflicts; execution ownership remains separately controlled. |

### 3.2 Synchronization dimensions

Display and reconcile these dimensions independently:

| Dimension | What is tracked | Meaning of a successful state |
|---|---|---|
| Identity | Project IDs, workspace mappings, provider references | The intended entities are linked without ambiguous identity merging. |
| Code | Base revision, local changes, candidate and integration revisions | Each task uses its intended code basis. Intentional branch divergence is not an error. |
| Context | Specification, decisions, instructions, selected evidence | The recorded package was delivered or acknowledged at the stated evidence level. |
| History | Session lineage, source positions, imported messages/events | Coverage is known through a recorded cursor or observation boundary. |
| Configuration | Desired configuration, effective settings where observable | Unsupported or unconfirmed settings are explicitly identified. |
| Native presentation | Native project registry, folder opening, visible sidebar | Only the particular operation that was verified is marked successful. |

### 3.3 State and evidence must be separate

A synchronization observation should carry:

```typescript
interface SyncObservation {
  id: string;
  projectId: string;
  dimension: "identity" | "code" | "context" | "history" |
    "configuration" | "native-presentation";
  targetId: string;
  state: "current" | "pending" | "stale" | "conflict" |
    "unsupported" | "unverified" | "paused" | "error";
  evidence: "topsl-transaction" | "provider-ack" |
    "provider-readback" | "source-observation" | "user-confirmation" | "none";
  expectedRevision: string | null;
  observedRevision: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulObservationAt: string | null;
  detail: string;
  suggestedAction: string | null;
}
```

This is a proposed domain contract, not a claim that providers expose matching fields.

Do not calculate a misleading “100% synchronized” percentage. A summary can say “Managed workflow current; one external source unverified.” An unsupported dimension is not a failed task, but it must not disappear into a green success badge.

### 3.4 Identity rules

Use a stable Topsl project ID independent of its name, path, Git remote, or provider project ID. Move concrete path and trust bindings into `Workspace` records.

Canonical path checks must remain host-specific. Resolve symlink aliases and consider filesystem case behavior without assuming every filesystem on an operating system behaves identically. Do not automatically merge different checkouts because they share a Git remote. Do not automatically grant access to another root of a multi-root native project.

Record native groups separately from individual roots. A task worktree normally appears beneath its logical project, not as an unrelated project in the main sidebar. New device/folder mappings require explicit approval.

### 3.5 Conflict rules

Retain a last-common observation for fields that can change in both Topsl and a native application. Compare base, local intent, and observed remote state. If both sides changed incompatibly, show a conflict rather than using unqualified last-write-wins.

Use Topsl-owned names/order by default in coordinated mode; offer an explicit “follow native source” policy for users who prefer that behavior. Preserve existing naming behavior during migration until the user changes it.

Native removal must not delete Topsl history or trigger endless automatic recreation. A project rename, relink, archive, native unlink, history deletion, and filesystem deletion are different operations with different confirmations.

### 3.6 External operation protocol

Record intent before dispatching a provider operation. Store the response when received. Reconcile by supported readback before deciding whether a retry is safe.

```text
Prepared → Dispatch recorded → Provider acknowledgment → Readback/verification
                         ↘ Unknown outcome → Reconcile or user resolution
```

Event deduplication can make the local projection idempotent. It cannot guarantee exactly-once execution of an external command or model turn. After a lost reply, an unknown outcome must not automatically create another billable run.

---

## 4. Target architecture and domain model

### 4.1 Architecture

```text
Desktop UI and CLI
        │ typed commands, scoped queries, ordered events
        ▼
Topsl coordination service
  ├── Workflow scheduler and acceptance gates
  ├── Workspace ownership and integration
  ├── Context packages and visibility policy
  ├── Project/native-history reconciliation
  ├── Approval and capability evaluation
  └── Usage and operational evidence
        │
        ├── Codex adapter
        ├── Claude adapter
        └── Native terminal / native application handoff
        │
Encrypted database + protected artifact storage
```

Keep scheduling deterministic. A model may propose a workflow or explain a conflict, but service code validates the plan, enforces permissions, schedules dependencies, and decides whether acceptance evidence is present.

Run one coordination owner per local Topsl profile. Multiple windows or clients connect to it. A database-backed ownership rule must prevent two application instances from separately dispatching the same task. A permanent background daemon is not required for the first release; closing the application must leave active work cancelled, handed off explicitly, or marked uncertain.

### 4.2 Core entities

| Entity | Required responsibility and important fields |
|---|---|
| `Project` | Stable logical identity, display policy, approved shared settings. |
| `Workspace` | Project/host/root bindings, canonical filesystem identity, checkout type, branch, trust revision, availability. |
| `ProviderProfile` | Provider/runtime identity, local profile reference, sanitized account binding, authentication route; no copied credentials. |
| `Workflow` | Objective, template version, specification revision, dependency graph, budget policy, state. |
| `Task` | Role, dependencies, input references, permitted outputs, acceptance criteria, ownership and revision. |
| `AgentSession` | Provider-native identity, account/profile/runtime binding, role, workspace, parent/fork lineage, observability. |
| `ExecutionAttempt` | Task/session link, requested/reported model, start manifest, status, errors, dispatch identity, usage evidence. |
| `ContextPackage` | Immutable content manifest, sources, omissions, visibility policy, size estimates and content hash. |
| `ContextDelivery` | Package/attempt link, delivery state, provider evidence and timestamp. |
| `Artifact` | Patch, commit/snapshot, specification, review, or report; author, provenance, content hash and confidentiality. |
| `Verification` | Check definition, exact target revision, environment, result, evidence and invalidation state. |
| `ReviewFinding` | Candidate reference, affected behavior, severity, evidence, resolution/disposition and recheck result. |
| `WorkspaceLease` | Workspace identity, owning attempt, generation, heartbeat, execution binding and reconciliation status. |
| `OperationIntent` | External request identity, expected revision, dispatch/acknowledgment state and recovery evidence. |
| `SyncObservation` | Per-dimension source, coverage, freshness and state. |

Keep conversations as a user-facing history grouping. Do not use them as the sole execution or ownership unit.

### 4.3 State machines

Keep execution, task, workflow, and acceptance states distinct:

```text
Attempt: prepared → starting → running ↔ awaiting-approval
                                      → completed | failed | interrupted | uncertain

Task: draft → ready → active → submitted → reviewing → verifying → accepted
          ↘ blocked             ↘ changes-requested → ready

Workflow: draft → ready → running ↔ blocked → awaiting-acceptance → accepted
                                      ↘ failed | cancelled
```

A retry creates a new attempt; it does not overwrite the old attempt. An existing provider session may be reused only when its account, workspace, role, and continuity constraints remain valid. Independent reviewers must not resume sessions contaminated with a competing answer.

Validate transitions, dependency cycles, required capabilities, and revision expectations in the service. Disallow two active turns on a session unless an adapter explicitly proves the runtime supports the intended behavior.

### 4.4 Security invariants

| Invariant | Enforcement |
|---|---|
| No concurrent managed writers to the same filesystem workspace | Transactional lease acquisition over canonical workspace identity, including aliases. |
| No cross-project context leakage | Retrieval predicates and grant validation enforced server-side. |
| No false independent review | Restricted context, fresh session, and independently enforced filesystem/tool access. |
| No silent permission escalation | Effective capability checks and digest-bound approval. |
| No false completion | Service-owned acceptance gate requiring current artifacts and checks. |
| No duplicate dispatch after uncertainty | Durable intent and reconciliation before any replacement attempt. |
| No stale account/runtime trust | Validate profile, executable, runtime revision, and workspace trust at dispatch. |

---

## 5. Multi-model workflow behavior

### 5.1 Workflow templates

| Template | Execution behavior | Completion rule |
|---|---|---|
| Build + review | One implementer; another agent reviews a pinned candidate; repair is bounded. | Required findings resolved or explicitly waived, checks current, user accepts. |
| Parallel specialists | Separate writers implement agreed interfaces in isolated workspaces. | Combined candidate passes integration checks. |
| Independent proposals | Agents receive the same approved problem statement without peer proposals. | Frozen submissions are compared against a declared rubric. |
| Pair debugging | One writer/driver; navigator proposes experiments at checkpoints. | Reproduction and regression evidence support the fix. |
| Competing implementations | Independent candidates receive the same test protocol. | Measured comparison selects a candidate; no majority-vote shortcut. |
| Independent test design | Test designer starts with requirements and allowed interfaces, not implementation details. | Frozen test artifact is run against the candidate in a separate verification step. |

Each template should define required capabilities, role visibility, dependencies, allowed state transitions, repair limits, and expected artifacts. Roles are configurable and model selection is interchangeable.

### 5.2 The first vertical slice

1. Capture the request and acceptance criteria as specification revision 1.
2. Confirm the approved workspace and code baseline, then create an implementer attempt.
3. Build and deliver its context package. Display provider acceptance evidence.
4. Run implementation and collect a candidate artifact with a precise revision.
5. Freeze the candidate. Start a fresh reviewer session against it.
6. Normalize evidence-backed findings; allow “no substantiated findings.”
7. Return accepted findings to the implementer in a new attempt when repair is required.
8. Run checks against the final candidate. Any changed candidate invalidates prior review/check acceptance by default.
9. Present changes, review disposition, tests, usage coverage, and remaining limitations for user acceptance.

Do not equate model agreement with correctness. Turn material disagreements into a reproduction, documentation check, benchmark, or explicit unresolved decision.

### 5.3 Routing and budgets

Start with user-selected role presets and the existing native model discovery where supported. Store requested and provider-reported effective models separately. When the effective model is not reported, label it unconfirmed.

Support per-workflow concurrency, per-provider concurrency, repair-round limits, wall-clock alerts, and usage/spend thresholds. A subscription allowance must not be invented from token counts. A spend threshold derived from delayed estimates is an approximate guardrail, not a guaranteed billing ceiling.

Track hidden concurrency conservatively: only enable native subagent fan-out when its count and permissions can be bounded or when the user explicitly accepts reduced observability. Do not let two visible workers each create an unbounded invisible team.

---

## 6. Context, history, and configuration

### 6.1 Context packages

Extend the existing immutable context snapshot rather than replacing its provenance model. [R4]

A package must identify the objective, specification and decision revisions, interface contracts, workspace baseline, candidate references, allowed source evidence, unresolved findings, and expected outputs. Include conversation excerpts only where relevant.

Record all exclusions and truncations. If mandatory acceptance criteria or interfaces cannot fit the configured budget, block dispatch or require a reviewed reduction; never silently omit them. Store tokenizer-based sizes when available and clearly label estimates otherwise.

Capture instruction-file paths and hashes together with the delivery method. File presence, explicit injection, provider acknowledgment, and runtime-confirmed loading are different evidence levels. Never describe successful submission as proof that the model understood every item.

### 6.2 Context updates during execution

Shared decisions are versioned. An agent continues to be associated with the inputs it actually received, even after newer context becomes available.

Show “Specification 13 available; this attempt started with 12.” Allow explicit delivery at a supported checkpoint, cancellation/restart, or completion against the old specification with later review. Do not modify an in-flight context package retroactively.

A downstream task must evaluate dependency revisions before dispatch. A changed interface may block the task even when an unrelated documentation change would not.

### 6.3 Per-agent grants and independence

Replace project-hash grant keys with unpredictable unique grant IDs. Bind each grant to project, workflow, task/attempt, visibility policy, allowed operations, expiry, and coordinator instance. Revoke it independently when the attempt ends or ownership changes.

History/search results should include source IDs and revisions so agents and the UI can cite evidence. Queries must enforce scope before ranking, limiting, and pagination.

An independent proposal/test task must be denied peer outputs through every relevant route: context service, search, exported files, repository artifacts, accessible transcripts, and tools. A prompt is not an access control. If the runtime cannot enforce the required isolation, mark the workflow “independence not enforced” or disable that template rather than claiming blind review.

### 6.4 Native history reconciliation

Prefer supported read/list interfaces. Use explicit transcript imports or scoped compatibility readers only when the route is authorized and understood. Never manufacture native messages to make another provider believe it authored a conversation.

Persist a source key containing provider, profile, session, and source identity. Use native event IDs where available; otherwise use a documented stable record identity with collision checks. Track cursors, source revisions, truncation/rotation, partial trailing records, parser version, and last success.

Do not advance a cursor beyond durably imported records. Preserve causal/native order separately from display timestamps. Compaction or missing source coverage must be visible. Reimports must respect deletion tombstones.

Imported reference conversations remain non-resumable unless account/session identity and the supported resume route have been independently verified. A cross-provider transfer is a new attributed handoff, not a native resume.

### 6.5 Configuration, skills, plugins, and permissions

Model shared intent separately from provider-specific settings. Examples include the desired network policy, required context tools, review-only access, and common project instructions. Translate only where equivalent semantics are verified.

For each session, display:

```text
Requested → Configured → Discovered → Enabled → Available/effective
```

Persist versioned configuration evidence. “Written to disk” does not mean “reloaded by a native session.” Use reviewed writes, backups, source-hash conflict detection, and allowlisted paths already present in the design. [R1]

Classify a capability as enforceable, observable-only, native-only, unsupported, or unknown. A missing required security capability blocks the workflow rather than silently weakening it.

---

## 7. Workspace ownership and integration

### 7.1 Workspace leases

Acquire a write lease transactionally using canonical host/filesystem identity, not merely a user-visible project ID. Two aliases of the same directory must contend for the same lease.

Lease expiration does not prove the old process stopped. Use a generation/fencing value for Topsl-controlled actions, but recognize that an already-running native process may retain direct filesystem access. Confirm termination or quarantine the workspace before reassigning it. PID alone is insufficient evidence because process identifiers can be reused.

External processes are outside complete Topsl control. Detect supported process/filesystem signals and flag externally modified candidates. Do not promise to discover every external writer.

### 7.2 Capture the real code basis

Record the Git base commit when available, plus included tracked changes, selected untracked files, submodule state, relevant large-file state, and instruction hashes. Use an approved content manifest for non-Git folders.

Require either a clean starting point or a reviewed snapshot of dirty inputs. Exclude credentials, ignored secrets, caches, and build output by default. Never silently reset or stash the user's working directory.

### 7.3 Parallel execution

One writer owns each mutable worktree. A reviewer reads a pinned snapshot; a test runner receives writable temporary/cache locations outside the protected candidate. Independent testing needs its own permitted writable workspace, not an exception to read-only review.

Worktrees are separation of checkout state, not a complete sandbox. Apply enforced filesystem/tool restrictions where supported and explicitly account for shared Git metadata. Allocate task-specific ports, databases, temporary directories, and mutable test resources.

### 7.4 Integration

Workers submit immutable candidates. An integration task applies selected candidates to a known integration base, resolves conflicts explicitly, and runs the required checks on the combined result.

Record base, input candidates, combined revision, environment, test commands, and result artifacts. Passing checks on separate branches never substitutes for checks on the combined revision.

A later patch invalidates earlier candidate-specific acceptance by default. Selective reuse of verification can be introduced only with explicit, tested rules. Do not let the implementer redefine acceptance tests or silently change the specification to pass.

Keep task workspaces until their artifact retention policy permits cleanup. Destructive cleanup requires confirmed inactivity and protected evidence; failed or uncertain work must not be auto-deleted.

---

## 8. Provider adapters and native applications

### 8.1 Shared adapter contract

Create a provider-neutral interface with capability negotiation instead of implementing a lowest-common-denominator wrapper. Use versioned runtime schemas and validated external payloads; avoid propagating unrestricted `any` values into domain state.

| Operation group | Required behavior |
|---|---|
| Discovery | Identify runtime, version, profile, compatibility evidence, and supported routes. |
| Models | Report available choices and supported controls; distinguish requested from effective values. |
| Sessions | Start, supported resume/fork, read, interrupt, and reconcile where available. |
| Turns/events | Normalize message, tool, approval, completion, and usage events without losing provenance. |
| Approvals | Bind the decision to request identity, exact operation, attempt, workspace, and runtime revision. |
| History | Supported pagination/cursors or explicit import boundaries. |
| Projects | Separate discovery, registry mutation, folder opening, and visible desktop behavior. |
| Native controls | Explicit terminal or application handoff for capabilities outside structured control. |

Each capability report includes its route, supported/runtime versions, tested platforms, observed restrictions, freshness, and evidence level. An untested capability is not promoted to supported because a similarly named command exists.

### 8.2 Codex adapter

Extract the existing Codex-specific execution logic from the manager into a dedicated adapter while preserving behavior. [R3]

Validate the installed runtime's actual schema before enabling model controls, session history reads, project methods, approvals, or native continuation routes. Preserve useful discovery metadata rather than reducing everything to model names. Add pagination and source reconciliation only for verified methods.

Keep experimental/native registry capabilities clearly labelled. A registry write/readback is not proof that a separate desktop refreshed its sidebar. [R9], [R10]

### 8.3 Claude adapter

Evaluate the supported structured Claude CLI/SDK route during implementation. Select the integration only after checking its current protocol, permissions, session behavior, licensing/authentication arrangement, and billing route against official documentation and the user's installation.

Keep native Claude terminals operational. A terminal-only route must be shown as native-controlled, with reduced structured visibility; it must not silently masquerade as a fully coordinated agent.

### 8.4 Authentication and subscriptions

Preserve provider-owned authentication and keep accounts separate. Topsl must never copy session tokens between applications or synchronize credential stores between devices.

Keep native-subscription execution and API-authenticated execution as distinct user-approved modes. Do not introduce an API key or paid request as a fallback. Where a route cannot use the user's selected authentication arrangement, explain the limitation and stop before dispatch.

Account/profile changes invalidate unsafe session reuse. Show sanitized account identity, active billing route, and credential owner without exposing secrets.

### 8.5 Native application actions

Use separate actions with capability checks:

| Action | Meaning |
|---|---|
| Open folder | Hand off an approved directory through a supported route. |
| Continue native session | Resume that provider's verified session identity. |
| Hand off to another provider | Create a new attributed context transfer and destination session. |
| Observe/import session | Add supported history without claiming ownership of execution. |
| Take coordinated ownership | Allowed only after active ownership and runtime capability are reconciled. |

Do not promise CLI/desktop continuation on every platform. Add platform/runtime-specific tests before displaying the action as supported. Native confirmations remain visible when required.

---

## 9. User interface and information architecture

### 9.1 Main navigation

After onboarding, open the last active project/workflow. Keep Applications available for installation and connection management rather than making it the recurring task destination.

Use primary navigation for **Projects**, **Activity**, **Applications**, and **Settings**. Within a project, provide **Overview**, **Tasks**, **Changes**, **Context**, **History**, and **Synchronization**. Avoid duplicating the same settings across project and application pages.

### 9.2 Workspace layout

The following is a text layout specification, not a screenshot of the current application:

```text
TOPSL / Topsl / Unified usage reporting
2 agents active · 1 action required · Integration not started

PROJECTS          WORKFLOW / TASKS                      INSPECTOR
Topsl             Define contract       Accepted       Selected: Review
  Usage report    Implement adapter     Submitted      Provider: Claude
  Sync engine     Review candidate C7   Running        Role: Reviewer
Pantheon          Repair findings       Waiting        Workspace: review-C7
                  Verify + integrate    Waiting        Code: candidate C7
                                                       Context: package 18
                  RECENT ACTIVITY                      Spec: revision 12
                  Candidate C7 submitted               Access: Read-only
                  Review started against C7            Source: Coordinated
                  Tests: 42/42 passed on C7

                  [Review pending action]              [Open session]
```

On narrow windows, collapse project navigation and place the inspector in an accessible drawer. Preserve active-task status and pending approvals without forcing horizontal scrolling.

### 9.3 Information hierarchy

| Always visible | Selected task/agent | Inspection drawer |
|---|---|---|
| Project and objective | Role, provider, requested/effective model | Native IDs and complete source metadata |
| Active tasks and blockers | Runtime/profile and workspace | Input manifests and content hashes |
| Pending approvals | Code/specification/context revision | Exact commands and raw supported events |
| Acceptance/integration stage | Current action and freshness | Detailed usage and compatibility evidence |
| Meaningful synchronization warning | Permissions and ownership mode | Source coverage, omissions, and configuration provenance |

Show machine-readable identifiers only where they help distinguish evidence; provide friendly labels plus copyable full values in the inspector.

### 9.4 Agent/task card contract

Every card must show the task title, role, provider, lifecycle stage, and next meaningful event. Its expanded state adds model, runtime, account/billing route, workspace, current code basis, context/specification revision, access policy, dependencies, deliverable, last activity, and usage coverage.

Show observability explicitly: **Coordinated**, **Observed external**, **Native handoff**, or **Uncertain ownership**. A process running somewhere on the machine is not automatically a Topsl-managed task.

Maintain selection by task/session ID during streaming. A background update must not switch the user's model selector, move keyboard focus, or jump the transcript to another conversation.

### 9.5 Synchronization panel

Each row shows dimension, state, source, expected/observed revision, last check, last success, reason, and next action. For example:

```text
Folders          Linked and verified
Code             Two isolated workspaces; changes not integrated
Shared context   Reviewer pending specification update
Codex history    Current through recorded turn 24
Claude history   Imported through 14:32; live coverage unavailable
Native sidebar   Not verified
```

“Refresh” reads state. “Resolve conflict,” “Deliver context update,” and “Relink folder” perform different operations and must remain separate. Before a write, show direction, affected target, expected revision, and whether user-owned data could change.

### 9.6 Context inspector

Show the exact delivered package with source citations, code references, hashes, included files, omitted material, and size estimates. Distinguish current project context from the inputs used by a historical attempt.

Explain independent mode: what the agent can access, what is withheld, and whether restrictions are enforced. Do not expose withheld peer content through previews available to that agent.

### 9.7 Changes, review, and verification

Provide a candidate-centric view: base revision, changed files, diff, authoring attempt, review findings, check results, and integration eligibility. Findings link to supporting evidence and their target candidate.

Use explicit states such as “Review passed on C7; current candidate is C8” and “Tests not run.” Test execution errors, failed assertions, skipped checks, and unavailable environments are distinct outcomes.

A waiver must record who approved it, why, and which candidate/criterion it covers. Acceptance does not erase unresolved limitations.

### 9.8 Approval and activity UX

Replace a generic paused indicator with a specific message such as “Codex requests network access for dependency installation.” Show the precise action, workspace, reason, destination where known, and scope/duration of approval.

Group streaming events into meaningful activity entries. Keep commands and raw outputs inspectable without dominating the main timeline. Display observable progress and evidence; do not invent model thoughts or a fake completion percentage.

Bind approve/deny buttons to the current request digest and revision. Resolved, cancelled, or stale requests must no longer be actionable. Never approve a queue of unrelated requests under an ambiguous “Allow all.”

### 9.9 Usage display

Separate native-reported tokens, estimates, API-cost estimates, and provider-reported subscription allowance. Preserve whether a report is per turn, per session, cumulative, or a delta; deduplicate by its proper scope.

Missing usage remains unknown. A total with incomplete sources should say “Known usage: X; two attempts unreported,” not simply show X as complete. Do not add cached-token counts twice where they overlap input totals.

### 9.10 Accessibility and interaction quality

Use readable text for content, monospace selectively for technical identifiers, and restrained status accents. Statuses require text/icons, not color alone. Respect reduced motion, visible focus, keyboard navigation, and screen-reader labels.

Test compact and standard layouts, long paths, Unicode names, high display scaling, empty states, lost connections, large transcripts, and multiple concurrent approvals. Stream updates must not repeatedly announce the entire interface to assistive technology.

---

## 10. Persistence, events, and recovery

### 10.1 Storage evolution

Keep encrypted SQLite as the local authority. Add indexed tables for workflow entities and critical queries through explicit schema migrations. Legacy records may remain in the document store during transition, but workflows must not depend on globally capped in-memory lists.

Index project/task/session foreign keys, source identities, event sequences, operation status, and timestamps used by pagination. Use stable cursor ordering with a tie-breaker; do not rely on timestamp uniqueness or mutable message text.

Keep large artifacts out of every state snapshot. Store protected content separately with hashes and retention metadata. Do not introduce a complex distributed event-sourcing framework as a prerequisite for local orchestration.

### 10.2 Durable control events

For task transitions and external operations, update domain state and the associated operation/event record in one transaction. Assign a monotonic local sequence for replay. Deduplicate imported provider facts by their stable source identity where possible.

Message deltas may be buffered in bounded batches. Checkpoint stream positions and final content so restart recovery does not replay billable work. Preserve raw supported evidence only under retention and redaction rules.

### 10.3 Scoped UI subscriptions

Provide a snapshot at sequence N, then ordered scoped events after N. The client detects gaps and resynchronizes. Subscribe atomically or buffer updates while fetching the snapshot so initial-load races do not lose events.

Use per-project/task queries, paginated history, normalized renderer state, and per-operation pending/error state. An unrelated project's refresh must not disable all controls through one `busy` flag. If UI backpressure drops transient display deltas, a durable resync must reconstruct the canonical final state.

### 10.4 Recovery and cancellation

On restart, reconcile active attempts, sessions, leases, source cursors, and unresolved provider operations. Preserve the pilot's no-blind-replay principle. [R1], [R3]

“Cancel requested” is not “process stopped.” Mark termination confirmed only after evidence. Late provider events must be attached to the original attempt and must not resurrect a cancelled workflow as accepted.

Record startup recovery decisions. When safe automatic reconciliation is unavailable, present the exact uncertainty and a constrained resolution path.

### 10.5 Privacy and deletion

Encrypt sensitive persisted history, context packages, and artifacts. Redact credentials from diagnostic output; a raw event capture must not become a secret archive. Treat imported instructions and tool output as untrusted content, not authority to broaden permissions.

Keep approvals in the trusted control path, not in context-service tools. Avoid storing non-exposed internal model reasoning as product telemetry.

Deletion must remove supported local derivatives, including search entries, context packages, and retained event payloads, subject to explicit retention policy. Keep minimal tombstones to prevent accidental reimport; do not retain deleted transcript text in an immutable audit log. Explain that exported files, native-provider copies, and backups have separate deletion boundaries.

---

## 11. Implementation phases

All items below are proposed work. A phase is complete only when its acceptance gate has recorded evidence. Dependencies take precedence over superficial UI completion.

### Phase 0 — Baseline, capability inventory, and immediate blockers

**Objective:** Establish a reproducible baseline and fix limitations that would make concurrent coordination unreliable.

| ID | Work package | Deliverable |
|---|---|---|
| P0.1 | Create a feature branch from the reviewed/current reconciled baseline; run existing checks on supported environments. | Baseline report with exact commit, runtime versions, commands, outcomes, and untested boundaries. |
| P0.2 | Inspect supported provider integration routes and authentication/billing constraints. | Versioned capability matrix; no paid execution during discovery without explicit approval. |
| P0.3 | Replace project-hash grant replacement with independent unique grants; add expiry/revocation primitives. | Regression tests for two simultaneous grants and isolated revocation. |
| P0.4 | Add scoped paginated history reads; remove global list-window dependency from critical context/handoff paths. | Tests with target-project history outside the previous 5,000-record window. |
| P0.5 | Document current synchronization and execution ownership boundaries. | Updated implementation-status and synchronization documentation. |

**Gate:** Existing behavior remains usable; baseline failures are identified rather than hidden; concurrent grants work; scoped history is complete through pagination; provider capabilities are classified as tested, untested, or unsupported.

### Phase 1 — Domain, persistence, and task-oriented UI foundation

**Objective:** Represent more than one agent/session per project without losing provenance or weakening ownership.

| ID | Work package | Deliverable |
|---|---|---|
| P1.1 | Add projects/workspaces, workflows/tasks, sessions/attempts, artifacts/checks, and revisions. | Domain schemas, validation, transition tests. |
| P1.2 | Add encrypted schema migrations and legacy mapping. | Migration, rollback/restore, tombstone, and provenance tests. |
| P1.3 | Introduce transactional workspace ownership and a single coordinator per profile. | Alias collision and duplicate-coordinator tests; retain conservative exclusion until this passes. |
| P1.4 | Extract Codex-specific logic behind the adapter contract without expanding behavior yet. | Adapter conformance fixtures preserving current execution semantics. |
| P1.5 | Add task list, inspector, ownership badges, and per-operation state. | Minimal multi-session UI and scoped command/query contracts. |

**Gate:** Several sessions can be represented under one project, but managed writers cannot collide. Historical runs remain attributable. Unknown legacy session/account bindings are not upgraded into trusted resumable sessions.

### Phase 2 — First complete cross-provider builder–reviewer workflow

**Objective:** Deliver the smallest end-to-end version of the product we discussed.

| ID | Work package | Deliverable |
|---|---|---|
| P2.1 | Add a verified structured Claude route and capability/billing checks. | Conformance tests plus an explicitly approved bounded live smoke when available. |
| P2.2 | Implement minimal versioned task context, delivery receipts, and per-attempt visibility grants. | Exact input manifest and omission display for every coordinated attempt. |
| P2.3 | Add deterministic build/review/repair dependencies and bounded loops. | Versioned builder–reviewer template with reversible provider assignments. |
| P2.4 | Capture candidate snapshots, fresh reviewer sessions, findings, and required checks. | Revision-bound review and verification records. |
| P2.5 | Show task progress, pending approvals, candidate changes, known usage, and final acceptance. | Usable first workflow without manually copying prompts or transcripts. |

**Gate:** A feature progresses from one request through implementation, independent candidate review, optional repair, verification, and explicit acceptance. Failed checks or stale candidate evidence block acceptance. A terminal-only fallback is not counted as successful structured-adapter acceptance.

**First product milestone:** Ship this vertical slice to the personal pilot before implementing large autonomous teams.

### Phase 3 — Complete local synchronization and context/history reconciliation

**Objective:** Make the shared project record dependable across supported native and coordinated activity.

| ID | Work package | Deliverable |
|---|---|---|
| P3.1 | Implement per-dimension synchronization observations, field authority, and conflict resolution. | Synchronization panel with directional actions and evidence. |
| P3.2 | Add versioned shared decisions, task dependency revision checks, and explicit context updates. | Stale-context notices and update/restart flows. |
| P3.3 | Add supported native history reads/import reconciliation, cursor durability, and deduplication. | Rotation, partial-source, replay, and deletion tests. |
| P3.4 | Generalize native project links while preserving groups, root trust, removals, and presentation limits. | Project/workspace mapping and conflict UX. |
| P3.5 | Add effective instruction/configuration evidence and capability inventories. | Requested-versus-effective session inspection. |

**Gate:** Restart/reimport causes no duplicate durable history; newer specifications are visible without falsifying old run inputs; native removals do not recreate themselves; unsupported sidebar behavior remains explicitly unverified.

### Phase 4 — Safe parallel agents and integration

**Objective:** Support specialists operating concurrently in one logical project.

| ID | Work package | Deliverable |
|---|---|---|
| P4.1 | Add managed worktree/snapshot lifecycle and per-workspace writer leases. | Two isolated workers with canonical-path collision protection. |
| P4.2 | Isolate mutable test resources and enforce required review visibility. | Port/database/temp allocation and isolation tests. |
| P4.3 | Implement task ownership, shared interface contracts, candidate submission, and integration queue. | Parallel-specialists template. |
| P4.4 | Add combined-revision verification and conflict-resolution workflow. | No integration acceptance from individual branch tests alone. |
| P4.5 | Add coordinator-wide fan-out limits and native subagent observability policy. | Actual or explicitly bounded/unknown concurrency reporting. |

**Gate:** Parallel workers do not write the same workspace; reviewers inspect stable inputs; external modifications invalidate affected evidence; only the tested combined candidate can be accepted.

### Phase 5 — Interface clarity, recovery, and release hardening

**Objective:** Make the system understandable and reliable beyond a demonstration.

| ID | Work package | Deliverable |
|---|---|---|
| P5.1 | Finish responsive project/task/context/changes/history/sync surfaces and accessible interaction. | Keyboard, assistive-technology, compact-layout, and long-content test records. |
| P5.2 | Complete sequence-based scoped subscriptions, virtualized history, and bounded streaming. | Measured UI and memory benchmarks under concurrency. |
| P5.3 | Complete source-aware usage, billing-route display, and budget alert behavior. | Snapshot/delta/cached-token deduplication tests. |
| P5.4 | Exercise crashes, unknown dispatches, stale approvals, account changes, and migration recovery. | Fault-injection acceptance report. |
| P5.5 | Validate supported packaged OS/runtime combinations and update implementation documentation. | Release matrix separating automated fixtures from live acceptance. |

**Gate:** Users can determine the responsible agent, exact inputs, blocker, next action, and acceptance status without opening raw logs. Recovery never silently replays unknown work. Advertised platform support matches recorded tests.

### Phase 6 — Advanced collaboration and optional cross-device operation

**Objective:** Extend a stable coordinator rather than overcomplicate the first release.

Add independent proposals, independent test design, competing implementations, pair-debugging checkpoints, and measured role-routing presets. Each template must declare its independence and verification requirements.

For optional multi-device operation, add device identity, approved workspace mapping, encrypted metadata/artifact replication, resumable transfer, conflict handling, and deletion propagation. Transport code through explicit repository/snapshot mechanisms, not a live SQLite file copy.

Do not allow two partitioned devices to claim exclusive ownership of the same authoritative execution workspace. Start with a designated owner host or a coordination authority. During connectivity loss, isolated local proposals may continue, but authoritative ownership transfer and shared integration must pause or require explicit resolution.

**Gate:** Unsupported remote/native control stays visible; replicas converge after reconnection without silently accepting conflicting work; secrets and local trust grants are not replicated as reusable authorization.

---

## 12. Repository change map

Paths marked **new** are proposed additions, not files claimed to exist in the reviewed repository. Keep module boundaries modest; merge closely related files when separation would add indirection without a clear responsibility.

| Existing entry point | Change | Proposed implementation location |
|---|---|---|
| `packages/domain/types.ts` | Split provider facts from workflow/domain state; retain compatibility during migration. | `packages/domain/workflow.ts`, `sessions.ts`, `workspaces.ts`, `sync.ts` — new. |
| `packages/domain/commands.ts` | Add typed task/context/workspace commands with request IDs and expected revisions. | Existing module plus scoped query/event types. |
| `packages/runtime/manager.ts` | Replace provider-specific branching with adapters and workspace ownership. | `packages/runtime/coordinator.ts` and `packages/providers/*` — new. |
| `packages/runtime/rpc.ts` | Preserve transport while validating version-specific payloads and handling lifecycle uncertainty. | Existing transport and provider-specific schema modules. |
| `packages/workspace/context.ts` | Per-attempt grants, visibility policies, source-aware retrieval, revocation. | `packages/context/grants.ts`, `policy.ts`, `packages.ts` — new. |
| `packages/workspace/history.ts` | Versioned context construction and incremental native history ingestion. | `packages/history/reconcile.ts` and `packages/context/*` — new. |
| `packages/workspace/projects.ts` | Separate logical projects from host/workspace mappings. | Existing discovery plus `packages/workspace/identity.ts` — new. |
| `packages/workspace/codex-projects.ts` | Preserve durable reconciliation; project native facts into the generic sync model. | Existing adapter plus `packages/sync/reconciler.ts` — new. |
| `packages/workspace/configuration.ts` | Preserve reviewed writes; record requested/effective configuration evidence. | Existing module plus capability projection. |
| `packages/persistence/store.ts` | Add migrations, indexed scoped repositories, operation intents and sequence queries. | `packages/persistence/migrations/*`, `repositories/*` — new. |
| `apps/service/service.ts` | Route commands to services; provide scoped queries and ordered subscriptions. | Existing entry point; scheduling in `packages/workflows/*` — new. |
| `apps/desktop/renderer/main.tsx` | Replace monolithic state/control ownership with focused views and normalized subscriptions. | `views/*`, `components/*`, `state/*` — new. |
| `apps/desktop/renderer/projects.tsx` | Group workspaces under projects; add synchronization summaries and clear native actions. | Existing view with shared task/workspace components. |
| `apps/cli/main.ts` | Expose supported coordinator status/actions and scoped context without bypassing approvals. | Extend only after shared service contracts are in place. |
| `docs/Implementation_Status.md` and `docs/Project_Synchronization.md` | Track each actual capability, evidence level, migration and remaining limitation. | Update alongside features, not only at release. |

Add focused tests under the repository's existing test conventions. Suggested suites include workflow transitions, context grants, context visibility, native-history replay, workspace leases, candidate verification, migration, and renderer event recovery.

Do not mix unrelated application installer/update rewrites into the orchestration branch unless a demonstrated integration defect requires them.

---

## 13. Migration and rollout

### 13.1 Migration mapping

| Legacy record | New representation | Safety rule |
|---|---|---|
| `Project` with one path | Same logical project ID plus one approved workspace | Preserve identity and history; revalidate canonical path before execution. |
| One native session ID per provider | Separate legacy `AgentSession` binding | Preserve the native ID and known account binding; unknown fields remain unknown. |
| `Run` | Execution attempt, with an optional imported-history task grouping | Do not invent an objective, code revision, or acceptance result that was never recorded. |
| `ContextSnapshot` | Legacy context package with original content/hash | Do not retroactively claim specification completeness or provider delivery. |
| Existing usage | Source-attributed usage fact | Keep old scope semantics; do not reinterpret snapshots as deltas. |
| Native project references | Native links and root mappings | Preserve removal history, trust boundaries, and naming policy. |
| Active or uncertain run | Unreconciled attempt/ownership state | No automatic replay, resume, or lease reassignment. |
| Deletion tombstone | Preserved deletion boundary | Reindexing or native reimport must not resurrect deleted local history. |

### 13.2 Migration procedure

Create a database-consistent encrypted backup using a supported backup/checkpoint procedure, not an arbitrary copy of an active database and WAL. Record schema version and integrity checks. Run migrations transactionally or in resumable checkpoints with an explicit recovery record.

Validate counts, project/session relationships, tombstones, provenance hashes, search scope, and encryption after migration. Keep destructive schema cleanup out of the first migration release. Preserve legacy read compatibility until the new projections have passed acceptance.

Do not allow an older application to write a newer unsupported schema. Recovery means restoring the compatible encrypted backup/application pair or completing a tested forward migration—not silently opening the database with an incompatible version.

### 13.3 Feature flags and deployment order

Use flags for workflow UI, structured Claude coordination, native-history reconciliation, parallel workspaces, advanced independent modes, and multi-device replication. Flags must not disable safety checks or reinterpret unknown state as success.

Roll out the builder–reviewer workflow first on an explicitly tested local configuration. Expand platform/runtime combinations based on actual acceptance evidence. Keep unsupported combinations usable through clearly labelled native routes where safe.

Update the design documentation with the new contracts and mark future capabilities as planned. Existing tests recorded in documentation are baseline evidence, not proof that the new implementation works.

---

## 14. Acceptance and fault-injection tests

Use deterministic adapter fixtures for repeatability, disposable directories for filesystem tests, and bounded explicitly approved live provider tests for protocol acceptance. Separate model-quality evaluation from coordinator correctness: a model producing a poor patch should cause normal review/verification failure, not break orchestration.

| ID | Test scenario | Required result |
|---|---|---|
| AT-01 | Issue two context grants for one project; revoke one. | Both initially work; only the revoked grant fails afterward. |
| AT-02 | Independent reviewer searches for a withheld peer artifact through every available context route. | Access is denied; permitted sources remain accessible. |
| AT-03 | Withheld content exists in an otherwise accessible transcript/export directory. | Required filesystem/tool isolation blocks it, or the workflow refuses to claim enforced independence. |
| AT-04 | Place target-project messages outside the newest 5,000 global records. | Scoped history and context retrieval remain complete through pagination. |
| AT-05 | Replay duplicate provider events and repeated cumulative usage snapshots. | No duplicate messages, transitions, or inflated usage totals. |
| AT-06 | Crash after recording dispatch but before receiving the provider reply. | Attempt becomes uncertain; no second model turn is blindly dispatched. |
| AT-07 | Open two coordinator instances and launch the same ready task. | Exactly one local owner records dispatch; the other attaches or fails safely. |
| AT-08 | Request two writer leases using symlink/path aliases of one workspace. | One lease succeeds; the other is rejected. |
| AT-09 | Let a lease expire while the original process remains alive. | Workspace is not reassigned until safe reconciliation or quarantine. |
| AT-10 | Run two agents in isolated workspaces within one logical project. | Both progress with distinct attribution and resource ownership. |
| AT-11 | Modify candidate C7 to C8 after review/tests pass on C7. | C7 evidence remains historical; C8 is not automatically accepted. |
| AT-12 | Both worker branches pass separately, but their combined result fails. | Integration remains blocked on the combined candidate. |
| AT-13 | Publish a new interface/specification during a running attempt. | UI shows stale inputs; downstream dispatch evaluates the new dependency revision. |
| AT-14 | Import a truncated/rotated source and restart before the next complete record. | No cursor advances beyond durable data; coverage loss or parser uncertainty is visible. |
| AT-15 | Delete a conversation, restart, and reimport the same native source. | Tombstones prevent accidental local resurrection. |
| AT-16 | Change account/profile, executable, or approved folder identity. | Unsafe reuse/dispatch is blocked pending review. |
| AT-17 | Approve a request after its attempt ended or its parameters changed. | Stale approval is rejected without executing the replacement action. |
| AT-18 | An external editor modifies a pinned candidate's source workspace. | The pinned snapshot remains stable or affected evidence is invalidated; no false acceptance. |
| AT-19 | Native registry readback succeeds while visible desktop refresh is unknown. | UI says registry verified and desktop presentation unverified. |
| AT-20 | UI misses events during disconnect while another task streams heavily. | Sequence gap triggers scoped resync; no session mixing or lost canonical state. |
| AT-21 | One provider reports usage and another does not. | Known totals show incomplete coverage; missing data is not zero. |
| AT-22 | A critical acceptance criterion would be truncated from context. | Dispatch blocks or requires an explicit reviewed reduction. |
| AT-23 | An unsupported security capability is required by the template. | Task does not silently fall back to weaker permissions. |
| AT-24 | User cancels, but the provider sends a late completion event. | Evidence is retained under the original attempt; workflow is not automatically accepted. |
| AT-25 | Migrate, interrupt the migration, restore, and open with an older application. | Recovery is consistent; incompatible writes are rejected; history remains protected. |
| AT-26 | Disconnect devices during conflicting metadata edits or ownership transfer. | Conflict is shown; authoritative execution ownership is not duplicated. |

Before a release, run the repository's existing `npm run check` and `npm run test:desktop` in appropriate supported environments, then the new suites. Record actual results rather than treating these commands as already executed.

---

## 15. Operational targets and proposed defaults

These are initial engineering targets and defaults to validate, not measured performance, provider guarantees, or irreversible user decisions.

| Setting or metric | Proposed initial value/behavior |
|---|---|
| Total coordinated concurrency | Two active agent attempts initially; increase only after ownership and performance tests pass. |
| Concurrent writers per concrete workspace | One, always. |
| Automatic repair rounds | At most two, then require explicit continuation or resolution. |
| Automatic model/provider substitution | Disabled by default; show the capability, billing, and context consequences before approval. |
| Automatic user acceptance/deployment | Disabled. |
| Startup after unknown dispatch | Reconcile; never assume failure merely because the reply was lost. |
| Provider fallback polling | Start around 30–60 seconds only where appropriate; respect supported event routes, rate limits, and backoff. |
| Local state-change display latency | Target p95 below 250 ms from service commit to relevant UI update under the documented benchmark. |
| Ordinary UI interaction | Target p95 below 200 ms; large queries paginate and must not block input. |
| History benchmark | At least 100,000 mixed-project messages with scoped queries and virtualized views. |
| Concurrency benchmark | Four fixture-driven streaming sessions to test headroom, while the initial live default remains two. |
| History ingestion | Explicit opt-in per source/profile; no broad home-directory scan. |
| Evidence retention | User-visible policy with protected artifacts and deletion boundaries; no indefinite raw secret-bearing event retention. |

Record hardware, operating system, runtime versions, source sizes, concurrency, and payload limits with every benchmark. The p95 targets do not include provider inference/network latency. Observe memory growth, cancellation responsiveness, and state-resync correctness alongside speed.

For model routing, measure accepted-task rate, escaped defects, repair count, wall time, and known usage coverage. Do not rank models by generated token volume or the number of tasks they claim to have completed.

---

## 16. First release demonstration and completion criteria

### 16.1 Demonstration scenario

Use a disposable feature branch and a bounded change such as adding source-aware usage normalization.

The user defines the desired behavior once and selects a builder–reviewer preset. Topsl captures specification 1 and the approved code basis, launches the implementer, records candidate C1, and asks the other provider to review that candidate. Any repair produces C2 with new evidence requirements. The final screen presents the diff, findings, test results, context delivery, usage coverage, and unresolved limitations for explicit acceptance.

No manual copying between provider conversations should be required. The user can inspect either native session where supported, but folder opening and session continuation remain different actions.

### 16.2 Definition of done

- [ ] Logical projects contain approved workspaces without duplicating project identity for every task worktree.
- [ ] Multiple agent sessions and execution attempts have stable, account-bound provenance.
- [ ] Both providers complete the supported structured builder–reviewer path, or the unsupported route is honestly gated.
- [ ] Every coordinated attempt records its actual code/context inputs and delivery evidence.
- [ ] Independent access is enforced when the workflow claims independence.
- [ ] Candidate-specific review and checks gate acceptance; completed inference alone is insufficient.
- [ ] Unknown dispatches, stale approvals, and uncertain writers cannot trigger unsafe automatic replay.
- [ ] History and usage reconcile without duplicate counting, cross-project loss, or tombstone violations.
- [ ] The UI clearly distinguishes current, pending, stale, unsupported, and unverified state.
- [ ] Migration, encryption, cancellation, restart, compact layout, and supported OS/runtime tests have recorded results.
- [ ] Documentation accurately separates implemented, tested, experimental, native-only, and planned capabilities.

**Release principle:** deliver a trustworthy two-agent workflow before expanding the number of agents. Topsl's advantage is not making every provider look identical; it is making responsibility, context, code state, evidence, and user control unambiguous.

---

## 17. Source references

Repository references below are pinned to the reviewed commit. They establish the source-level baseline, not successful execution of the proposed changes. External provider features and authentication arrangements must be checked against official documentation and the actual installed runtimes during Phase 0; this plan deliberately does not assume universal API or desktop support.

| Reference | Source and relevance |
|---|---|
| [R1] | Implementation status: current pilot architecture, recorded evidence, and explicit remaining gates. |
| [R2] | Domain types: project/path coupling, provider session map, run and context records. |
| [R3] | Runtime manager: project exclusion, Codex execution, account binding, approvals and uncertainty. |
| [R4] | History/handoffs: recent-message selection, truncation, import provenance and tombstones. |
| [R5] | Context service: project-level grants and history/search scope. |
| [R6] | Persistence store: encrypted storage, global list cap, search and deletion behavior. |
| [R7] | Service: full-state projection and change notifications. |
| [R8] | Main renderer: selected session/model state, global busy flag, workflow and usage presentation. |
| [R9] | Synchronization documentation: identity, native registry, opening and presentation boundaries. |
| [R10] | Codex project adapter: source projection, ordering, identity binding and synchronization state. |
| [R11] | Project renderer: trust, folder relinking, native grouping and opening controls. |

[R1]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/docs/Implementation_Status.md
[R2]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/packages/domain/types.ts
[R3]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/packages/runtime/manager.ts
[R4]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/packages/workspace/history.ts
[R5]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/packages/workspace/context.ts
[R6]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/packages/persistence/store.ts
[R7]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/apps/service/service.ts
[R8]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/apps/desktop/renderer/main.tsx
[R9]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/docs/Project_Synchronization.md
[R10]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/packages/workspace/codex-projects.ts
[R11]: https://github.com/Piore-Galore/Topsl/blob/2c6318d5d3d459086a5a796f82637c5db56c1994/apps/desktop/renderer/projects.tsx
