# Round 2 delivery baseline

R2-0 is complete. The original working tree passed the existing check and desktop smoke paths before Round 2 implementation edits began. The Windows and Intel Mac concurrency failures were not reproduced on this Apple silicon host. This report records source gaps, fixture results, runtime identity discovery and outstanding acceptance separately.

The [reviewed Round 2 plan](Topsl_Round_2_Improvement_Plan_Reviewed.md) is copied byte-for-byte from the supplied Desktop attachment: SHA-256 `776240b446b1c8ea2c597c4e6cf585a7e724b4479fd066536b04a452b478ed7e`. The [original improvement plan](Topsl_Improvement_Plan.md), [implementation evidence](Improvement_Execution.md), [prior baseline](Coordination_Baseline.md), capability inventory and implementation-status document were read as historical context. Earlier results retain their original meaning and do not count as new live acceptance.

## Captured checkout and tooling

| Item | Observed value |
|---|---|
| Run identity | `2026-10-15-r2-0-e5e004e` |
| Capture window | 2026-10-15 03:39:51–03:41:19 UTC / 11:39:51–11:41:19 Asia/Shanghai |
| Commit / branch | `e5e004e31e428d77d2242d3ab472e66d88bb0cc6` / existing `main` |
| Operating system | macOS 27.0.1, build 26A434; Darwin 27.0.0 |
| Architecture / CPU | arm64 / Apple M5 |
| Node / npm | v26.0.0 / 11.12.1, existing Homebrew installation |
| Electron / application | 44.4.5 / Topsl 0.1.1 |
| Git | Explicit `/opt/homebrew/bin/git`; exact version retained in manifest |
| Provider identities | Codex CLI `0.162.0-alpha.17.2`; Claude Code `2.1.183` |

[Initial state](round-2-evidence/2026-10-15-r2-0-e5e004e/initial-state.json) retains every tracked file's SHA-256, initial porcelain state, lockfile/source-plan hashes and available package scripts. The [evidence manifest](round-2-evidence/2026-10-15-r2-0-e5e004e/manifest.json) retains command identities, times, exits, full-log hashes and preservation checks. Source snapshots in the ledger are pinned to the reviewed commit, so later implementation does not change the baseline observations.

The six tracked local edits were `.github/workflows/build.yml`, `.github/workflows/release.yml`, `README.md`, `docs/Implementation_Status.md`, `package.json` and `scripts/package-summary.mjs`; the two existing untracked files were `scripts/verify-mac-package.mjs` and `tests/mac-package.test.mjs`. All eight retained their initial SHA-256 after the baseline runs. No branch, commit or push was created. This is a working-tree baseline that includes those existing packaging edits, rather than clean-commit qualification for R2-AT-40.

The inspected checkout and relevant parent/edited paths contained no applicable `AGENTS.md`. Existing `node_modules` were used without installing or downloading dependencies. Unit helpers create `topsl-test-unit-*` directories with synthetic encrypted stores and explicit fixture projects. Desktop smoke creates a fresh `topsl-test-desktop-*` profile with synthetic provider homes; native project/history fixtures remain under that profile. The optional `TOPSL_NATIVE_PROJECT_BINARY` and `TOPSL_BENCHMARK` inputs were removed from the child test environment. No provider model request, authentication/account change, live native database write, application install/update or release action occurred.

The [runtime identity record](round-2-evidence/2026-10-15-r2-0-e5e004e/runtime-identities.json) contains explicit selected executable paths, resolved paths, sizes, SHA-256 and `--version` output. Both version probes used empty disposable provider homes. These are identity observations only; no catalog query, model execution, profile entitlement or filesystem/network enforcement was accepted by R2-0.

## Unchanged baseline commands

| Command | Actual result | Retained evidence |
|---|---|---|
| `npm run check` | Passed typecheck; 235 unit tests, two opt-in skips; 17 release tests; desktop/service/CLI/renderer build. 43.5 seconds total. | [Full check output](round-2-evidence/2026-10-15-r2-0-e5e004e/check.txt) |
| `npm run test:desktop` | Passed original Electron journey, 100,000-message/four-source fixture, scoped UI checks and encrypted restart. 26.4 seconds. | [Full startup/assertion output](round-2-evidence/2026-10-15-r2-0-e5e004e/desktop.txt), [benchmark](round-2-evidence/2026-10-15-r2-0-e5e004e/desktop-artifacts/desktop-coordination-benchmark.json), [screenshots](round-2-evidence/2026-10-15-r2-0-e5e004e/desktop-artifacts/coordination-standard.png) |
| `npm test -- tests/parallel-workspaces.test.ts --reporter=default --reporter=json --outputFile.json=<report-path>` | All original 11 tests passed; assertions and fixture timings unchanged. 17.9 seconds. | [Full focused output](round-2-evidence/2026-10-15-r2-0-e5e004e/concurrency.txt), [Vitest JSON](round-2-evidence/2026-10-15-r2-0-e5e004e/concurrency-report.json) |

The build retained its existing warning about renderer chunks larger than 500 kB. The unit skips were the optional native Codex project test and heavy store benchmark; the desktop harness still exercised its existing large-history fixture. Eleven newly generated desktop artifacts were archived; stale pre-existing `packaged-mac.png` and `coordination-benchmark.json` were excluded. Archiving screenshots does not establish a new manual visual/accessibility acceptance pass.

