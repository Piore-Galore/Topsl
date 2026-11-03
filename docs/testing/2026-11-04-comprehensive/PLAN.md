# Comprehensive Topsl audit, repairs, and UX improvements

**Status:** Agreed plan, saved 4 November 2026, and executed the same day: see the [campaign report](REPORT.md), the [coverage register](COVERAGE.md) and the [evidence index](EVIDENCE.md). The planning record below is kept as written.

Related documents: [Implementation status](../../Implementation_Status.md), [Topsl design](../../Topsl_Design.md), [session-first UX cleanup](../../UX_Cleanup_Plan.md), and the [October campaign report](../TEST-REPORT.md).

## Summary

Audit the **current working tree, including uncommitted changes**, on this Apple silicon Mac. Find and fix functional bugs, missing behavior, visual defects, and usability problems, then verify the resulting app.

The campaign includes automated tests, hands-on Electron inspection, live Codex and Claude Code runs, and the macOS package. Broader navigation and workflow improvements are allowed when findings support them.

Planning baseline: TypeScript checking passes. The repository currently contains 94 test files and 200 declared application commands; these are inventory counts, not comprehensive acceptance evidence.

## Coverage

Build a coverage register from current screens, controls, command schemas, and documented behavior. Reconcile the October campaign against today's product, retaining retired features as historical coverage.

| Area | Required scenarios |
| --- | --- |
| Startup and persistence | Fresh profile, vault unlock, wrong passphrase, reopen, supported upgrades, missing/corrupt storage, recovery without duplicate work or data loss. |
| Providers | Discovery, locating and trusting executables, connection, authentication states, qualification success/failure/expiry, model and effort selection, usage refresh, CLI update operations and recovery. |
| Projects and navigation | Add, trust, rename, reorder, relink missing folders, project switching, restored destinations, All sessions search/pagination, command palette and compact navigation. |
| Sessions | New session, Auto/Discuss/Work, multiple coordinators, shared replies, clarification, goal queues, drafts, imported references, pause/resume/stop, restart and acceptance. |
| Teams and loops | Automatic/custom teams, custom roles, pinned models and effort, unavailable members, queued loops, budgets, checkpoints, publication, cancellation and uncertain outcomes. |
| Provider tools and history | Structured chats, native terminals, permissions and approval cards, streaming, interrupts, terminal resizing, imports, duplicate detection, deletion, search and attributed handoffs. |
| Advanced workflows | All four builder/reviewer pairings, candidate review, checks, findings, repairs, parallel workspaces, shared context, acceptance and publication conflicts. |
| Settings and integrations | Themes, auto-accept, Claude route/transcript controls, configuration preview/apply/conflicts, context grants, companion CLI/MCP, usage accounting and enabled experimental features. |

Every applicable action receives a successful-path check and meaningful validation, cancellation, or recovery checks. UI assertions must verify the resulting state and effects—not merely that a button was clickable.

## Execution and repair approach

1. **Establish reproducible evidence.** Record the starting revision, uncommitted changes, runtime versions, environment and commands. Preserve existing work. Use disposable Topsl profiles and scratch projects; keep qualification folders outside temporary directories as required by the current sandbox probes.

2. **Repair coverage gaps first.** Update obsolete campaign screens and package assumptions. Include the provider-qualification journey in routine desktop coverage. Exercise the auxiliary usage and workflow journeys. Keep fixture setup through service commands separate from actions being verified through the UI.

3. **Run the automated baseline.** Use `npm run check` and the Electron journeys. Classify failures as product defects, harness defects or environmental blockers. Preserve first-failure evidence and inspect skips instead of treating an overall green exit as complete coverage.

4. **Inspect the actual interface.**

   - Visit every current destination, pane and dialog in Paper and Night, including empty, populated, loading, blocked, failed and completed states.
   - Check standard and minimum window sizes, navigation and detail-pane breakpoints, and 150%/200% zoom. Exercise System theme changes.
   - Inspect clipping, overlap, button sizing, alignment, scroll behavior, contrast, long paths, long responses, Unicode and dense lists.
   - Test keyboard operation, focus restoration, modal behavior, accessible names, text selection, clipboard and IME entry. Attempt native VoiceOver journeys and record any limitations separately.
   - Walk through first setup, starting work, resolving a blocker, reviewing results and returning to earlier work using the interface's visible guidance.

