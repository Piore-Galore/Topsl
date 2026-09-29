# Personal pilot implementation and acceptance

**Implementation:** Topsl 0.1.0, following the v2.1 design.  
**Recorded:** 29 September 2026.  
**Scope:** Working local application and the first usable foundations. The design's later phases are not declared complete by a compiled package.

## Implemented paths

| Area | Actual implementation | Evidence / boundary |
|---|---|---|
| Desktop boundary | Sandboxed renderer, context-isolated preload, typed IPC, validated sender frame, trusted native dialogs, separate utility process | Desktop smoke rejects unknown commands; no arbitrary shell command in the renderer API |
| Protected history | SQLCipher database and FTS index; OS-protected key or scrypt/AES-GCM passphrase envelope | Tests verify encrypted database/WAL, wrong-key failure, transaction rollback, and encrypted restart |
| Lifecycle control | Immutable plans, exact digest/revision/expiry binding, durable consumed approvals and installation locks | Tests cover stale/tampered approvals, concurrent jobs, crash recovery without replay |
| Downloads | Official publisher allowlist, platform/architecture selection, SHA-256 and length checks, progress, cancellation, fresh reviewed retry | Corrupt bytes and interrupted transfers cannot expose an executable artifact; resume is deliberately not attempted |
| Installation | macOS desktop download plus native archive/installer completion; other owner-supported official setup/store handoffs | Installation is pending until rediscovery verifies an actual version; installer/store execution and elevation remain native |
| Updates | Homebrew cask routing with selected token/channel; bundled Codex routes to its parent; other owners use native controls | Fixture tests distinguish owner paths, disable manager auto-refresh, and model locks, permission denial, disk exhaustion, and uncertainty |
| External changes | Periodic read-only rediscovery, content-bound executable identities, immutable installation revisions, compatibility invalidation | Runs retain the version and executable identity used at launch; a changed executable cannot silently run under old trust |
| Native controls | Real PTYs for Codex and Claude, including login, slash commands, skills, plugins, MCP, hooks, permissions and model controls | Actual PTY process test; terminal output is transient and credentials are not extracted |
| Codex integration | JSON-RPC over private local stdio; initialize, models/account, start/resume, turn streaming, tool records, approvals, interrupt, native usage snapshots | Synthetic protocol tests plus an actual isolated initialization/model probe; experimental personal use only |
| Claude integration | Native terminal, explicit transcript import, source attribution, reviewed Markdown handoff | No claim of a structured Claude approval bridge or full desktop automation |
| Accounts | Provider-owned login; sanitized Codex account summary; account-bound native resume; no silent API-key substitution | Account mismatch requires a new conversation and explicit handoff. Full multi-profile account isolation is a later phase |
| Projects and writers | Trusted native folder selection, canonical path check, one active Topsl writer per project, captured installation revision | Uncertain runs block a new writer until reconciliation. External writers are still governed by their native environments |
| Shared local project catalog | Opt-in native folder discovery, canonical-path deduplication, startup/minute/manual reconciliation, persistent source status, trust review, folder relinking, common application picker | Fixture coverage for aliases, partial/invalid sources, pause/races, missing/changed folders, and restart; see [source and launch boundaries](Project_Synchronization.md) |
| Native project connections | Experimental Codex project API: trusted-folder registration, native names/order in Topsl's sidebar, group rename/reorder, readback, removal retention, identity/profile pinning; Claude Code folder deep links | Actual isolated Codex API acceptance plus Electron create/rename/order/pause/restart smoke. Visible Codex desktop-cache refresh and full Claude sidebar mirroring are not established |
| History and handoffs | Selected native JSONL import, idempotent provenance IDs, project-filtered search, immutable attributed context preview/export, local deletion/tombstones | No synthetic provider transcript and no writeback to native histories; exported files remain user-owned |
| Configuration | Explicit native file allowlist, JSON/TOML syntax checks, source hash, parent/symlink checks, encrypted backup, atomic replace | File-write success never claims native reload. A concurrent external editor is detected by repeated reads; there is no cross-process editor transaction |
| Context service | Permission-restricted local socket / Windows named pipe, random per-project grant, stdio MCP companion | Project grants can read context only, and expire on process exit. Native configuration installation remains explicit |
| Interface | Applications/onboarding/palette, workspaces, timeline, native terminal, history/search, settings, Paper/Night/System | Actual Electron journeys and compact-layout smoke. Full assistive-technology testing remains a separate gate |

