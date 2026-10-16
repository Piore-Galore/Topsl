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

**Follow-up, 16 October 2026.** The suite is now `codex-runtime-qualification/v2`, and its first review turn also tests `candidate-reader`. The probe passes only when a `read_range` answer under the probe's grant returned the marker of a one-file build that only Topsl holds, and the reply quotes it. A passing run now satisfies the reviewer role. Details: [Codex workflows plan, step 4](Codex_Workflows_Plan.md#step-4-reader-probe-in-the-qualification-16-october-2026).

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

## Follow-up — hosted-runner CI for v0.1.2 (15 October 2026)

At the v0.1.2 preparation commit `b803825`, `main` failed [Compile Topsl](https://github.com/Piore-Galore/Topsl/actions/runs/38753613729) on Linux x64, Windows x64 and macOS Intel, and [Round 2 lifecycle stress](https://github.com/Piore-Galore/Topsl/actions/runs/38753613823) on all four runners. The tag-triggered release runs the same checks, so v0.1.2 could not publish. [Pull request #1](https://github.com/Piore-Galore/Topsl/pull/1) corrects the causes below. Everything above remains the dated record of the earlier runs.

| Failure on hosted runners | Cause | Correction |
|---|---|---|
| Windows checks ended `error` instead of `passed` ("Task quiescence is unproven"), and many Windows tests timed out | Checks run with Topsl's minimal environment, which has no `PSModulePath`. Windows PowerShell then found `Get-CimInstance` and `ConvertTo-Json` by searching every installed module. On the `windows-2025` image that took about 20 s per process query (49 s with four at once), past the 4 s observation timeout | Both Windows process queries ([`windowsDescendants`](../packages/runtime/process-lifecycle.ts) and [`affectedProcesses`](../packages/platform/system.ts)) turn module auto-loading off and import `Microsoft.PowerShell.Utility` and `CimCmdlets` from `$PSHOME`. The descendant observation timeout is now 15 s, because the first query after boot took 7.5 s |
| An explicit stop of a group member that outlived its leader reported `unknown` instead of `absent` on Apple silicon | `kill(-pgid, 0)` returned `EPERM`, which macOS reports for an exited member that is not yet reaped. It was treated as unknown | `processGroupPresent` treats `EPERM` as present, so the stop keeps waiting and escalating as it does on Linux |
| Waits failed (`expected '' to contain 'ready'`) and tests hit the 15 s limit on Linux, Windows and Intel macOS | `vi.waitFor` defaults to 1 s, a few tests chose 8–10 s, and the per-test limit was 15 s. Hosted runners are several times slower than a developer machine | [`tests/setup.ts`](../tests/setup.ts) gives every wait at least 30 s, and the test and hook limits are 120 s. A wait still returns as soon as its condition holds |
| `spawn /opt/homebrew/bin/git ENOENT` on Intel macOS | Tests and the Round 2 demo fixture hardcoded Apple silicon Homebrew git | `gitExecutable` in [`tests/helpers.ts`](../tests/helpers.ts), and the fixture, use that path only when it exists and otherwise `git` on `PATH`, like the product lookup |
| Mac package verification failed on pull request builds | electron-builder skips signing on pull requests, so the bundle verification after signing found an unsigned app | [`build.yml`](../.github/workflows/build.yml) sets `CSC_FOR_PULL_REQUEST: "true"`. The Mac bundle is only ad-hoc signed, so no secret is involved |
| Once the query worked, R2-AT-03 reported `quiescent` on Windows instead of `uncertain` | On Windows, Node ends a process's non-detached children when that process exits (libuv puts them in a kill-on-close job), so the fixture's descendant never outlived its parent there | The fixture detaches the descendant on Windows only; on POSIX it stays in the owned group. The assertions are unchanged |
| On a slower Windows runner, four checks ended `error` instead of `passed` or `failed`, one environment preparation timed out, and lifecycle stress failed in its third of 20 iterations | Test fixtures gave checks, hooks and environment preparation (`npm ci` plus reviewed hooks) 1–10 s budgets. That runner's full suite took 876 s instead of 576 s. One preparation ran past its 10 s budget, and the check that writes 2.4 MB of output most likely ran past 5 s | Test fixtures give checks and hooks 30 s and preparation 60 s, except where a test exercises the timeout itself. The protected-log test reports the execution's error if it fails |
| Twenty Windows lifecycle iterations would not fit the job's time limit | On that runner each iteration took 164–199 s, so twenty need about an hour, and the job allowed 60 minutes including setup. The Windows compile job also spent 20 of its 35 minutes on setup and tests, before its desktop smoke and packaging steps. Both are inferred from step times; neither job reached its limit | The lifecycle stress jobs allow 120 minutes, and the compile and release desktop jobs 60 minutes. The number of iterations is unchanged |
| Two candidate-manifest tests failed on Windows | Windows reports file mode `0o666`, and refuses to move a directory while capture holds a file in it open (`EPERM`) | The legacy-manifest test uses the platform's own mode. The hardlink parent-swap test also accepts `EPERM` on Windows; either way nothing is published |

The Windows query change also affects users. `affectedProcesses` decides whether an application is running before an install or update. It uses the same cmdlets, so on a machine with large PowerShell modules installed it would also exceed its 15 s limit and report the process state as unknown. This is inferred; only the descendant query was measured.

### Validation

- **Windows diagnostics.** A temporary workflow on the hosted `windows-2025` image (since deleted) ran Topsl's exact query with Topsl's minimal environment. As before, it took about 20 s per query, and 49 s with four in parallel. With auto-loading off and the two modules imported from `$PSHOME` it took 0.32–0.33 s per query and about 0.6 s with four in parallel, and 0.33 s with the runner's full environment. Two alternatives stayed slow: setting `PSModulePath` to Windows PowerShell's own module folder (19–42 s), and importing only `CimCmdlets` (about 20 s, because `ConvertTo-Json` was still found by the same search).
- **R2-AT-03 on Windows.** A second diagnostic on `windows-2025` (Node 22.23.3) ran the fixture's parent and child outside the test. The non-detached child was dead when its parent closed and absent from the process query. A detached child stayed alive, and the query listed it with its parent's process ID and a creation time inside the observation window.
- **First pull request run with the query fix** (`168ce77`): the Windows suite passed 312 tests with 13 skipped and failed only R2-AT-03, which the fixture change addresses. Compile Topsl passed on Linux x64 and macOS Apple silicon, and on macOS Intel the test step passed.
- **Second run** (`74ddbf0`): Compile Topsl passed on Linux x64, macOS Apple silicon and macOS Intel, and lifecycle stress passed all 20 iterations on the same three runners, which covers the `EPERM` change. R2-AT-03 passed on Windows. That Windows runner was slower, and five budget-bound tests failed there, as described in the table. Its lifecycle iterations took 164, 199 and 191 s; the third failed on the protected-log check.
- **Linux x64 cloud container** (Electron as Node, `ANTHROPIC_BASE_URL` unset): `tsc --noEmit` passed, and `node scripts/test.mjs tests/durable-executions.test.ts tests/runtime.test.ts` passed 24 of 24. Limited to one CPU with `taskset -c 0`, the `advanced-workflows`, `builder-reviewer`, `durable-executions` and `parallel-workspaces` test files failed 8 of 44 tests with the old budgets, with the same timeouts as the hosted runners, and passed 44 of 44 with the new ones in 309 s. With the final budgets, the nine test files whose budgets changed passed 86 tests with 1 skipped: seven through `node scripts/test.mjs`, and `environments` and `round2-acceptance` through `npm test --`. Those two need npm to start them, because they find npm's CLI next to the Node that npm reports in `npm_node_execpath`; started directly under Electron they fail with `ENOENT` for `npm-cli.js`. `npm run test:release` passed 16 tests with 1 skipped after the workflow time-limit change.
- **Remote evidence:** the pull request's Compile Topsl and Round 2 lifecycle stress checks on the four hosted runners. The container cannot run the Windows or macOS code paths.

## Follow-up — v0.1.2 release run (15 October 2026)

The tag-triggered [release run](https://github.com/Piore-Galore/Topsl/actions/runs/38780563793) for `0768a59` failed on Windows x64 in two tests on its first attempt, so its publish job was skipped. [Compile Topsl on `main`](https://github.com/Piore-Galore/Topsl/actions/runs/38780147207) ran the same commit on another Windows runner, and both tests passed there; the release runner's test step took 1039 s, against 903 s. Shortly afterwards, a Windows runner in the [lifecycle stress run for pull request #2](https://github.com/Piore-Galore/Topsl/actions/runs/38783557705), whose change no test uses, ran a third test past its limit in the first iteration.

| Test | Slow run | Same test on another Windows runner | Change |
|---|---|---|---|
| R2-AT-37/38, `reverse=true` | Release: exceeded the 120 s test limit at 170 s. Removing its folder afterwards failed with `EBUSY` because its check was still running | 65 s (`main`) | Tests are allowed 300 s ([`vitest.config.ts`](../vitest.config.ts)), and the Round 2 acceptance tests no longer set their own 120 s limits |
| Parallel workspaces: fanout capability gate and third task wait | Lifecycle stress for pull request #2: exceeded the 120 s test limit, then `EBUSY` while removing its workspace | 34–38 s (`main` and the release run) | The same 300 s limit |
| R2-AT-26, reviewed package hook | Release: the check ended `error` instead of `passed`; the whole test took 100 s. The assertion did not say why | 54 s (`main`) | The assertion reports the execution's failure phase, environment failure kind and error. A later run showed a time-limit fault, fixed as described below. The release runner's cause was not recorded |

Re-running only the failed Windows job on the same tag passed on the second attempt, with a test step of 794 s. The publish job then published the [v0.1.2 prerelease](https://github.com/Piore-Galore/Topsl/releases/tag/v0.1.2) with its four packages and their checksum files. The other jobs kept their first-attempt results, so the Linux and Mac packages come from the first attempt and the Windows package from the second, all built from `0768a59`.

### Time limits included the Windows process-tree query

With the clearer assertion, the Windows run for [pull request #3](https://github.com/Piore-Galore/Topsl/pull/3) at `6a83dcb` ([job log](https://github.com/Piore-Galore/Topsl/actions/runs/38787409777/job/116603237356)) failed R2-AT-26 with `environment phase, environment timeout: Environment preparation timed out.` The whole test took 19 s, under its hook's 30 s and its install's 60 s limits, so the limit that ran out belonged to one of the two 5 s version probes (`node --version` and `npm --version`).

Each preparation command and each check started its time limit when it was spawned and stopped it only after [`ProcessLifecycle.completion`](../packages/runtime/process-lifecycle.ts) returned. On Windows, that call also queries the process tree with PowerShell after the command closes, which can take several seconds: 7.5 s for the first query after boot, with a 15 s limit of its own. A probe that had already finished could therefore be recorded as timed out. The run did not record the probe's timestamps, so that the query, rather than the probe itself, used up the 5 s is inferred from the timings and from the reproduction under Validation.

[`environments.ts`](../packages/workflows/environments.ts) and [`check-executions.ts`](../packages/workflows/check-executions.ts) now stop the timer when the command closes, so a limit covers the command and not the observation after it. A command that does not close in time is still stopped and recorded as timed out, and descendants still running after it closes still make the result `uncertain`. On POSIX the observation is a check of the command's process group with a one-second grace period; group members that finish within that second no longer count against the command's limit.

### Validation

- **Linux x64 cloud container** (Electron as Node, `ANTHROPIC_BASE_URL` unset): `npm run typecheck` passed. `npm test -- tests/environments.test.ts -t "exact reviewed package hook"` passed 1 test, `npm test -- tests/round2-acceptance.test.ts -t "R2-AT-37/38"` passed 2, and `npm test -- tests/parallel-workspaces.test.ts -t "fanout capability gate"` passed 1. With the hook changed to exit with status 3, the hook test failed with `environment phase, environment preparation: Environment preparation command failed; candidate tests were not executed.`
- **Time-limit change** (same container): with a temporary 6 s delay inserted before the observation that follows a command's close (not committed), `npm test -- tests/environments.test.ts -t "exact reviewed package hook"` failed in 20 s with the CI run's message, `environment phase, environment timeout: Environment preparation timed out.` With the change, it passed under the same delay. A temporary test running a check that exits at once with a 1 s limit ended `error` under the delay before the change and `passed` after it. Without the delay, `npm run typecheck` passed, and `npm test` passed 323 tests with 3 skipped in 37 files (2 of them skipped) in 533 s.

## Follow-up — R2-AT-37/38 check ended `error` on Windows (16 October 2026)

On [pull request #4](https://github.com/Piore-Galore/Topsl/pull/4) at `1b32e1c`, whose change no test runs, the Windows x64 compile job ([job log](https://github.com/Piore-Galore/Topsl/actions/runs/38844559579/job/116792344089)) failed R2-AT-37/38 `reverse=true`: its first dependency check ended `error`, where the test expects `failed`. The other 312 Windows tests passed, and the same test passed on that pull request's earlier commit `e76b445` and on `main` at `d8eda1e`. A re-run of the job on the same commit passed.

The test failed after 21 s, while `reverse=false` took 59 s on the same runner, so neither the check's nor the preparation's 30 s limit can have run out. An `error` that early can come from one of the prepared environment's 5 s version probes (`node --version` and `npm --version` in [`environments.ts`](../packages/workflows/environments.ts)), a Windows process-tree observation that does not end `quiescent`, or a file error while the candidate is materialized. The assertion did not say which, and the job keeps no artifacts, so the cause is unknown.

The assertion in [`round2-acceptance.test.ts`](../tests/round2-acceptance.test.ts) now reports the execution's failure phase, environment failure kind and error, as R2-AT-26's does.

### Validation

- **Linux x64 cloud container** (Electron as Node, `ANTHROPIC_BASE_URL` unset): `npm run typecheck` passed, and `npm test -- tests/round2-acceptance.test.ts -t "R2-AT-37/38"` passed 2 tests. With both probe limits temporarily set to 1 ms (not committed), the `reverse=true` test failed as on the Windows runner, with `expected 'error' to be 'failed'`, and the assertion reported `environment phase, environment timeout: Environment preparation timed out.`
- **Remote evidence:** this pull request's Compile Topsl and Round 2 lifecycle stress checks on the four hosted runners.

## Follow-up — version probes ran past 5 s on Windows (16 October 2026)

[Pull request #11](https://github.com/Piore-Galore/Topsl/pull/11) at `9146b22`, whose change no test runs, failed its Windows x64 compile job on the first run and on one re-run, in a different test each time. Both failures came from a 5 s version probe in environment preparation.

| Run | Failed test | What it shows |
|---|---|---|
| [First run](https://github.com/Piore-Galore/Topsl/actions/runs/38867661661/job/116864401184) | R2-AT-39, an active real check across coordinator reconstruction | When the test's 30 s wait for the check's output ended, the check log held only `Environment preparation timed out.` The install has a 30 s limit and starts after the wait begins, so it could not have timed out by then. The limit that ran out belonged to one of the two 5 s probes. This is inferred from the timing |
| [Re-run](https://github.com/Piore-Galore/Topsl/actions/runs/38867661661/job/116870932091) | R2-AT-26, exact reviewed package hook | The case whose hook should time out failed with `timeout` after starting 2 of its 4 preparation commands, so the second command, `npm --version`, ran past its 5 s limit |

Since the [time-limit change above](#time-limits-included-the-windows-process-tree-query), a limit ends when the command closes, so on the re-run the probe itself took more than 5 s. Earlier, `main` at `cbfec68` ([run](https://github.com/Piore-Galore/Topsl/actions/runs/38850966987)) failed two Windows tests without saying why: R2-AT-26 with a missing registry ended `timeout` where it expects `preparation`, and R2-AT-39's cleanup-fault check ended `error` where it expects `passed`. Those failures and R2-AT-37/38's early `error` above fit the same cause, but none of those runs recorded it.

### Change

- The two version probes in [`environments.ts`](../packages/workflows/environments.ts), `node --version` and `npm --version`, have 30 s each instead of 5 s. A probe's limit still ends when it closes, so a normal preparation is no slower. A check plan keeps the environment recipe it was previewed with, so plans previewed before this change keep 5 s probes.
- Two waits that cover a whole environment preparation allow 120 s instead of 30 s: R2-AT-39's wait for its check's output in [`round2-acceptance.test.ts`](../tests/round2-acceptance.test.ts), and R2-AT-26/29's wait for its hook's output in [`environments.test.ts`](../tests/environments.test.ts). The probes and install before them can now take longer than 30 s without running out of time. A wait still returns as soon as its condition holds.
- When R2-AT-26's hook-timeout case fails its count of started commands, the message names those commands.

### Validation

- **Linux x64 cloud container** (Electron as Node, `ANTHROPIC_BASE_URL` unset), `main` at `a4642cc` plus this change: `npm test -- tests/environments.test.ts` passed 21 tests in 214 s, and `npm test -- tests/round2-acceptance.test.ts` passed 5 with 1 skipped in 124 s.
- **Slow probe** (same container): with the `npm --version` probe temporarily replaced by a command that prints a version after 6 s (not committed), `npm test -- tests/environments.test.ts -t "exact reviewed package hook"` failed under a 5 s limit with `environment phase, environment timeout: Environment preparation timed out.`, the message from pull request #3's Windows run, and passed under the 30 s limit.
- **Re-run failure** (same container): with only the hook-timeout case's `npm --version` limit temporarily set to 1 ms (not committed), the same test failed as on the re-run, with `to have a length of 4 but got 2`, and its message named the two commands that had started.
- **Full check** (same container): `npm run check` passed. That is the typecheck, `npm test` with 337 tests passed and 4 skipped in 41 files (3 of them skipped) in 494 s, `npm run test:release` with 16 passed and 1 skipped, and the build.
- **Remote evidence:** this pull request's Compile Topsl and Round 2 lifecycle stress checks on the four hosted runners. The container cannot run the Windows code paths.