The complete commands and exit statuses are also in [commands.json](round-2-evidence/2026-10-15-r2-0-e5e004e/commands.json). To repeat baseline capture without overwriting evidence, copy [capture-baseline.mjs](round-2-evidence/2026-10-15-r2-0-e5e004e/capture-baseline.mjs) into a fresh sibling directory under `docs/round-2-evidence/` and execute that copy from the repository. It records the then-current tree; reproducing this exact baseline additionally requires the captured source/dirty-file hashes and installed toolchain to match. The capture script refuses to overwrite an existing initial-state record.

## Historical CI and concurrency classification

Unauthenticated read-only GitHub API observations reconfirmed run `38558938712` and its exact baseline SHA: Apple silicon and Linux succeeded; Windows x64 and Intel Mac failed. [Retained job/step/annotation evidence](round-2-evidence/2026-10-15-r2-0-e5e004e/historical-ci-jobs.json) contains the five Windows concurrency failures and one Intel Mac concurrency failure. Windows recorded one “two writers” count mismatch and four 15-second test timeouts. Intel Mac recorded queued work dispatching while the test expected “Waiting for capacity.” Desktop smoke and packaging were skipped on those failing jobs.

Full historical job log archives were unavailable: `gh` is not installed and the unauthenticated log endpoint returned HTTP 403, “Must have admin rights to Repository.” The [fetch record](round-2-evidence/2026-10-15-r2-0-e5e004e/historical-ci-fetch.json) preserves that limitation. Public annotations are retained failure diagnostics, not a claim to possess the complete original logs.

The original tests use fixed worker lifetimes and unawaited close calls. Those are concrete investigation targets. The local suite passing twice does not prove the historical failures were harmless or establish a production scheduler defect. R2-1 must replace timing-created conditions with explicit barriers and await shutdown, then qualify Windows and Intel Mac separately without weakening concurrency assertions.

## Prioritized F01–F10 ledger

[findings-ledger.json](round-2-evidence/2026-10-15-r2-0-e5e004e/findings-ledger.json) records reproduction steps, confirmed observations, remaining hypotheses, affected platforms, intended fixes, commit-bound source excerpts and exact acceptance IDs for every finding. The mappings below are future acceptance obligations; baseline fixture passes do not mark the new Round 2 cases passed.

| ID / priority | Baseline classification and intended response | Exact Round 2 acceptance cases |
|---|---|---|
| F01 / P0 | Source-confirmed production route gap: Claude structured execution is gated and default Codex capabilities do not qualify. R2-2 supplies a supported explicit route, service-owned acceptance and assisted fallback. | 10, 11, 12, 14, 15, 16, 37, 38 |
| F02 / P1 | Shared readiness policy requires reviewer writes. R2-2 separates builder/reviewer requirements. | 09, 37, 38 |
| F03 / P1 | Historical CI failures confirmed; local non-reproduction; timing/teardown causation unproven. R2-1 adds barriers, durable task lifecycle and awaited close. | 01, 02, 03, 04, 06, 40 |
| F04 / P1 | Source-confirmed full-candidate/prompt coupling, binary rejection and budget limit. R2-3 separates complete manifests from bounded context and pinned retrieval. | 17, 18, 20, 22, 23, 24 |
| F05 / P1 | Fixed exclusions can omit legitimate tracked source. R2-3 distinguishes reviewed source coverage from mandatory credential/native-state protection. | 19, 21 |
| F06 / P1 | Explicit verification boundary: dependencies unprepared, OS/network isolation unenforced. R2-4 adds versioned environment preparation and honest restrictions. | 25, 26, 27, 28, 29, 30, 37, 38 |
| F07 / P0 | Source-derived cleanup-before-persistence failure path; not fault-injected at baseline. R2-1 persists execution/results before separate cleanup and tests storage/cancellation faults. | 05, 06, 07, 08, 39 |
| F08 / P1 | Refresh errors swallowed; same-project ordering gap needs controlled reproduction. R2-5 adds monotonic scope/freshness/error state and recovery. | 31, 32, 33, 36 |
| F09 / P2 | Setup exposes execution details before route readiness. R2-5 provides readiness-first draft/assisted/start flows and accessible guidance. | 34, 36 |
| F10 / P2 | Basic model metadata and omitted partial-message preparation confirmed; installed support remains version-dependent. R2-2/R2-5 add validated streaming and requested/effective metadata. | 13, 15, 35 |

Each number denotes `R2-AT-NN` from Section 13 of the copied plan. All 40 IDs are mapped in the machine-readable ledger. Existing code paths apply across platforms; only this macOS arm64 fixture baseline was executed locally.

## Outstanding gates

R2-0 establishes a reproducible starting point. It does not qualify production provider execution, real permissions/fanout controls, a dependency-based two-provider build/review/repair journey, native sidebar refresh, a clean committed export, or a packaged operating system. R2-AT-01–40 retain their round-specific proof requirements. Explicitly authorized live R2-2/R2-6 execution and independent macOS arm64, macOS Intel, Windows x64 and Linux x64 checks remain pending. No credentials, subscriptions, billing routes or approval gates were changed to obtain this baseline.
