# Test decisions and defects — campaign 2026-10-19-comprehensive

Coordinator register of confirmed defects, harness corrections, contract decisions and open product questions found while executing the [comprehensive test plan](TEST-REPORT.md#scope-and-source). Every product defect below has (or had, until fixed) a reproducing test kept as `test.fails` with a `// CAMPAIGN DEFECT <case>` comment. `test.fails` keeps the suite green while the test still runs, and turns red once the defect is fixed, so whoever fixes a defect must also change that test to a plain `test`. No product code was changed in this campaign. Test, harness and documentation changes are listed under [Corrections applied](#corrections-applied).

Source: `d4b788efb17adce0ec6362eeb745f62639767d0e` (product code unchanged), host darwin-arm64. Run each reproduction from the repository root as `npm test -- <file> -t "<name>"`. Since the [runner fix](#corrections-applied), the agent-session billing variables no longer need to be removed by hand; the campaign itself ran every command through a local `env -i` wrapper (`cleanenv.sh`, untracked).

## Product defects

Severity is the coordinator's triage. The plan priority (P0/P1) belongs to the case and is listed separately.

### High

| ID | Case (plan priority) | Defect | Source | Reproduction |
| --- | --- | --- | --- | --- |
| D-01 | LOOP-13 (P0) | **Fixed in the [follow-up](#follow-up-fixes-d-01-to-d-05) (19 October 2026).** With Recursive Looping turned off, Pause, Stop and Resume are refused, yet active runs keep running, monitoring wakeups fire and restarts auto-resume. Project-wide **Stop everything** stops the child goal but swallows the loop refusal, and the loop then admits a new iteration and dispatches again. | `packages/orchestration/loop-engine.ts:1343` (`control` → `assertEnabled`, throws at `:289`); `tick()` at `:1793` has no flag check; `stopProject` at `:1590` | `npm test -- tests/campaign-loops-state.test.ts -t "LOOP-13"`; service level: `tests/campaign-loops-state-service.test.ts:345` |
| D-02 | STATE-12 (P0) | **Fixed in the [follow-up](#follow-up-fixes-d-01-to-d-05) (19 October 2026).** Two concurrent publication confirmations write the folder twice. With the same command ID, the receipt check is check-then-run. With two command IDs and the same digest, both pass the "already published" check before either writes, and real Git through the service ends with two receipts. | `packages/orchestration/repository.ts:85-125`; concurrent message handling at `apps/service/worker.ts:12` | `tests/campaign-loops-state.test.ts:1509`, `:1532`; `tests/campaign-loops-state-service.test.ts:614` (the service-level reproduction raced on its own and did not reproduce in the 13:23Z gate run; it now holds the first write behind a barrier until a second confirmation reaches the write, reproduces 5/5, and fails with two publication events when run as a plain `test`) |
| D-03 | STATE-04 (P0) | **Fixed in the [follow-up](#follow-up-fixes-d-01-to-d-05) (19 October 2026).** A crash just after the promotion transaction leaves the promoted child in `awaiting-acceptance`. `finishIteration` never runs, so the iteration gets no outcome records, token totals or reclaim. | `loop-engine.ts:4524-4534` settles the child after the transaction; `advance()` at `:1869-1874` treats the iteration as finished | `tests/campaign-loops-state.test.ts:1135` |
| D-04 | OPS-02 (P0) | **Fixed in the [follow-up](#follow-up-fixes-d-01-to-d-05) (19 October 2026).** The rolling member-turn allowance undercounts once more than 2,000 updates fall inside one window: with 3 turns truly left, below the admission minimum of 4, a due wakeup admits work. | `loop-engine.ts:2157` (`.slice(-2000)`) | `tests/campaign-loops-state.test.ts:996` (control `:982`) |
| D-05 | OPS-02 / §8 usage cursor (P0) | **Fixed in the [follow-up](#follow-up-fixes-d-01-to-d-05) (19 October 2026).** A crash between the usage record write and the iteration turn-count write double-charges: 12 turns recorded for 11 launches. | `loop-engine.ts:2146-2161` (two writes, no transaction) | `tests/campaign-loops-state.test.ts:1043` (control `:1029`) |
| D-06 | BW-21 (P0) | If the managed interrupt rejects during `builder-reviewer-cancel`, the workflow is already saved as `cancelled`. The reader grant stays live and workflow checks are not cancelled, and the command receipt says `failed`. | `packages/workflows/builder-reviewer.ts:2407-2415`; `apps/service/service.ts:2735-2740` | `npm test -- tests/campaign-build-review.test.ts tests/campaign-build-review-service.test.ts -t "failed managed interruption"` |
| D-08 | REPL-08 (P0) | Secret-like portable inputs are accepted for staging and export: nested `secret` and `passphrase` keys, `aws_secret_access_key`, `.netrc` and `.git-credentials`. | `packages/replication/local.ts:147-152` | `npm test -- tests/campaign-advanced-replication.test.ts -t "REPL-08"` |

### Medium

| ID | Case | Defect | Source | Reproduction |
| --- | --- | --- | --- | --- |
| D-07 | HX-10 (P0) | A reviewed snapshot prepared for Codex can be sent to a Claude installation. `run-start` checks the snapshot's provider, project, conversation, hash and approval, but not the target installation. | `apps/service/service.ts:3374-3386`; dialog text `apps/desktop/main.ts:939-946` | `npm test -- tests/campaign-history-projects.test.ts -t "non-Codex installation"` |
| D-09 | PKG-03 (P0) | If `<userData>/context.sock` is longer than 104 bytes (the macOS socket limit), the vault never unlocks. The app shows `listen EINVAL`, even though the database was already migrated and the context connection is optional. | `packages/workspace/context.ts:151-154`, `:194`; `apps/service/service.ts:565` | `node scripts/campaign-packaged-test.mjs longpath` (needs the packaged app; details in the local, untracked `test-results/agent-testing/2026-10-19-comprehensive/p8-packaged-upgrade/summary.md`) |
| D-10 | HX-10 (P0) | A send that the runtime refuses ("Connect a compatible Codex runtime first.") is still recorded as `handoff.sent`. | `apps/service/service.ts:3389-3404` | `-t "runtime refuses"` in `tests/campaign-history-projects.test.ts` |
| D-11 | CQ-01 (P0) | The macOS firmlink alias `/System/Volumes/Data/private/tmp` passes the check that keeps qualification folders out of `/tmp`. A full Codex qualification ran there. | `packages/providers/qualification.ts:143-150` | `-t "firmlink"` in `tests/campaign-claude-codex-qualification.test.ts` |
| D-12 | MCP-05 (P0) | The companion MCP server gives no reply to malformed JSON (no −32700) and silently drops lines over 16,000 characters, so a client waiting on that ID hangs. | `apps/cli/main.ts:71`, `:171-180` | `-t "MCP-05"` in `tests/campaign-storage-authority-mcp.test.ts` |
| D-13 | TEAM-13 (P1) | `orchestration-message` with `routing: "status"` and no active goal creates a new code goal while still reporting `status`. `auto` routing classifies the same question as a new goal. | `packages/orchestration/engine.ts:724`, `:762` | `tests/campaign-teams-auto.test.ts:1544` |
| D-14 | AUTO-11 (P1) | The active-role-count override accepts 1.5, 1, 2 (below the three required purposes) and 1e9. A stored 1.5 makes every automatic reorganization fail. | `loop-engine.ts:1174`, `:3328`; schema `packages/domain/loop-commands.ts:115` | `tests/campaign-teams-auto-optimizer.test.ts:726`, `:744` |
| D-16 | AUTO-10 (P1) | `rankModels` keys statistics by model ID only, so the same ID on two providers is ranked from whichever records came last. | `adaptation.ts:136` | `tests/campaign-teams-auto-optimizer.test.ts:455` |
| D-17 | HX-09 (P1) | The handoff snapshot never discloses omitted or clipped context. Because the text runs oldest to newest, the 150,000-character total cap drops the newest messages first. The plan for omission reports in `docs/Topsl_Improvement_Plan.md:81` means this could instead be recorded as NOT IMPLEMENTED; it is kept as a defect because newest-first loss is a behaviour, not only a missing label. | `packages/workspace/history.ts:21-44`; dialog `apps/desktop/renderer/main.tsx:1089-1099` | `-t "discloses the omission"` in `tests/campaign-history-projects.test.ts` |

### Low

| ID | Case | Defect | Source | Reproduction |
| --- | --- | --- | --- | --- |
| D-18 | DATA-04 (P0) | A `vault.json` containing `null`, `false` or `0` is overwritten with a new key when no database exists yet. With a database present it is refused safely. | `apps/desktop/vault.ts:59-73` | `-t "falsy JSON"` in `tests/campaign-storage-authority-vault.test.ts` |
| D-20 | CONF-02 (P0) | Configuration preview limits text to 1,000,000 characters, while reading limits files to 1,000,000 bytes. A 1,200,000-byte edit is written whole and then cannot be read back. | `packages/domain/commands.ts:905`; `packages/platform/system.ts:178-185`; `packages/workspace/configuration.ts:90-118` | `-t "1,000,000-byte"` in `tests/campaign-config-usage.test.ts` |
| D-21 | PW-03 (P0) | Specialist ownership refusals never name the offending path. Enforcement itself held in every variant. | `packages/workflows/parallel-specialists.ts:692-699` | `-t "names the exact changed path"` in `tests/campaign-checks-parallel-pw.test.ts` |
| D-22 | PR-13 (P1) | U+061C (Arabic letter mark), the only `Bidi_Control` character missing from the class, is not escaped in approval summaries. | `packages/providers/codex-approvals.ts:7-8` | `-t "Bidi_Control"` in `tests/campaign-apps-providers.test.ts` |
| D-23 | REPL-10 (P1) | Expired replication approval previews are never removed, and each keeps its full portable content inside the encrypted vault. | `packages/replication/local.ts:317-356` | `-t "expired approval previews"` in `tests/campaign-advanced-replication.test.ts` |
| D-25 | TEAM-03 (P0) | An owner-set count of 5 and maxCount of 3 at the same goal-role scope resolves 5 assignments and reports no conflict. The plan and `docs/Coordinator_Feature_Specification.md:96` require the conflict to be explained. Found while strengthening tests after the independent review. | `packages/orchestration/membership.ts:171-183` (count is never compared with maxCount) | `tests/campaign-teams-auto.test.ts:609` |
| D-24 | LOOP-09 / §6.1 | A monitoring `initialSeconds` larger than `maxSeconds` is accepted: the first delay is 3,600 s, then 60 s. | `loop-engine.ts:2016-2020` | `tests/campaign-loops-state.test.ts:631` |

## Disputed by the independent review

The independent review (Phase 9) re-ran each high-severity reproduction and read every other one. It confirmed every defect above (D-25 was found afterwards, while strengthening tests) except these two, which it judges possibly intended. They stay as `test.fails` reproductions. Their case rows remain FAIL against the plan's literal expectation, but the report counts them as open product questions, not confirmed defects, until the owner decides the intended rule.

| ID | Case | Observation | Source and reproduction | Why disputed |
| --- | --- | --- | --- | --- |
| D-15 | AUTO-06 (P1) | A valid contribution to a failed hard iteration ranks a model below the same contribution to a failed easy one: the lower-bound estimate is 0.0718 vs 0.1131, although the averages are 0.48 vs 0.4667. | `packages/orchestration/adaptation.ts:50`, `:78`; `tests/campaign-teams-auto-optimizer.test.ts:196` | Ranking by a conservative lower estimate is documented in the source, and the case asks to reproduce the current rules. |
| D-19 | TASK-01 (P0) | `task-transition` from cancelled to cancelled with a new detail succeeds and records a new revision (2→3) with the new detail; the state does not change. | `packages/domain/workflow.ts:403`; `-t "terminal tasks"` in `tests/campaign-storage-authority.test.ts` | `if (from === to) return;` is a deliberate same-state rule; the earlier revision is kept as `task-revision:2`. Decide whether terminal tasks may take detail updates. |

## Positive capabilities recorded as NOT IMPLEMENTED

- **AD-01 / J-13 (N1):** no enforced isolation route exists in production (`apps/service/service.ts:410`), so independent advanced templates stay unavailable. This is correct gating, not a passed capability.
- **AUTO-08:** there is no cumulative exploration turn budget. The check runs per proposal with `exploratoryTurns: 0` (`loop-engine.ts:3358-3360`).
- **PKG-12, PKG-13:** recovery messages are raw SQLite or `safeStorage` text, with no disk-space or original-key guidance. Restore UX is already listed as remaining in [Implementation status](../Implementation_Status.md).
- **PKG-14:** the uninstall review in [Topsl design](../Topsl_Design.md) §12.9 has no command or UI.

## Documentation contradictions found

The canonical docs below are corrected in this campaign's change set. The correction describes the observed behaviour; it does not decide whether that behaviour is intended.

- **USAGE-12:** README, design and implementation status said owner budgets and quota readings never start, block or stop work. In fact loop child admission waits on an exhausted owner budget or a runtime-reported limit (`apps/service/service.ts:1368-1405`, `loop-engine.ts:3646-3664`). Direct chats are not blocked.
- **OPS-10 / `docs/Recursive_Looping.md`:** four claims conflict with D-01, D-03 and D-04: the header "always shows" Stop, "Stop everything" stops runs, a replayed promotion "settles once", and the rolling history has no stated cap. *Follow-up:* with D-01, D-03 and D-04 fixed, the document now describes the fixed behaviour, the disable policy and the rolling-history compaction.
- **AUTO-09:** `docs/Recursive_Looping.md` says any worse routine experiment is reverted. The code reverts only a routine experiment that falls to a zero success rate.

## Corrections applied

| Change | Why | Verification |
| --- | --- | --- |
| `scripts/test.mjs` removes the eight billing variables (`billingConflicts` list) before launching Vitest | The first clean-checkout run failed 143 of 640 tests only because this agent session exported `ANTHROPIC_BASE_URL`; the product correctly refuses to launch providers then. A Dock launch has no such variable. Tests that need one set it themselves. | Combined gate run with the session's environment intact; see [the report](TEST-REPORT.md#combined-gate) |
| `scripts/live-session.mjs` ported to the Navigator's Atlas navigation, with a matching update to [Live provider sessions](../Live_Provider_Sessions.md) | At `d4b788e` the script still waited for an "Applications" landing screen and clicked removed "Search", "Activity" and "Workspace" buttons, so every route failed before any model turn, including the model-free stand-ins. Checks, dialog policy and pass criteria are unchanged. | All 12 documented stand-in routes pass, and both negative controls still fail with their documented messages |
| `tests/claude-route.test.ts` CL-17/CL-18 portability | Plan §10.2 records Windows CI failures from a Unix mode assertion and a `#!/bin/sh` fixture. POSIX assertions are unchanged. On Windows the test now checks the file's ACL with `Get-Acl` and launches the stand-in through Node. Because the product's account reader launches only a native `.exe`, the Windows path also replaces `readClaudeAccount` with a test double that mirrors its mapping, so the real Windows account read stays untested. | POSIX: 21/21 pass. Windows: unverified until CI runs |
| New campaign tests `tests/campaign-*.test.ts` and harnesses `scripts/campaign-ui-test.mjs`, `scripts/campaign-packaged-test.mjs`, `scripts/campaign-upgrade-profile.mjs` | Cover plan cases that the existing suites did not assert | See the [coverage register](TEST-COVERAGE.md) |

## Follow-up fixes (D-01 to D-05)

*Dated follow-up, 19 October 2026, after the campaign.* D-01 to D-05 were repaired on top of the campaign branch (`5b5b0b4`). The campaign's records above stay as they were found; this section records what changed and how it was verified. Each fix turned its `test.fails` reproductions into plain `test`s, and "recorded fact" tests that pinned the defective behaviour now assert the fixed behaviour.

| ID | Fix | Source |
| --- | --- | --- |
| D-01 | **Disable policy (open question 1, decided):** turning Recursive Looping off pauses every started run that is meant to run, as the owner's Pause does (new generation, wakeups cancelled, child goals paused, open rounds interrupted). `loop-feature-set` does this at once, and every tick repeats it while the flag is off, so no iteration is admitted, no wakeup fires and restart does not auto-resume. Stop and Pause stay available; Resume needs the flag. Turning the flag back on resumes nothing. "Stop everything" therefore stops loop runs with the flag off. The renderer's off view lists unfinished runs with **Stop**. Paused rather than stopped, so turning off an experimental flag never discards a run. | `LoopSupervisor.control`, `holdWhileDisabled`, `tick`, `recover` in `packages/orchestration/loop-engine.ts`; `loop-feature-set` in `apps/service/service.ts`; `StoppableRuns` in `apps/desktop/renderer/components/recursive-loop.tsx` |
| D-02 | A repeated command ID that arrives while the first is still running joins it and shares its outcome. A run's publication and reconciliation steps run one at a time and re-read the run inside that fence, so the second confirmation of a checkpoint is refused as already published. | `receipt` in `packages/orchestration/repository.ts`; `publish`, `reconcilePublication`, `serialPublication` in `loop-engine.ts` |
| D-03 | The promotion (and rejection) transaction sets `settlementPending` on the iteration. Settling the child goal and `finishIteration` clear it; each tick first completes a still-pending settlement of the run's latest iteration. | `settleIteration`, `settleLatest`, `advance`, `finishIteration` in `loop-engine.ts`; `LoopIteration.settlementPending` in `packages/domain/recursive-loops.ts` |
| D-04 | The `.slice(-2000)` cap is replaced by lossless compaction: entries older than 31 days are dropped and adjacent entries merge while their span is at most 1/64 of their age, dated by their latest turn. Turns are never dropped inside a window; a merged turn can be counted slightly late (at most 1/64 of the window), never early. | `compactRecent`, `account` in `loop-engine.ts` |
| D-05 | The usage record and the iteration's turn count are written in one transaction. | `account` in `loop-engine.ts` |

**Observed while fixing D-01, not changed:** the Claude route rejects every cancelled turn (`packages/providers/claude.ts`, "Claude cancellation requested; process exit confirmed."), so the runtime records it as `uncertain` even with process-group absence confirmed. A loop Stop after a Pause, or after the feature is turned off mid-turn, then stays `stopping` until the owner reconciles that turn (`run-reconcile`). This also happens with the flag on; the service Stop test reconciles the turn as the owner would. Whether a confirmed-exit cancellation should be recorded as `interrupted` is a separate Claude-route decision.

**Verification** (darwin-arm64, working tree on `5b5b0b4` with these changes, agent session environment; `scripts/test.mjs` drops the billing variables itself):

- `npm test -- tests/campaign-loops-state.test.ts tests/campaign-loops-state-service.test.ts tests/recursive-loops.test.ts`: 134 passed, 1 expected fail (D-24, LOOP-09, not in scope).
- `npm run check`: `tsc --noEmit` passed; Vitest 82 files passed (3 skipped), 1,102 tests passed, 28 expected fail, 5 skipped; `test:release` 18/18; `build` passed with its existing large-chunk warning. The 28 expected failures are the remaining reproductions; the 9 removed are D-01 (3), D-02 (3), D-03 (1), D-04 (1) and D-05 (1).
- `npm run test:desktop -- scripts/desktop-loop-test.mjs`, with `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` removed: passed in an actual Electron session against the Codex stand-in. A new step turns the feature off while the Endless run monitors, checks the run reaches `paused` and is listed under **Existing runs** with **Stop**, and stops it from there (screenshot `test-results/loop-feature-off-existing-run.png`, local and untracked).

Not covered: packaged builds, Windows and Linux, remote CI, and live providers.

## Open product questions

1. **LOOP-13 disable policy:** should turning Recursive Looping off stop and settle active and monitoring runs, or leave them controllable? The plan requires that Stop never disappears behind an off flag. The current code satisfies neither option. *Decided in the [follow-up](#follow-up-fixes-d-01-to-d-05):* turning it off pauses runs and leaves them controllable (Stop and Pause), without resuming anything when it is turned back on.
2. **CL-14 total turn bound:** a Claude turn that keeps producing valid output or retries has no total deadline, though Stop still ends it. Decide whether a total-duration or retry budget is wanted.
3. **CL-13 stall escalation:** the stall path sends SIGTERM once and never escalates. A turn that ignores it stays unsettled until the user presses Stop.
4. **Membership ceiling:** the role-policy ceiling of 64 holds and 65 is refused. If the product requirement means no fixed ceiling, that is a design gap; the plan's §1.1 notes this.
5. **AD-09 member identity:** the same `memberId` is accepted under two roles, although the schema comment says it is unique within a preset.
6. **Packaging hardening:** Electron fuses are at defaults (RunAsNode on, asar integrity off). Migration backups accumulate without cleanup. One "topsl Safe Storage" keychain item is shared by every build and the owner's real profile.
7. **`Service.command` input validation:** the service trusts its callers; `commandSchema` runs only at the desktop IPC and worker boundaries.
