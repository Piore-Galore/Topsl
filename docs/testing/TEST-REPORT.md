# Comprehensive test campaign report — 19 October 2026

Final report for campaign `2026-10-19-comprehensive`, which executed the *Topsl Comprehensive Testing Plan for AI Agents* (359 cases, 14 journeys, 197 public commands) against the pinned development snapshot. Companion records: the [coverage register](TEST-COVERAGE.md) (every case, journey and command), the [decisions and defects register](TEST-DECISIONS.md), and the resumable [phase state](PHASE-STATE.md).

## Verdict

**Qualification failed, and the campaign is incomplete.**

- **Failed:** the local runs confirmed P0 defects. The most serious is D-01: with Recursive Looping turned off, Stop is refused while runs keep working. Others are duplicate publication writes, unsettled promotion recovery, rolling-allowance accounting errors, cancellation cleanup and handoff targeting. Under plan §12.6 no release-qualification or full-support claim can be made for this source.
- **Follow-up (19–20 October 2026, after the campaign):** every recorded defect was then fixed or, for D-15, decided as intended, and the merged result passed CI on all four platforms; see [Follow-up: fixes and four-platform CI](#follow-up-fixes-and-four-platform-ci). The campaign results below remain those of `d4b788e`.
- **Follow-up (20 October 2026):** D-11, D-17 to D-23 and D-26 were fixed, D-19 after the owner decided that finished tasks must not change,, and their reproductions now pass as plain tests; see [Defect repairs — 20 October 2026 follow-up](TEST-DECISIONS.md#defect-repairs--20-october-2026-follow-up).
- **Incomplete:** these cells were not executed: Intel Mac, Windows and Linux; the live Claude Build-and-review pairings and Claude qualification; long soaks; screen-reader acceptance; real first-open.

What *is* established, with evidence, is a delimited set of darwin-arm64 results, listed below. A PASS row means the asserted contract held for this source on this host and layer. It does not qualify other platforms, providers or layers.

## Scope and source

| Item | Value |
| --- | --- |
| Product source | `d4b788efb17adce0ec6362eeb745f62639767d0e` (the plan's pin). **No product code changed.** |
| Test and harness changes | Branch `test/comprehensive-campaign` ([decisions → Corrections applied](TEST-DECISIONS.md#corrections-applied)) |
| Host | darwin-arm64 only: macOS 27.0.1 (26A434), Apple M5, 10 cores, 32 GiB; Node v26.0.0; Electron 44.4.5 (Vitest runs under its Node 24.21.0); npm 11.12.1 |
| Native runtimes | Codex CLI 0.163.0 (native binary), Claude Code 2.1.302 |
| Inventory | 359 cases, 14 journeys, 197 commands (162 general, 19 coordinator, 16 loop); the source command schemas match the plan's Appendix A exactly |
| Owner authorization (19 October 2026) | Bounded live model turns (qualification and the live Build-and-review pairing script), a read-only Claude `/usage` read, and pushing the branch for CI. No installer operations or release publication |

## How it was executed

The coordinator ran the baseline, desktop, stress, native and packaging steps. Eleven worker packets, one per feature area, mapped every case to the existing tests and added tests where coverage was missing. A further worker ported the live-session script, another mapped desktop journeys to cases, and an independent reviewer re-executed and audited the results. Workers could not edit product code, ran only their own files through the canonical runner, and kept each confirmed defect as a `test.fails` reproduction.

### Commands and results

| Step | Command (from a clean checkout unless noted) | Result |
| --- | --- | --- |
| Install | `npm ci` | exit 0 |
| Baseline, first attempt | `npm run typecheck` then `node scripts/test.mjs` in a `/tmp` checkout with the agent session's environment | **Invalid run, preserved:** 143 failed / 492 passed / 5 skipped. Causes: leaked `ANTHROPIC_BASE_URL` (the product correctly refuses providers then), a `/tmp` checkout (qualification folders refused there by design) and bypassing `npm test` (no `npm_execpath`) |
| Baseline | `cleanenv.sh npm run typecheck && npm test && npm run test:release && npm run build`, checkout outside `/tmp` | typecheck pass; Vitest **635 passed, 5 skipped (opt-in) of 640**; release 18/0/0; build pass |
| Desktop journeys | `cleanenv.sh npm run test:desktop -- scripts/<each>.mjs` for desktop, coordinator, Atlas, loop, focused usage, Round 2 UI; `node --test tests/round2-demo-fixture.test.mjs` | all exit 0 (each harness run independently) |
| Lifecycle stress | `node scripts/lifecycle-stress.mjs --iterations 20 --seed campaign-2026-10-19-01` | 20/20 iterations passed (load uncontrolled; a flake screen, not a soak) |
| Round 2 acceptance | `node scripts/round2-acceptance.mjs --stress` | 6 passed / 0 failed, including the 100 MB / 10,000-source synthetic capture; 0 provider requests |
| No-inference native | `probe-codex.mjs`, `probe-provider-capabilities.mjs`, opt-in `codex-projects-native` and `codex-tools-native` tests, all with disposable homes | all passed; 0 model turns; Codex returned 8 catalog models |
| Package | `npm run package -- --mac --arm64`; `npm run verify:mac-package`; `scripts/package-summary.mjs` | `Topsl-0.1.2-mac-arm64.zip`, 146,283,720 bytes, SHA-256 `3da1499d8d7a202b14b98deabe6821421239b27d5ee0284d2c0b21285285ab6e`; signature verified |
| Packaged startup | `scripts/packaged-atlas-inspection.mjs` | **First attempt FAILED** (vault stayed "Unlocking…" for 45 s on the first launch of the new build; cause unconfirmed, likely a one-time Keychain step); diagnostic rerun passed |
| Packaged and upgrade | `scripts/campaign-packaged-test.mjs <scenario>` (10 scenarios) | 143 of 145 checks passed: the PKG-03 socket-path defect and a raw disk-full message |
| Combined gate (branch) | `npm run typecheck && npm test && npm run test:release && npm run build` **in the session's own environment**, plus all seven desktop harnesses (`cleanenv.sh`) | typecheck pass; Vitest **1,087 passed, 36 expected-fail, 5 skipped** (85 files); release 18/0/0; build pass; all desktop harnesses exit 0. This also verifies the runner fix: the same environment had failed 143 tests at baseline |
| Final gate after test strengthening | same Vitest/typecheck/release/build sequence, session environment | see [Combined gate](#combined-gate) |

### Combined gate

After the independent review, 25 tests were strengthened to assert exact reasons and authoritative boundaries, each with a mutation-checked negative control. The 13 strengthened files then passed together: 255 passed, 17 expected-fail, 0 failed. The gate was then run twice on the branch:

| Run (UTC) | Result |
| --- | --- |
| 13:23–13:32 | typecheck, release (18/0/0) and build passed. Vitest: 1,093 passed, 36 expected-fail, 5 skipped, **1 failed**. The failure was the STATE-12 service-level `test.fails`: its concurrency race did not reproduce on that run, so the expected failure did not happen. **First failure preserved:** the reproduction was nondeterministic. |
| 13:34–13:43 | After a barrier made that reproduction deterministic (5/5 expected-fail; as a plain `test` it fails with two publication events): typecheck, release (18/0/0) and build passed. Vitest: **1,093 passed, 37 expected-fail, 5 skipped, 0 failed** (85 files). |

The desktop harnesses were not rerun after strengthening, because no harness script changed; their last run is the 12:10 combined gate. The 37 expected failures are the reproductions of the 25 recorded defects (D-01 to D-25); several defects have more than one.

## Results

Counts come from the [coverage register](TEST-COVERAGE.md), after the independent review's reclassifications. The case result is the worst local layer result, so a PASS case can still have NOT RUN layers.

| Case result (darwin-arm64) | Cases |
| --- | ---: |
| PASS (at least one layer passed, none failed) | 287 |
| FAIL | 27 |
| BLOCKED | 9 |
| NOT RUN | 36 |

| Layer | PASS | FAIL | NOT IMPLEMENTED | BLOCKED | NOT RUN | NOT APPLICABLE |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| U contract | 86 | 7 | 0 | 0 | 37 | 0 |
| S service | 204 | 18 | 1 | 0 | 49 | 2 |
| P process | 103 | 3 | 0 | 0 | 80 | 0 |
| E Electron | 26 | 0 | 0 | 6 | 223 | 0 |
| N0 native | 2 | 0 | 0 | 0 | 40 | 0 |
| N1 live | 5 | 2 | 1 | 67 | 52 | 1 |
| K packaged | 15 | 1 | 0 | 10 | 76 | 0 |
| L load | 1 | 0 | 0 | 0 | 14 | 0 |

Every darwin-x64, win32-x64 and linux-x64 cell is BLOCKED (no host; the CI push needs the owner's credentials), except Codex qualification on Windows, which is NOT APPLICABLE by design.

**FAIL cases (27):** DATA-04, CONF-02, MCP-05, REPL-08, REPL-10, TEAM-03, TEAM-13, LOOP-09, LOOP-13, AUTO-06\*, AUTO-10, AUTO-11, STATE-04, STATE-05, STATE-12, OPS-02, OPS-10†, PR-13, BW-21, PW-03, HX-09, HX-10, PKG-03, TASK-01\*, CQ-01, CQ-05‡, CQ-06‡.

\* Disputed by the independent review as possibly intended (D-15, D-19).  
† OPS-10 failed because `docs/Recursive_Looping.md` contradicted the evidence; this change set corrects those passages, and a fresh review is still needed.  
‡ First live Codex qualification attempt: candidate-reader and interrupt timed out at 180 s while 11 worker agents loaded the host. The diagnostic retry passed every capability. First-run reliability is not established.

**Defects:** 25 product defects are recorded, D-01 to D-25: 23 confirmed and 2 disputed. Each has a reproduction, source location and severity in [TEST-DECISIONS](TEST-DECISIONS.md). The high-severity ones are D-01 LOOP-13, D-02 STATE-12, D-03 STATE-04, D-04 and D-05 OPS-02, D-06 BW-21 and D-08 REPL-08.

**Commands:** all 197 are mapped to cases through the plan's 60 groups. Every group has at least one PASS case, and 70 commands sit in a group with a FAIL case. A group with a PASS case is mapping coverage only: it does not mean each command's validation, scope and recovery variations all passed.

## Live provider results (N1)

All live runs used the owner's existing sign-ins on this Mac, disposable `topsl-test-live-*` Topsl profiles, scratch projects, the ported `scripts/live-session.mjs`, Codex CLI 0.163.0 and Claude Code 2.1.302.

| Run | Outcome | Model turns |
| --- | --- | --- |
| Claude `/usage` read (opt-in test) | PASS: 3 windows parsed, reset labels kept, account and profile unchanged | 0 |
| Claude Code → Codex handoff | PASS: 4880 + 3760 answered 8640 in Claude Code's native terminal; Codex continued through the reviewed handoff | 2 (1 Claude, 1 Codex) |
| Codex/Codex Build and review, first attempt | Qualification: 6 capabilities passed; candidate-reader and interrupt **timed out at 180 s**, so the workflow correctly never started | 3 Codex |
| Claude/Codex and Codex/Claude, first attempts | Native Codex error "workspace routing discovery timed out" before any turn (not a Topsl message; transient) | 0 |
| Claude/Codex, diagnostic retry | Codex qualification **passed all 8 capabilities** (gpt-6.1-sol); the Claude build step then stopped at Claude Code's own "Do you want to proceed?" prompt, which the script leaves to the owner, after 15 minutes | 3 Codex, plus 1 Claude Code session (usage not reported to Topsl) |
| Claude/Claude | Stopped at the same Claude Code permission prompt | 1 Claude Code session (usage not reported to Topsl) |

Totals: 7 Codex model turns, 1 Claude prompt turn, and two Claude Code build sessions whose usage Topsl cannot see. Claude runtime qualification (4 turns) was not run: its only route, `scripts/live-loop.mjs --claude-model`, also runs a mixed Goal loop beyond the approved scope. The four-pairing matrix (BW-19, J-03) remains BLOCKED until the owner can answer Claude Code prompts during the run.

## Packaged results (K, darwin-arm64)

On the extracted package the following passed, each using an isolated `--user-data-dir`:

- packaged identity; signature, plus rejection of a tampered copy;
- native SQLite and PTY modules loaded from `app.asar.unpacked`;
- a terminal opened, resized and closed through the packaged UI;
- the packaged companion CLI with grant enforcement;
- OS-vault creation and reopen;
- vault fault handling with no replacement key;
- crash-during-migration recovery;
- backup restore;
- app-bundle removal leaving data intact.

Upgrades of realistic profiles, created by building and running the v0.1.1 and v0.1.2 tag sources, preserved project, conversation and message IDs, trust and search, with no privilege widening. v0.1.1 then refused the migrated profile as newer without changing it.

These are the exceptions:

- the socket-path defect D-09;
- recovery messages for disk full and a foreign key store, recorded as NOT IMPLEMENTED;
- real Gatekeeper first-open (PKG-07), which needs the owner, and other platforms, both BLOCKED.

The old profiles came from tag sources, not published assets, and used passphrase vaults only.

## Independent verification (Phase 9)

A reviewer that produced no results checked the campaign:

- **Re-execution:** it re-ran each high-severity defect with `test.fails` changed to `test` in a temporary copy. Every one failed on its defect assertion.
- **Defect verdicts:** it confirmed 22 of 24 defects, disputed 2 as possibly intended, lowered two severities and corrected one source path.
- **Test audit:** it sampled about 180 PASS-backing tests and found none fully vacuous, but about 25 whose negative control was weak or which did not check the refusal reason. Those were strengthened, each with a mutation check, and that work found D-25.
- **Classification audit:** it reclassified overclaimed rows. These include the four lifecycle-stress L rows (a flake screen, not a soak), several partial PASS rows, and two rows that had cited `test.fails` tests as PASS evidence. The overrides are kept as an auditable layer (`p9-review/overrides.jsonl`) in the local evidence.
- **Harness changes:** the runner, live-session and Claude-route test changes were found not to weaken any check.

## Limitations

- One host and architecture. No Intel Mac, Windows or Linux execution. The CL-17/CL-18 Windows test changes are unverified. On Windows the account-read fixture uses a test double, so the real Windows account read is untested.
- Worker test runs, the stress run and the first live qualification shared the machine with up to 11 concurrent agents, so timing-sensitive observations were made under uncontrolled load.
- Electron-layer coverage of non-UI cases is mostly happy-path (26 E PASS). Most E variations are NOT RUN.
- No 1-, 8- or 24-hour soak was run. Measured slopes are reported but are not pass criteria: loop boundary cost grew with retained history, and a bounded UI soak showed no DOM, listener or process growth. Only the fixture renderer target (p95 ≤ 250 ms; measured 132 ms) was adopted.
- Screen-reader acceptance, a real OS theme switch and OS key-store lock states were not exercised, because they would change the owner's system or keychain.
- The plan's §6.3 optimization benefit study needs a live multi-model corpus and was not run.

## Remaining work

These are listed in priority order in [PHASE-STATE → Blockers and next runnable packets](PHASE-STATE.md#blockers-and-next-runnable-packets):

1. Push for the CI cells.
2. Rerun the live Claude pairings with the owner present.
3. Decide whether Claude live qualification may run.
4. Repair the defects, flipping each reproduction to `test` and rerunning the gate.
5. Re-review OPS-10 against the corrected documentation.
6. Run the soaks and the remaining NOT RUN variations.

## Follow-up: fixes and four-platform CI

*Dated follow-up, 19 October 2026 (UTC), after the campaign.* The owner signed in to the GitHub CLI, and the campaign branch was pushed as `codex/test-campaign-2026-10-19`. That name matches the workflow's `codex/**` push trigger; nothing was merged to `main` or released. Two repair sessions fixed D-01 to D-05 and D-06 to D-10 plus D-12. Their changes were merged into `test/comprehensive-campaign` as `43977cb`; each repair is recorded in [TEST-DECISIONS](TEST-DECISIONS.md#defect-repairs--19-october-2026-follow-up).

**Local gate on `43977cb`** (darwin-arm64, session environment): typecheck passed. Vitest: 1,119 passed, 17 expected-fail, 5 skipped, 85 files. Release tests 18/0/0, build passed. All seven desktop harnesses passed: main, coordinator, Atlas, loop, focused usage, Round 2 UI and campaign UI.

**CI runs on the campaign branch:**

| Run (commit) | Linux x64 | macOS Apple silicon | macOS Intel | Windows x64 |
| --- | --- | --- | --- | --- |
| 39271847356 (`5b5b0b4`) | check passed; desktop **failed**: loop journey, Endless text box detached by re-render (`desktop-loop-test.mjs:380`) | check passed; desktop **failed**: confirmations 3 of 4 expected (`desktop-test.mjs:1755`) | check **failed**: the campaign OPS-06 test exceeded 600 s | Vitest 969 passed / **17 failed** (campaign tests not Windows-safe) / 36 expected-fail / 113 skipped; job hit the 60-minute limit (OPS-06 took 1,362 s) |
| 39285908708 (`02aeda5`, OPS-06 opt-in and Windows fixes) | check passed; desktop **failed**: confirmations 3 of 4 expected | **all steps passed** | cancelled by the next push | cancelled by the next push |
| 39289887882 (`43977cb`, all fixes merged) | **all steps passed**: Vitest 1,119 / 16 expected-fail / 6 skipped; four desktop journeys; AppImage | **all steps passed**: Vitest 1,119 / 17 / 5; four desktop journeys; zip signed and verified | check passed (Vitest 1,119 / 17 / 5; release 18/0); desktop **failed**: confirmations 8 of 9 expected | **all steps passed**: Vitest 1,003 passed / 17 expected-fail / 121 skipped; release 17 passed / 1 skipped; desktop smoke; portable exe |
| 39363648985 (`a055657`, F-01 fix, Tasks-heading harness fix and interrupted Claude turns merged) | **all steps passed**: Vitest 1,122 / 16 expected-fail / 6 skipped; four desktop journeys; AppImage | **all steps passed**: Vitest 1,122 / 17 / 5; four desktop journeys; zip signed and verified | **all steps passed**: Vitest 1,122 / 17 / 5; release 18/0; four desktop journeys; zip | **all steps passed**: Vitest 1,005 passed / 17 expected-fail / 122 skipped; desktop smoke; portable exe |
| 39405382328 (`86226e2`, every remaining defect fix merged) | **all steps passed**: Vitest 1,140 passed / 6 skipped, no expected failures; four desktop journeys; AppImage | **all steps passed**: Vitest 1,141 / 5 skipped; four desktop journeys; zip signed and verified | **all steps passed**: Vitest 1,141 / 5 skipped; four desktop journeys; zip | **all steps passed**: Vitest 1,024 passed / 122 skipped; desktop smoke; portable exe |
| 39466511628 (`e5c208a`, live defects D-27 to D-29 fixed and streamed message text written in batches) | **all steps passed** | **all steps passed** | **all steps passed** | **all steps passed** |

Round 2 lifecycle stress on `43977cb` (run 39289887713) passed on all four platforms. The Windows job took 68 minutes; the other three took 11 to 21 minutes.

**What this establishes:**

- The four advertised platforms pass the full Vitest suite, campaign tests included, at `43977cb`.
- The historical Windows failures from plan §10.2 (CL-17 and CL-18 in `tests/claude-route.test.ts`) no longer fail. CL-17 now checks effective ACL access on Windows. On Windows, CL-18's main route test runs, and its `.cmd` diagnostics case is an expected failure, because it exposes D-26.
- Windows still skips 121 tests on purpose: POSIX shell stand-ins, Codex qualification (unsupported on Windows), and the coordinator and loop desktop journeys. Those cells remain unqualified on Windows (plan §9.1).

**Recurring desktop failure (F-01), since fixed:** the main desktop journey intermittently loses one native confirmation. The harness counts confirmations after a click, and one never arrives within 5 seconds. It happened in three runs on three platforms: Apple silicon (3 of 4), Linux (3 of 4) and Intel (8 of 9). Each time, the same journey passed on the other platforms in that run, and it passed in every local run. It matches the historical signature in plan §10.3. Neither the harness nor the product code involved changed. It is recorded in [TEST-DECISIONS](TEST-DECISIONS.md#recurring-desktop-confirmation-loss-f-01). *Dated follow-up, 20 October 2026:* it was a product defect. A routine project refresh briefly disabled the start button, and the click landed on the disabled button. It reproduced locally with a throttled renderer, and was fixed together with the related Endless mode-switch failure. CI run 39308245212 on the fix (`846e14c`, branch `codex/f01-lost-click`) passed every step on all four platforms. See the record for the evidence and verification.

**F-01 fix and final run.** F-01 was a real lost click. The workflow start button was disabled for a moment on every routine project refresh, and a click that landed in that moment was dropped ([TEST-DECISIONS](TEST-DECISIONS.md#recurring-desktop-confirmation-loss-f-01)). After the fix, the cancelled-turn change and a harness fix for an ambiguous Tasks heading, run 39363648985 on `a055657` passed every step on all four platforms, desktop journeys included. Round 2 lifecycle stress (run 39363649021) passed on all four. The next commit (`53efe74`) only adds documentation.

**All recorded defects resolved (20 October 2026).** D-01 to D-26 are all fixed, except D-15, which the owner decided is intended behaviour; D-19 was fixed following the owner's decision. The intermittent desktop failures F-01 (a lost click on the workflow start button) and the loop-journey timeout (choosing a loop run left the previous run's details on screen) were real product bugs, now fixed. On `86226e2` the suite has no `test.fails` reproductions left: the local gate passed 1,141 tests with 5 skipped, typecheck, release tests 18/0, build and all seven desktop journeys. CI run 39405382328 passed every step on all four platforms on its first attempt, and lifecycle stress (run 39405382330) passed on all four. Each repair is recorded in [TEST-DECISIONS](TEST-DECISIONS.md). One failure seen once on Apple silicon (a Goal loop staying "Active" for 180 s, CI run 39384214512 attempt 2) did not recur in any later run; it matches a historical signature from plan §10.3 and is kept on record as watched, not diagnosed.

**Live and soak coverage (20 October 2026).** These runs covered the cells still open after the defect repairs. All ran on darwin-arm64 against `main` at `419fd85`, under the owner's authorization.

| Cell | Result |
| --- | --- |
| Live Build-and-review pairings (BW-19, J-03) | None reached acceptance. Codex/Codex and Claude/Codex stopped at Codex qualification (the candidate-reader probe failed again). Codex/Claude stopped when its "Run a command" requests went unanswered for 15 minutes. Claude/Claude's Claude Code build passed, then its review stopped on D-27. |
| Live Claude runtime qualification (CL-05, CL-15) | **Passed:** all 7 capabilities in 4 turns (`claude-opus-5-5`, Claude Code 2.1.302) |
| Live mixed Claude/Codex Goal loop | **Blocked:** the first Claude turn hit D-28 and ended `uncertain`. The run then sat at "assessing" with no wait reason (D-29) until the procedure's 60-minute limit. |
| Loop soak, 1,000 boundaries with an accelerated clock (OPS-06, `TOPSL_LOOP_SOAK=1`) | **Passed:** 1,001 boundaries, 67 promotions, 33 rejections, 155 s. Per-boundary cost still grows with retained history (3.3 s for the first 100; slower each 100 after). |
| Lifecycle stress, 100 iterations (seed `campaign-2026-10-20-soak`) | **Passed:** 100 of 100 |
| UI soak, one hour (UI-26, `TOPSL_UI_SOAK_MINUTES=60`) | **Passed:** 9,447 cycles and 103,917 navigations; p95 37 ms, maximum 227 ms. After warm-up, DOM nodes −165, listeners −46, heap −1.5%, processes ±0. It ran alongside the loop soak and lifecycle stress, so latency was measured under load. |

Live usage: about 14 Codex turns (four qualifications plus build turns), 4 Claude qualification turns, one Claude coordinator turn, and three Claude Code terminal sessions whose usage Topsl cannot see. The 8-hour and 24-hour real-time soaks in plan §12.7 were not run; the accelerated loop soak covers the same 1,000-boundary workload. New defects D-27 to D-29 are recorded in [TEST-DECISIONS](TEST-DECISIONS.md#live-and-soak-follow-up--20-october-2026). *Follow-up, 20 October 2026:* all three are repaired with reproducing tests on branch `codex/live-defects-d27-d29` ([record](TEST-DECISIONS.md#live-defect-repairs--20-october-2026)); the live runs above have not been repeated.

**Live defects fixed (21 October 2026).** D-27 to D-29 were fixed from reproducing tests, recorded in [TEST-DECISIONS](TEST-DECISIONS.md#live-and-soak-follow-up--20-october-2026). A follow-up change writes a reply's streamed text in batches instead of rewriting the stored message on every delta: 20,100 deltas now cost 3 writes instead of 20,100. Local gate on `e5c208a`: typecheck; Vitest 1,150 passed and 5 skipped; release 18/0; build; all seven desktop journeys. The campaign UI harness first failed its soak step, because the new opt-in soak duration had broken the default cycle count; this was fixed in `e5c208a`. CI run 39466511628 passed every step on all four platforms, and lifecycle stress (run 39466511756) passed on all four. The fixes have not been confirmed against live providers: the mixed Claude/Codex loop and a Claude/Claude review hand-back would need another owner-attended live run.

**Live re-verification of the fixes (21 October 2026).** Both runs used `main` at `6450570`, the owner's sign-ins and disposable profiles.

| Run | Result |
| --- | --- |
| Claude/Claude Build and review (`live-session.mjs --workflow claude-claude`), first attempt | Stopped during the build: Claude Code's "Do you want to proceed?" prompt for `npm run check` sat unanswered for 15 minutes, far down the Tasks page in the build card's terminal. The build's edit to `src/order.mjs` had already landed. |
| Same, second attempt | **Passed, reaching awaiting acceptance.** The Claude Code build (Accept edits mode) changed only `src/order.mjs`; Topsl took its reply from the transcript (587 s). The Claude Code review (Plan mode, fresh session) found no problems, and Topsl took that reply from the transcript too, confirming **D-27 fixed live**. The required check passed (`totalCents` 900). Nothing was accepted or applied. |
| Mixed Claude/Codex Goal loop (`live-loop.mjs --mixed-only --max-turns 30`) | **Completed** in 22 minutes. Claude qualification passed 7/7 in 4 turns. Iteration 1 used 15 member turns: the Claude and Codex coordinators assessed and organized, the Claude implementer made the change, and Claude and Codex reviewed it; the iteration was promoted to checkpoint 1 (`README.md` modified). Iteration 2 found no work, and every required goal was satisfied on checkpoint 1. The first coordinator turn, which D-28 cut off on 20 October, completed, confirming **D-28 fixed live**. No member turn became uncertain, so D-29's new wait reason was not exercised live; its stand-in test covers it. |

One owner choice was needed although both coordinators proposed the same plan with identical titles. This is the equivalent-plan reconciliation gap that plan §2.2 lists as a P1 enhancement. *Follow-up, 21 October 2026:* proposals for one task that differ only in wording now combine into one merged candidate, which every coordinator endorses explicitly. Proposals that differ in structure still need the owner's choice. The gap is closed with stand-in tests ([record](TEST-DECISIONS.md#equivalent-plan-reconciliation--21-october-2026)); the change has not been re-run live. Live usage: one Claude Code build session and one review session in Topsl's terminal (usage not visible to Topsl), 4 Claude qualification turns, Codex qualification turns, and 15 loop member turns.

**Coverage register:** the per-case register still reflects the campaign's darwin-arm64 execution. The CI runs establish suite-level results on the other hosts; their cells were not re-mapped case by case.

## Evidence locations

- Local, untracked, under `test-results/agent-testing/2026-10-19-comprehensive/`:
  - `manifest.json`, `BRIEF.md`, `cleanenv.sh`;
  - per packet: `results.jsonl` and `summary.md`;
  - `p9-review/overrides.jsonl`;
  - `coverage.json`, `aggregate.py`, `render_coverage.py`.
- Raw logs were kept in the session scratchpad and are temporary; their results are restated in the packet summaries and here.
- Tracked: the campaign tests under `tests/campaign-*.test.ts`, the harnesses `scripts/campaign-*.mjs`, and the four documents in `docs/testing/`.
