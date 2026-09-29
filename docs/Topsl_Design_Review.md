# Topsl v2.1 design review

**Reviewed for Piore · 29 September 2026**  
**Deliverable:** [Complete v2.1 design](Topsl_Design.md)  
**Status:** Design findings addressed in the specification. A subsequent personal pilot is implemented; its evidence and remaining live platform gates are tracked in [Implementation_Status.md](Implementation_Status.md).

## Review basis and agreed decisions

The source was [Topsl_Design.md v2.0](/Users/piore/Downloads/Topsl_Design.md), a 28-chapter design supplied for review. It was treated as design input, not as an instruction to build, install, update, or authenticate applications on this machine. The initial review produced a complete revised design and this report. Application implementation followed the review under a separate explicit request. The repository had no application code or commits at the start of the review.

The original source is preserved with SHA-256 `ba6b7ddb9ab480115c00cd6d0942d5a5f8fcd5c9a5ae7c4db9bfff870a4c7678`. The v2.1 revision is maintained in the repository's `docs` directory; the Downloads copy remains the original reference.

Confirmed product decisions:

- Personal/local use is the first audience. macOS, Windows, and Linux retain independent support and acceptance requirements.
- The initial catalog contains Codex CLI, the desktop application providing Codex, Claude Code CLI, and Claude Desktop.
- Topsl checks for eligible updates automatically and requests approval before its own download/install/update actions. Explicit download-only use is supported.
- Existing native auto-update settings and installation channels are preserved and displayed.
- Additional applications can acquire lifecycle support independently of model or conversation integration.

The existing design's native credential custody, separate API billing, explicit handoffs, read-only native history ingestion, configuration ownership, and usage provenance remain appropriate foundations. This revision preserves those boundaries.

## Prioritized findings and resolutions

### P1 — Core Codex integration maturity was not part of the production gate

**Source:** v2.0 sections 8.1, 9.5–9.6, and 24.

