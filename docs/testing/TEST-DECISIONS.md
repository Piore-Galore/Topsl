# Test decisions and defects — campaign 2026-10-19-comprehensive

Coordinator register of confirmed defects, harness corrections, contract decisions and open product questions found while executing the [comprehensive test plan](TEST-REPORT.md#scope-and-source). Every product defect below has a reproducing test kept as `test.fails` with a `// CAMPAIGN DEFECT <case>` comment. `test.fails` keeps the suite green while the test still runs, and turns red once the defect is fixed, so whoever fixes a defect must also change that test to a plain `test`. No product code was changed in this campaign. Test, harness and documentation changes are listed under [Corrections applied](#corrections-applied).

Source: `d4b788efb17adce0ec6362eeb745f62639767d0e` (product code unchanged), host darwin-arm64. Run each reproduction from the repository root, prefixed with `test-results/agent-testing/2026-10-19-comprehensive/cleanenv.sh`; with the [runner fix](#corrections-applied) the prefix is optional.

## Product defects

Severity is the coordinator's triage. The plan priority (P0/P1) belongs to the case and is listed separately.

### High

| ID | Case (plan priority) | Defect | Source | Reproduction |
| --- | --- | --- | --- | --- |
| D-01 | LOOP-13 (P0) | With Recursive Looping turned off, Pause, Stop and Resume are refused, yet active runs keep running, monitoring wakeups fire and restarts auto-resume. Project-wide **Stop everything** stops the child goal but swallows the loop refusal, and the loop then admits a new iteration and dispatches again. | `packages/orchestration/loop-engine.ts:1343` (`control` → `assertEnabled`, throws at `:289`); `tick()` at `:1793` has no flag check; `stopProject` at `:1590` | `npm test -- tests/campaign-loops-state.test.ts -t "LOOP-13"`; service level: `tests/campaign-loops-state-service.test.ts:345` |
| D-02 | STATE-12 (P0) | Two concurrent publication confirmations write the folder twice. With the same command ID, the receipt check is check-then-run. With two command IDs and the same digest, both pass the "already published" check before either writes, and real Git through the service ends with two receipts. | `packages/persistence/repository.ts:85-125`; concurrent message handling at `apps/service/worker.ts:12` | `tests/campaign-loops-state.test.ts:1509`, `:1532`; `tests/campaign-loops-state-service.test.ts:614` |
| D-03 | STATE-04 (P0) | A crash just after the promotion transaction leaves the promoted child in `awaiting-acceptance`. `finishIteration` never runs, so the iteration gets no outcome records, token totals or reclaim. | `loop-engine.ts:4524-4534` settles the child after the transaction; `advance()` at `:1869-1874` treats the iteration as finished | `tests/campaign-loops-state.test.ts:1135` |
| D-04 | OPS-02 (P0) | The rolling member-turn allowance undercounts once more than 2,000 updates fall inside one window: with 3 turns truly left, below the admission minimum of 4, a due wakeup admits work. | `loop-engine.ts:2157` (`.slice(-2000)`) | `tests/campaign-loops-state.test.ts:996` (control `:982`) |
| D-05 | OPS-02 / §8 usage cursor (P0) | A crash between the usage record write and the iteration turn-count write double-charges: 12 turns recorded for 11 launches. | `loop-engine.ts:2146-2161` (two writes, no transaction) | `tests/campaign-loops-state.test.ts:1043` (control `:1029`) |
| D-06 | BW-21 (P0) | If the managed interrupt rejects during `builder-reviewer-cancel`, the workflow is already saved as `cancelled`. The reader grant stays live and workflow checks are not cancelled, and the command receipt says `failed`. | `packages/workflows/builder-reviewer.ts:2407-2415`; `apps/service/service.ts:2735-2740` | `npm test -- tests/campaign-build-review.test.ts tests/campaign-build-review-service.test.ts -t "failed managed interruption"` |
| D-07 | HX-10 (P0) | A reviewed snapshot prepared for Codex can be sent to a Claude installation. `run-start` checks the snapshot's provider, project, conversation, hash and approval, but not the target installation. | `apps/service/service.ts:3374-3386`; dialog text `apps/desktop/main.ts:939-946` | `npm test -- tests/campaign-history-projects.test.ts -t "non-Codex installation"` |
| D-08 | REPL-08 (P0) | Secret-like portable inputs are accepted for staging and export: nested `secret` and `passphrase` keys, `aws_secret_access_key`, `.netrc` and `.git-credentials`. | `packages/replication/local.ts:147-152` | `npm test -- tests/campaign-advanced-replication.test.ts -t "REPL-08"` |
| D-09 | PKG-03 (P0) | If `<userData>/context.sock` is longer than 104 bytes (the macOS socket limit), the vault never unlocks. The app shows `listen EINVAL`, even though the database was already migrated and the context connection is optional. | `packages/workspace/context.ts:151-154`, `:194`; `apps/service/service.ts:565` | `node scripts/campaign-packaged-test.mjs longpath` (needs the packaged app; see [p8 summary](../../test-results/agent-testing/2026-10-19-comprehensive/p8-packaged-upgrade/summary.md), local evidence only) |

### Medium

| ID | Case | Defect | Source | Reproduction |
| --- | --- | --- | --- | --- |
| D-10 | HX-10 (P0) | A send that the runtime refuses ("Connect a compatible Codex runtime first.") is still recorded as `handoff.sent`. | `apps/service/service.ts:3389-3404` | `-t "runtime refuses"` in `tests/campaign-history-projects.test.ts` |
| D-11 | CQ-01 (P0) | The macOS firmlink alias `/System/Volumes/Data/private/tmp` passes the check that keeps qualification folders out of `/tmp`. A full Codex qualification ran there. | `packages/providers/qualification.ts:143-150` | `-t "firmlink"` in `tests/campaign-claude-codex-qualification.test.ts` |
| D-12 | MCP-05 (P0) | The companion MCP server gives no reply to malformed JSON (no −32700) and silently drops lines over 16,000 characters, so a client waiting on that ID hangs. | `apps/cli/main.ts:71`, `:171-180` | `-t "MCP-05"` in `tests/campaign-storage-authority-mcp.test.ts` |
| D-13 | TEAM-13 (P1) | `orchestration-message` with `routing: "status"` and no active goal creates a new planning goal while still reporting `status`. `auto` routing classifies the same question as a new goal. | `packages/orchestration/engine.ts:724`, `:762` | `tests/campaign-teams-auto.test.ts:1544` |
| D-14 | AUTO-11 (P1) | The active-role-count override accepts 1.5, 1, 2 (below the three required purposes) and 1e9. A stored 1.5 makes every automatic reorganization fail. | `loop-engine.ts:1174`, `:3328`; schema `packages/domain/loop-commands.ts:115` | `tests/campaign-teams-auto-optimizer.test.ts:726`, `:744` |
| D-15 | AUTO-06 (P1) | A valid contribution to a failed hard iteration ranks a model below the same contribution to a failed easy one: the lower-bound estimate is 0.0718 vs 0.1131, although the averages are 0.48 vs 0.4667. | `packages/orchestration/adaptation.ts:50`, `:78` | `tests/campaign-teams-auto-optimizer.test.ts:196` |
| D-16 | AUTO-10 (P1) | `rankModels` keys statistics by model ID only, so the same ID on two providers is ranked from whichever records came last. | `adaptation.ts:136` | `tests/campaign-teams-auto-optimizer.test.ts:455` |
| D-17 | HX-09 (P1) | The handoff snapshot never discloses omitted or clipped context. Because the text runs oldest to newest, the 150,000-character total cap drops the newest messages first. The plan for omission reports in `docs/Topsl_Improvement_Plan.md:81` means this could instead be recorded as NOT IMPLEMENTED; it is kept as a defect because newest-first loss is a behaviour, not only a missing label. | `packages/workspace/history.ts:21-44`; dialog `apps/desktop/renderer/main.tsx:1089-1099` | `-t "discloses the omission"` in `tests/campaign-history-projects.test.ts` |

### Low

| ID | Case | Defect | Source | Reproduction |
| --- | --- | --- | --- | --- |
| D-18 | DATA-04 (P0) | A `vault.json` containing `null`, `false` or `0` is overwritten with a new key when no database exists yet. With a database present it is refused safely. | `apps/desktop/vault.ts:59-73` | `-t "falsy JSON"` in `tests/campaign-storage-authority-vault.test.ts` |
| D-19 | TASK-01 (P0) | `task-transition` from cancelled to cancelled with a new detail succeeds and rewrites the terminal task (revision 2→3). | `packages/domain/workflow.ts:403` | `-t "terminal tasks"` in `tests/campaign-storage-authority.test.ts` |
| D-20 | CONF-02 (P0) | Configuration preview limits text to 1,000,000 characters, while reading limits files to 1,000,000 bytes. A 1,200,000-byte edit is written whole and then cannot be read back. | `packages/domain/commands.ts:905`; `packages/platform/system.ts:178-185`; `packages/workspace/configuration.ts:90-118` | `-t "1,000,000-byte"` in `tests/campaign-config-usage.test.ts` |
| D-21 | PW-03 (P0) | Specialist ownership refusals never name the offending path. Enforcement itself held in every variant. | `packages/workflows/parallel-specialists.ts:692-699` | `-t "names the exact changed path"` in `tests/campaign-checks-parallel-pw.test.ts` |
| D-22 | PR-13 (P1) | U+061C (Arabic letter mark), the only `Bidi_Control` character missing from the class, is not escaped in approval summaries. | `packages/providers/codex-approvals.ts:7-8` | `-t "Bidi_Control"` in `tests/campaign-apps-providers.test.ts` |
| D-23 | REPL-10 (P1) | Expired replication approval previews are never removed, and each keeps its full portable content inside the encrypted vault. | `packages/replication/local.ts:317-356` | `-t "expired approval previews"` in `tests/campaign-advanced-replication.test.ts` |
| D-24 | LOOP-09 / §6.1 | A monitoring `initialSeconds` larger than `maxSeconds` is accepted: the first delay is 3,600 s, then 60 s. | `loop-engine.ts:2016-2020` | `tests/campaign-loops-state.test.ts:631` |

## Positive capabilities recorded as NOT IMPLEMENTED

- **AD-01 / J-13 (N1):** no enforced isolation route exists in production (`apps/service/service.ts:410`), so independent advanced templates stay unavailable. This is correct gating, not a passed capability.
- **AUTO-08:** there is no cumulative exploration turn budget. The check runs per proposal with `exploratoryTurns: 0` (`loop-engine.ts:3358-3360`).
- **PKG-12, PKG-13:** recovery messages are raw SQLite or `safeStorage` text, with no disk-space or original-key guidance. Restore UX is already listed as remaining in [Implementation status](../Implementation_Status.md).
- **PKG-14:** the uninstall review in [Topsl design](../Topsl_Design.md) §12.9 has no command or UI.

## Documentation contradictions found

The canonical docs below are corrected in this campaign's change set. The correction describes the observed behaviour; it does not decide whether that behaviour is intended.

- **USAGE-12:** README, design and implementation status said owner budgets and quota readings never start, block or stop work. In fact loop child admission waits on an exhausted owner budget or a runtime-reported limit (`apps/service/service.ts:1368-1405`, `loop-engine.ts:3646-3664`). Direct chats are not blocked.
- **OPS-10 / `docs/Recursive_Looping.md`:** four claims conflict with D-01, D-03 and D-04: the header "always shows" Stop, "Stop everything" stops runs, a replayed promotion "settles once", and the rolling history has no stated cap.
- **AUTO-09:** `docs/Recursive_Looping.md` says any worse routine experiment is reverted. The code reverts only a routine experiment that falls to a zero success rate.

## Corrections applied

| Change | Why | Verification |
| --- | --- | --- |
| `scripts/test.mjs` removes the eight billing variables (`billingConflicts` list) before launching Vitest | The first clean-checkout run failed 143 of 640 tests only because this agent session exported `ANTHROPIC_BASE_URL`; the product correctly refuses to launch providers then. A Dock launch has no such variable. Tests that need one set it themselves. | Combined gate run with the session's environment intact; see [the report](TEST-REPORT.md#combined-gate) |
| `scripts/live-session.mjs` ported to the Navigator's Atlas navigation, with a matching update to [Live provider sessions](../Live_Provider_Sessions.md) | At `d4b788e` the script still waited for an "Applications" landing screen and clicked removed "Search", "Activity" and "Workspace" buttons, so every route failed before any model turn, including the model-free stand-ins. Checks, dialog policy and pass criteria are unchanged. | All 12 documented stand-in routes pass, and both negative controls still fail with their documented messages |
| `tests/claude-route.test.ts` CL-17/CL-18 portability | Plan §10.2 records Windows CI failures from a Unix mode assertion and a `#!/bin/sh` fixture. POSIX assertions are unchanged. On Windows the test now checks the file's ACL with `Get-Acl` and launches the stand-in through Node. | POSIX: 21/21 pass. Windows: unverified until CI runs |
| New campaign tests `tests/campaign-*.test.ts` and harnesses `scripts/campaign-ui-test.mjs`, `scripts/campaign-packaged-test.mjs`, `scripts/campaign-upgrade-profile.mjs` | Cover plan cases that the existing suites did not assert | See the [coverage register](TEST-COVERAGE.md) |

## Open product questions

1. **LOOP-13 disable policy:** should turning Recursive Looping off stop and settle active and monitoring runs, or leave them controllable? The plan requires that Stop never disappears behind an off flag. The current code satisfies neither option.
2. **CL-14 total turn bound:** a Claude turn that keeps producing valid output or retries has no total deadline, though Stop still ends it. Decide whether a total-duration or retry budget is wanted.
3. **CL-13 stall escalation:** the stall path sends SIGTERM once and never escalates. A turn that ignores it stays unsettled until the user presses Stop.
4. **Membership ceiling:** the role-policy ceiling of 64 holds and 65 is refused. If the product requirement means no fixed ceiling, that is a design gap; the plan's §1.1 notes this.
5. **AD-09 member identity:** the same `memberId` is accepted under two roles, although the schema comment says it is unique within a preset.
6. **Packaging hardening:** Electron fuses are at defaults (RunAsNode on, asar integrity off). Migration backups accumulate without cleanup. One "topsl Safe Storage" keychain item is shared by every build and the owner's real profile.
7. **`Service.command` input validation:** the service trusts its callers; `commandSchema` runs only at the desktop IPC and worker boundaries.