5. **Fix and retest findings.** Prioritize data loss, unintended execution, broken core workflows and inaccessible controls. Also repair confusing navigation, missing feedback and incomplete current workflows. Larger UX changes receive a documented before/after flow and task-based acceptance checks. Preserve Atlas identity and the CLI-only integration boundary.

6. **Keep interfaces compatible.** Reuse existing service commands where possible. Any necessary command, read-model or persistence additions must preserve existing profiles and saved sessions, with corresponding compatibility tests. Audit controls remain outside ordinary product UI.

## Live, reliability, and packaged validation

- **Live budget:** enforce a campaign-wide maximum of **80 structured-turn starts and prompted terminal rounds combined**, including qualification, coordinator activity, retries and retests. Verify the accounting with stand-ins before live execution; the existing loop `--max-turns` flag is insufficient. Actual provider token usage remains variable.
- **Live journeys:** qualify both installed CLIs, exercise model/effort selections, a mixed-provider session from discussion through accepted work and a queued loop, direct chat/terminal use, handoff, and all four builder/reviewer pairings. Prioritize primary journeys and reserve capacity for retesting failures.
- **Live boundaries:** use existing sign-ins and scratch repositories. Test host-changing installation/update paths through disposable targets or simulations; distinguish those results from an actual managed installation.
- **Recovery:** inject provider disconnects, malformed responses, stalled processes, service termination, repeated submissions and restarts during active work. Verify cancellation, workspace ownership and reconciliation before retry.
- **Load:** run the existing 100,000-message benchmark, lifecycle stress and 1,000-boundary loop exercise, plus a **60-minute Electron navigation/streaming soak**. Measure search, rendering, memory and child-process behavior; distinguish store timings from actual UI timings.
- **Package:** build with `npm run package -- --mac --arm64`, run `npm run verify:mac-package`, and exercise the extracted application with an isolated profile. Verify startup/reopen, native modules, terminal operation, session journeys and supported upgrade fixtures.

Missing authentication, exhausted quota or unavailable native facilities become explicit blocked cases. They never become fixture-backed live passes.

## Completion and deliverables

- Fix confirmed defects within this scope and rerun their reproductions. Add focused regression tests for consequential behavior; use before/after screenshots and interaction checks for visual repairs.
- Run the final automated gate and affected Electron/package journeys against the final source. Repeat long-running checks when relevant fixes invalidate their earlier results.
- Record each finding's severity, reproduction, expected/actual behavior, evidence, repair and verification.
- Save the campaign report, coverage register and evidence index under `docs/testing/2026-11-04-comprehensive/`. Preserve earlier campaigns as dated records.
- Update canonical design, implementation status and user instructions alongside behavior changes. Check documentation links and `git diff --check`.
- Report passed, failed, blocked, untested, deferred and retired coverage separately. Do not claim comprehensive acceptance with unresolved critical/high-impact defects or blocked core journeys.

Windows, Linux, Intel Mac, remote CI and release publication remain outside this campaign. Broader UX work addresses current Topsl workflows; unrelated future product features remain documented proposals.

## Planning evidence — 4 November 2026

The planning inspection used `/Users/piore/repos/Topsl` on `claude/windows-qualification`, at `1f6ac802377f6deaae74d3f7191d0af5204f3ac8` plus the existing uncommitted changes. Host: macOS arm64; shell Node.js: v26.0.0. Re-record the source and environment when the campaign starts.

| Check | Observed result and scope |
| --- | --- |
| `npm run typecheck` | Passed during planning. This establishes TypeScript checking only; the full campaign was not run. |
| `codex --version` | `codex-cli 0.163.0`, resolved through `/opt/homebrew/bin/codex`. No live model turn. |
| `claude --version` | `2.1.305 (Claude Code)`, resolved through `/opt/homebrew/bin/claude`. No live model turn. |
| Static test inventory | 94 immediate `tests/` files ending in `.test.ts` or `.test.mjs`; not a count of individual test cases or passing tests. |
| Static command inventory | 200 `type: z.literal(...)` declarations across the general, orchestration, loop, session and import command schemas; not evidence that every command has been exercised. |
| Desktop runner inspection | The provider-qualification journey is outside the default desktop suite. |
| Auxiliary harness inspection | The older UI campaign exercises retired screens; the packaged campaign retains a 0.1.2 artifact and old paths. Update these before treating their results as current evidence. |
| Live harness inspection | `scripts/live-loop.mjs --max-turns` limits loop member turns; it does not cap the campaign's total qualification, intake and other provider activity. |
