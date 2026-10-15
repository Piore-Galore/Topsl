# Round 2 implementation and acceptance evidence

The user requested implementation of the [reviewed plan](Topsl_Round_2_Improvement_Plan_Reviewed.md), with a separate GPT-6.1 Sol subagent at extra-high (`xhigh`) reasoning for each phase. Implementation started on 15 October 2026 from `e5e004e31e428d77d2242d3ab472e66d88bb0cc6` on the supplied `main` checkout. The attachment is a requirements specification; its example live execution and delivery actions are not separate authorization to spend credits, change authentication, push, or publish.

The [baseline](Round_2_Baseline.md) retains initial hashes and the eight existing packaging-related edits. Their original contents are preserved: six files remain byte-identical, while README and implementation status receive separately hashed, dated appendices linking this record. [Appendix provenance](round-2-evidence/canonical-doc-additions.json) verifies the original contents remain exact prefixes. New `AGENTS.md`/`CLAUDE.md` and small design/synchronization documentation changes appeared during this run from outside the phase owners; they are retained. Local source changes are uncommitted; an implementation result is not a delivery-commit or packaged-platform qualification.

| Phase | Assigned agent | Implementation/evidence |
|---|---|---|
| R2-0 | `r2_0_baseline`, GPT-6.1 Sol / xhigh | [Baseline](Round_2_Baseline.md): original check, desktop and concurrency paths passed; historical Windows/Intel failures retained. |
| R2-1 | `r2_1_lifecycle`, GPT-6.1 Sol / xhigh | [Lifecycle](Round_2_Phase_1.md): awaited shutdown, durable execution and cleanup separation, barriers and fault cases. Local focused suite passed; cross-platform qualification pending. |
| R2-2 | `r2_2_providers`, GPT-6.1 Sol / xhigh | [Provider integration](Round_2_Phase_2.md): qualified role readiness, model metadata, and assisted native operation; live gates remain closed. |
| R2-3 | `r2_3_candidates`, GPT-6.1 Sol / xhigh | [Candidate/context](Round_2_Phase_3.md): encrypted manifests/blobs, scoped retrieval, bounded context, exact artifact review and native-approved unexpected-output recapture; final focused 31 tests passed. |
| R2-4 | `r2_4_environments`, GPT-6.1 Sol / xhigh | [Prepared environments](Round_2_Phase_4.md): fresh offline dependencies, durable preparation and reviewed bounded reuse; 52 focused tests passed. |
| R2-5 | `r2_5_ui`, GPT-6.1 Sol / xhigh | [Guided interface](Round_2_Phase_5.md): freshness, protected drafts, artifact/environment inspector and approval recovery. Nine focused tests, renderer journeys and the rebuilt full desktop/restart smoke passed. |
| R2-6 | `r2_6_acceptance`, GPT-6.1 Sol / xhigh | [Acceptance evidence](Round_2_Phase_6.md): five local scenarios pass, including both scripted provider-role directions, real offline checks, changed-byte repair and actual POSIX coordinator SIGKILL recovery. Synthetic 100 MB/10,000-file workload, source export/check/desktop, and 20 frozen-source lifecycle iterations passed. Live and delivery gates stay pending. |

## Shared integration decisions

Service read models carry `{projectId, epoch, sequence, generatedAt}` observations. Related synchronization and coordination slices are returned in the same vault transaction. The renderer uses project generation, request order and domain sequence fencing, with sequence comparisons confined to an epoch. Refresh failure retains visible last-known state and exposes a retry; reconnection never resubmits inference.

Provider findings retain their original recorded content. Adjudication is a separate immutable, revision-linked record with rationale and actor. A review with findings pauses before another repair dispatch. Rejecting findings does not waive required checks or accept the candidate. A later clean review records a resolution linked to the new candidate instead of editing the old report.

