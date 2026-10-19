# Phase state and handoff — campaign 2026-10-19-comprehensive

Resumable state of the comprehensive test campaign, as plan §0.8 requires. Read the [campaign report](TEST-REPORT.md) first, then this file, then check the actual repository and process state before continuing. Do not repeat a side-effecting action (live model turns, pushes, package installs) merely because its outcome is missing here.

## Identity

| Item | Value |
| --- | --- |
| Product source under test | `d4b788efb17adce0ec6362eeb745f62639767d0e` (unchanged by this campaign) |
| Campaign branch | `test/comprehensive-campaign` (tests, harness fixes, documentation) |
| Clean baseline checkout | `.claude/worktrees/campaign-clean` (detached at `d4b788e`; holds the packaged candidate under `release/`) |
| Old-release sources | `.claude/worktrees/campaign-v011` (tag v0.1.1), `.claude/worktrees/campaign-v012` (tag v0.1.2), both built |
| Host | darwin-arm64, macOS 27.0.1, Apple M5, Node v26.0.0 (Vitest runs under Electron 44.4.5's Node 24.21.0) |
| Local evidence root | `test-results/agent-testing/2026-10-19-comprehensive/` (untracked; manifest, per-packet `results.jsonl` and summaries, `coverage.json`) |
| Raw logs | session scratchpad `evidence/` (temporary; key results are copied into the packet summaries and the report) |

## Phase status

| Phase | Status | Gate assessment |
| --- | --- | --- |
| 0 Execution contract | Done | 359 cases, 14 journeys and 197 commands inventoried; commands identical to Appendix A; manifest written |
| 1 Harness trust | Done for darwin-arm64 | Clean baseline 635 passed / 5 opt-in skipped of 640; six desktop harnesses and Round 2 fixture test passed; harness defects fixed (billing variables in the runner, stale live-session script); CL-17/CL-18 Windows fixes written but unverified |
| 2 Storage, ownership, authority | Executed locally; gate **not met** | P0 failures remain: D-12 (MCP-05), D-18 (DATA-04); D-19 (TASK-01) disputed |
| 3 Applications, providers, terminals, usage | Executed locally, partial native; gate **not met** | D-11 (CQ-01), D-20 (CONF-02), D-22 (PR-13); live Codex qualification passed on retry after a first-attempt failure |
| 4 Projects, context, desktop | Executed locally; gate **not met** | D-07/D-10 (HX-10), D-17 (HX-09); UI cases 24 E PASS, screen reader and real OS theme BLOCKED |
| 5 Workflows and artifacts | Executed locally; gate **not met** | D-06 (BW-21), D-21 (PW-03); live four-pairing matrix BLOCKED |
| 6 Teams and loops | Executed locally; gate **not met** | D-01 (LOOP-13, P0), D-02 (STATE-12), D-03 (STATE-04), D-04/D-05 (OPS-02), D-13, D-14, D-16, D-24, D-25 (TEAM-03); D-15 disputed |
| 7 Optional workflows and replication | Executed locally; gate **not met** | D-08 (REPL-08), D-23 (REPL-10); AD-01/J-13 isolation NOT IMPLEMENTED |
| 8 Native, packaged, extended | Partially executed | darwin-arm64 package built, verified and exercised; D-09 (PKG-03); Intel Mac, Windows and Linux BLOCKED (no host, CI push needs the owner); soak runs not performed |
| 9 Independent verification | Done for this source | Independent review confirmed 22 of 24 defects by re-execution or reading, disputed 2, and triggered reclassifications and the strengthening of 25 tests, which found D-25. Final gate on the branch (13:34Z): Vitest 1,093 passed, 37 expected-fail, 5 skipped, 0 failed; typecheck, release and build passed |

## Cleanup state

- No campaign process is left running. Live-session profiles were disposable `topsl-test-live-*` folders; the handoff run's profile stayed in `$TMPDIR` (the script reports `profileDeleted: false`) and holds no credentials.
- `topsl-test-campaign-*` profiles from the UI harness remain in `$TMPDIR`; delete them freely.
- The worktrees `.claude/worktrees/campaign-clean`, `campaign-v011` and `campaign-v012` remain for rerunning packaged and upgrade scenarios. Remove them with `git worktree remove` when no longer needed.
- No keychain item was created by the campaign. The packaged runs reused the existing "topsl Safe Storage" item.
- The Codex qualifications recorded during live runs lived only in disposable Topsl profiles. They do not qualify the owner's own Topsl.

## Blockers and next runnable packets

1. **Remote CI cells: done on 19 October 2026.** The branch was pushed as `codex/test-campaign-2026-10-19`. At `43977cb`, Linux, Apple silicon and Windows passed every step; Intel passed its tests but hit F-01 in the desktop journey ([report](TEST-REPORT.md#follow-up-fixes-and-four-platform-ci)). F-01 was diagnosed and fixed on 20 October 2026, and CI on the fix passed every step on all four platforms ([record](TEST-DECISIONS.md#recurring-desktop-confirmation-loss-f-01)). The original instructions are kept below for a rerun.

   Original blocker: a push with the owner's GitHub credentials. The workflow triggers on `main` and `codex/**`. Run:

   ```bash
   git push origin test/comprehensive-campaign:codex/test-campaign-2026-10-19
   ```

   Then record each platform's `npm run check` and desktop results, including whether `tests/claude-route.test.ts` CL-17/CL-18 now pass on Windows.
2. **Live Claude pairings (BW-19, J-03).** Blocked on the owner being present to answer Claude Code's own permission prompts. Rerun the four `--workflow` routes of `scripts/live-session.mjs` while watching the Topsl window.
3. **Claude runtime qualification live (CL-05, CL-15).** Requires a decision to allow `scripts/live-loop.mjs --claude-model`, which also runs a mixed Goal loop.
4. **Defect repair.** Each D-xx row has a reproduction. A fix must flip that `test.fails` to `test` and rerun the combined gate.
5. **Not yet attempted:** the L-layer soaks (8-hour and 24-hour loop, one-hour UI), real-quarantine first open (PKG-07), screen-reader acceptance (UI-06), the optimization benefit study (plan §6.3), and the NOT RUN variations listed per case in [the coverage register](TEST-COVERAGE.md).
