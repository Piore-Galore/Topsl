# Topsl — Round 2 Improvement Plan

## Production workflow completion, reliable verification, and clear synchronization

| Item | Value |
|---|---|
| Document status | Reviewed implementation specification; implementation and live acceptance remain pending |
| Prepared and source-checked | October 14, 2026 |
| Repository | `Piore-Galore/Topsl` |
| Verified baseline | `e5e004e31e428d77d2242d3ab472e66d88bb0cc6` on `main` |
| Relationship to the first plan | Incremental completion and hardening of the implemented architecture, not a restart or replacement |
| Primary milestone | A real Claude–Codex build → review → repair → verification → acceptance workflow on an ordinary dependency-based repository |
| Review method | Source-and-CI findings, current official integration documentation, dependency review, failure-path review, and acceptance-test traceability |
| Validation boundary | No application build, desktop journey, paid model request, or repository write was performed while preparing this document |

The branch was rechecked for this plan and still points to the reviewed baseline. The existing CI run was also rechecked. Source references are collected in Section 16 and cited where they establish current behavior. Proposed architecture, defaults, and targets are recommendations, not claims about implemented functionality. [R01] [R02]

---

## Contents

1. [Objective and scope](#1-objective-and-scope)
2. [Baseline findings](#2-baseline-findings)
3. [Design decisions and invariants](#3-design-decisions-and-invariants)
4. [Delivery sequence](#4-delivery-sequence)
5. [Phase R2-0 — Establish the delivery baseline](#5-phase-r2-0--establish-the-delivery-baseline)
6. [Phase R2-1 — Deterministic lifecycle and durable execution evidence](#6-phase-r2-1--deterministic-lifecycle-and-durable-execution-evidence)
7. [Phase R2-2 — Usable provider integration and role-specific readiness](#7-phase-r2-2--usable-provider-integration-and-role-specific-readiness)
8. [Phase R2-3 — Complete candidates and bounded context](#8-phase-r2-3--complete-candidates-and-bounded-context)
9. [Phase R2-4 — Reproducible verification environments](#9-phase-r2-4--reproducible-verification-environments)
10. [Phase R2-5 — Trustworthy UI state and guided workflows](#10-phase-r2-5--trustworthy-ui-state-and-guided-workflows)
11. [Phase R2-6 — Live acceptance and release qualification](#11-phase-r2-6--live-acceptance-and-release-qualification)
12. [Repository change map and work ownership](#12-repository-change-map-and-work-ownership)
13. [Acceptance and fault-injection matrix](#13-acceptance-and-fault-injection-matrix)
14. [Migration, rollout, and operational targets](#14-migration-rollout-and-operational-targets)
15. [Plan review and resolved design issues](#15-plan-review-and-resolved-design-issues)
16. [Source references](#16-source-references)

---

## 1. Objective and scope

### 1.1 Product outcome

Complete the functionality already designed and substantially implemented. The next release should make Topsl useful on real projects, not merely increase the number of collaboration templates.

The target experience is:

> A user selects a project, describes a change, reviews a proposed team and execution recipe, and starts a supported workflow. Topsl gives each agent an identifiable task and code basis, obtains a review of the exact candidate, runs the actual project checks in a prepared environment, and presents a clear acceptance decision. Errors, stale observations, and uncertain execution remain visible and recoverable.

The first qualified demonstration must involve a dependency-based repository with multiple source files, a tracked binary asset, an approved new file, and at least one real test command. It must include a failure and a recovery scenario, not just a successful model response.

### 1.2 Preserve the implemented foundation

Retain the encrypted store, task/session/attempt separation, project identity, workspace ownership, immutable context and candidate evidence, bounded repair loops, scoped history, synchronization dimensions, and explicit native-application boundaries. The implementation report describes these foundations and their existing fixture coverage. Extend their contracts rather than build a second coordinator beside them. [R03]

Continue developing in this repository. Preserve existing projects, history, tombstones, native-session bindings, and user work. Do not treat older evidence as invalid merely because its format is superseded; retain it with its original interpretation and limitations.

### 1.3 In scope

| Workstream | Required result |
|---|---|
| Runtime lifecycle | Event-driven concurrency tests, awaited shutdown, reliable ownership release, and retained execution outcomes |
| Provider completion | A supported real execution path, role-specific readiness, and useful assisted native operation where automation is unavailable |
| Context and candidates | Complete approved artifact capture without embedding an entire repository in every prompt |
| Verification | Reproducible dependency preparation, controlled execution, and evidence that survives cleanup failures |
| Synchronization UI | Monotonic scoped views, visible freshness, and actionable recovery |
| Workflow usability | Guided setup, understandable changes/reviews, and model controls backed by actual capabilities |
| Acceptance | Real-provider evidence and independent cross-platform checks tied to an exact commit |

### 1.4 Deferred expansion

Do not add new advanced collaboration templates, broaden cross-device transport, increase default fanout, create automatic model-ranking systems, or attempt unsupported native sidebar/database mirroring in this round. Keep existing implementations, but qualify only the capabilities actually validated.

This plan does not authorize spending API credits, changing provider authentication, altering account settings, modifying native project databases, publishing a release, or pushing repository changes. Those actions remain subject to the user's explicit authorization and existing approval controls.

## 2. Baseline findings

### 2.1 Source-backed gaps

| ID | Finding at the reviewed commit | Evidence classification | Required response |
|---|---|---|---|
| F01 | Structured Claude execution throws without a fixture transport. The default Codex capability declarations also do not satisfy the coordinated workflow's required `enforceable` capabilities. | Confirmed code paths; production workflow availability gap | R2-2: supported integration and capability acceptance |
| F02 | Builder and reviewer are both checked for structured execution, read-only access, and workspace writing. | Confirmed service policy | R2-2: role-specific requirements |
| F03 | CI passes on Apple silicon and Linux but fails on Windows and Intel Mac. Concurrency fixtures use fixed-duration worker lifetimes; teardown does not await shutdown. | CI outcomes confirmed; timing/cleanup causes are strong hypotheses to reproduce, not proven production scheduler defects | R2-1: barriers, lifecycle evidence, awaited teardown |
| F04 | Context creation serializes every captured file, rejects binary contents, and applies a default one-million-byte budget. Git capture includes permitted tracked files even when selected paths are supplied. | Confirmed implementation limitation | R2-3: separate full candidate capture from bounded model context |
| F05 | Capture excludes directory names such as `build`, `release`, and `.claude`, including potentially relevant tracked files. | Confirmed policy behavior; relevance depends on the project | R2-3: project-aware coverage and protected-source policies |
| F06 | Verification runs in a materialized temporary candidate without installed dependencies or enforced OS/network isolation. | Explicit implementation boundary | R2-4: prepared environment and accurately declared execution restrictions |
| F07 | Check cleanup precedes durable output/verification persistence. Cleanup failure can prevent the result from being recorded after execution and approval consumption. | Source-derived failure path; fault injection required | R2-1: durable execution/result records and separate cleanup state |
| F08 | Scoped refresh errors are swallowed. Project-generation fences do not consistently order concurrent responses within the same project. | Confirmed hook behavior; stale-response race requires a deterministic UI test | R2-5: freshness/error state and snapshot sequencing |
| F09 | Workflow creation exposes executable paths, argument JSON, model aliases, and output manifests before establishing complete route readiness. | Confirmed UI implementation | R2-5: guided setup and explicit draft-versus-runnable state |
| F10 | Provider contracts retain only basic model data, and prepared Claude arguments omit partial-message streaming. | Confirmed current code; additional support remains version-dependent | R2-2 and R2-5: richer metadata and validated streaming |

Sources: provider adapters and contracts [R04] [R05] [R06]; service [R07]; CI and concurrency tests [R02] [R08] [R09] [R10]; candidates/context [R11] [R12]; verification [R13]; UI [R14] [R15] [R16].

### 2.2 CI baseline

The reviewed workflow run is `38558938712`, for the baseline commit on October 14, 2026. [R02]

| Target | Observed result | Consequence |
|---|---|---|
| macOS Apple silicon | Success | Its run completed checks, desktop smoke, and packaging steps |
| Linux x64 | Success | Its run completed checks, desktop smoke, and packaging steps |
| Windows x64 | Failure | Later desktop smoke and packaging steps did not run |
| macOS Intel | Failure | Later desktop smoke and packaging steps did not run |

The Windows log in the source review reported five failures in `parallel-workspaces.test.ts`; Intel Mac reported one. Fixed timing windows and unawaited cleanup are investigation targets, not grounds to weaken concurrency assertions. Preserve the original failure logs when implementing fixes. [R08] [R09] [R10]

### 2.3 Interpret acceptance accurately

Keep four independent categories: implementation present, deterministic fixture passed, selected live runtime validated, and packaged platform qualified. Passing one category does not imply the others. A documentation statement that a phase is implemented must not become a green user-facing capability badge by itself.

## 3. Design decisions and invariants

### 3.1 Required distinctions

| Distinction | Rule |
|---|---|
| Task completion vs. model completion | A finished turn is a submitted result, not accepted work |
| Model completion vs. writer quiescence | A finished turn does not prove that an owned process or descendant has stopped writing |
| Persistent service vs. task execution | An idle App Server may remain alive; release task ownership only using validated task-scoped quiescence, not a blanket requirement to kill every provider service |
| Candidate vs. prompt | Candidate coverage is complete for its approved scope; the initial prompt is intentionally bounded |
| Content identity vs. workspace identity | Identical bytes can share content identity across checkouts; execution authority remains bound to the exact host/workspace |
| Protocol support vs. enforcement | A response parser proving protocol compatibility does not prove filesystem, network, permission, or fanout enforcement |
| User approval vs. technical capability | Approval authorizes an operation; it cannot turn an unsupported enforcement mechanism into a supported one |
| Result vs. cleanup | Durable verification evidence and temporary-resource cleanup have separate outcomes |
| Intent vs. observed settings | Show requested settings separately from settings actually reported or otherwise verified |
| Registry vs. sidebar | Native registry readback does not prove a desktop sidebar refreshed |
| Snapshot vs. freshness | An internally consistent snapshot may still be old; expose its watermark and last successful observation |
| Native continuity vs. cross-provider handoff | Native session identities remain provider-specific; Topsl transfers explicit context and artifacts, not hidden model state |

### 3.2 Non-negotiable behavior

No unknown provider dispatch is automatically repeated. No two active managed writers receive the same mutable workspace. Lease expiry, a signal being sent, or a parent PID disappearing is insufficient evidence of complete task shutdown.

No silent provider, model, authentication, or billing substitution is permitted. Credentials stay outside prompts, history, portable replication, candidate manifests, and renderer diagnostics. Existing account/profile mismatch checks remain enforced.

No candidate, specification, original acceptance harness, or recorded review is edited retroactively. New requirements, output manifests, environments, and repairs create new revisions. Old evidence remains historical and can be explicitly superseded.

No UI state can label content synchronized, permissions enforced, checks passed, or a native session resumed beyond the evidence available. Unsupported independent-review modes remain unavailable rather than falling back to a prompt that asks the agent not to inspect peers.

### 3.3 Scoped, not universal, synchronization

The product promise is reliable synchronization of Topsl-owned project facts and supported external observations. It is not identical provider memories, identical native sidebars, or universal cross-device equivalence.

Represent project links, code basis, context, history coverage, configuration, and native presentation separately. Intentional branch divergence is not a synchronization error. Unacknowledged requirements, incomplete history, unexpected workspace mutation, and an unverified native presentation are distinct conditions with distinct remedies.

## 4. Delivery sequence

Use the following order, with two limited parallel tracks. Every phase must leave a usable, testable increment.

| Phase | Focus | Dependency | Exit artifact |
|---|---|---|---|
| R2-0 | Baseline and evidence inventory | None | Reproducible baseline report and prioritized issue list |
| R2-1 | Lifecycle, concurrency, and durable checks | R2-0 | Cross-platform deterministic lifecycle suite and durable execution records |
| R2-2 | Provider integration and role readiness | R2-1 for controlled execution | Selected-runtime acceptance registry, supported route, and assisted native fallback |
| R2-3 | Candidate manifests and bounded context | R2-1 contracts; may overlap R2-2 | Versioned manifest/context reader and large/binary project coverage |
| R2-4 | Verification environments | R2-1 and R2-3 | Prepared environment recipe, dependency evidence, and reliable checks |
| R2-5 | UI freshness and workflow usability | Freshness work after R2-0; full setup depends on R2-2–R2-4 | Monotonic project views, readiness UX, and guided workflow |
| R2-6 | Real end-to-end acceptance | R2-1–R2-5 | Commit-bound acceptance bundle and platform support matrix |

Validate a minimal, self-contained live task in R2-2. Validate the complete dependency-based, binary-containing repository only in R2-6. This avoids making provider validation depend on an environment system that has not yet been built.

## 5. Phase R2-0 — Establish the delivery baseline

### Goal

Turn the prior source review into a reproducible engineering baseline without conflating source inspection, old fixture results, and new live acceptance.

### Implementation work

Record the checked-out commit, working-tree state, operating system, architecture, Node/Electron/package-manager versions, selected runtime identities, and available test commands. Read the original implementation plan and implementation evidence already in the repository. Preserve any unrelated local edits; use an isolated worktree for this round when needed.

Run the repository's existing deterministic check and desktop smoke paths in disposable profiles. Keep provider live tests opt-in. A model catalog query or runtime startup is not a substitute for execution acceptance, and no tests should silently use the developer's actual project/history directories.

Create an issue/evidence ledger for F01–F10. Each entry records reproduction steps, confirmed observations, remaining hypotheses, affected platforms, intended fix, and exact acceptance cases from Section 13.

Archive machine-readable test reports and failure diagnostics with run/commit identity. Reproduce the existing concurrency failures before modifying their assertions. Record a non-reproduction honestly when host timing differs.

### Deliverables and gate

Produce `docs/Round_2_Baseline.md` and a small machine-readable evidence manifest. Suggested filenames are new additions, not claims that they already exist.

Exit when existing regressions are classified, their evidence is retained, and the team can distinguish product defects from test-timing failures. Do not block unrelated read-only planning on live-provider availability.

## 6. Phase R2-1 — Deterministic lifecycle and durable execution evidence

### 6.1 Replace timing-window concurrency fixtures

Extend the existing worker fixture with explicit control messages: `ready`, `allow-turn-complete`, `turn-complete`, `allow-exit`, and `process-closed`. These are proposed fixture messages, not native provider protocol methods.

The test must hold both workers at a barrier before asserting simultaneous activity. Hold a worker after model completion while testing that its ownership remains active. Release its exit barrier before asserting that queued work resumes. Test both orderings of acknowledgement and completion and deliberately delay startup, event delivery, and shutdown.

Use bounded deadlines only to fail stuck tests. Elapsed sleeps must not create the correctness condition. A slow host should produce a useful timeout report, not a false concurrency violation.

### 6.2 Introduce an awaited lifecycle contract

Extend `ProviderConnection.close()` and runtime shutdown with an asynchronous, idempotent completion contract. Audit every caller: test teardown, service shutdown, utility-process exit, cancellation, resource cleanup, application updates, and crash recovery. The current contract exposes `close(): void`, so changing only one caller is insufficient. [R06]

A proposed lifecycle record contains the task/attempt ID, native session/turn identity, child/process-group identity where available, start evidence, last observation, termination request, actual exit/close evidence, and remaining descendants. Keep it in protected service-owned storage.

| State | Meaning | Ownership behavior |
|---|---|---|
| Starting | Launch intent recorded; execution not yet established | Reserve affected capacity/workspace |
| Running | Validated execution is active | Hold ownership |
| Turn finished | A provider result arrived; task execution may remain active | Hold ownership until validated quiescence |
| Stopping | Stop requested and acknowledged where supported | Hold ownership |
| Quiescent | No remaining owned task execution can mutate the workspace, under the validated route | Release eligible ownership |
| Uncertain | Evidence is insufficient or conflicting | Retain exclusion and expose reconciliation |

A persistent provider service and an execution-specific child need different handling. Do not kill a shared runtime merely to satisfy a unit-test assumption. Conversely, do not treat a persistent connection returning “idle” as proof that unobserved descendants stopped. Each adapter must state what its lifecycle evidence establishes.

For process execution, use a validated host-specific process-group/job abstraction. Check descendants and stdio closure, not only the immediate parent's exit. Keep unknown process ownership visible when the platform cannot establish more. Native external sessions remain outside Topsl's ownership claim unless explicitly adopted through a supported route.

### 6.3 Durable check execution before effects

Refactor verification into a durable execution record independent of its approval plan and cleanup job.

Required ordering:

1. Validate the approved plan, current candidate, protected harness, environment identity, executable identity, and owner lease.
2. In one transaction, consume the applicable authorization, create `CheckExecution`, and record dispatch intent.
3. Materialize inputs and prepare resources with their identities recorded. Distinguish a pre-dispatch failure from an uncertain external dispatch.
4. Launch once and attach lifecycle evidence. Reconcile ambiguous outcomes instead of launching again.
5. Establish the result, task quiescence, output collection, and candidate/harness integrity. Persist the outcome, provenance, and verification eligibility before cleanup.
6. Enqueue cleanup independently; retry cleanup safely without rerunning the check.

Persist bounded execution observations and available output incrementally while the task runs; do not wait for final quiescence to retain all evidence. Final acceptance eligibility is still deferred until the required lifecycle and integrity checks complete.

If the database cannot persist a final result, do not report a durable pass. Retain an unresolved execution and surface the storage failure. A protected recovery spool is optional, but it must not imply that disk-full conditions can always be recovered automatically.

### 6.4 Separate outcomes

| Record | Suggested states |
|---|---|
| Check execution | `prepared`, `dispatching`, `running`, `stopping`, `passed`, `failed`, `error`, `cancelled`, `uncertain` |
| Cleanup job | `not-started`, `pending`, `running`, `completed`, `failed`, `blocked-by-active-process` |
| Acceptance eligibility | Derived from candidate, harness, environment, final process evidence, and required checks; never from cleanup success alone |

“Check passed; cleanup pending” is legitimate only after valid execution evidence has been saved. “Command returned zero; descendant still active” is not acceptance-ready.

Persist bounded full check logs or chunked protected log references, separate from a short UI error summary. Link every output to the execution and exact target revision. A cleanup exception must not replace an earlier result or suppress its report.

### 6.5 Teardown, restart, and CI

Shutdown stops new dispatch, requests cancellation where authorized, waits for validated completion within a bounded policy, flushes protected evidence, and only then closes persistence. If stopping cannot be established, record uncertainty before closing and preserve affected directories and leases.

Clean temporary workspaces only after the lifecycle and resource manager permit it. Windows lock failures should become classified cleanup jobs, not an opportunity to repeatedly rerun inference or forcibly delete active work.

After deterministic barriers are installed, repeat the lifecycle suite on all four supported CI targets. A proposed stress gate is 20 consecutive lifecycle-suite iterations per target on an isolated CI job; reduce or shard test cost without weakening the scenario. Include separately generated scheduling delays and report seeds for reproducibility.

### Exit gate

The full CI matrix is green on the delivery commit. Timing assertions use explicit barriers. Post-result cleanup failure preserves evidence. Timeout, cancellation, child-process exit, and service restart cannot cause automatic duplicate execution or premature workspace reuse.

## 7. Phase R2-2 — Usable provider integration and role-specific readiness

### 7.1 Replace static gates with qualified capability records

Keep the existing adapter interface, but extend it with a service-owned runtime acceptance registry. Do not replace `native-only` with `enforceable` unconditionally or add an “allow unverified” switch.

A capability record must identify:

| Field group | Required contents |
|---|---|
| Binding | Provider, route, adapter/schema version, executable identity, runtime version, host OS/architecture, native profile, permission-policy hash |
| Evidence | Test case/version, observation time, evidence artifact references, outcome, and restrictions |
| Validity | Bound account/entitlement where relevant, invalidation reasons, review status, and the policy for stale evidence |
| Capability | Exact operation and scope: structured turn, immutable candidate read, workspace write restriction, cancellation, usage reporting, or bounded fanout |
| Meaning | Protocol supported, behavior observed, policy enforced under this configuration, native-only, unsupported, or unknown |

Qualification tests must exercise actual operations, including a negative control for any claimed restriction. An agent saying that it could not write a file is not sufficient evidence; confirm the attempted operation and resulting filesystem state through the trusted validation mechanism. Finite tests qualify the declared configuration, not universal resistance to every possible escape.

A registry entry can only be written by the trusted validation path. A renderer checkbox, model statement, fixture transport, or imported device record cannot grant live enforcement. Store the runtime test observations, not credentials or unredacted authentication responses.

Invalidate affected acceptance when the executable, adapter protocol, account/profile, managed configuration, or sandbox configuration changes. Do not invalidate unrelated project history. A stale capability record should produce a specific revalidation action.

### 7.2 Evaluate requirements per role and workflow mode

Readiness is a derived decision over exact requirements, not a universal status attached to a provider.

| Role/mode | Required capability | Not automatically required |
|---|---|---|
| Structured implementer | Valid dispatch/result identity; approved authentication; permitted workspace access; applicable write boundaries; recoverable lifecycle | Review-output schema or image input unless the task requires it |
| Ordinary candidate reviewer | Fresh session; immutable candidate inputs; candidate read/retrieval route; writes denied under the chosen route; attributable review result | Workspace-writing capability |
| Independent reviewer | Ordinary reviewer requirements plus enforced peer/context/filesystem/tool isolation appropriate to the independence claim | Merely being a different provider is insufficient |
| Test executor | Approved environment and command; protected harness; resource ownership; reliable process/result evidence | Provider inference access |
| Assisted native step | Explicit handoff, reviewed export scope, native opening, and validated result import | Automated progress/stop guarantees that the native route cannot expose |

Return a structured readiness result containing mode, blockers, warnings, capabilities used, freshness, and available next actions. Suggested blockers include `authentication-required`, `permission-profile-unverified`, `candidate-reader-unavailable`, `process-lifecycle-unverified`, and `unsupported-model-setting`.

The same readiness result must drive both the UI and the dispatch broker. A successful preflight is not durable authorization forever: recheck execution-critical bindings immediately before effects.

### 7.3 Keep authentication routes explicit

Support native execution through the user's installed provider runtime only where the integration route is permitted and technically validated. Native sign-in remains in the provider-owned flow. Topsl must not extract or broker subscription session credentials.

Treat an embedded SDK/API route as a separate provider profile with separate user authorization and billing. Preserve the subscription-oriented defaults; do not turn on API billing because native execution is unavailable.

Anthropic's documentation distinguishes an end user's own sign-in to the unmodified Claude Code binary from a third-party product offering its own Claude.ai login or intermediating plan credentials. It directs developer product integrations toward appropriate API or supported cloud-provider authentication. This distinction must be reviewed for the actual Topsl route; it is not blanket permission for every wrapper or integration. [D01]

Implement explicit billing-route types rather than reusing the current `ProviderAccount.billingRoute: "native-subscription"` for all future integrations. No new route should be available until its own consent, credential isolation, and accounting behavior is implemented. [R06]

### 7.4 Complete the structured adapters

**Codex:** preserve the existing App Server route. Generate or validate version-specific protocol schemas against the selected runtime. Preserve optional response fields without assuming their availability. Keep session, thread, and turn identifiers distinct according to the runtime protocol. Verify actual dispatch, write-denial behavior, interruption, reconnection, and account binding before promoting a capability.

**Claude:** replace the production fixture-only path with a supported, consented execution route. Keep fixtures dependency-injected and unavailable to normal service commands. Validate argument support through a versioned adapter; do not rely on one prepared argument list for every installation.

For stream output, add partial-message support where available. The official programmatic guide documents `--include-partial-messages` with streaming JSON. [D03] Handle partial text and final messages without double-counting, retain stable event identities, and tolerate documented additive informational events. Unknown authority-bearing requests, inconsistent identities, and malformed results must still fail safely.

The reviewer needs a working candidate-reader route. Disabling every tool while expecting it to retrieve the larger manifest introduced in R2-3 is not a viable implementation. Prefer a narrowly scoped reader over granting unrestricted filesystem access.

Request schema-constrained review output where the selected runtime supports it. Validate its candidate revision, finding paths, line references, and required fields. Invalid output is a protocol/format problem, not a clean review. An explicitly approved bounded format-repair attempt must create a new attempt; do not silently add billable retries.

### 7.5 Preserve richer model and instruction information

Current OpenAI documentation describes paginated model discovery with supported/default reasoning effort and input modalities, as well as instruction-source information returned for thread start/resume/fork. Actual availability is client/runtime dependent. [D02]

Extend the adapter catalog and prepared-turn contract to retain role-specific requested settings, supported values, defaults, observation source, and reported effective settings. Do not hardcode model names or assume settings are interchangeable across provider protocols.

Record loaded instruction sources only when actually reported or verified. A path reported as loaded and a content hash measured later are different observations; do not imply that a later disk hash proves the bytes used at startup. Preserve both provenance and timestamp. Submitted context is not proof of comprehension.

### 7.6 Assisted native workflow

Provide an explicit assisted mode while automation is blocked. It should prepare an attributed handoff, pin the candidate/specification, open the supported native surface, track the handoff as externally controlled, and import the resulting report after user review.

Do not simulate native input, rewrite transcript stores, or claim successful native continuation from a folder-open operation alone. A manually supplied result is labelled `user-supplied` or `native-import`, not `live-provider-ack`.

Assisted import must validate the expected candidate/specification IDs. If source files changed during the external step, preserve the report but mark its applicability stale. Require explicit confirmation that external writing stopped before admitting another managed writer to the same mutable workspace.

### 7.7 Minimal live acceptance

On an authorized disposable project, validate one builder edit, one reviewer response, a denied out-of-scope write, cancellation, and result attribution. Run each installed-provider route only after native consent. Keep a small explicit usage budget and record actual coverage rather than guessing subscription allowances.

Exit when there is a real supported structured route for each claimed role, or a clearly usable assisted alternative. Do not mark the full automated cross-provider milestone complete until both provider directions have passed the later R2-6 demonstration. If a route cannot yet be supported, identify the exact blocker and keep unrelated engineering work moving.

## 8. Phase R2-3 — Complete candidates and bounded context

### 8.1 Separate artifact coverage from model input

Introduce a versioned candidate manifest backed by protected content-addressed blobs. Reuse the encrypted artifact/store foundation. Do not require a full rewrite of history or the workflow state machine.

| Object | Purpose |
|---|---|
| Candidate manifest | Approved paths, file hashes/sizes/types/modes, additions/deletions, base identity, and coverage rules |
| Protected blob | Actual captured bytes, addressable only through authorized artifact references |
| Context package | Objective, mandatory requirements, selected decisions/interfaces, change summary, and references into the candidate |
| Retrieval receipt | Which candidate file/range was returned to which attempt, with its revision and outcome |
| Coverage report | Included scope, approved exclusions, unsupported inputs, and whether any omission blocks acceptance |

The candidate is complete only for its explicitly declared and reviewed scope. It must never be called a complete checkout while silently excluding necessary files.

Keep execution binding separate from content identity. A content revision should reflect canonical paths, bytes, relevant file modes, and policy/manifest semantics. Workspace authority continues to use host, canonical root, checkout identity, and lease generation. This permits meaningful comparison across worktrees without transferring execution trust.

Legacy candidate IDs and hashes retain their original semantics. Add a new schema/hash version; do not rewrite old hashes or make them appear equivalent to the new content-only revision.

### 8.2 Capture policy and source coverage

Use the Git-tracked manifest as a starting point, but classify files by role and explicit policy rather than directory name alone. Tracked source in `build/` or `release/` may be required. Tracked agent instructions may be relevant but must not be executed or treated as trusted control messages just because they were captured.

Keep credentials, provider private state, and unrelated user files out of candidates. A reviewed exception for legitimate source content is not an exception for native credential stores. Provide a safe mechanism for synthetic test values or separately brokered runtime secrets instead of copying secrets into the repository snapshot.

Secret detection is a warning/control layer, not a guarantee that every secret is recognized. A flagged source requires review, redaction, or a blocked candidate with explicit coverage implications. Redacting runtime-critical bytes prevents claiming verification of the original complete input.

Maintain explicit handling for symlinks, submodules, generated code, ignored assets, platform path collisions, executable bits, renames, and staged deletions. Unsupported cases remain visible and blocked when required. Do not globally follow symlinks or erase current path-trust checks to expand coverage.

For large files and repositories, stream capture/hashing, use cancellable bounded I/O, and deduplicate protected blobs. Keep configurable per-file/project/disk limits with an actionable preflight. Increasing the existing prompt byte limit is not the fix.

### 8.3 Immutable candidate reader

Extend the scoped context service with candidate-aware list, search, read-range, and supported binary-preview operations. These are new Topsl tool contracts, not assumed provider-native methods.

Every request must bind the project, workflow, attempt, candidate revision, grant, permitted paths, and visibility mode. Resolve content through the manifest/blob store rather than arbitrary absolute paths. Return the content hash and candidate revision with each read. Reject traversal, cross-project references, expired/revoked grants, withheld peer artifacts, and unsupported content routes.

Independent-mode access filtering must happen before search and pagination. Artifact names, snippets, and source metadata must not leak withheld peer content. Grant installation failures should block a retrieval-dependent task before a paid turn is submitted.

A materialized review directory can be an adapter fallback only when its isolation and immutability properties are validated for that workflow. It does not become an independent review merely because files were copied to a separate folder.

### 8.4 Bounded initial context

Compose the initial package from mandatory requirements, current approved decisions, public interfaces, candidate/base IDs, a change summary, changed-file metadata, selected high-value excerpts, and instructions for retrieving additional evidence.

Use a model-aware token budget when reliable information is available. Reserve space for output, tool results, and runtime overhead. Preserve a separate byte/transport limit. When only an estimate is available, label it, use a conservative margin, and show uncertainty rather than inventing a context-window size.

Never silently drop mandatory acceptance criteria. If mandatory content alone does not fit, block before dispatch and propose a smaller task or explicit specification restructuring. Record what optional content was omitted and why. Failed context submission must not trigger an automatic duplicate model turn.

Keep a retrieval log so the UI can distinguish content initially delivered, content subsequently returned by tools, and content never supplied. None of these states establishes understanding.

### 8.5 Binary files and output manifests

An unchanged PNG or other binary asset should remain represented by hash, size, and type without being serialized as text. A changed binary asset needs an appropriate review/test route or an explicit manual verification requirement. Do not label the entire candidate fully reviewed when relevant binary changes were never inspected.

Allow the user to approve safe output directories or a narrow creation policy before execution, then review the actual new-file manifest afterward. Hash each proposed addition before it enters the candidate. A pending output review does not authorize immediate execution of new scripts.

Review and verification must use the same approved resulting manifest. Preserve original acceptance harnesses; newly added tests may supplement them but cannot replace or weaken them. A required new file omitted from approval blocks acceptance rather than disappearing from the candidate.

### Exit gate

A repository with several megabytes of source, binary assets, tracked build scripts, deletions, and new files can be captured and reviewed without sending all contents in one prompt. Every retrieved byte resolves to the recorded candidate. Omission and unsupported-review boundaries remain explicit.

## 9. Phase R2-4 — Reproducible verification environments

### 9.1 Introduce reviewed environment recipes

A check needs both an approved candidate and a prepared environment. Add an `EnvironmentRecipe` and `EnvironmentInstance` linked to each `CheckExecution`.

| Recipe input | Requirement |
|---|---|
| Toolchain | Selected executable identities and relevant runtime/compiler versions |
| Dependencies | Lockfile/package-manager selection and approved installation recipe |
| Preparation | Exact commands, lifecycle-script policy, expected outputs, resource limits, and timeouts |
| Filesystem | Immutable input store; declared writable execution/output paths; no access to unrelated workspaces |
| Network | Separate preparation and execution policies; allowlists only where actually enforceable |
| Environment variables | Explicit non-secret values and references to scoped secret grants; never plaintext credentials in the recipe |
| External services | Isolated ports, databases, temporary paths, and service lifecycle ownership |
| Identity | Recipe hash, candidate/lockfile references, platform, toolchain, preparation result, and coverage |

Detect likely recipes from project manifests and package scripts, but treat repository-provided recipes as untrusted input that must be reviewed. Do not turn a package-script string into an unrestricted shell command in the renderer.

### 9.2 Preparation lifecycle

The environment proceeds through planned, approved, preparing, ready, failed, cancelled, or uncertain states. Preparation and verification have separate records and logs. A missing package registry or failed compiler setup is an environment failure, not automatically a defect in the generated candidate.

For the initial dependency-based support, implement a locked JavaScript/TypeScript recipe and a self-contained command recipe. Additional languages can follow the same interface without being advertised before acceptance.

Use a fresh workspace or a verified immutable dependency cache. Never copy arbitrary live `node_modules` or tool caches and call the environment reproducible. Cache identity must cover lockfiles, toolchain/platform, install options, lifecycle policy, and relevant preparation inputs. Do not reuse mutable cache contents after untrusted tasks may have modified them.

Installation hooks and native module builds may be necessary. Default to no unreviewed lifecycle-script execution, then offer a narrow reviewed exception for the exact packages/commands required. A blanket “ignore all scripts” policy cannot be the only route for projects that require generated or native components.

### 9.3 Execution layout

Keep the canonical candidate and protected original harness outside the mutable test workspace. Materialize a disposable execution tree whose starting inputs are verified against the manifest. Tests may write only to declared paths under the chosen execution policy.

Some build tools create output beside source files. Support reviewed output locations or a disposable copy/overlay, while comparing protected source/harness inputs before and after. Unexpected source mutation invalidates the result. Generated output must not shadow or redefine the original test harness unnoticed.

Separate three identities: code candidate, protected acceptance protocol, and environment instance. A passed result binds all three. Reusing the same command string with different dependencies does not establish equivalent verification.

### 9.4 Enforcement profiles

Offer explicit execution profiles rather than treating all temporary folders as sandboxes.

| Profile | Intended use | Allowed claim |
|---|---|---|
| Isolated verification | Untrusted code or stronger containment requirements | Only the filesystem/network/process boundaries established by the selected validated mechanism |
| User-approved local verification | Trusted local development where full isolation is unavailable | Executes with disclosed local privileges and exclusions; not independently sandboxed |
| Unsupported | Required restrictions cannot be met | No execution; show the missing mechanism and alternative route |

Do not disable provider authentication or strip required runtime state indiscriminately while building process isolation. Credentials required by a provider process and credentials available to a check process have different scopes. Check processes should not inherit model-provider credentials by default.

External test services must be disposable or explicitly user-approved. Never use a production database as the default verification dependency. Enforce resource limits where the host supports them and disclose unverified limits.

### 9.5 Approval reuse without changing the test protocol

Separate immutable acceptance-definition approval from bounded permission to execute that definition. A user may approve a limited number of reruns within one workflow and an exact recipe/harness policy.

Each rerun still creates a new execution record and binds the exact candidate. Candidate changes can fit the policy only when that allowance is explicit. A changed executable, harness, dependency policy, environment permissions, or authentication route requires fresh review.

Retain maximum uses, expiry, scope, revocation, and atomic consumption. Do not reuse an old consumed single-execution plan or silently turn it into unlimited authorization.

### Exit gate

An ordinary dependency-based project prepares and tests successfully without relying on live developer dependencies. Environment failure, actual test failure, uncertain execution, and cleanup failure are distinguishable. Test results are durable and bind code, harness, and environment identities.

## 10. Phase R2-5 — Trustworthy UI state and guided workflows

### 10.1 Use monotonic, scoped read models

Extend the existing scoped-event implementation; do not return to global full-history snapshots.

Every project/workflow read model should carry its scope, vault epoch, committed sequence, and generated-at timestamp. Related data that must be mutually consistent should be read in one database snapshot. If separate queries are unavoidable, return and compare their revisions rather than silently combining different states.

Subscribe with a well-defined snapshot-and-replay boundary. Buffer or replay events after the snapshot watermark so no commit is lost between fetching and subscribing. Epoch mismatch, a cursor ahead of a restored vault, or a missed sequence must trigger scoped resynchronization.

Use both scope-generation and request-order fences. A late response for a previously selected project is rejected. A late older response for the same project must also be rejected. Domain sequence takes precedence over arrival time. Do not compare sequence numbers across unrelated epochs.

Coalesce overlapping refresh requests and use one scoped subscription owner where practical. Components should subscribe to task/workflow slices rather than re-fetching an entire project for every token. Keep the existing bounded transcript/history approach.

### 10.2 Expose refresh and source health

Return refresh status and errors from `useScopedRefresh()` rather than swallowing them. Views retain last-known data with a visible state such as current, refreshing, stale, disconnected, resynchronizing, or failed.

A freshness indicator should answer: what revision is shown, when it was last successfully observed, which source failed, and what the user can do next. A failed refresh must not masquerade as a successful empty response.

Keep local synchronization progress separate from provider/network activity. For example, a displayed task can be current through the last stored event while its external provider observation is stale. Both facts should be representable without a misleading global green badge.

On resume from sleep, focus, reconnection, and vault restore, reconcile affected scopes. Retry idempotent reads with bounded backoff; never use UI reconnection as a reason to repeat a model turn or destructive command.

### 10.3 Start with workflow readiness

Make the normal workflow screen a guided decision flow with advanced controls available on demand.

| Step | Default presentation | Advanced details |
|---|---|---|
| Goal | Objective and acceptance criteria | Interfaces, constraints, prior decisions |
| Team | Supported builder/reviewer presets and availability | Exact runtimes, profiles, model IDs, effort, capability records |
| Environment | Detected reviewed preparation/test recipe | Executables, arguments, hook policy, network and resource limits |
| Scope | Change boundaries and new-file policy | Explicit manifests, excluded files, unsupported artifacts |
| Review and start | Exact plan summary and effects | Digests, source revisions, consent policy, execution identities |

Show blocked routes before the user completes the form. Use distinct actions: save draft, validate runtime, prepare assisted handoff, or start coordinated workflow. A selected trusted binary is not automatically an accepted workflow route.

Persist drafts by project/workflow and fence asynchronous updates. Switching projects must not accidentally reuse another project's requirements, environment recipe, or output scope.

### 10.4 A task inspector that leads to a decision

Retain the existing role/stage/workspace/context inspector and connect it to actionable evidence. Default task information should show the owner, current action, blocker, expected artifact, code basis, context freshness, permission mode, and acceptance stage.

Provide a readable diff tied to the candidate, with reviewer findings beside affected lines. Selecting a finding should reveal its supporting evidence and the candidate that addressed it. Selecting a test result should reveal the environment, command, status, and protected log.

Maintain an explicit finding-disposition workflow: accept a substantiated finding, mark it resolved by a new candidate, or reject it with a recorded rationale. A model's confident criticism alone must not force an endless repair cycle. A changed candidate invalidates the applicability of affected old findings/checks without deleting them.

Keep hashes, native IDs, raw events, and full configuration in an inspection drawer. They support the decision but should not dominate the main screen.

### 10.5 Synchronization and context presentation

Present separate rows for project links, code/workspaces, context, history coverage, effective configuration, and native presentation. Each row needs state, evidence source, last successful observation, and next action.

Example wording is illustrative, not live telemetry:

| Situation | Appropriate display |
|---|---|
| Deliberate worker divergence | “Two isolated candidates; integration not started” |
| New requirements during a turn | “This task uses specification 12; specification 13 is pending” |
| Accepted context submission | “Context package acknowledged; comprehension not established” |
| Imported external history | “Imported through the recorded source position; live coverage unavailable” |
| Registry readback only | “Registry current; native sidebar not verified” |
| Failed scope refresh | “Showing last-known project state; reconnect or retry” |
| Successful check, failed cleanup | “Check passed on candidate C7; cleanup needs attention” |

Show initial context, retrieved evidence, omitted optional inputs, and unsupported required inputs separately. Do not display internal/private reasoning as invented progress telemetry.

### 10.6 Native actions, model controls, and usage

Keep Open folder, Continue native session, Hand off, Fork task, Review candidate, and Integrate changes separate. Enable each action only when its actual route is supported. Native opening does not imply session adoption or project-list synchronization.

Expose only model settings supported by the selected runtime/profile. Preserve user intent when a setting becomes unsupported, but block or request an explicit change; do not silently downgrade it. Display requested and effective model/effort side by side when they differ or when effective settings are unknown.

Maintain source-aware usage and coverage labels. Missing usage is unknown, not zero. Token counts, estimated API cost, reported billing, and subscription allowance are different metrics. New billing routes must not be silently added into a subscription allowance total.

### 10.7 Accessibility and interaction acceptance

Retain Paper, Night, and System themes and the restrained retro-terminal aesthetic. Use readable labels, ordinary text for actions, and monospace primarily for code/identities. Avoid decorative effects that compete with status information.

Test keyboard-only setup, approval, finding navigation, and recovery. Status must not depend on color alone. Dialog focus must return to its trigger. Live announcements should summarize useful stage changes without reading every token. Validate compact width, enlarged text, reduced motion, long paths, and Unicode names.

### Exit gate

The user can establish readiness, start or save a draft without manually writing JSON, see exactly what each agent uses, inspect changes and verification, and distinguish stale data from current evidence. Out-of-order responses and connection failures cannot silently regress the screen.

## 11. Phase R2-6 — Live acceptance and release qualification

### 11.1 Demonstration repository

Create a disposable test project with locked dependencies, multiple source modules, a tracked binary image, a tracked build script, a real test harness, and a feature requiring one new source file. Include enough source text to exceed the previous one-million-byte prompt approach without requiring excessive model usage.

For the larger capture/retrieval stress case, use a synthetic 100 MB repository with at least 10,000 small files plus several larger/binary assets. This is a proposed test workload, not a measured capacity claim. Keep the live inference demonstration smaller and bounded while exercising the same manifest-based path.

### 11.2 Required user journey

The user opens the project, reviews readiness, chooses the provider assignment, and approves the environment and initial task inputs. Topsl prepares context and resources, starts the builder, captures the resulting candidate, and asks the other provider to review the exact revision.

If the review finds a real defect, Topsl records the finding, runs a bounded repair, and obtains new evidence. If there is no finding, it must not fabricate one to demonstrate the repair loop; run a separate deliberately seeded-defect case instead.

Topsl prepares the environment, runs real checks, and displays code/harness/environment identities. The user accepts or rejects the exact candidate. Acceptance is distinct from applying, merging, or publishing it; those actions retain separate approvals.

Run the journey in both provider directions under the claimed supported configurations. A native assisted step may qualify assisted mode, but cannot satisfy the fully automatic workflow milestone.

### 11.3 Required negative scenarios

Exercise a denied write, invalid review output, dependency-preparation failure, actual test failure, external source mutation, stale specification, interrupted refresh, unknown dispatch response, restart during execution, and cleanup failure after a durable result.

Seed fixed reference defects to verify that the system does not simply count model agreement as success. Confirm original checks cannot be weakened to pass. Preserve unresolved disagreements and let the user decide rather than automatically trusting a reviewer verdict.

### 11.4 Evidence package

Archive a manifest linking the repository commit, test inputs, toolchain/runtime identities, authentication-route category, capability records, commands, logs, candidate revisions, verification artifacts, and approved usage limits. Redact credentials and unrelated source content before any publication.

Separate deterministic fixtures, real-process tests, live-provider runs, packaged desktop smoke, and performance measurements. Record skips and failed attempts. A rerun may demonstrate a fix, but should not erase the original failure.

### 11.5 Release decision

A platform is qualified only for its tested features. A successful cross-platform build does not certify every native authentication, desktop-continuation, or process-isolation route. Maintain a feature-by-platform/runtime support matrix.

For the round's primary automatic milestone, require both provider directions on at least one explicitly named qualified host configuration. Advertise additional host/runtime combinations only after their live acceptance. Require all four existing deterministic CI jobs to pass before declaring the cross-platform code delivery green.

Do not create release tags, publish packages, modify repository protection, or configure paid signing services as an implicit part of completing this document. Prepare the evidence and requested changes for user-authorized delivery.

## 12. Repository change map and work ownership

### 12.1 Existing code to extend

| Area | Existing files | Intended change |
|---|---|---|
| Provider contracts and capabilities | `packages/providers/contract.ts`, `codex.ts`, `claude.ts` | Async lifecycle, qualified capabilities, role requirements, effective settings, valid structured Claude route |
| Runtime and service integration | `packages/runtime/manager.ts`, `rpc.ts`, `coordinator.ts`; `apps/service/service.ts` | Awaited process handling, durable execution, consistent readiness checks, bounded event-driven dispatch |
| Workflow execution | `packages/workflows/builder-reviewer.ts`, `parallel-specialists.ts`, `advanced.ts` | Integrate shared readiness/lifecycle changes without adding templates |
| Candidate/context | `packages/workflows/candidates.ts`; `packages/context/packages.ts`; `packages/workspace/context.ts` | Versioned manifests, protected blob retrieval, bounded initial packages, retrieval receipts |
| Verification and resources | `packages/workflows/verification.ts`, `check-inputs.ts`; `packages/workspace/resources.ts` | Durable outcomes, preparation recipes, original-harness protection, separate cleanup |
| Persistence and migrations | `packages/persistence/store.ts` and existing repositories/migrations | Add schemas/indexes without rewriting historical records or weakening encryption |
| UI and scoped reads | `apps/desktop/renderer/state/scoped.ts`, `workflows.tsx`, `coordination.tsx`, related components | Monotonic refresh, visible errors, guided setup, readiness, evidence-driven changes view |
| Tests and CI | Existing runtime/workflow/context/verification/desktop tests and `.github/workflows/build.yml` | Barriers, lifecycle faults, new contracts, reproducible reports, all-target acceptance |

Suggested new modules include a provider acceptance registry, a shared readiness evaluator, an execution-environment service, a check-execution repository, a protected blob repository, and a cleanup queue. Place them within the existing package structure. Their names are implementation suggestions, not existing paths that have been inspected.

### 12.2 Keep refactoring bounded

Extract feature handlers from the large service/UI files when changing those features. Use shared typed IPC/read-model contracts and schema validation rather than extending `any`-based paths. Do not delay functional fixes for a broad framework rewrite.

Keep one canonical readiness evaluator, lifecycle abstraction, candidate reader, and verification execution path. The builder–reviewer, parallel, and advanced workflows must consume the same policy rather than drifting into separate implementations.

### 12.3 Suggested change sets

| Change set | Scope | Depends on | Review emphasis |
|---|---|---|---|
| CS01 | Baseline report and deterministic fixture barriers | None | Reproduce failures without weakening assertions |
| CS02 | Async shutdown, durable check execution, cleanup queue | CS01 | Unknown outcomes, process ownership, disk/cleanup errors |
| CS03 | Provider capability registry and role-specific readiness | CS02 contracts | No fixture promotion or blanket gate removal |
| CS04 | Real provider route, supported settings, assisted flow | CS03 | Auth/billing boundaries and live evidence |
| CS05 | Versioned candidate manifests and scoped retrieval | CS02 contracts | Data integrity, secrecy, path trust, old-format compatibility |
| CS06 | Prepared verification environments | CS02, CS05 | Harness integrity, dependencies, process isolation |
| CS07 | Scoped freshness and guided workflow/evidence UI | Early freshness can follow CS01; complete integration uses CS03–CS06 | Race tests, truthful status, accessibility |
| CS08 | End-to-end evidence and release qualification | CS01–CS07 | Distinguish implementation, fixture, live, and platform acceptance |

Work on distinct modules can proceed in isolated worktrees. Give changes to shared contracts, database migrations, lockfiles, and service dispatch boundaries a designated owner. Cross-provider review should target the exact candidate commit. Do not ask several agents to independently rewrite shared state machines and then combine them without contract review.

## 13. Acceptance and fault-injection matrix

Retain the original plan's tests. The following round-specific cases add coverage for the new gaps. Test IDs are intended to remain stable in code, CI reports, and the implementation evidence document.

### 13.1 Lifecycle and durability

| ID | Scenario | Required assertion | Phase |
|---|---|---|---|
| R2-AT-01 | Two workers held at ready barriers | Both run concurrently in distinct workspaces; aliases still collide | R2-1 |
| R2-AT-02 | Turn complete but exit not released | Capacity and write exclusion remain occupied until validated quiescence | R2-1 |
| R2-AT-03 | Parent exits while owned descendant remains | No early cleanup or workspace reuse; outcome/ownership stays appropriately unresolved | R2-1 |
| R2-AT-04 | Service shutdown during an active task | Shutdown is awaited; no writes after persistence closes; no replay on reopen | R2-1 |
| R2-AT-05 | Cleanup throws after check success | Durable result survives; only cleanup is pending/failed | R2-1 |
| R2-AT-06 | Crash after dispatch intent or lost native reply | Original execution is reconciled; a second effect is not automatically dispatched | R2-1 |
| R2-AT-07 | Concurrent approval consumption and cancellation | Exactly one authorized execution intent; cancellation does not erase late evidence | R2-1 |
| R2-AT-08 | Disk-full/write failure during result persistence | No false durable pass; storage failure and uncertain acceptance remain visible | R2-1 |

### 13.2 Provider readiness and integration

| ID | Scenario | Required assertion | Phase |
|---|---|---|---|
| R2-AT-09 | Reviewer supports reads but not writes | Ordinary reviewer can qualify without implementer-only capabilities | R2-2 |
| R2-AT-10 | Fixture record offered as live capability evidence | Production activation rejects it; no renderer/manual flag grants enforcement | R2-2 |
| R2-AT-11 | Runtime/profile/account/policy changes | Affected acceptance invalidates; unrelated historical evidence is retained | R2-2 |
| R2-AT-12 | Native route unavailable | No API/model/provider fallback; assisted mode states its limitations | R2-2 |
| R2-AT-13 | Partial output, duplicate final message, additive event | Text and usage are not duplicated; documented informational events do not corrupt lifecycle | R2-2 |
| R2-AT-14 | Invalid review JSON or wrong candidate revision | No clean-review result; bounded explicit remediation preserves the original attempt | R2-2 |
| R2-AT-15 | Unsupported effort/model or changed effective settings | No silent downgrade; requested/effective provenance is correct | R2-2 |
| R2-AT-16 | Assisted import after candidate/specification drift | Report remains attributed but stale; it cannot satisfy current acceptance | R2-2 |

### 13.3 Candidate and context coverage

| ID | Scenario | Required assertion | Phase |
|---|---|---|---|
| R2-AT-17 | Source exceeds previous prompt limit | Initial prompt stays bounded; complete approved candidate remains retrievable | R2-3 |
| R2-AT-18 | Unchanged binary image and changed binary asset | Unchanged asset does not block text review; changed asset gets an explicit supported/manual verification gate | R2-3 |
| R2-AT-19 | Tracked build source and protected credential path | Legitimate source inclusion is reviewed; secrets/native state remain excluded | R2-3 |
| R2-AT-20 | Live workspace changes after capture | Reader returns pinned artifact bytes; current-workspace evidence is marked stale | R2-3 |
| R2-AT-21 | Cross-project path, withheld peer, expired grant | All reader/search/preview routes deny access before pagination or snippets | R2-3 |
| R2-AT-22 | Mandatory requirements exceed model budget | Block before paid dispatch; no silent truncation or automatic retry | R2-3 |
| R2-AT-23 | New file, rename, staged deletion, output rejection | Exact approved resulting manifest is used by review and checks; required omissions block acceptance | R2-3 |
| R2-AT-24 | Old-format candidate, equal content in separate workspaces, large/interrupted capture | Legacy semantics remain readable; content identity can match without sharing trust; bounded capture cannot corrupt manifests | R2-3 |

### 13.4 Verification environment

| ID | Scenario | Required assertion | Phase |
|---|---|---|---|
| R2-AT-25 | Locked dependency-based project | Environment prepares and actual checks execute without live developer dependencies | R2-4 |
| R2-AT-26 | Registry unavailable, hook denied, preparation timeout | Environment failure is distinct from a failing candidate test | R2-4 |
| R2-AT-27 | Changed lockfile/toolchain or tampered dependency cache | Environment identity changes; unsafe cached contents cannot be reused as verified | R2-4 |
| R2-AT-28 | Test runner modifies original harness or source | Evidence is invalidated; new tests cannot replace original acceptance inputs | R2-4 |
| R2-AT-29 | Two tests use databases, ports, and output trees | Resources remain isolated; cleanup waits for lifecycle evidence | R2-4 |
| R2-AT-30 | Reused execution authorization with changed permissions or expiry | Out-of-scope reuse fails; valid bounded reuse creates a new execution record | R2-4 |

### 13.5 UI consistency and usability

| ID | Scenario | Required assertion | Phase |
|---|---|---|---|
| R2-AT-31 | Reverse arrival order of same-project responses | Older sequence never overwrites newer accepted state | R2-5 |
| R2-AT-32 | Rapid project/task switch with pending requests | No stale data, draft, error, or selection leaks across scope | R2-5 |
| R2-AT-33 | Refresh failure, missed events, restored vault epoch | Last-known state is labelled; recovery replays/resnapshots correctly | R2-5 |
| R2-AT-34 | User configures a blocked workflow | Early readiness explains blockers; save draft and assisted actions are distinct from Start | R2-5 |
| R2-AT-35 | Model/usage metadata missing or conflicting | Unknown is not zero; requested/effective and source freshness remain distinct | R2-5 |
| R2-AT-36 | Keyboard, compact width, enlarged text, Unicode paths | Setup, evidence review, approval, and recovery remain usable and clearly labelled | R2-5 |

### 13.6 Integrated release gates

| ID | Scenario | Required assertion | Phase |
|---|---|---|---|
| R2-AT-37 | Live Codex builder → Claude reviewer | Qualified route completes on a dependency-based repository with a binary asset and exact-candidate verification | R2-6 |
| R2-AT-38 | Live Claude builder → Codex reviewer | Reversed assignment meets the same acceptance contract; no provider-role assumptions | R2-6 |
| R2-AT-39 | Seeded defect, bounded repair, restart, and cleanup fault | Real checks catch the defect; new evidence applies to repaired candidate; recovery cannot fabricate completion | R2-6 |
| R2-AT-40 | Clean export and all four CI targets | Claimed committed implementation passes independently; local/uncommitted edits are not counted as delivered | R2-6 |

Live cases require explicit authorization and available supported routes. Mark them pending or failed when not executed; do not substitute fixture output and label the gate passed.

## 14. Migration, rollout, and operational targets

### 14.1 Additive schema migration

Introduce versions for runtime acceptance, check execution, cleanup jobs, candidate manifests/blob references, environment recipes/instances, and UI read models. Migrate through the existing protected persistence system.

Take a consistent encrypted backup using the database's supported backup path, not a live WAL file copy. Verify schema and integrity before proceeding. Make interrupted migrations recoverable and reject writes from older binaries that do not understand the new schema.

Keep old conversations, attempts, candidates, context packages, verification records, grants' non-secret provenance, and tombstones. Legacy verification without a recorded environment remains historical with environment coverage unknown; it must not become a newly qualified verification by default.

When rolling back, do not run an older writer against a newer database. Restore a compatible backup or use a supported read-only compatibility mode. Explain any data not included in the restored backup before restoration.

### 14.2 Blob retention and deletion

Protected blobs must be encrypted at rest and protected by the existing access boundaries. Use references so identical content can be deduplicated without granting access across projects.

Garbage collection must respect candidates, context packages, active/uncertain executions, verification evidence, explicit retention policies, and tombstones. Deleting a conversation must follow the product's defined treatment of independently retained project artifacts; show that distinction rather than silently deleting an accepted project candidate or silently retaining supposedly deleted conversation derivatives.

Cleanup jobs retain minimal non-sensitive provenance after deleting materialized bytes. They must not remove active workspaces or resurrect deleted records during retries. Blob backfill and cleanup should be resumable and bounded, not block the whole UI indefinitely.

### 14.3 Feature activation

Use independent feature gates for durable checks, qualified structured provider routes, manifest context, prepared verification, and the guided UI. Keep safe legacy read paths available during migration.

A feature flag selects an implemented path; it never overrides runtime, policy, trust, or authentication requirements. Fixture injection and unrestricted native credential use must not have user-facing production toggles.

Roll out in order: internal fixture paths, isolated real-process tests, one qualified live host, then additional runtime/platform combinations. Document assisted-only and unsupported combinations explicitly.

### 14.4 Proposed targets

These are design/test targets, not results achieved by this plan.

| Measure | Proposed target or default | Measurement boundary |
|---|---|---|
| Managed model concurrency | Default two tasks, respecting verified descendant/fanout accounting | Do not increase until lifecycle and provider coverage are established |
| Automatic repair rounds | Retain a maximum of two by default | Additional work requires an explicit new decision |
| Initial context budget | Model-aware, reserving output/tool overhead; configurable | Mandatory content may block; no fixed universal token count |
| Large capture acceptance | Synthetic 100 MB / 10,000-file workload | Tests capture/retrieval bounds, not a guarantee of every asset format |
| Metadata update latency | Target p95 ≤250 ms from service commit to visible selected-scope update on the declared test host | Excludes provider inference/network; record host and workload |
| Stale-state indication | On a detected refresh failure or transport loss, before presenting the next action based on assumed freshness | Cannot claim detection before the underlying transport notices a failure |
| History UI | Retain bounded pagination/virtualization with the existing 100,000-message benchmark | Measure correctness, memory, and actual render latency separately |
| Lifecycle stress | Proposed 20 repeated barrier-driven suite runs per target | Report individual failures; do not hide them with retry-to-green |
| Diagnostic retention | Bounded protected logs with explicit truncation/retention labels | Never store credentials or arbitrary unbounded provider payloads |

### 14.5 Scope of completion

The round is complete when the claimed routes work outside fixtures, all acceptance-required data has traceable identity, verification survives the specified faults, the UI cannot silently regress, and the release evidence matches the delivered commit.

Completion does not mean all native sidebars mirror, every operating system supports every isolation mechanism, all assets fit every model, or every runtime accepts the same settings. Those remain separately reported capability boundaries.

## 15. Plan review and resolved design issues

### 15.1 Review performed

This plan was checked against the pinned source review and rechecked branch/CI results, then reviewed for dependency order, recovery safety, scope preservation, acceptance-test coverage, and contradictions between product behavior and claimed guarantees. The official provider documentation was checked for authentication boundaries, model/instruction metadata, and streaming configuration. [R01] [R02] [D01] [D02] [D03]

This is a design review of the plan, not an independent model review, a security certification, or evidence that implementation tests have passed.

### 15.2 Issues corrected during the plan review

| Review issue | Resolution incorporated into the specification |
|---|---|
| Live-provider validation could depend on unbuilt context/environment features | R2-2 uses a small self-contained live probe; R2-6 owns the full-project demonstration |
| Removing the static gate could weaken permission enforcement | Registry-backed, role-specific qualification replaces it; user approval and fixture evidence cannot grant technical capability |
| Reviewer readiness unnecessarily demanded write access | Separate reviewer and implementer requirement sets |
| Waiting for every provider process to exit would break persistent App Server use | Distinguish service lifetime from task-scoped quiescence; require appropriate validated lifecycle evidence |
| Persisting a result before cleanup could accidentally mean passing before descendants stop | Persist a final eligible result only after required lifecycle/integrity checks; cleanup is separate afterward |
| A full manifest could be misrepresented as a full checkout despite omissions | Coverage is explicit; required unsupported/omitted inputs block acceptance |
| Binary assets could be retained but never meaningfully reviewed | Unchanged assets do not block text review; changed relevant binary inputs need a supported or manual verification gate |
| A new content hash could retroactively change historical evidence | Add schema/hash versions and separate workspace authority from content identity |
| Dependency installation could execute unreviewed hooks or inherit credentials | Exact recipes, scoped environment, hook policy, explicit preparation approval, and separate billing/auth boundaries |
| Reusable approvals could bypass single-use protections | Separate bounded execution policy from immutable test definition; each run still binds a fresh candidate/execution |
| Same-project UI races remained after project-selection fencing | Compare domain snapshot sequence and request order within scope, in addition to scope generation |
| “Perfect sync” could be interpreted as identical provider memories/sidebar views | Preserve dimension-specific observations and native presentation boundaries |
| Assisted operation could be counted as automatic acceptance | Separate release qualification and provenance for assisted and coordinated modes |
| A passing local tree could be confused with delivered code | Final qualification uses a clean export of the actual delivery commit |

### 15.3 Requirement traceability

| Finding | Primary phase(s) | Acceptance coverage |
|---|---|---|
| F01 — Production provider gates | R2-2, R2-6 | R2-AT-10–16, R2-AT-37–38 |
| F02 — Role capability mismatch | R2-2 | R2-AT-09 |
| F03 — CI/lifecycle timing | R2-1 | R2-AT-01–04, R2-AT-40 |
| F04 — Full-repository prompt limitation | R2-3 | R2-AT-17–18, R2-AT-20–24 |
| F05 — Exclusion policy | R2-3 | R2-AT-19, R2-AT-23–24 |
| F06 — Verification environment | R2-4 | R2-AT-25–30 |
| F07 — Cleanup can suppress evidence | R2-1 | R2-AT-05–08, R2-AT-39 |
| F08 — Stale UI state/races | R2-5 | R2-AT-31–33 |
| F09 — Setup friction/readiness | R2-5 | R2-AT-34, R2-AT-36 |
| F10 — Runtime model/stream metadata | R2-2, R2-5 | R2-AT-13–15, R2-AT-35 |

### 15.4 Outstanding implementation decisions

Select and validate the actual Claude integration/authentication route. Choose the host-specific containment mechanisms for qualified verification and independent modes. Decide the protected-blob storage backend by extending the existing encrypted store or using an equivalently protected blob layer. These choices require implementation evidence; the plan intentionally does not invent their results.

They do not prevent baseline fixes, durable check records, deterministic CI tests, UI freshness work, or assisted workflow improvements from proceeding. Keep each unresolved decision attached to the affected capability, rather than blocking the entire application.

### 15.5 Final decision

Proceed with incremental implementation, beginning with CS01 and CS02. Treat unsupported live capability qualification and full automatic end-to-end acceptance as explicit outstanding gates, not as permissions to bypass safeguards. Do not expand collaboration features until the ordinary two-provider workflow is useful, observable, and reproducibly verified.

## 16. Source references

Repository sources below refer to the pinned baseline unless stated otherwise. CI and branch endpoints are observations checked on October 14, 2026 and may later change. Source-linked facts establish the starting point; the proposed changes remain this plan's recommendations.

[R01]: https://github.com/Piore-Galore/Topsl/commit/e5e004e31e428d77d2242d3ab472e66d88bb0cc6 "Verified repository baseline"
[R02]: https://github.com/Piore-Galore/Topsl/actions/runs/38558938712 "CI run for the reviewed baseline"
[R03]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/docs/Improvement_Execution.md "Implementation and acceptance evidence"
[R04]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/packages/providers/claude.ts "Claude adapter and production gate"
[R05]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/packages/providers/codex.ts "Codex adapter and capability declarations"
[R06]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/packages/providers/contract.ts "Provider contract"
[R07]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/apps/service/service.ts "Service readiness and workflow integration"
[R08]: https://github.com/Piore-Galore/Topsl/actions/runs/38558938712/job/115834913116 "Windows failure job"
[R09]: https://github.com/Piore-Galore/Topsl/actions/runs/38558938712/job/115834913156 "Intel Mac failure job"
[R10]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/tests/parallel-workspaces.test.ts "Concurrency fixture timing and cleanup"
[R11]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/packages/workflows/candidates.ts "Candidate capture, exclusions, materialization, and text conversion"
[R12]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/packages/context/packages.ts "Task context packaging and delivery"
[R13]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/packages/workflows/verification.ts "Check planning, execution, persistence, and cleanup order"
[R14]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/apps/desktop/renderer/state/scoped.ts "Scoped refresh and error handling"
[R15]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/apps/desktop/renderer/workflows.tsx "Workflow creation and runtime controls"
[R16]: https://github.com/Piore-Galore/Topsl/blob/e5e004e31e428d77d2242d3ab472e66d88bb0cc6/apps/desktop/renderer/coordination.tsx "Project/task refresh and inspection UI"
[D01]: https://code.claude.com/docs/en/legal-and-compliance "Anthropic authentication, credential use, and native binary boundary; checked October 14, 2026"
[D02]: https://learn.chatgpt.com/docs/app-server "OpenAI App Server documentation: runtime model and instruction metadata; checked October 14, 2026"
[D03]: https://code.claude.com/docs/en/headless "Claude programmatic execution and partial-message streaming; checked October 14, 2026"

| Reference | What to inspect |
|---|---|
| [R01] | Commit identity and baseline |
| [R02] | All four CI job outcomes |
| [R03] | Already implemented foundations and declared validation limits |
| [R04], [R05], [R06], [R07] | Adapter gates, capability semantics, lifecycle contract, and service policy |
| [R08], [R09], [R10] | Failing jobs and corresponding fixture structure |
| [R11], [R12] | Candidate coverage, binary handling, and initial context limits |
| [R13] | Environment limitations and cleanup-before-persistence ordering |
| [R14], [R15], [R16] | Refresh consistency, errors, readiness, and workflow presentation |
| [D01] | Authentication route decision; recheck before releasing an integration |
| [D02] | Runtime-specific schema and model/instruction support; documentation alone does not qualify an installed binary |
| [D03] | Supported programmatic streaming behavior and version-dependent options |

---

**Primary completion criterion:** demonstrate a real, supported two-provider workflow on an ordinary repository, with bounded context, reproducible checks, durable evidence, correct recovery, and a UI that makes every important limitation visible.