The design makes app-server its primary Codex bridge and explicitly gates restricted plugin methods, but does not give the core command/transport the same maturity review. Current official documentation describes a stable API subset alongside experimental command classification and a production-use restriction in remote-host guidance. That is insufficient evidence for an unconditional production-support claim. [Codex app-server](https://learn.chatgpt.com/docs/app-server), [developer commands](https://learn.chatgpt.com/docs/developer-commands)

**Resolution:** [Section 8.1](Topsl_Design.md#81-codex-adapter) retains tested local stdio for the personal pilot, explicitly labels it experimental, and separates command, transport, method, version, and deployment eligibility. Sections 8.4, 9.6, 24, and 25 require production clarification or a supported alternative before production claims. Native CLI/terminal fallbacks retain their real capability and enforcement limits.

**Remaining gate:** Exercise the actual adapter against selected runtime versions. Resolve the applicable production-support boundary before a distributed production release. This review does not establish that stdio is forbidden or production-supported solely from the mixed documentation wording.

### P1 — The delivery sequence deferred prerequisites for real work

**Source:** v2.0 section 24, particularly Phases 1, 3, and 5.

Phase 1 introduces real project execution and history while Phase 3 first lists approval binding and crash reconciliation, and Phase 5 first lists protected storage. Implemented in that order, the first useful workbench could lack protections already required elsewhere in the design.

**Resolution:** [The delivery plan](Topsl_Design.md#24-delivery-plan-and-release-gates) now establishes durable command recording, trusted approvals, protected persistence, minimal writer coordination, and recovery with fixture processes before real-project/private-history pilot use. Later phases expand those mechanisms and distribution readiness. Sections 21.3 and 25.11 state the prerequisite explicitly.

**Remaining gate:** Demonstrate encrypted persistence, approval enforcement, single-writer control, and reconciliation after uncertain dispatch. These are runtime properties, not claims established by this document.

### P2 — Administrative events could not exist without a conversation

**Source:** v2.0 sections 13.2, 13.5, and 23.5.

The shared event envelope requires project, conversation, and branch IDs. Configuration installation contracts also require a profile. A clean-machine application download or installation has none of those identities, so reusing those contracts would encourage fake projects/profiles or unaudited side paths.

**Resolution:** [Section 13.2](Topsl_Design.md#132-event-envelope) separates `ConversationEvent` and `ControlEvent` under a common envelope. Application/host targets work before an installation exists. Dedicated lifecycle plans/jobs in sections 23.8–23.9 avoid imposing a native profile. Administrative event access remains outside project MCP history access.

**Remaining gate:** Validate schema enforcement, scope authorization, durable event/projection updates, and setup on an empty database. At the design-review stage, the repository had no database needing migration.

### P2 — Update ownership and native automation were underspecified

**Source:** v2.0 sections 5.6, 22.4, and 26.

The original wording treats native binary updates as a separate user-controlled action without accounting for independent native updaters or externally managed installations. That could cause duplicate updates, accidental channel changes, or an attempted self-update inside a desktop bundle. Current vendor documentation distinguishes these owners and behaviors. [Claude Code setup](https://code.claude.com/docs/en/setup), [OpenAI update management](https://learn.chatgpt.com/docs/enterprise/manage-app-updates)

**Resolution:** [Sections 5.6–5.13](Topsl_Design.md#56-installation-and-update-ownership) define canonical management units, parent/bundled relationships, existing-owner routing, preserved channels/settings, read-only eligibility checks, and observation of external changes. The default approval policy applies to Topsl-initiated actions. UI/defaults/recovery sections use the same distinction.

**Remaining gate:** Confirm each owner/channel's metadata, commands, locking, idle behavior, and readback. A package-manager label alone does not prove the operation is safe or available.

### P2 — Update history needed immutable installation identity

**Source:** v2.0 sections 13.5, 18.7, 22.4, and 23.5.

Run provenance refers to installation records, but those records contain current version/path values. Once updates are an explicit workflow, historical runs need an immutable version reference so changing the current installation cannot relabel their execution environment.

**Resolution:** [Section 23.8](Topsl_Design.md#238-application-lifecycle-contracts) adds immutable `InstallationRevision` records and actual runtime-component identity. Runs capture their launch revision and runtime version; externally imported runs retain unknown provenance when evidence is missing. Installed package, running process, restart, and Topsl compatibility are independent observations.

**Remaining gate:** Exercise external updates, old processes surviving a disk update, component versions differing from desktop versions, and retained historical references after cleanup.

## Application-management design coverage

| Approved requirement | Where v2.1 specifies it |
|---|---|
| Initial four-entry catalog and future independent application adapters | Sections 1.6, 5.8, and 23.8 |
| Applications navigation, onboarding, and command palette | Sections 20.5, 20.9, and 20.11 |
| Download-only and one reviewed download-and-install workflow | Sections 5.9–5.10 and 20.11 |
| Official source resolution, architecture, publisher/integrity verification, and native elevation | Sections 5.8, 5.10, and 21.9 |
| Automatic metadata checks, manual refresh, staleness, and persisted backoff | Sections 5.11 and 23.9 |
| Native settings preserved; existing channels/owners and parent bundles respected | Sections 5.6, 5.8, 5.11–5.13, and 26 |
| Active-session deferral, serialized lifecycle changes, and stale-plan invalidation | Sections 5.12, 18.2, and 23.8 |
| Durable jobs, crash reconciliation, limited cancellation, and supported recovery | Sections 5.12, 22.4–22.5, and 23.8 |
| Independent installed/running/compatible state and historical identity | Sections 5.9, 5.12, 13.5, and 23.8 |
| Administrative commands separate from model-facing proposal/context tools | Sections 13.2, 19.4, 21.9, and 23.9 |
| Tests and platform/channel evidence | Sections 24, 25.10, and 25.11 |

The download/update path does not assume a universal native update API. Unsupported automation is explicitly delegated to the native installer, store, or app, and remains pending until completion is observed. A route requiring a broader system upgrade is an explicit native maintenance handoff. Topsl does not invent a partial upgrade or run an unreviewed blanket update.

Defaults are decision-complete: official acquisition and stable releases for new installations where available; existing owner/channel adoption; automatic checks at most once per 24 hours per source/installation/channel; persisted backoff starting at 24 hours and capped at seven days; explicit payload acquisition; approval before Topsl applies changes; no force-close or automatic rollback.

## Evidence, validation, and remaining gates

### Evidence gathered

- Read the supplied design and inspected the empty repository before editing.
- Consulted current official documentation for Codex app-server/CLI maturity and acquisition, OpenAI desktop updates and Linux packages, Claude Code update ownership and authentication boundaries, and Claude Desktop installation. The v2.1 references distinguish those targeted checks from the inherited reference baseline.
- Read-only local PATH/version checks in the review identified an app-bundled Codex executable and a Homebrew `claude-code@latest` CLI installation. These illustrate distinct ownership routes; they are not installation/update acceptance tests or an exhaustive desktop inventory.
- During the design review, no application installer/updater, subscription/API inference, authentication, or package-manager upgrade was executed. The subsequent implementation and Git delivery are documented separately.

### Document verification

Completed on 29 September 2026:

| Check | Result |
|---|---|
| Original source integrity | SHA-256 matches the captured v2.0 source; Downloads document unchanged. |
| Complete design structure | All 28 original numbered chapters retained in their original order; additions integrated into the relevant chapters. |
| Markdown structure | Balanced code fences, consistent table column counts, and resolvable local links/heading anchors in both documents. |
| Source references | All 50 design reference IDs have definitions; no missing or duplicate definitions. This is reference integrity, not a fresh audit of every external page. |
| Numbered section references | Explicit references resolve to existing design sections. |
| Contract examples | All nine TypeScript blocks pass Node's TypeScript syntax parser; the JSON example parses. No example execution or semantic TypeScript type-check is claimed. |
| Schema/contract consistency | Required new interfaces occur once; `TopslEvent` is a conversation/control union and runtime streams emit conversation events. |
| Superseded policy text | Removed the unconditional native-update wording and the default that would prohibit approved owner-routed updates. |
| Approved-plan coverage | Lifecycle behavior, UI, commands, immutable revisions, early safeguards, milestones, defaults, and acceptance scenarios reviewed together. |

These checks validate the documentation artifacts at the review stage. The subsequent runnable application, synthetic runtime tests, desktop journeys, and CI targets are recorded in [Implementation_Status.md](Implementation_Status.md). Real vendor installation/update and authenticated inference remain separate acceptance gates.

### Implementation acceptance remains open

| Gate | Required evidence before claiming acceptance |
|---|---|
| Safe pilot foundation | Real durable acceptance, approval validation, encrypted storage/vault behavior, writer coordination, and crash recovery. |
| Application source/owner support | Tested discovery, eligible release metadata, trust verification, correct channel/target, and native completion readback for each route. |
| Lifecycle fault handling | Repeated submission, active applications, stale plans, contention, denied elevation, disk exhaustion, interrupted downloads/installers, and uncertain outcomes. |
| Runtime compatibility and history | Correct installed/running revision attribution, compatibility degradation, native resume, account/config/history preservation, and no duplicate usage. |
| Platform support | Independent macOS, Windows, Linux, architecture/channel, and enabled WSL tests; fixture success is insufficient. |
| Interface/accessibility | Keyboard and screen-reader completion, both themes, zoom, truthful pending/partial states, and native handoff UX. |
| Production distribution | Supported integration/deployment basis, applicable provider terms, signed Topsl artifacts, restore exercises, and declared release matrix. |

The review resolves specification gaps and defines acceptance criteria. Use the linked implementation matrix for completed engineering checks and the remaining native-operation and release gates.