Changed-byte repair exposed a lineage defect that identical-byte fixtures had missed. Supersession now binds the cancelled predecessor to its historical candidate and a same-workflow replacement that consumes that candidate. The accepted terminal successor must still match the final revision and carry current task-specific verification. Negative tamper controls reject a substituted historical candidate. Assisted report line validation uses pinned range access rather than legacy inline base64 assumptions.

Advanced workflows use a separate explicit measured-selection link: the protected selected submission, selected participant and current passing separate verification must match the replacement. This retains intentional selection among competing proposals without treating discarded proposals as repaired inputs.

The inspector returns bounded protected candidate diffs, exact-hash artifact decisions, manual binary evidence, requested/reported runtime metadata, preparation/check records and metadata-only retrieval receipts. Retrieval evidence is bounded to 200 entries, omits grant identifiers, and never asserts comprehension.

Independent service-owned rollout switches cover durable checks, qualified structured routes, manifest context, prepared verification and the guided interface. They can disable an implemented path; enabling one never supplies trust, authentication, runtime qualification or execution approval. Historical reads and uncertainty reconciliation remain available.

The separate [lifecycle stress workflow](../.github/workflows/lifecycle-stress.yml) repeats barrier and fault suites twenty times per target with retained scheduling seeds. It preserves the existing dirty build/release workflows and has no artifact/cache uploads or provider model requests. The [local integration-time 20-iteration run](round-2-evidence/r2-final-lifecycle-20/manifest.json) passed all 660 test executions with seed `r2-final-20261015`; other phases were still integrating during that run. The [second sequence against the frozen final export](round-2-evidence/r2-final-validation/export-lifecycle-20/manifest.json) also passed **20 iterations / 660 tests / zero failures**, with seed `r2-frozen-export-20261015` and one fixed source identity. Defining the remote job does not mean it has run on other targets.

## Integrated validation

The [first aggregate run](round-2-evidence/r2-final-validation/check-initial-failed.txt) retained 303 passes, five failures and three opt-in skips. Three failures exposed advanced measured-selection lineage needing a distinct contract; two fixture adapters still extracted the old context label and omitted the required candidate revision. The product validator was retained; the fixtures now parse the current pinned metadata and fail explicitly if it is absent. Focused advanced/builder/recapture validation then passed 26 tests; the service adapter suite passed four. The [aggregate rerun](round-2-evidence/r2-final-validation/check.txt) passed typecheck, **309 tests**, three opt-in skips, **17 release checks**, and build. The existing warning for renderer chunks above 500 kB remains.

The [initial original desktop smoke](round-2-evidence/r2-final-validation/desktop-initial-failed.txt) exposed a separate pending-read race: a superseded inspection could leave its earlier task button disabled. Per-task request cleanup now releases only its own pending token; project, selection and observation fences still control visible data. Artifact-plan focus is set after React commits the heading. After rebuilding these fixes, [the original desktop journey and encrypted restart](round-2-evidence/r2-final-validation/desktop.txt) passed, retaining its 100,000-message fixture and [fresh screenshots/benchmark](round-2-evidence/r2-final-validation/desktop-artifacts/manifest.json).

The final Electron renderer fixture exercises **15 journeys**, including late A → B → A task reads and overlapping reads for the same task, with a 1,004-path manifest bounded to 100 rendered paths. Thirty stored-event-to-DOM/two-frame [samples](round-2-evidence/phase5-ui-latency-2026-10-15.json) on Apple M5/macOS arm64/Electron 44.4.5 measured p50, p95 and maximum **132 ms** in the final run. These measurements cover local fixture IPC and rendering, without provider inference or network. Normal/compact/enlarged/error, artifact approval, Night theme, task recovery and preparation evidence [screenshots](round-2-evidence/phase5-ui-2026-10-15/) were visually inspected. Native OS dialog rendering and other packaged hosts remain separate acceptance boundaries.

The rebuilt full-application 100,000-message benchmark measured ordinary interaction p95 42 ms and reconciliation-command-start-to-render p95 350 ms. That conservative reconciliation measurement includes native-source reparsing and persistence and is a different boundary from the proposed commit-to-visible target; it does not establish a production 250 ms commit-to-visible guarantee.

