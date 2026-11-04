# Evidence index — comprehensive campaign, 4 November 2026

Where the [campaign report](REPORT.md)'s results are recorded. Most evidence is local to the owner's Mac under `test-results/agent-testing/2026-11-04-comprehensive/` (ignored by Git: screenshots, logs, profiles' reports). A small set of summaries and captures is committed in [evidence/](evidence/).

## Committed

| File | What it holds |
| --- | --- |
| [evidence/live-turn-ledger.json](evidence/live-turn-ledger.json) | Every live model turn the campaign counted (number, time, provider, kind, model, effort); none refused |
| [evidence/live-journeys.json](evidence/live-journeys.json) | Each live journey's result: coordinators, intakes, queue, loop outcome and qualification observations, or why it stopped |
| [evidence/final-gate.json](evidence/final-gate.json) | The final gate on `e12a6d3`: each step's exit code, the test counts, every recovery case's checks (including the two service-kill reruns), the package's size and SHA-256, and the packaged scenarios' counts |
| [evidence/isolation-results.json](evidence/isolation-results.json), [evidence/hostile-text.png](evidence/hostile-text.png) | Renderer isolation and hostile text, final gate |
| [evidence/repairs-results.json](evidence/repairs-results.json), [evidence/terminal-leave.png](evidence/terminal-leave.png) | The 12 repaired findings checked in the app, final gate |
| [evidence/turn-budget-self-test.json](evidence/turn-budget-self-test.json) | The turn budget's stand-in self-test, final gate |
| [evidence/live-retry-ledger.json](evidence/live-retry-ledger.json), [evidence/live-retry-journeys.json](evidence/live-retry-journeys.json), [evidence/live-retry-answers.json](evidence/live-retry-answers.json) | The [live retry follow-up](REPORT.md#follow-up-live-retry-4-november-2026): its 35 counted turns; each run's outcome, qualification, review, check, Claude steps and Codex requests; and every delegated answer with the request and the reason, the home folder written as `~` |
| [evidence/final-soak-summary.json](evidence/final-soak-summary.json) | The 60-minute soak on `c4d7325` after the final gate: memory, heap and process trends, store and UI timings, goal outcomes and leftovers |

## Local (not committed)

Paths are relative to `test-results/agent-testing/2026-11-04-comprehensive/` on the owner's Mac.

| Folder | Produced by | Contents |
| --- | --- | --- |
| `cleanenv.sh` | coordinator | The clean environment every command ran in |
| `live/` | coordinator | `ledger.jsonl` (the turn ledger), `bin/` (the wrappers), and per journey: `run.log`, `report.json` and screenshots: `l1-session/`, `l2-codex-codex/` (including `workflow-request.png`, the request to read `~/.codex/memories`), `l3-claude-codex-attempt1/` and `-attempt2/`, `l4-claude-claude/` (`claude-build-permission.png`), `l5-handoff/`, `diag/` (the diagnostic qualification) |
| `evidence/` | coordinator | The turn-budget self-test, isolation and repairs results, the mid-campaign gate (`check-midway.log`, `desktop-midway.log`), the first package (`package.log`, `verify-package.log`), the mid-campaign packaged run (`packaged/`), and the recovery reruns after the repairs |
| `final/` | coordinator | The final gate: `gate.log` (each step's exit code and time), one log per step, `revision.txt`, `package-sha256.txt`, `recovery/`, `campaign-ui/`, `round2-ui/` and `packaged/`; and the soak after the gate: `soak.log` and `soak-60min/` (samples, timings, events, summary) |
| `w1-harnesses/` | W1 | The ported auxiliary harnesses' runs (`campaign-ui-run1`–`run4`), packaging logs, the offline sandbox profiles and the packaged scenarios on W1's build |
| `w3-inspection/` | W3 | 404 views (703 files), named destination-state-theme-size; `checks.json` and `checks-loops.json` with every automated check and interaction |
| `w4-recovery-load/` | W4 | `evidence-index.json` (every command with its time window and files), the load runs, `soak-60min/` (samples, timings, events), and the recovery runs (`recovery-316d210/` is the final one on `5d39db1`) |

The live retry follow-up's local evidence is in a sibling folder, `test-results/agent-testing/2026-11-04-live-retry/`: `live/` holds the turn ledger, the wrappers, the memory folder's file times before and after (`memories-*.txt`, sizes and times only), and per run its `run.log`, `answers/` (each request and answer) and `run/` (report and screenshots); `diag-claude-after-codex/`, `diag2/` (`typescript`, Claude Code's raw output), `diag3/` and `diag4/` hold the screen-read diagnostics; `standin*/` hold the stand-in checks of the delegated answers and the follow-up; and `check.log` the automated check.

Worker branches, merged into `claude/windows-qualification`: W1 `844fe45` (merge `5bd8cb3`), W3 `9962cf2` (merge `db76f94`), W4 `316d210` and `1206868` (merge `7d2c4a5`).
