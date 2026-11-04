# Comprehensive campaign report — 4 November 2026

Report of the campaign the [plan](PLAN.md) describes: an audit of Topsl's current source on this Apple silicon Mac, with automated tests, hands-on Electron inspection, live Codex and Claude Code runs, recovery and load checks and the macOS package, and repair of what it found. Companion records: the [coverage register](COVERAGE.md) (every scenario with its evidence and result) and the [evidence index](EVIDENCE.md).

## Verdict

**Not comprehensive acceptance, and no release qualification.** Every P0 and P1 finding was fixed and its reproduction passes; the automated gate, the Electron journeys, the campaign journeys, the packaged checks and a repeated 60-minute soak pass on the final source. But core live journeys are blocked or failed, two P2 findings need the owner's decision, and several cells were not run.

- **Repaired and verified:** 3 P1 and 12 P2 findings, among them a keyboard trap in the native terminal, sessions stuck after a restart or a failed Claude launch, duplicate sessions from a double-click, an interrupt that never ended, accepting a candidate unseen, and IME submission (see [Findings](#findings)). No P0 was found.
- **Passed live** (50 of 80 turns): both CLIs qualified; a mixed Codex and Claude session from discussion through accepted work and a published loop, with Claude at high effort; a Claude Code terminal → Codex chat handoff.
- **Blocked or failed live:** Codex/Codex and Claude/Claude build and review need owner answers; Claude/Codex failed twice at Codex's reader probe (C-4); Codex/Claude was not run.
- **Open:** C-4 and C-5 (owner decisions), 9 P2/P3 findings deferred or partly fixed, and the gaps under [Not established](#not-established).
- **Follow-up, same day:** the owner decided C-4 and C-5, both were repaired, and all four build-and-review pairings then passed live to acceptance, at 35 of a further 40 turns. See [Follow-up: live retry](#follow-up-live-retry-4-november-2026). The verdict above stands: this is still not comprehensive acceptance.

## Scope and source

| Item | Value |
| --- | --- |
| Starting source | `1f6ac80` on `claude/windows-qualification` plus that day's uncommitted provider fixes, committed as `b2e9568`, then merged with `main` (PR #42 Claude usage on Windows, PR #44 watch mode) as `5d39db1`. Every worker started from `5d39db1`. |
| Final source | `e12a6d3` (all product changes; only documentation and one harness fix followed). The campaign commits on top of `5d39db1`: `fe5ee02`, `6544166`, `6bcee55`, `e12a6d3`, plus the merged worker branches. |
| Host | macOS 27.0.1 (26A434), Apple M5, 10 cores, 32 GiB; Node v26.0.0; npm 11.12.1; Electron 44.4.5 |
| Native runtimes | Codex CLI 0.163.0 and Claude Code 2.1.305, both from `/opt/homebrew/bin`, signed in (ChatGPT; claude.ai Max). Claude Code 2.1.309, bundled with the Claude desktop app, was read with `--help` only. |
| Environment | Every npm, node and Electron command ran through `cleanenv.sh` (`env -i` with `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `TERM`), because the agent shell exports `ANTHROPIC_*` and `CLAUDE_CODE_*` variables that Topsl correctly refuses. Qualification folders sat under `node_modules/.cache`, outside the temporary directories the sandbox probes refuse. |
| Out of scope (plan) | Windows, Linux, Intel Mac, remote CI and release publication. CI ran only after the campaign, on the pull request. |

## How it ran

The coordinator (this session) merged `main`, recorded the environment, built the live turn budget and ran the live journeys, the packaged build and the final gate, and repaired the defects. Four workers ran in parallel, each in its own git worktree so their builds could not disturb another's Electron runs:

| Worker | Task | Output |
| --- | --- | --- |
| W1 | Port the auxiliary harnesses (`campaign-ui-test.mjs`, `campaign-packaged-test.mjs`, `campaign-upgrade-profile.mjs`, `round2-ui-test.mjs`) to the session-first screens and the 0.1.3 package, run them, build and verify a package | Branch merged as `5bd8cb3`; 3 P3 findings |
| W2 | Build the coverage register by static mapping | [COVERAGE.md](COVERAGE.md) |
| W3 | Inspect every destination, pane and dialog in Electron: themes, sizes, zoom, states, keyboard, IME, contrast, a first-run walkthrough | `scripts/campaign-inspection.mjs`, merged as `db76f94`; 24 findings |
| W4 | Recovery fault injection, load benchmarks and a 60-minute soak | `scripts/campaign-soak.mjs`, `campaign-recovery-desktop.mjs`, `campaign-harness.mjs` and `tests/fixtures/codex-soak.cjs`, merged as `7d2c4a5`; 6 findings |

## Results

### Automated gate

The final gate ran on `e12a6d3` from 03:20 to 03:47 local time on 4 November 2026, in the clean environment, with no other agent running. Summary: [evidence/final-gate.json](evidence/final-gate.json).

| Step | Result |
| --- | --- |
| `npm run check` | Passed: TypeScript; Vitest **1,218 passed, 5 skipped** (90 files: 88 passed, 2 skipped; the skips are opt-in benchmarks and live checks); 18 of 18 release checks; the build |
| `npm run test:desktop` (7 scripts) | Passed: the main journey with its encrypted restart, and the coordinator, Atlas, loop, session, Claude usage and Providers journeys |
| `node scripts/campaign-isolation-test.mjs` | Passed: no Node in the renderer; the preload exposes only `command` and `subscribe`; sandbox, context isolation and web security on; window.open, navigation, string code and network blocked; permissions refused; an unknown command rejected; hostile HTML, a script URL, terminal escapes and bidirectional controls shown as text ([capture](evidence/hostile-text.png)) |
| `node scripts/campaign-repairs-test.mjs` | Passed: 12 of 12 repaired findings ([results](evidence/repairs-results.json), [terminal capture](evidence/terminal-leave.png)) |
| `npm run test:desktop -- scripts/campaign-ui-test.mjs` | Passed: 33 steps, 7 retired with their replacements checked, no known defect left |
| `node scripts/round2-ui-test.mjs` | Passed: interaction latency p95 131 ms (target 250 ms) |
| `node scripts/campaign-recovery-desktop.mjs --case all` | 8 of 9 cases passed. `service-kill` failed one check, "the window says the control service stopped": the banner was shown, but the freshness note repeated its words and the harness's strict locator refused two matches. With `.first()` (harness defect, fixed) the case passed twice in a row. |
| `node scripts/campaign-turn-budget.mjs self-test` | Passed ([results](evidence/turn-budget-self-test.json)) |

### Electron journeys

Default suite and campaign journeys: see [Automated gate](#automated-gate). Earlier in the campaign, on `5d39db1`, W1 ran `campaign-ui-test.mjs` (33 passed, 7 retired, 3 known defects: W1-1 to W1-3), `round2-ui-test.mjs` and `desktop-usage-test.mjs`, all passing after harness fixes. The Providers journey joined `npm run test:desktop`'s default list.

### Live providers

The live budget was enforced, not estimated. [`scripts/campaign-turn-budget.mjs`](../../../scripts/campaign-turn-budget.mjs) wraps each CLI in [`campaign-turn-proxy.mjs`](../../../scripts/campaign-turn-proxy.mjs), which records every model turn in one ledger and refuses any past the cap before it reaches the provider. For Codex that means each JSON-RPC `turn/start`; for Claude Code, each `--print` run and each interactive terminal session. Its stand-in self-test passed before any live run: the ledger held exactly the turns Topsl and the stand-ins reported (Codex qualification 3, Claude 4, a two-coordinator intake 3), recorded the Claude coordinator's effort, and with the cap one turn above the count let exactly one more through and refused the rest. That self-test also found defect C-1 below.

Turns used: **50 of 80** (Codex 29 with `gpt-6.1-sol`; Claude Code 19 structured turns with `claude-opus-5-5`, 6 of them at `--effort high`, plus 2 terminal rounds). None was refused. All ran between 01:43 and 02:09 local time on 4 November 2026.

| Journey (script) | Turns | Result |
| --- | ---: | --- |
| Mixed session, first attempt (`live-loop.mjs --session`, Codex and Claude coordinators, Claude at high effort) | 7 | **Failed, cause not established.** Both qualifications spent their turns, then the Codex coordinator was "not qualified for coordinator-contribution", so both messages failed. The harness was stopped before it wrote its report, so the qualification result is lost. The harness now logs each qualification as it happens. |
| Diagnostic: one Codex qualification through the wrapper | 3 | Recorded as current: structured turn, sandbox (read-only, workspace-write), interrupt, lifecycle and fresh session passed; the candidate reader failed (Codex read the marker but did not quote it). The wrapper does not break qualification. |
| Mixed session, second attempt | 27 | **Passed.** Codex (3 turns) and Claude (4 turns) qualified with every probe passing. A Discuss message was answered by both coordinators without starting work. A Work message became a goal on the automatic team (Codex implementer and reviewer); it was reviewed with no findings, accepted, and a loop in the session then started from it, satisfied its goal on checkpoint 1 and published `value.ts` to the folder. Claude Code received `--effort high` on all 6 of its coordinator turns. |
| Build and review, Codex/Codex (`live-session.mjs --workflow codex-codex`) | 4 | **Blocked: owner answers required.** Codex's build asked to run two commands, one of which reads `~/.codex/memories/MEMORY.md` in the owner's home, outside the scratch project. Topsl showed both as approval cards with its warning that Codex 0.163.0 may run an approved command outside its sandbox. The harness leaves these answers to the owner, and the campaign did not answer them or turn on auto-accept. |
| Build and review, Claude/Codex | 6 (two attempts) | **Failed at qualification, twice.** A Codex reviewer needs the candidate reader, and in both attempts Codex read the marker without quoting it. |
| Build and review, Claude/Claude | 1 | **Blocked: owner answer required.** Claude Code, building in Accept edits, asked to run `cat > src/order.mjs …; npm run check` in the scratch project. Left to the owner. |
| Build and review, Codex/Claude | 0 | **Not run:** its Codex build would ask for the same owner answers as Codex/Codex. |
| Claude Code terminal → import → Codex chat handoff (`live-session.mjs --claude --codex`) | 2 | **Passed.** Claude Code answered in Topsl's native terminal; its transcript was imported through Settings → Imports and handed to a structured Codex chat, which answered with the expected sum. |

Codex's candidate reader passed in 1 of 4 live qualifications today (October: 2 of 4), so a Codex reviewer cannot be qualified reliably (finding C-4).

### Interface inspection

W3 visited 404 views over 4 phases with Codex and Claude stand-ins: every destination; Paper, Night and System (following an emulated appearance change); 1280×880, 1024×768, 900 and 899 px, 560×720, and 150% and 200% zoom; empty, populated, loading, blocked, failed and completed states; and content stress. Automated checks found no horizontal page overflow, no text-contrast failure and no unnamed control. Every Tab stop but one showed a visible focus change, the command palette, drawer, handoff and configuration dialogs trapped focus and returned it, IME Enter submitted nothing in 8 fields, and no renderer error was logged. VoiceOver cannot be driven from Playwright and was not run (limitation, below). Findings W3-1 to W3-24 are in the register below.

### Recovery, load and soak

W4 ran these on `5d39db1`, with other agents loading the machine (load average about 11 on 10 cores):

| Check | Result |
| --- | --- |
| 100,000-message history benchmark in `scripts/desktop-test.mjs` | Passed: history IPC p95 1.10 ms (store), UI interaction p95 50 ms, import 5.6–6.1 s per 25,000-message file, service working set 113 → 238 MB (peak 431 MB) |
| `node scripts/lifecycle-stress.mjs --iterations 20 --seed campaign-2026-11-04-01` | Passed: 20 of 20 iterations, 35 tests each |
| `node scripts/round2-acceptance.mjs --stress` | 6 of 6 tests passed; the runner then crashed with EISDIR on a symlinked `node_modules` (harness defect, fixed); rerun passed: 10,018 files (109 MB) captured in 21.3 s |
| `TOPSL_BENCHMARK=1 npm test -- tests/coordination-benchmark.test.ts` | Passed: ingest 28.0 s, history query p95 12.3 ms, commit p95 8.7 ms |
| `TOPSL_LOOP_SOAK=1 npm test -- tests/campaign-loops-state.test.ts -t OPS-06` (1,000 loop boundaries) | Passed: 1,001 boundaries in 361 s; the last 100 took about 12 times as long as the first 100, as the test's comment expects from retained history |
| `node scripts/campaign-soak.mjs --minutes 60` | 60.1 minutes, 180 cycles (60 Discuss sessions, 60 Work sessions accepted, 60 streamed chats), 0 failed steps. Main process RSS 200 → 205 MB with a flat heap; renderer heap 7.2 → 43.5 MB, 13.8 MB after a forced collection; control service 113 → 201 MB, flat after minute 12; 5 Electron processes throughout; at most 2 stand-ins at once; quit in 247 ms with no process left. Navigation p95 stayed 50–137 ms, but the project-wide `orchestration-query` grew from 5 ms to 1.2 s and New chat, first streamed text and reopening from All sessions slowed 2 to 5 times (W4-6). |
| `node scripts/campaign-recovery-desktop.mjs --case all` with 7 cited test files (119 tests) | Disconnect mid-turn, malformed and wrong-shape output passed. Stall, service termination, restart and double submission failed in part (W4-1 to W4-4). |

After the repairs, `campaign-recovery-desktop.mjs --case all` was rerun on the final source: see [Automated gate](#automated-gate).

**Soak repeated on the final source.** After the gate, from 03:49 to 04:50 local time, the soak ran again on `c4d7325`, the product source of `e12a6d3` (only documentation and the recovery harness fix followed), in the clean environment with no other agent or Electron instance running (load average about 6): `cleanenv.sh node scripts/campaign-soak.mjs --minutes 60 --out test-results/agent-testing/2026-11-04-comprehensive/final/soak-60min`, exit 0. Summary: [evidence/final-soak-summary.json](evidence/final-soak-summary.json).

| Measure | W4, `5d39db1`, load about 11 | Final, `c4d7325`, load about 6 |
| --- | --- | --- |
| Duration, cycles, failed steps | 60.1 min, 180, 0 | 60.1 min, 180, 0 |
| Main process | RSS 200 → 205 MB, heap flat | RSS 200 → 244 MB; heap 8–21 MB throughout and 10 MB at the end, so the rise is outside the JavaScript heap (not investigated further) |
| Renderer JS heap | 7.2 → 43.5 MB; 13.8 MB after a forced collection | 7.2 → 28.9 MB (peak 45.5); 11.5 MB after a forced collection |
| Control service working set | 113 → 201 MB | 113 → 214 MB, flat after minute 18 |
| Processes | 5 Electron throughout; at most 2 stand-ins; quit in 247 ms, nothing left | 5 Electron throughout; at most 1 stand-in; quit in 220 ms, nothing left |
| Navigation p95 | 50–137 ms | 36–113 ms |
| `orchestration-query`, full project view (store) | 5 ms → 1.2 s | 5 ms → 0.94 s (p95 0.84 s) |
| `history-page` / `session-list` p95 (store) | 1.8 s / 757 ms | 87 ms / 26 ms |
| New chat p50, first / second half | 70 / 837 ms | 59 / 74 ms |
| First streamed text p50, first / second half | 378 / 828 ms | 322 / 815 ms |
| Reopen from All sessions p95 | 1,062 ms | 239 ms |
| Click to reply (Discuss) and to goal card (Work), p50 / p95 | 2.2 / 4.7 s and 2.2 / 3.7 s | 1.9 / 2.0 s and 1.9 / 2.0 s |

New chat, reopening from All sessions and the store's history and session-list reads no longer slowed over the run. The lower load may account for part of that; the two causes were not separated. The full project view still grows, and first streamed text still more than doubles in the second half, so W4-6 remains partly fixed. The summary's `session:*` p50, measured from the session heading rather than the click, rose from 1.3 to 1.8 s. Comparing medians suggests the heading now appears sooner after the click, since the click-relative times fell.

### Package

| Step | Result |
| --- | --- |
| `npm run package -- --mac --arm64` on `e12a6d3` | `release/Topsl-0.1.3-mac-arm64.zip`, 146,332,912 bytes, SHA-256 `4ae8080944bc713238fff0e53c492cd661c05974e8f488f96dc9663163d2347d`; ad-hoc signed (no Team ID) |
| `npm run verify:mac-package` | Signature and topsail icon verified |
| `node scripts/campaign-packaged-test.mjs` identity, native, upgrade-v013, vaultfaults | 24/24, 33/33, 40/40 and 8/8 passed: startup and reopen, native SQLite and PTY modules and a terminal, an upgrade from a 0.1.3 profile made by the tagged release, and vault faults |
| Same harness, an earlier package (02:38, from `db76f94` plus the then-uncommitted terminal and Providers copy fixes) | longpath 3/3, removal 2/2, upgrade-v012 38/38, faults 5 passed and 1 blocked (disk image), restore 2 passed and 1 blocked (v0.1.1 fixture) |
| `TOPSL_PACKAGED_APP=release node scripts/desktop-session-test.mjs` | Passed, against the extracted app, with the new pre-qualification and custom-role checks |

## Findings

Severity: **P0** data loss or unintended execution; **P1** broken core workflow or inaccessible control; **P2** a defect that misleads or impedes use; **P3** polish. C- findings are the coordinator's; W*n*- findings are the workers'. Every repaired finding has a reproduction that now passes.

| ID | Sev. | Area | Finding | Status | Repair and verification |
| --- | --- | --- | --- | --- | --- |
| C-1 | P1 | Sessions, Claude | A Claude Code run that exited with an error before it reported a session (a launch failure, bad flag or refused turn) was recorded as an unknown outcome, so the session coordinator stayed "running" for good and the message never settled. Found by the turn-budget self-test. | **Fixed** (`fe5ee02`) | Claude Code reports its session before any model call, so such a run is now a known failure the coordinator retries or gives up on. `tests/claude-route.test.ts` (fails before a session → failed; fails after one → still unknown); the self-test's capped intake now settles with the other coordinator's answer. |
| C-2 | P2 | Sessions | A coordinator turn with a genuinely unknown outcome left the session "answering" with no way to reconcile from the session. | **Fixed** (`fe5ee02`) | The pending answer names the coordinator, says the outcome is unknown and offers **Inspect & reconcile**; nothing retries until then. `tests/native-sessions.test.ts`. |
| C-3 | P2 | Live harnesses | `live-loop.mjs` waited for the status footer removed on 30 October, and `live-session.mjs` used retired controls (+ Add project, the History import, the imported conversation's title), so every live run would have failed before its first turn. | **Fixed** | Ported; the mixed session and the handoff then passed live. |
| C-4 | P2 | Providers, live | Codex 0.163.0 fails the candidate-reader probe in most live qualifications (3 of 4 today): it reads the marker through Topsl's reader but does not quote it, so a Codex **reviewer** cannot be qualified reliably. Coordinators and implementers are unaffected. | **Fixed** (follow-up) | Not model inconsistency: Codex calls dynamic tools from a script and guessed an MCP-shaped result that Topsl's answer does not have. The tool descriptions now say what each answer holds. `tests/candidate-tools.test.ts`; the reader then passed in 6 of 6 live qualifications ([follow-up](#follow-up-live-retry-4-november-2026)). |
| C-5 | P2 | Providers, live | With the owner's Codex configuration, a Codex build in a scratch project asked to read `~/.codex/memories/MEMORY.md` in the owner's home. Topsl showed it as an approval card with its sandbox warning, and it was not approved. | **Fixed** (follow-up) | The owner chose memories off for Topsl's Codex: Topsl starts `codex app-server` with Codex memories off for reading and writing. `tests/campaign-claude-codex-qualification.test.ts` (C-5); live, no Codex build asked for its memories again ([follow-up](#follow-up-live-retry-4-november-2026)). |
| C-6 | P3 | Live | In the first mixed-session attempt the Codex route was "not qualified" after its qualification had spent 3 turns. The report was lost when the stalled run was stopped. | **Not reproduced** | 3 later live Codex qualifications recorded. `live-loop.mjs` now logs each qualification immediately and keeps the profile when asked. |
| W1-1 | P3 | Advanced workflows | Activity showed the same stale-snapshot banner twice (page and Parallel integration). | **Fixed** | Parallel integration shows only its own read failures there. `campaign-ui-test.mjs` UI-10 asserts one banner. |
| W1-2 | P3 | Feedback | A pending operation was announced with its internal command name ("conversation add…"). | **Fixed** | Plain labels ("Creating the chat…"). `campaign-ui-test.mjs` UI-11; `campaign-repairs-test.mjs` W1-2. |
| W1-3 | P3 | Persistence | A brand-new profile wrote four encrypted migration backups of its empty database. | **Fixed** | A database created by this open skips its migrations' backups; upgrades still back up. `tests/store.test.ts`; `campaign-ui-test.mjs` UI-01. |
| W3-1 | P1 | Provider tools | Keyboard trap: once focus entered the native terminal, no key moved it out. | **Fixed** | Escape (still sent to the program) then Tab or Shift+Tab leaves the terminal; the panel says so. `campaign-repairs-test.mjs` W3-1. |
| W3-2 | P2 | New session | Cmd+Enter during an IME composition started a session with the uncommitted text. | **Fixed** | Ignored while composing. `campaign-repairs-test.mjs` W3-2 (CDP composition; no real macOS input method). |
| W3-3 | P2 | Sessions | Review changes showed only a candidate ID, and the acceptance dialog listed no files, so a candidate was accepted unseen. | **Fixed** (file list) | Results → Changes and the acceptance confirmation list each changed file with added/modified/deleted. `tests/orchestration-service.test.ts`. File contents are still shown only on Apply. |
| W3-4 | P2 | Providers | A failed qualification read showed "Not read" and wrongly claimed Codex reported no models. | **Fixed** | Says the read failed, keeps the last state, offers a retry. `campaign-repairs-test.mjs` W3-4. |
| W3-5 | P2 | Dialogs | A dialog opened by a slow command returned focus to `<body>`. | **Fixed** | Focus returns to the control that started the command. `campaign-repairs-test.mjs` W3-5. |
| W3-6 | P2 | Sessions | Side panes: no focus move on open, Escape did nothing, Close dropped focus. | **Fixed** | Opening focuses the pane heading, Escape closes, focus returns to the toggle. `campaign-repairs-test.mjs` W3-6. The overlay below 1200 px still covers the header toggles (deferred). |
| W3-7 | P2 | Settings | Theme choices exposed the selection only by colour. | **Fixed** | `aria-pressed` (the other Settings choices already had it). `campaign-repairs-test.mjs` W3-7. |
| W3-8 | P2 | Sidebar | Session titles were cut mid-letter, and attention labels squeezed them to about 8 characters. | **Fixed** | Ellipsis, a 45% cap on the label, full text on hover. `campaign-repairs-test.mjs` W3-8. |
| W3-9 | P2 | Sessions | A session blocked by no qualified provider named internal IDs, offered Open Team, and New session claimed the session would wait. | **Fixed** | Plain wording, **Open Providers**, and New session says a message sent now is not answered. `campaign-repairs-test.mjs` W3-9. |
| W3-10 | P2 | Sessions | A failed required check was a dead end: no output and no way forward. | **Partly fixed** | The goal says a check failed and how to move on (stop, then send the fix as Work). The check's output and exit code are still not shown (deferred: the goal view has no link to its check run). |
| W3-11 | P2 | Provider tools | Long messages looked truncated (fixed 236 px rows, hidden inner scroller); import metadata showed as "REFERENCE {json}". | **Partly fixed** | Imported non-message text is labelled. Fixed-height rows remain (deferred: they are the 100,000-message virtualization). |
| W3-12 | P3 | Sessions | At 560×720 and 1024×768 the sticky composer covers a pending decision. | Deferred | |
| W3-13 | P3 | Shell | Between 900 and 1100 px the top bar was empty. | **Fixed** | The breadcrumb shows down to 900 px. `campaign-repairs-test.mjs` W3-13. |
| W3-14 | P3 | Sessions | Title truncation split an emoji. | **Fixed** | By code point. `tests/coordinator-threads.test.ts`. |
| W3-15 | P3 | All sessions | Long unbroken titles ran under the badges. | **Fixed** | Wrapping; not re-inspected. |
| W3-16 | P3 | Sessions, loops | State labels lag or disagree (sidebar, header badge, loop badges, loop breadcrumb). | Partly fixed | An ended goal is no longer the composer's target; the rest deferred. |
| W3-17 | P3 | Loops | A loop's page listed other loops' requests. | **Fixed** | Loop requests name their run. `tests/session-loops.test.ts`. Requests recorded earlier still show on every loop of their session. |
| W3-18 | P3 | Sessions | Pause/Stop shown on idle or stopped sessions; an accepted goal stayed the composer target. | **Fixed** | `campaign-repairs-test.mjs` W3-18. |
| W3-19 | P3 | First run | Guidance gaps on Providers and after qualifying. | Partly fixed | A trust hint and "Next: start work with + New session"; Download stays primary on a fresh Providers page (deferred). |
| W3-20 | P3 | Copy | Jargon and raw data in copy. | Partly fixed | Plain compatibility badge; Connect / test summarizes. Capability IDs and route names remain (deferred). |
| W3-21 | P3 | Providers | The lifecycle review printed a literal "\n". | **Fixed** | Not re-inspected. |
| W3-22 | P3 | Reads | Failed reads were shown poorly (All sessions stuck loading, Imports without retry, session and loop pages). | **Fixed** | `campaign-repairs-test.mjs` W3-22 (All sessions); the other three not re-run. |
| W3-23 | P3 | Palette | The command palette has no search field. | Deferred | A feature. |
| W3-24 | P3 | Layout | Minor layout issues at 560 px. | Deferred | |
| W4-1 | P1 | Sessions, recovery | After a restart or a service crash while a coordinator answered, the session said "Answering…" for good, Stop session failed with "This run is not active in Topsl", and reconciling from Provider tools did not unstick it. | **Fixed** (`fe5ee02`, `6bcee55`, `e12a6d3`) | Stop goes ahead when the interrupt cannot be delivered; the uncertain coordinator is shown with **Inspect & reconcile**, and the pending answer says it waits for the owner. `tests/native-sessions.test.ts`; `campaign-recovery-desktop.mjs` restart, service-kill and restart-reconcile-first. |
| W4-2 | P2 | Sessions | Double-clicking Start session or Send created two sessions or two messages, each with its own coordinator turns. | **Fixed** (`6bcee55`) | One submission at a time. `campaign-recovery-desktop.mjs` double; `campaign-repairs-test.mjs` W3-9. |
| W4-3 | P2 | Runtime | A turn that acknowledged an interrupt but never ended stayed "running" with the writer lease until Topsl quit. | **Fixed** (`6bcee55`) | Topsl stops the process 30 s after its interrupt ([design §18.6](../../Topsl_Design.md)). `campaign-recovery-desktop.mjs` stall (stand-in; real Codex behaviour not established). |
| W4-4 | P3 | Goals, recovery | After a restart mid-goal the goal said "1 coordinators preparing" with no sign of the uncertain run. | **Fixed** (`6bcee55`) | The goal card names the member and offers **Inspect & reconcile**. `tests/native-sessions.test.ts`; `campaign-recovery-desktop.mjs` restart-goal. |
| W4-5 | P3 | Provider tools | While any member turn ran, chats were refused with "Coordinator/provider concurrency budget is full…". | **Fixed** (wording) | The refusal says what to do; nothing is queued, by design. |
| W4-6 | P3 | Performance | Store and UI slowdown as a project grows: `orchestration-query` 5 ms → 1.2 s over 120 sessions and 60 goals. | **Partly fixed** (`e12a6d3`) | New session and Project settings, which re-read after every change, now request only what they use (`setup: true`). The full view's growth (per-conversation message and per-goal assignment scans) remains, not profiled. Re-measured in the [final soak](#recovery-load-and-soak): `orchestration-query` 5 ms → 0.94 s and first streamed text still slows; New chat, reopening and the `history-page` and `session-list` spikes did not recur, at a lower machine load. |

## Coverage

The [coverage register](COVERAGE.md) maps 200 scenarios across the plan's eight areas, plus 206 commands and the October campaign's 359 cases (324 still apply, 11 in narrowed form, 24 retired). After execution:

| Outcome | Scenarios |
| --- | ---: |
| Passed | 166 |
| Failed, then fixed and passed | 24 (23 before the follow-up) |
| Failed, open | 0 (1 before the follow-up: ADV-18, live build and review) |
| Blocked | 2 (STA-13 disk-full fault, STA-23 schema-1 restore) |
| Not run | 5 (PRV-02 discovery on a real host, PRV-23 host-changing install or update, PRV-28 live Codex allowance and Claude `/usage` reads, NAV-09 project filter narrowing, SET-10 written configuration versus what the provider loaded) |
| Retired | 3 |

82 of the 190 passed rows are `partial` (81 of 189 before the follow-up): they passed what exists, and the register names what is still unasserted. 37 commands have no test that sends them, and 62 have no sender in the interface; the register lists both. The campaign raised 5 rows from `gap` to `covered` and 11 from `gap` to `partial`, and the follow-up raised ADV-18 from `gap` to `partial`.

## Not established

- **Live build and review.** Only the handoff and the mixed session passed live. Codex/Codex and Claude/Claude are blocked on owner answers, Claude/Codex failed at Codex's reader probe twice, and Codex/Claude was not run. No live turn ran after the interface and recovery repairs (the live runs used the source with C-1 and C-2 fixed). *Follow-up, same day:* each pairing passed once live on the final source plus the C-4 and C-5 repairs; what that run did not establish is listed in the [follow-up](#follow-up-live-retry-4-november-2026).
- **Real input methods and assistive technology.** IME composition was simulated through Chrome DevTools Protocol, not a macOS input method. VoiceOver could not be driven from Playwright and was not attempted by hand; accessible names were checked only in Chromium's accessibility tree.
- **Host-changing provider operations.** CLI download, install and update from Providers (register PRV-20) were not exercised, even through disposable targets.
- **Packaged cells.** `osvault` needs the real login keychain, the disk-full fault mounts a disk image, and the schema-1 restore needs a v0.1.1 fixture: blocked, as recorded by the harness. Packaged launches in `campaign-packaged-test.mjs` run offline under `sandbox-exec` with Chromium's own sandbox off; the packaged session journey ran with the network and the sandbox on.
- **Repeats after the repairs.** The full 404-view inspection was not repeated on the final source; `campaign-repairs-test.mjs` re-checks 12 inspection findings. The recovery cases and the 60-minute soak were rerun on it. The soak's comparison with W4's run is confounded by the different machine load, and the main process's 44 MB native-memory rise in the final soak was not investigated.
- **Deferred findings.** W3-10 (check output), W3-11 (row height), W3-12, W3-16, W3-19, W3-20, W3-23, W3-24 and W4-6 (full-view growth) remain, as listed above.
- **Outside the plan.** Windows, Linux and Intel Mac; release publication. Remote CI ran only on the pull request after this report.

## Follow-up: live retry, 4 November 2026

Run after this report, the same day, on the owner's instructions. The owner chose, for C-4, to investigate the delivery first; for C-5, memories off for Topsl's Codex; for the pairings' permission requests, answers by Claude (the agent running this campaign) approving only requests confined to the disposable project; and a further budget of 40 live turns.

**Source.** `1b190d4` (`main` after PR #45) plus this follow-up's product changes, built once with `npm run build` before the first live turn. The changes were uncommitted while the runs took place, on branch `claude/live-review-retry`; the product files did not change after that build. The live harness changed during the runs, as described below.

### What C-4 was

Codex's own session records (`~/.codex/sessions`) show what the model was given in the six reader probes of the morning. Codex 0.163.0 does not call Topsl's `read_range` tool directly. The model writes a short JavaScript program for Codex's `exec` tool, and in that program the tool's answer is a string: the JSON text Topsl returns. In 5 of the 6 probe turns, the model assumed an MCP-shaped object instead and printed only `result.content[]` items of type `"text"`, which do not exist. Its program printed nothing, and the model then replied, truthfully, that it could not retrieve the line. The two passes printed the string itself or used `search`. Codex's app-server declaration of a dynamic tool has no output schema, only a description, and the descriptions did not say what came back.

**Fix.** The candidate tools' descriptions ([candidate-tools.ts](../../../packages/context/candidate-tools.ts)) now say each answer is one JSON document as text, "a string, not an object with a content array", and name the fields each answer holds. A new test in [candidate-tools.test.ts](../../../tests/candidate-tools.test.ts) checks that every field a description names is in that tool's answer. The probe itself is unchanged and still requires the quote. **Live:** `candidate-reader` passed in all 6 Codex qualifications of the retry, against 1 of 6 probe turns that morning. In the first, the model's program printed the result string.

### What C-5 changed

Topsl starts `codex app-server -c features.memories=false -c memories.use_memories=false -c memories.generate_memories=false` for every Codex connection, qualification included ([codex.ts](../../../packages/providers/codex.ts), [manager.ts](../../../packages/runtime/manager.ts)); `-c` overrides only that process. Evidence:

- Codex's own `config/read` and `experimentalFeature/list`, called with no thread or turn, report memories on without the overrides and off with them.
- A new test in [campaign-claude-codex-qualification.test.ts](../../../tests/campaign-claude-codex-qualification.test.ts) checks the arguments a production runtime manager passes.
- In the live qualification's Codex session, the developer message no longer carries `memories.instructions`, which the morning's sessions did, and the session's metadata records `"memory_mode": "disabled"`. No live Codex build asked for `~/.codex/memories` again.
- The owner's memory folder was unchanged, in every file's size and modification time, from before the first live turn until after the Codex/Codex run.

It changed later, while the retry was running: `MEMORY.md` grew, and one new rollout summary appeared, for a Topsl reader-probe session recorded at 02:05, before the fix. The owner's own Codex (the ChatGPT app's Codex service, running since 2 November with memories on) turns rollouts in `~/.codex/sessions` into memories, whichever process wrote them. So Topsl sessions from before this change can reach the owner's memories, and `MEMORY.md` already mentions Topsl's scratch folders 31 times. Sessions from after the change are marked `memory_mode: disabled`. That the owner's Codex skips them is inferred from that marker, not observed. Nothing in the owner's memories was changed by this campaign.

### Harness changes

[live-session.mjs](../../../scripts/live-session.mjs):

- **Delegated answers.** `TOPSL_LIVE_ANSWERS=<folder>` writes each request a workflow run waits on to a file and acts only on the answer file written back ([Live provider sessions](../../Live_Provider_Sessions.md#delegated-answers)). Checked first against the stand-ins: allow, deny, and a Claude Code permission prompt.
- **Follow-up after a delegated deny.** A **No** to a Claude Code permission prompt ends Claude's turn on the declined call, so Topsl takes no reply (first Claude/Claude run below). With `TOPSL_LIVE_LEDGER`, the script then types one follow-up, as the owner would: the reason, and a request to finish in the folder with a final reply. Each follow-up is counted in the turn ledger before it is typed. The ledger's locking moved into [campaign-turn-ledger.mjs](../../../scripts/campaign-turn-ledger.mjs), shared with the proxy; the turn-budget self-test passed after the move.
- **Screen read in view.** Claude/Codex timed out twice waiting for Claude Code to accept its instructions, with a blank terminal pane. Diagnostics, using the Codex stand-in and no Codex turns, established that this was the harness, not Topsl or Claude Code:
  - Claude Code got a normal 24-by-100 terminal.
  - Recorded with `script(1)`, it drew its folder-trust prompt at once.
  - The window received those 1,036 characters on the right terminal id.
  - The pane's rows stayed empty, because xterm.js 6 stops drawing a terminal scrolled out of view, and on that team's taller workflow card the step's terminal was below the fold.
  
  The script read the rows without scrolling, so it never saw the prompt. It now scrolls the terminal into view before reading it. An owner scrolling to the terminal sees the prompt, so this is not a product defect.

### Live results

| Pairing (`--workflow`) | Result | Requests answered |
| --- | --- | --- |
| Codex qualification alone (`--qualify`) | **Passed**, every probe, reader included | — |
| `codex-codex` | **Passed** at acceptance in 5 turns: the build changed only `src/order.mjs`, the review found nothing, the required check passed | 9 allowed, 2 denied: a read of `AGENTS.md` in every folder above the project, and a copy of the project into `/private/tmp` |
| `claude-claude`, first run | Failed: after a **No**, Topsl took no reply from Claude's transcript, as documented | 1 allowed (write `src/order.mjs`, `npm run check`), 1 denied (copy into `/private/tmp`, `rm -rf` there, `npm ci`) |
| `claude-codex`, two runs | Failed before any prompt, both times: the harness's screen read (above) | — |
| `claude-claude`, with the follow-up | **Passed** at acceptance: one follow-up after the same denial; Claude finished in the folder; Claude Code's review, in Plan, found nothing; the check passed | 1 allowed, 1 denied |
| `claude-codex`, after the screen fix | **Passed** at acceptance: one follow-up after Claude asked for `npm ci` with npm's cache in `~/.npm`; Claude redid it with the cache in the project's ignored `.cache/`; the Codex review found nothing; the check passed | 3 allowed, 1 denied |
| `codex-claude` | **Passed** at acceptance in 4 turns: Claude Code's review compared every file's hash with the manifest and found nothing; the check passed | 5 allowed, 1 denied (a copy into `/private/tmp`) |

Turns: **35 of 40** in [the retry's ledger](evidence/live-retry-ledger.json). Codex had 22 structured turns, with `gpt-6.1-sol`. Claude Code had 11 terminal sessions and 2 follow-ups. Six of those sessions never received a prompt: the two stalled runs and four diagnostics. None was refused. Every answer and its reason is in [live-retry-answers.json](evidence/live-retry-answers.json): 19 allowed, 6 denied. Each run's outcome is in [live-retry-journeys.json](evidence/live-retry-journeys.json). Every Codex command ran through a login shell (`zsh -lc`), which reads the owner's shell startup files, and `npm run check` may write npm's own log under `~/.npm/_logs`. These answers counted both as confined to the project.

**Not established by the retry.**

- Each pairing passed once. Acceptance was not pressed, by design.
- The reader's 6 of 6 is one day on one Codex version.
- That the owner's memory pipeline skips `memory_mode: disabled` sessions is inferred, not observed.
- The answers were the delegate's under the owner's rule, not the owner's own.

**Automated check.** On the follow-up's final source, after the live runs, `npm run check` passed in the clean environment: TypeScript; Vitest 1,220 passed and 5 skipped (90 files: 88 passed, 2 skipped); 18 of 18 release checks; and the build. The turn-budget self-test passed after the ledger refactor. `npm run test:desktop`, the package and remote CI were not rerun for this follow-up. The renderer and packaging did not change, but that is an inference, not a check.

## Decisions for the owner

1. **Codex reviewers (C-4).** The reader probe requires Codex to quote a marker it read through Topsl's reader. Codex 0.163.0 read it but did not quote it in 3 of 4 live runs today, so Codex can rarely be qualified as a reviewer. Options: keep the strict probe and review with Claude; let the probe retry once (one more model turn per qualification); or accept a structured citation of the read instead of a quote. *Decided 4 Nov: investigate the delivery first;* the cause was Topsl's tool descriptions, now fixed ([follow-up](#follow-up-live-retry-4-november-2026)).
2. **Codex memories in Topsl builds (C-5).** Your Codex configuration lets a build read `~/.codex/memories/MEMORY.md`, which then reaches the model in a Topsl workflow. Decide whether Topsl should start Codex with memories off for its own turns, or leave it to Codex's configuration. *Decided 4 Nov: memories off for Topsl's Codex,* now implemented.
3. **Attended live pairings.** The four builder/reviewer pairings need someone to answer Codex's and Claude Code's permission requests, or **Settings → Auto-accept → Sandboxed** in the run's disposable profile. The campaign did neither; running `node scripts/live-session.mjs --workflow <team>` while you are present would close that gap. *Decided 4 Nov:* the owner delegated the answers, approving only requests confined to the disposable project, for at most 40 more turns.
4. **Deferred findings.** The P2 and P3 items above that remain open are candidates for a follow-up change.