## Build targets and channel matrix

Compilation, desktop smoke, vendor installation, and paid inference are separate results.

| Host | Topsl build target | Codex CLI | Codex desktop host | Claude Code | Claude Desktop |
|---|---|---|---|---|---|
| macOS arm64 | ZIP; local build and UI smoke exercised | Official release download; trusted CLI/stdio; adopted Homebrew update | Discover ChatGPT/Codex aliases and bundled CLI; native archive/update route | Official binary download; adopted Homebrew stable/latest update; native terminal | Official archive acquisition and native completion |
| macOS x64 | ZIP; GitHub runner target | Same routes with x64 artifacts | x64 official metadata where advertised | x64 binary / channel-aware Homebrew route | Universal macOS archive |
| Windows x64 | Portable EXE; GitHub runner target | Official ZIP; native setup; executable selection | Common user installation paths; native store/installer route | Native setup/owner update; native executable selection | Common user installation path; native installer route |
| Linux x64 | AppImage; GitHub runner target | Official musl archive; native setup; PATH discovery | Official native download/setup route; desktop discovery must be extended for each packaging channel | Official binary download; native setup/update and PATH discovery | No official native Linux application advertised; install/download disabled |

Unverified store/package deployments, custom locations, Windows Store discovery, WSL/remote hosts, Linux ARM builds, and channels outside the table are not promoted to supported structured operations. A user can locate a known native CLI executable, but doing so is not platform/channel certification. `.cmd` wrappers require selecting the actual executable; Topsl does not enable arbitrary shell interpretation to launch them.

Read-only release resolution uses the OpenAI GitHub release API for independent Codex CLI downloads and Homebrew's cask metadata for eligible official artifacts/checksums. Homebrew metadata is identified as the checksum source; it is not represented as vendor signing evidence. Native OS/installer publisher verification remains required before execution. Unknown or externally controlled native auto-update settings are displayed as unknown and are never changed.

A vendor-managed desktop's eligible update is determined by its own channel, not the public installer feed. Its update action opens the existing application. Reconciliation requires a changed version before reporting an update; a closed native flow with an identical installation is recorded as unchanged and requires a fresh review to try again. Unknown or active process state keeps the operation unresolved.

## Recorded engineering evidence

