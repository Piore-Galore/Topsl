# Live provider sessions

Topsl's automated suites use stand-in providers and never contact a model. [`scripts/live-session.mjs`](../scripts/live-session.mjs) checks real sessions through Topsl's own interface, using each provider's existing sign-in on the machine that runs it: one provider, or Claude Code followed by Codex continuing the same conversation through a context handoff. Each provider gets one short prompt, which counts toward that account's usage. This covers part of remaining gate 2 in [Implementation status](Implementation_Status.md#remaining-gates-and-deliberate-limits); a session check is not a runtime qualification. With `--qualify`, the script instead runs Topsl's Codex [runtime qualification](#codex-runtime-qualification) through the guided setup, which starts up to three model turns.

## Run it

```sh
npm run build
node scripts/live-session.mjs --claude "$(command -v claude)"
node scripts/live-session.mjs --codex "$(command -v codex)"
node scripts/live-session.mjs --claude "$(command -v claude)" --codex "$(command -v codex)"
node scripts/live-session.mjs --qualify --codex "$(command -v codex)"
```

`--claude` or `--codex` alone checks that provider. Both together run Claude Code first and then hand its conversation to Codex, as described [below](#both-handoff-from-claude-code-to-codex). `--qualify` with `--codex` alone runs the runtime qualification instead of a prompt. Like the qualification itself, it runs on macOS and Linux only. `--model <id>` chooses the Codex model instead of the one Codex reports as default, and must be one Codex reports. `--output <folder>` changes where the evidence goes, and `--keep-profile` keeps the disposable Topsl profile after a pass. Linux needs a display, for example `xvfb-run --auto-servernum`.

## What a run does

- Topsl runs from this checkout with a new `topsl-test-live-*` profile in the operating system's temporary folder, so the user's own Topsl profile is never opened. Packaged builds ignore this test profile switch.
- The billing variables Topsl refuses (`billingConflicts` in [`packages/platform/system.ts`](../packages/platform/system.ts), such as `ANTHROPIC_API_KEY` or `OPENAI_BASE_URL`) are removed from Topsl's environment, as a launch from the Dock would not have them. The report lists the removed names only.
- Native dialogs are answered by the script. It approves only the dialogs listed below, for the exact executable and folder it selected, cancels any other, and records every dialog in the report.
- Each executable is chosen with **Locate runtime** (`select-runtime`) and trusted, and a new empty `live-project` folder inside the profile is added and trusted as a project.
- The prompt is `What is A + B? Reply with only the number.`, with random four-digit numbers whose sum is not already on screen. After a handoff, Codex is asked `Add C to the number Claude Code replied with in the handoff above. Reply with only the number.` A step passes only if the expected sum comes back as a whole number, not inside a longer one.
- With `--qualify`, Topsl also gets `TOPSL_TEST_QUALIFICATION_DIR`: a new `topsl-qualify-*` folder in `~/Library/Caches` on macOS or `~/.cache` on Linux, because a qualification in the temporary folder could not be judged. The script deletes that folder after every run, passed or failed.
- `report.json` and screenshots go to `test-results/live-session/<claude|codex|both|qualify>-<time>/`. A one-provider report keeps that provider's `executable`, `prompt`, `expectedReply`, `replyObserved`, `replySeconds` and `session` at the top level. A report for both keeps them per provider under `steps`, with `conversation` for the shared conversation. The profile is deleted after a pass and kept after a failure.

Approved dialogs: **Which runtime are you locating?** (Claude Code or Codex CLI), **Choose the native executable**, **Allow this native executable?**, **Select a trusted project**, **Trust this project?**, **Connect the experimental Codex integration?** (Codex only), for Claude, the transcript chosen for **Import Claude JSONL**, and, after a handoff is attached, **Send the reviewed context to Codex?** for the one message the script sends. With `--qualify`, **Qualify this Codex runtime with live model turns?** is approved once, and only when its text names the selected executable, the chosen model, up to 3 model turns and the script's qualification folder.

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

### Codex: runtime qualification

`--qualify` runs the [runtime qualification](../README.md#qualify-a-codex-runtime) from the guided setup, with Codex in both roles. The script sends no prompt of its own; the qualification's probes are the model turns.

| Step | Passes when |
|---|---|
| **Models & account** | As for Codex alone. The model is the one Codex reports as default, or the one `--model` names |
| Guided setup | In **Activity → Create a workflow → 2. Team**, **Codex builds · Codex reviews** is chosen and the runtime is selected for both roles. **Discover builder models** lists the model, and it is chosen for both roles |
| **Qualify builder runtime** | Topsl's dialog is approved as described above, and the script does not retry. Topsl records a qualification with every probe passed, none untested, no error, and at most 3 turns started |
| Readiness | Topsl's readiness query and the guided setup both show the builder and reviewer roles satisfied with this qualification |

The report keeps what Topsl recorded: the suite, the model, the turns started, each probe's capability, outcome and detail, any probe not tested, the approval requests the suite declined, any error, and when the qualification expires. It keeps only the account type and plan, and writes the home folder as `~`. `modelTurns` is the number of turns Topsl reports it started, or `null` if Topsl started the qualification but recorded nothing. A failed run keeps the same record, so a failure shows which probe failed. The `candidate-reader` detail also says how Codex reported each tool call when it completed, including whether the call's content holds the probe's marker but never the content, and which items the turn completed.

A qualification counts only in the profile that ran it, and this one is disposable. A pass does not qualify the user's own Topsl; that takes **Qualify builder runtime** there, with up to three more turns.

## What a pass does not establish

- Sandbox enforcement, tool approvals or edits. For Codex, [runtime qualification](../README.md#qualify-a-codex-runtime) covers those separately.
- Packaged applications, other operating systems or other provider versions than the one run.
- Claude Code's billing mode. Its terminal owns its login and billing, and the report does not read them; the screenshots show whatever Claude Code displays.
- Native sidebar or history refresh in the providers' own applications.
- Moving a native session between providers. The handoff gives Codex the reviewed text in a new turn of its own session; neither provider's own history shows the other's messages.
- The live builder and reviewer workflows of R2-AT-37/38 ([acceptance mapping](Round_2_Phase_6.md#acceptance-traceability)). The handoff check is one chat, not a reviewed candidate, and a qualification builds and reviews nothing.
- For a qualification, the user's own Topsl being qualified, as above, or any Codex release, account, managed policy or host other than the one that ran it.

## Check the procedure without a model

Stand-ins in [`tests/fixtures/live-session`](../tests/fixtures/live-session) imitate the parts of each provider that the script drives, without a network or an account. They run on macOS and Linux:

```sh
npm run build
CLAUDE_CONFIG_DIR="$(mktemp -d)" node scripts/live-session.mjs --claude "$PWD/tests/fixtures/live-session/claude.cjs"
node scripts/live-session.mjs --codex "$PWD/tests/fixtures/live-session/codex.cjs"
CLAUDE_CONFIG_DIR="$(mktemp -d)" node scripts/live-session.mjs --claude "$PWD/tests/fixtures/live-session/claude.cjs" --codex "$PWD/tests/fixtures/live-session/codex.cjs"
```

For the qualification, the stand-in is the suite's own scripted app-server, [`codex-qualify.cjs`](../tests/fixtures/codex-qualify.cjs), which answers each probe as a Codex runtime with a working sandbox would. It runs the write probes' commands in a pretend sandbox, and, as Codex 0.163.0 did in the first live run, it refuses an interrupt sent before the reply streams:

```sh
node scripts/live-session.mjs --qualify --codex "$PWD/tests/fixtures/live-session/codex-qualify.cjs"
```

Topsl gives a runtime only a fixed list of environment variables, so the stand-in's failure modes need a wrapper. This one never calls the reader, and its run fails with `Not passed: candidate-reader.` and the reviewer role blocked:

```sh
standin="$(mktemp -d)/codex-skips-reader"
printf '#!/bin/sh\nFIXTURE_READER=skip exec node "%s" "$@"\n' "$PWD/tests/fixtures/codex-qualify.cjs" > "$standin" && chmod +x "$standin"
node scripts/live-session.mjs --qualify --codex "$standin"
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
| 16 October 2026 | Claude Code 2.1.300 (Homebrew) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `f7cab45` (trust fix) | **Passed.** Claude Code again selected **No, exit** first, as the report's `folderTrustDefault` shows; the script moved to **Yes, I trust this folder** and confirmed it. Claude Code answered the prompt with the sum after 3 seconds. `/exit` ended the session with code 0, Topsl recorded the run as `completed` with the process gone, and the imported transcript had Claude's reply |
| 16 October 2026 | Claude Code 2.1.300 (Homebrew), handing off to Codex CLI 0.163.0 (npm) | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `f7cab45` | **Passed.** The Claude Code step passed as in the run before, with the sum after 3.5 seconds. Topsl's reviewed handoff carried the two messages of Claude Code's conversation, including its reply (431 characters). With the handoff attached and **Send the reviewed context to Codex?** approved, `gpt-6.1-sol` in **Read-only review** answered with Claude Code's number plus the new one after 10.1 seconds. The run ended `completed`, no approval was requested, Topsl stored one usage record, and the imported conversation kept one reply from each provider |
| 16 October 2026 | Stand-ins for the runtime qualification | Linux x64 cloud container, `xvfb-run`, Node 22 | `93328aa` (qualification mode) | The qualification stand-in passed: every probe passed in 4 turns, both roles were ready in the readiness query and in the guided setup, and the qualification folder was deleted. A stand-in that never calls the reader failed with `Not passed: candidate-reader.`, with the builder ready and the reviewer blocked by `candidate-reader-unavailable`. A `--model` the stand-in does not report stopped the run before the qualification dialog, with no turns started. Codex alone and both passed again |
| 16 October 2026 | Stand-ins for the runtime qualification | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `8ad7667` | As on Linux. The qualification stand-in passed in 4 turns with both roles ready. The stand-in that never calls the reader failed with `Not passed: candidate-reader.`, with only the reviewer blocked. Both runs deleted their `~/Library/Caches/topsl-qualify-*` folder |
| 16 October 2026 | Codex CLI 0.163.0 (npm package `@openai/codex`), runtime qualification | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `4647087` | **Failed** with `Not passed: read-only, workspace-write, interrupt.` Topsl started 4 turns with `gpt-6.1-sol` on the ChatGPT sign-in, and the suite took 40.7 seconds. `native-subscription`, `structured-turn`, `candidate-reader`, `fresh-session` and `process-lifecycle` passed; for `candidate-reader`, one `read_range` answer returned the marker and the reply quoted it. In the read-only probe the suite accepted Codex's approval request for the sentinel write, and the file was created. In the workspace-write probe it accepted both sentinel writes, and the outside file was created too. Topsl sent the interrupt when the turn's start was reported, and Codex answered `no active turn to interrupt`. The qualification was recorded until 15 November 2026 with both roles blocked by `permission-profile-unverified`. The folder in `~/Library/Caches` was deleted and the profile was kept |
| 16 October 2026 | Stand-in for the runtime qualification | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `aae71ea` (probe fix) | Passed. Topsl recorded `codex-runtime-qualification/v3` with every probe passed in 4 turns and no approval requests, both roles were ready, and the `~/Library/Caches/topsl-qualify-*` folder and the profile were deleted |
| 16 October 2026 | Codex CLI 0.163.0 (npm package `@openai/codex`), runtime qualification | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `aae71ea` (probe fix) | **Failed** with `Not passed: candidate-reader, read-only, workspace-write.` Topsl started 4 turns with `gpt-6.1-sol` on the ChatGPT sign-in, and the suite took 76.2 seconds. `native-subscription`, `structured-turn`, `fresh-session`, `interrupt` and `process-lifecycle` passed; the interrupt went out after the reply's first streamed text and ended the turn. With approvals off, Codex asked for no approval. It reported no command in the read-only probe and only the inside write, which completed, in the workspace-write probe, so no file was created where the policy forbids one and the sandbox was not tested. For `candidate-reader`, one `read_range` answer returned the marker, but the reply did not quote it. The qualification was recorded until 15 November 2026 with the builder blocked by `permission-profile-unverified` and the reviewer also by `candidate-reader-unavailable`. The folder in `~/Library/Caches` was deleted and the profile was kept |
| 16 October 2026 | Stand-in for the runtime qualification | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `a756265` (rework) | Passed. Topsl recorded `codex-runtime-qualification/v4` with every probe passed in 3 turns and no approval requests, both roles were ready, and the `~/Library/Caches/topsl-qualify-*` folder and the profile were deleted |
| 16 October 2026 | Codex CLI 0.163.0 (npm package `@openai/codex`), runtime qualification | macOS, Apple silicon (`darwin/arm64 27.0.0`) | `a756265` (rework) | **Failed** with `Not passed: candidate-reader.` Topsl started 3 turns with `gpt-6.1-sol` on the ChatGPT sign-in, and the suite took 52.7 seconds. `read-only` and `workspace-write` passed as policy-enforced: with no model turn, Topsl's write into the workspace under the read-only policy and its write outside the workspace under workspace-write both exited with code 1 (`Operation not permitted`), while the control command and the inside write ran, and no file appeared where the policy forbids one. `native-subscription`, `structured-turn`, `fresh-session`, `interrupt` and `process-lifecycle` passed too. For `candidate-reader`, one `read_range` answer returned the marker, but the reply began `I couldn’t recover the line from the tool result.` The qualification was recorded until 15 November 2026 with the builder ready and the reviewer blocked by `candidate-reader-unavailable`. The folder in `~/Library/Caches` was deleted and the profile was kept |

On 16 October 2026, on one Mac, Codex passed at `d8eda1e`, and Claude Code alone and the handoff from Claude Code to Codex passed at `f7cab45`. Claude Code's four earlier live runs failed: twice because of how the script handled its folder trust prompt (fixed in `c660a1b` and `73a9233`), and twice because the endpoint set in its own configuration refused the prompt with API error 403. Each pass covers that Mac, those provider versions and one prompt per provider; [What a pass does not establish](#what-a-pass-does-not-establish) lists what it leaves open.

The runtime qualification's one live run, on the same Mac at `4647087`, failed. Every write that landed had first been approved by the suite. A real review run declines every approval ([manager.ts](https://github.com/Piore-Galore/Topsl/blob/4647087/packages/runtime/manager.ts#L1026-L1030)), and the stand-in assumed that an approved command still runs inside the sandbox, so the two sandbox probes measured the approval rather than the sandbox. That Codex runs an approved command outside its sandbox when the sandbox blocks it is inferred from this result, not observed: the report does not record how Codex ran each command. That Codex accepts an interrupt only some time after it reports the turn started is also an inference. The owner started this run in Terminal, because Claude Code's auto mode on that Mac refused the command (`Create Unsafe Agents`) each of the four times it was asked to run it. The [live run record](Codex_Workflows_Plan.md#live-run-16-october-2026) has the details. The [probe fix](Codex_Workflows_Plan.md#step-6-follow-up-sandbox-and-interrupt-probes-16-october-2026) that followed turns approvals off for the two sandbox probes and sends the interrupt once the reply streams. Its one live rerun, at `aae71ea`, passed the interrupt and failed `candidate-reader`, `read-only` and `workspace-write`. With approvals off, the model did not attempt the writes the sandbox should block, so the sandbox was not tested, and its reply left out the reader's marker, which the first run's reply had quoted. The [rerun record](Codex_Workflows_Plan.md#live-rerun-16-october-2026) has the details and the rework the owner approved next. That rework runs both sandbox writes itself through Codex's `command/exec`, with no model, and gives the reader its own turn. Its one live run, at `a756265`, passed both sandbox probes as policy-enforced and the interrupt, and failed only `candidate-reader`: Codex called the reader and got the marker, but the reply said it could not recover the line. The [live run record](Codex_Workflows_Plan.md#live-run-of-the-rework-16-october-2026) has the details.
