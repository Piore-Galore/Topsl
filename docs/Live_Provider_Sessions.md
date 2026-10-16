# Live provider sessions

Topsl's automated suites use stand-in providers and never contact a model. [`scripts/live-session.mjs`](../scripts/live-session.mjs) checks real sessions through Topsl's own interface, using each provider's existing sign-in on the machine that runs it: one provider, or Claude Code followed by Codex continuing the same conversation through a context handoff. Each provider gets one short prompt, which counts toward that account's usage. This covers part of remaining gate 2 in [Implementation status](Implementation_Status.md#remaining-gates-and-deliberate-limits); it is not a runtime qualification.

## Run it

```sh
npm run build
node scripts/live-session.mjs --claude "$(command -v claude)"
node scripts/live-session.mjs --codex "$(command -v codex)"
node scripts/live-session.mjs --claude "$(command -v claude)" --codex "$(command -v codex)"
```

`--claude` or `--codex` alone checks that provider. Both together run Claude Code first and then hand its conversation to Codex, as described [below](#both-handoff-from-claude-code-to-codex). `--model <id>` chooses the Codex model instead of the one Codex reports as default, `--output <folder>` changes where the evidence goes, and `--keep-profile` keeps the disposable Topsl profile after a pass. Linux needs a display, for example `xvfb-run --auto-servernum`.

## What a run does

- Topsl runs from this checkout with a new `topsl-test-live-*` profile in the operating system's temporary folder, so the user's own Topsl profile is never opened. Packaged builds ignore this test profile switch.
- The billing variables Topsl refuses (`billingConflicts` in [`packages/platform/system.ts`](../packages/platform/system.ts), such as `ANTHROPIC_API_KEY` or `OPENAI_BASE_URL`) are removed from Topsl's environment, as a launch from the Dock would not have them. The report lists the removed names only.
- Native dialogs are answered by the script. It approves only the dialogs listed below, for the exact executable and folder it selected, cancels any other, and records every dialog in the report.
- Each executable is chosen with **Locate runtime** (`select-runtime`) and trusted, and a new empty `live-project` folder inside the profile is added and trusted as a project.
- The prompt is `What is A + B? Reply with only the number.`, with random four-digit numbers whose sum is not already on screen. After a handoff, Codex is asked `Add C to the number Claude Code replied with in the handoff above. Reply with only the number.` A step passes only if the expected sum comes back as a whole number, not inside a longer one.
- `report.json` and screenshots go to `test-results/live-session/<claude|codex|both>-<time>/`. A one-provider report keeps that provider's `executable`, `prompt`, `expectedReply`, `replyObserved`, `replySeconds` and `session` at the top level. A report for both keeps them per provider under `steps`, with `conversation` for the shared conversation. The profile is deleted after a pass and kept after a failure.

Approved dialogs: **Which runtime are you locating?** (Claude Code or Codex CLI), **Choose the native executable**, **Allow this native executable?**, **Select a trusted project**, **Trust this project?**, **Connect the experimental Codex integration?** (Codex only), for Claude, the transcript chosen for **Import Claude JSONL**, and, after a handoff is attached, **Send the reviewed context to Codex?** for the one message the script sends.

### Claude Code: native terminal

Topsl runs Claude Code only in its native terminal. Production builds refuse the structured `claude --print` route ([`claudeStructuredGate`](../packages/providers/claude.ts)), so that route is not checked.

| Step | Passes when |
|---|---|
| **Native terminal** in the disposable folder | Claude Code starts with no arguments, under its own login, model and permission settings |
| Claude Code's folder trust prompt | **Yes, I trust this folder** is selected and confirmed. Claude Code 2.1.183 selects it first, but 2.1.300 lists and selects **No, exit** first. The script reads the selected answer from the screen, moves to **Yes** with the arrow keys and presses Enter only once the screen shows it selected. The report's `folderTrustDefault` keeps the answer Claude Code had selected |
| One prompt | Sent once Claude Code shows its shortcuts hint, or its permission mode in place of the hint, below the input. The sum appears in the terminal. A sign-in screen stops the run before any prompt is sent. After it, a sign-in request or an API error Claude Code has stopped retrying ends the run, and the report's `apiError` keeps that error's status |
| `/exit` | The session exits with code 0, Topsl records the run as `completed`, no terminal stays open and the process is gone. If `/exit` has not ended it after 30 seconds, the script presses Ctrl+C twice and then uses **Close session**, and the report says which ended it |
| History import | Claude Code's transcript for the folder (matched by its `cwd` under `~/.claude/projects`, or `CLAUDE_CONFIG_DIR`) imports through **History → Import Claude JSONL**, and the imported history has Claude's reply with the sum |

Keys and text reach Claude Code by giving Topsl's terminal the keyboard focus, not by clicking it: when a terminal application turns on mouse reporting, the terminal passes clicks to it. Claude Code's prompts are read from Topsl's terminal screen as well as from its output. In the first live run below, Topsl's terminal showed the folder trust prompt, but the output with escape sequences removed did not contain it, so the run timed out. The likely cause is that Claude Code moves the cursor over blank cells instead of writing spaces, which runs its words together in the output. The report's `folderTrustReadFrom` says whether the output or only the screen showed that prompt.

Claude Code keeps that transcript in its own history; the script does not delete it.

### Codex: structured chat

| Step | Passes when |
|---|---|
| **Models & account** | The connection is approved and Codex reports its models and account. The report keeps only the account type and plan, not the sign-in identity |
| One prompt | Sent from a new chat in **Read-only review** with the chosen model. Any approval request is declined and listed. The run ends `completed` and the reply contains the sum. The report counts the usage records Topsl stored |

### Both: handoff from Claude Code to Codex

Claude Code runs as above, up to its history import. Codex then continues the imported conversation instead of a new chat:

| Step | Passes when |
|---|---|
| **Models & account** | As for Codex alone |
| **Prepare handoff** | With Codex selected and Claude Code's imported conversation open, Topsl shows the handoff for review. Its text has Claude Code's reply with the sum, and the script then chooses **Attach to next Codex message**. The report keeps the reviewed snapshot's SHA-256, its length and how many messages it carries |
| One prompt | Sent in **Read-only review** with the handoff attached, once **Send the reviewed context to Codex?** is approved. The run ends `completed` and the reply is Claude Code's number plus the new one, which Codex can only work out from the handed-off context |
| Shared conversation | The imported conversation keeps both replies, attributed to Claude Code and Codex |

If the Claude Code step fails, Codex is not started.

## What a pass does not establish

- Sandbox enforcement, tool approvals or edits. For Codex, [runtime qualification](../README.md#qualify-a-codex-runtime) covers those separately.
- Packaged applications, other operating systems or other provider versions than the one run.
- Claude Code's billing mode. Its terminal owns its login and billing, and the report does not read them; the screenshots show whatever Claude Code displays.
- Native sidebar or history refresh in the providers' own applications.
- Moving a native session between providers. The handoff gives Codex the reviewed text in a new turn of its own session; neither provider's own history shows the other's messages.
- The live builder and reviewer workflows of R2-AT-37/38 ([acceptance mapping](Round_2_Phase_6.md#acceptance-traceability)). The handoff check is one chat, not a reviewed candidate.

## Check the procedure without a model

Stand-ins in [`tests/fixtures/live-session`](../tests/fixtures/live-session) imitate the parts of each provider that the script drives, without a network or an account. They run on macOS and Linux:

```sh
npm run build
CLAUDE_CONFIG_DIR="$(mktemp -d)" node scripts/live-session.mjs --claude "$PWD/tests/fixtures/live-session/claude.cjs"
node scripts/live-session.mjs --codex "$PWD/tests/fixtures/live-session/codex.cjs"
CLAUDE_CONFIG_DIR="$(mktemp -d)" node scripts/live-session.mjs --claude "$PWD/tests/fixtures/live-session/claude.cjs" --codex "$PWD/tests/fixtures/live-session/codex.cjs"
```

After a handoff, the Codex stand-in adds the numbers in the current request to the last Claude reply in the handed-off context, so it answers correctly only if that context reaches it. The Claude stand-in refuses to start without `CLAUDE_CONFIG_DIR`, so it never writes into a real Claude Code profile. To check how a refused request is reported, give it an API error status in that folder; the run then fails with `Claude Code reported API error 403 instead of replying.`:

```sh
config="$(mktemp -d)" && echo 403 > "$config/stand-in-api-error"
CLAUDE_CONFIG_DIR="$config" node scripts/live-session.mjs --claude "$PWD/tests/fixtures/live-session/claude.cjs"
```

## Results

| Date | Provider | Host | Topsl | Result |
|---|---|---|---|---|
| 15 October 2026 | Stand-ins for Claude Code and Codex | Linux x64 cloud container, `xvfb-run`, Node 22 | `b803825` with this script | Both passed: Claude's folder trust, reply, `/exit` with code 0 and transcript import; Codex's connection, reply and one usage record |
| 15 October 2026 | Claude Code 2.1.183 (Homebrew) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `0768a59` (v0.1.2), with the script from `ce4ec31` | Failed before any prompt was sent. Topsl's terminal showed Claude Code's folder trust prompt, but the script read only the terminal output, did not find the prompt there and timed out after 120 seconds |
| 15 October 2026 | Stand-ins, with the Claude Code stand-in drawing spaces as cursor movements | Linux x64 cloud container, `xvfb-run`, Node 22 | `c660a1b` (screen fix) | The script without the fix failed as on the Mac. With the fix, both passed, and the folder trust prompt was read from the screen |
| 15 October 2026 | Claude Code 2.1.183 (Homebrew) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `0768a59` (v0.1.2), with the script from `c660a1b` | Failed after the prompt was sent. Topsl's part worked: the folder trust prompt was read from the screen and accepted, the input was ready (Claude Code showed `auto mode on` in place of the shortcuts hint) and the prompt went in. Claude Code, on API usage billing through an endpoint set in its own configuration rather than in Topsl's environment, then showed `Please run /login · API Error: 403` from that endpoint, so no reply came and `/exit` and the transcript import were not reached |
| 15 October 2026 | Stand-ins, including a stand-in API error | Linux x64 cloud container, `xvfb-run`, Node 22 | `c660a1b` with API error reporting | Both passed. With a stand-in API error 403, the Claude run failed with `Claude Code reported API error 403 instead of replying.` and the report's `apiError` was 403 |
| 16 October 2026 | Claude Code 2.1.183 (Homebrew) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `d8eda1e` | Failed after the prompt was sent, as in the run before. The folder trust prompt was read from the screen and accepted, and the prompt went in. Claude Code then showed `Please run /login · API Error: 403` from the endpoint set in its own configuration, and the report's `apiError` was 403 |
| 16 October 2026 | Codex CLI 0.163.0 (npm package `@openai/codex`) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `d8eda1e` | **Passed.** Topsl recorded the executable as owned by npm and trusted it. Codex, signed in with ChatGPT, reported 8 models, and its default model, `gpt-6.1-sol`, answered the prompt from a new chat in **Read-only review** with the sum after 10.6 seconds. The run ended `completed`, no approval was requested and Topsl stored one usage record |
| 16 October 2026 | Stand-ins, including both providers with a handoff | Linux x64 cloud container, `xvfb-run`, Node 22 | `accd052` (handoff check) | Claude alone, Codex alone and both passed. In the run with both, the reviewed handoff carried Claude's reply, Codex answered with that number plus the new one, and the conversation kept both replies. A Codex stand-in that ignores the handoff failed with `The Codex reply does not contain the answer.` With a stand-in API error 403, the Claude step failed and Codex was not started |
| 16 October 2026 | Claude Code 2.1.300 (Homebrew) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `d8eda1e` | Failed before any prompt was sent. Claude Code 2.1.300's folder trust prompt lists **No, exit** first and selects it. The script pressed Enter expecting the earlier default, so Claude Code declined the folder and exited with code 1. The report still said the prompt was `accepted`, because the script did not check which answer was selected |
| 16 October 2026 | Stand-ins, with the Claude Code stand-in asking for trust as 2.1.300 does | Linux x64 cloud container, `xvfb-run`, Node 22 | `73a9233` (trust fix) | The script from before the fix failed as on the Mac, and its report said `accepted`. With the fix, Claude alone passed with `folderTrustDefault` `No, exit`, and a stand-in in the 2.1.183 order passed with `Yes, I trust this folder`. Codex alone and both passed again, and the missing-handoff and API error checks failed as intended |

The Codex run of 16 October 2026 is the first live session to pass. Claude Code has not passed. In the two runs that sent its prompt, the endpoint set in its own configuration refused the request, and in the next run Claude Code 2.1.300 declined the disposable folder because of the script's trust answer. The handoff from Claude Code to Codex has run only with stand-ins.