- Strict TypeScript compilation and the deterministic test suite are run before delivery. Test cases cover approval/IPC boundaries, encrypted database/WAL, project scoping, imports/deletion, configuration conflicts, publisher/architecture validation, lifecycle faults, real PTY loading, and synthetic Codex streaming/approvals/usage.
- The actual desktop smoke opens an isolated passphrase-encrypted profile, creates a temporary project, discovers and deduplicates fixture native projects, reviews trust, pauses and refreshes discovery, creates/renames/reorders native registry fixtures, imports and searches a fixture transcript, previews a handoff, approves a native instruction-file edit, changes themes, checks compact layout and keyboard navigation, and reopens the encrypted profile.
- The installed macOS arm64 Codex `0.158.0-alpha.2.1` completed `initialize` and `model/list` in an empty temporary native home and returned seven models. **Zero model turns were submitted.** This is a protocol smoke, not full integration acceptance for that version.
- The same installed runtime passed the optional native project acceptance test: isolated create, rename, reorder, independent-connection readback, and native removal retention. Its project API remains experimental. No visible-sidebar refresh or Claude native project-list write API is certified by this result.
- A macOS arm64 personal-pilot archive was compiled locally. The [GitHub workflow](https://github.com/Piore-Galore/Topsl/actions/workflows/build.yml) independently builds and tests its four declared runner targets. Its run result, not this document's matrix alone, determines CI completion.
- The original Downloads design is preserved, with SHA-256 `ba6b7ddb9ab480115c00cd6d0942d5a5ae7c4db9bfff870a4c7678`.

No test installed or updated the user's real Codex/Claude applications, modified their provider settings, authenticated an account, or made a paid model request.

## Acceptance scenarios mapped to tests

| Scenario | Implementation-ready verification |
|---|---|
| Clean machine and one provider | Desktop smoke starts with an empty catalog; discovery adapters only return real paths. Perform a clean vendor acquisition per supported OS/channel before advertising that installation route as certified |
| Desktop-only, mixed versions/channels | Discovery canonicalizes aliases, scans desktop bundles and PATH, groups shared management units, and records revisions. Fixture owner routing plus live host discovery; complete real multi-channel installation matrix separately |
| Download-only, corrupt bytes, interrupted/cancelled transfer | Lifecycle tests require verified completion without execution, removal of partial output, cancellation, and fresh approval on retry |
| Wrong architecture or publisher | Artifact selection rejects an incompatible architecture, unsupported host, untrusted redirect host, or mismatched publisher. Native/store routes remain explicit when no direct artifact is verified |
| Homebrew Claude vs bundled Codex | Tests assert the exact selected cask token and disabled refresh; bundled Codex resolves to its desktop parent |
| Active sessions and concurrent updates | Tests prove idle deferral and single installation ownership. Unknown process inventory also defers changes; no force-close action is provided |
| External update / stale approval | Content-bound executable and owner/channel revisions invalidate old previews and trust. Historical runs retain launch versions and identities |
| Permission denial, locks, disk failure, crash | Fixture manager errors become uncertain; no automatic duplicate dispatch. Durable intents and consumed approvals survive reopen; successful native readback is required to resolve uncertainty |
| Installation succeeds but integration fails | Job actual version and installation compatibility are independent. Tests require successful installation labeling without claiming compatibility |
| Accounts, configuration and history survive updates | Lifecycle code never edits provider account stores or configuration. Encrypted restart, account-binding, imports/search/deletion, and immutable run-revision tests protect Topsl records |
| OS/channel acceptance | GitHub builds/test smoke establish host compilation and synthetic behavior only. Native installer, elevation, signature failure, live session update, and runtime-version acceptance require their own recorded cases |

## Remaining gates and deliberate limits

1. **Real vendor operations:** Perform disposable-machine installation/update/signature/elevation tests for each advertised OS/channel. Fixture success cannot establish native installer success. An uncertain package job may require finishing/repairing through its native owner before Topsl can confirm the approved target.
2. **Runtime policy:** Validate paid authenticated task execution, real tool approvals, sandbox enforcement, extension behavior, and native history fidelity against chosen runtime versions. Resolve Codex production eligibility before a production-supported distribution.
3. **Coverage beyond this pilot:** Full structured Claude integration, multiple native profiles/accounts, branch/fork lineage, automatic native history reconciliation, complete capability inventories/effective managed policy, quota/cost ledgers, parallel worktrees, optional API providers, WSL/remote hosts, cross-device synchronization, and complete visible native sidebar mirroring remain future phases. Codex registry synchronization and Claude folder links are implemented with the boundaries above; custom sections, pins, chats, and Claude project-list creation/order are not mirrored.
4. **Distribution:** Sign/notarize packages, add a Topsl updater, test restore/recovery UX and assistive technology, and validate packaged application launch on clean OS installations. This pilot builds unsigned packages and does not configure paid signing services.
5. **Scale:** The initial state projection caps each record collection at 5,000; history search returns up to 100 matches. Deletion removes all conversation derivatives directly in SQLite, including records outside the state window. Pagination and large-history performance acceptance remain open.
6. **Ownership limitations:** Native installations can change outside Topsl. Unknown update preferences, process inventory, or compatibility stay explicitly unknown. No rollback or broader system upgrade is silently introduced.

The [v2.1 design](Topsl_Design.md) remains the complete target architecture and acceptance contract. This implementation makes its personal-pilot paths concrete without treating future phases or unperformed live acceptance as complete.
