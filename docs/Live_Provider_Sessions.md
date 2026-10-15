# Live provider sessions

Topsl's automated suites use stand-in providers and never contact a model. [`scripts/live-session.mjs`](../scripts/live-session.mjs) checks one real session through Topsl's own interface, using the provider's existing sign-in on the machine that runs it. It sends one short prompt, which counts toward that account's usage. This covers part of remaining gate 2 in [Implementation status](Implementation_Status.md#remaining-gates-and-deliberate-limits); it is not a runtime qualification.

## Run it

```sh
npm run build
node scripts/live-session.mjs --claude "$(command -v claude)"
node scripts/live-session.mjs --codex "$(command -v codex)"
```

Each run checks one provider. `--model <id>` chooses the Codex model instead of the one Codex reports as default, `--output <folder>` changes where the evidence goes, and `--keep-profile` keeps the disposable Topsl profile after a pass. Linux needs a display, for example `xvfb-run --auto-servernum`.

## What a run does

- Topsl runs from this checkout with a new `topsl-test-live-*` profile in the operating system's temporary folder, so the user's own Topsl profile is never opened. Packaged builds ignore this test profile switch.
- The billing variables Topsl refuses (`billingConflicts` in [`packages/platform/system.ts`](../packages/platform/system.ts), such as `ANTHROPIC_API_KEY` or `OPENAI_BASE_URL`) are removed from Topsl's environment, as a launch from the Dock would not have them. The report lists the removed names only.
- Native dialogs are answered by the script. It approves only the dialogs listed below, for the exact executable and folder it selected, cancels any other, and records every dialog in the report.
- The executable is chosen with **Locate runtime** (`select-runtime`) and trusted, and a new empty `live-project` folder inside the profile is added and trusted as a project.
- The prompt is `What is A + B? Reply with only the number.`, with random four-digit numbers whose sum is not already on screen. The run passes only if the sum comes back.
- `report.json` and screenshots go to `test-results/live-session/<provider>-<time>/`. The profile is deleted after a pass and kept after a failure.

Approved dialogs: **Which runtime are you locating?** (Claude Code or Codex CLI), **Choose the native executable**, **Allow this native executable?**, **Select a trusted project**, **Trust this project?**, **Connect the experimental Codex integration?** (Codex only) and, for Claude, the transcript chosen for **Import Claude JSONL**.

### Claude Code: native terminal

Topsl runs Claude Code only in its native terminal. Production builds refuse the structured `claude --print` route ([`claudeStructuredGate`](../packages/providers/claude.ts)), so that route is not checked.

| Step | Passes when |
|---|---|
| **Native terminal** in the disposable folder | Claude Code starts with no arguments, under its own login, model and permission settings |
| Claude Code's folder trust prompt | Accepted with its default answer, which trusts the new folder |
| One prompt | The sum appears in the terminal; a sign-in screen stops the run before any prompt is sent |
| `/exit` | The session exits with code 0, Topsl records the run as `completed`, no terminal stays open and the process is gone. If `/exit` has not ended it after 30 seconds, the script presses Ctrl+C twice and then uses **Close session**, and the report says which ended it |
| History import | Claude Code's transcript for the folder (matched by its `cwd` under `~/.claude/projects`, or `CLAUDE_CONFIG_DIR`) imports through **History → Import Claude JSONL**, and the imported history has Claude's reply with the sum |

Claude Code keeps that transcript in its own history; the script does not delete it.

### Codex: structured chat

| Step | Passes when |
|---|---|
| **Models & account** | The connection is approved and Codex reports its models and account. The report keeps only the account type and plan, not the sign-in identity |
| One prompt | Sent from a new chat in **Read-only review** with the chosen model. Any approval request is declined and listed. The run ends `completed` and the reply contains the sum. The report counts the usage records Topsl stored |

## What a pass does not establish

- Sandbox enforcement, tool approvals or edits. For Codex, [runtime qualification](../README.md#qualify-a-codex-runtime) covers those separately.
- Packaged applications, other operating systems or other provider versions than the one run.
- Claude Code's billing mode. Its terminal owns its login and billing, and the report does not read them; the screenshots show whatever Claude Code displays.
- Native sidebar or history refresh in the providers' own applications.

## Check the procedure without a model

Stand-ins in [`tests/fixtures/live-session`](../tests/fixtures/live-session) imitate the parts of each provider that the script drives, without a network or an account. They run on macOS and Linux:

```sh
npm run build
CLAUDE_CONFIG_DIR="$(mktemp -d)" node scripts/live-session.mjs --claude "$PWD/tests/fixtures/live-session/claude.cjs"
node scripts/live-session.mjs --codex "$PWD/tests/fixtures/live-session/codex.cjs"
```

The Claude stand-in refuses to start without `CLAUDE_CONFIG_DIR`, so it never writes into a real Claude Code profile.

## Results

| Date | Provider | Host | Topsl | Result |
|---|---|---|---|---|
| 15 October 2026 | Stand-ins for Claude Code and Codex | Linux x64 cloud container, `xvfb-run`, Node 22 | `b803825` with this script | Both passed: Claude's folder trust, reply, `/exit` with code 0 and transcript import; Codex's connection, reply and one usage record |

No live provider session has been recorded yet.