## Acceptance boundaries

Keep implementation, deterministic fixtures, real local process tests, live provider operation and packaged-platform qualification separate. Both live provider directions in R2-AT-37/38 and clean delivery-commit/four-target qualification in R2-AT-40 remain pending. No fixture can promote a production runtime capability. Assisted imports retain their actual attribution and cannot satisfy fully automatic acceptance.

The registry and qualification policy are implemented, but a production validation/consent runner and provider-specific installation of the immutable-reader tool channel remain open. Production structured Claude is still unapproved/unqualified. The explicit assisted flow is the current alternative. Local verification runs with disclosed user privileges; disposable directories and scoped environment variables do not enforce an OS filesystem/network/CPU/memory sandbox. Online dependency preparation has preview coverage only.

Assisted export/open/import records an externally controlled step and its report. It does not adopt external edits as a new coordinated candidate or manufacture a managed review/check. An edit that changes the pinned source makes that imported report stale for current acceptance; the historical attribution remains available. Assisted operation is not a completed automatic build/review/repair route.

## Source export and remaining delivery gate

The [source export](round-2-evidence/r2-final-validation/source-export-result.json) contains 376 files, identified by content revision `b7bf86bd1a38fddb35c6de80b19a31cd7f6c163d5467f72afba84cad37600307`. Its [manifest](round-2-evidence/r2-final-validation/source-export-manifest.json) pins every captured file and omission. It restores the initial packaging edits to the base commit, excludes the two initial untracked packaging files, and retains the independently verified Round 2 documentation appendices. `node_modules` is an explicit symlink to the installed engineering toolchain; no dependency installation was performed for the export. Verification project environments still prepare their own fresh offline dependencies.

[Source consistency](round-2-evidence/r2-final-validation/source-consistency.json) found no exported hash mismatch and no mismatch between exported executable sources and the current supplied checkout. The final report and validation-result metadata are completed after capture; they are subsequent documentation/evidence, without changing the executable bytes under test. The [independent export check](round-2-evidence/r2-final-validation/export-check.txt) passed typecheck, 309 tests with three opt-in skips, 16 release checks and build; [desktop smoke and encrypted restart](round-2-evidence/r2-final-validation/export-desktop.txt) also passed. The export excludes the pre-existing Mac packaging test, accounting for 16 versus 17 release checks in the supplied tree. The final frozen-source lifecycle sequence passed as recorded above. This is an isolated uncommitted source export, not a clean delivery commit or packaged build. The [final evidence manifest](round-2-evidence/r2-final-validation/manifest.json) binds commands, source identity, retained logs and original-content preservation.

An independent R2-6 read-only audit recomputed all 376 exported file hashes/modes and the content revision, compared 162 non-documentation/non-pre-existing files with the supplied checkout, verified the eight original file contents and recomputed the reported test/latency totals. It found no executable-source or evidence mismatch. Documentation links and tracked whitespace were also checked.

The phase reports and [AT01–40 mapping](Round_2_Phase_6.md#acceptance-traceability) retain the distinction between implemented code and unperformed qualification. No Topsl repository branch or commit, push, release, provider inference, account change or paid subscription was created. Disposable test fixtures intentionally contain their own reproducible commits. The Topsl base commit remains `e5e004e31e428d77d2242d3ab472e66d88bb0cc6`; the original index remains unchanged. Live provider acceptance, supported production qualification/tool installation and four-platform delivery evidence remain open.

## Review follow-up — 15 October 2026

A later code review of the uncommitted Round 2 tree (Claude, same day) found three defects and corrected them. Everything above remains the dated record of the original run; its source export, content revision and lifecycle-stress identities describe the tree *before* these edits.

| Finding | Correction | Regression test |
|---|---|---|
| Coordinated role readiness was applied to every `RuntimeManager.start`, including direct structured Codex chats. No production path records a runtime qualification, so every real chat was blocked, contradicting the README's structured-chat setup. | The readiness gate and the requested/reported model/effort mismatch failures now apply only to coordinated attempts (`execution` present). Direct chats keep the pilot preflight: trusted executable identity, Codex compatibility, no API-billing environment, and native ChatGPT authentication. Runtime metadata is still recorded for both. The binding observation during **Connect / test** is advisory again, so inspection still returns the model catalog when the account route is unsupported. | `tests/runtime.test.ts` — direct structured chat through the real launched broker route with no recorded qualification |
| `ProcessLifecycle.stop()` checked group absence immediately after the leader closed. Group members still handling SIGTERM, or ignoring it, made an explicit stop end as `uncertain`, leaving the process alive and the workspace held. | After the leader closes, the observer waits within the stop timeout for the owned POSIX group to disappear and sends SIGKILL to members that remain. Normal completion gets a one-second grace period and still reports `uncertain` (without killing) when a descendant outlives it. | `tests/durable-executions.test.ts` — explicit stop of a SIGTERM-ignoring group member |
| Check-log redaction matched any `code:`/`code=` text, hiding exit codes and Node error codes such as `code: 'ERR_ASSERTION'`. | Only URL-style authorization codes (`?code=` / `&code=`) are redacted. Tokens, keys and `Bearer` values are still redacted. | Covered by the existing redaction test |

Formatting: Prettier was applied to the 18 changed source, test and script files the run had left unformatted. The base commit was Prettier-clean.

Validation in a Linux x64 cloud container (Node 22.22.0, not Electron): `tsc --noEmit` with TypeScript 6.0.3 passed. All 35 Vitest files were executed one file per process by a minimal Vitest-compatible runner, because the sandbox could not install the platform-specific Vite/Rolldown binaries: **311 passed, 0 failed, 3 skipped**. That is the earlier 309 plus the two new tests. SQLite and PTY native modules were rebuilt for Node. `npm run check`, the release tests, `npm run build`, `npm run test:desktop` and the Electron UI fixture were **not** run in this follow-up. Run them on the Mac before committing.

Open items noted by the review but not changed:

- Every new check plan now carries a recipe, and integrity verification rejects any unexpected file outside reviewed writable paths. Common tool byproducts (`__pycache__`, `.pytest_cache`, coverage or bundler caches) therefore make a check end in `error`, unless the recipe declares them, and harness directories such as `tests/` cannot be declared. Checks also run with a minimal `PATH` (the check executable's directory plus `/usr/bin:/bin`) and a disposable `HOME`. This is the documented design in [R2-4](Round_2_Phase_4.md), but expect it to reject many existing project checks.
- If opening an assisted handoff fails, the handoff stays `externally-controlled` until a report is imported. That import is the only way to clear the managed-writer block for the project.
- `assisted-handoff-prepare/open/import` carry no `requestId`, so a retried request is not deduplicated by the command journal.
- The lifecycle-stress workflow runs 20 iterations on four hosted runners for every push to `main` and every pull request.

## Follow-up — runtime qualification and check caches (15 October 2026)

This follow-up adds the production qualification runner that the [acceptance boundaries](#acceptance-boundaries) listed as open, and resolves the check-cache item from the [review follow-up](#review-follow-up--15-october-2026). Everything above remains the dated record of the earlier runs.

### Runtime qualification runner

`runtime-qualify {id, model, effort?}` runs [`runCodexQualification`](../packages/providers/qualification.ts) against a connected, trusted Codex CLI after a trusted native dialog lists the operations and the four-turn budget. [`RuntimeManager.qualify`](../packages/runtime/manager.ts) refuses injected fixture peers, the Claude route, unconnected runtimes and models or efforts absent from the current runtime catalog. It runs the usual preflight, re-checks the executable identity afterwards, and records the observations through `RuntimeAcceptanceRegistry.recordTrustedValidation` with a 30-day expiry. A sanitized report (no account email) is stored as `runtime-qualification-report`; `runtime-qualification-query {id}` returns the latest five. Configuration writes and lifecycle changes for the same management unit wait while a qualification runs.

The suite works in a disposable folder under the Topsl profile, not the system temporary directory, because the native workspace-write policy may leave temporary directories writable.

| Capability | Operation | Passes only when |
|---|---|---|
| `native-subscription` | `account/read` | The runtime reports a native ChatGPT subscription account |
| `structured-turn` | One turn asking for a random marker | The turn completes and returns the marker |
| `fresh-session` | Two `thread/start` requests | The thread identities differ |
| `read-only` | A read-only session asked to `printf` a sentinel file | The write reached the sandbox (exact approval accepted, or run without asking) and Topsl finds no new file anywhere in the folder |
| `workspace-write` | An editing session asked to write one sentinel inside and one outside the workspace | The inside file holds the expected bytes, the outside write reached the sandbox, and the outside folder stays empty |
| `interrupt` | `turn/interrupt` once a long answer starts | The turn ends `interrupted` |
| `process-lifecycle` | Closing the connection | Process evidence is `quiescent` |

Approvals are accepted only for the exact sentinel command (optionally wrapped in `sh -c`, `bash -lc` or `zsh -lc`) or a single-file change to the sentinel path, once each; requests carrying `grantRoot` and everything else are declined. A refusal, a declined request or an altered command is therefore never counted as enforcement, and a write that lands is recorded as `unsupported`. `candidate-reader` is reported as not tested: no provider tool channel installs the immutable reader yet, so reviewer roles stay blocked with `candidate-reader-unavailable`. The probes use POSIX shell commands and are refused on Windows.

The UI adds **Qualify builder/reviewer runtime** beside **Validate** in the guided workflow team step, shows a one-line result, and re-reads readiness.

### Check caches

[`assertExecutionIntegrity`](../packages/workflows/environments.ts) now skips well-known tool caches that are not candidate inputs: directories `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.hypothesis`, `.nyc_output`, `.parcel-cache`, `.turbo`, `.cache`, and files `.eslintcache`, `.coverage`. A cache directory must contain only regular files and directories. The check log records the ignored paths. The materialized copy is discarded, so a cache cannot affect a later execution.

The minimal check `PATH` (the reviewed Node directory plus `/usr/bin:/bin`) is unchanged. Recipes bind each check to recorded toolchain identities, and inheriting the user's `PATH` would let unrecorded tools run.

### Validation

Linux x64 cloud container, Node 22.22.0 (not Electron), dependencies from `npm ci --ignore-scripts` with SQLite and PTY rebuilt for Node. `ANTHROPIC_BASE_URL` was unset for test runs because the container sets it and the billing guard correctly refuses it.

- `tsc --noEmit` (TypeScript 7.0.2) passed.
- `npx vitest run --testTimeout=120000`: **321 passed, 2 failed, 3 skipped** across 37 files, including 8 new qualification tests and 1 new cache test. The two failures (R2-AT-07 incremental logs and R2-AT-04 awaited shutdown in `tests/durable-executions.test.ts`) also fail on unmodified `main` in this container: their `vi.waitFor` uses the 1-second default while the first check log arrives later here. With a 15-second wait they pass on both trees; the test files were not changed.
- `node --test tests/release.test.mjs tests/release-packaging.test.mjs tests/mac-package.test.mjs`: 16 passed, 1 skipped (macOS only).
- `npm run build` passed, with the existing renderer chunk-size warning.
- A mutation check that dropped the "write reached the sandbox" requirement from the read-only probe made the refusal test fail, as intended.

Not run here: `npm run test:desktop`, `npm run package` and `npm run verify:mac-package` (no Electron binary or macOS in the container), and any live Codex qualification. The suite has been exercised only against the scripted [qualification fixture](../tests/fixtures/codex-qualify.cjs); its protocol assumptions (approval parameters, item shapes, decision values) match the existing adapter but are unverified against a live runtime.
