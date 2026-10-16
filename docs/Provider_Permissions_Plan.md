# Provider permissions plan

Plan for letting the owner choose the permissions of each Claude Code and Codex session Topsl starts, using each provider's own modes, and for showing which mode Topsl asked for. The project owner approved it on 16 October 2026 with every recommendation under [Decisions](#decisions). Progress and validation for each step are recorded under [Delivery record](#delivery-record).

Code links are pinned to `10b95cb`, the `main` commit the plan was written against, because their line numbers drift as the steps land.

## Goal

When the plan is done, the owner can:

- Choose a permission mode when Topsl opens a Claude Code or Codex terminal, or leave it to the provider's own settings, which stays the default.
- Choose from four Codex chat presets instead of two, including one that runs commands in the workspace sandbox without asking.
- See on each run which mode Topsl asked for and, for a Codex chat, the approval policy and sandbox Codex reports it adopted.
- Start a terminal in a bypass mode only after confirming it in Topsl's own dialog, each time.

Out of scope: workflow roles and the runtime qualification, which keep the profiles they were qualified with; the Claude structured route, which stays refused; editing native settings files, which Topsl's configuration editor already does with a preview; reading managed policy; and Windows sandboxing.

## Where it stood

At `10b95cb`, Topsl passed no permission settings to a terminal, and Codex chats had two fixed presets.

| Session Topsl starts | What Topsl passes | What decides permissions |
| --- | --- | --- |
| Claude Code terminal | `claude` with no arguments, in the project folder ([manager.ts:1174-1292](https://github.com/Piore-Galore/Topsl/blob/10b95cb/packages/runtime/manager.ts#L1174-L1292)) | Claude Code's own settings. Its built-in starting mode for interactive sessions has been auto since 2.1.283 ([permission modes](https://code.claude.com/docs/en/permission-modes)) |
| Codex terminal | `codex` with no arguments, through the same code | Codex's own `config.toml` |
| Codex chat, **Read-only review** | Sandbox read-only and approval policy `untrusted` ([codex.ts:221-297](https://github.com/Piore-Galore/Topsl/blob/10b95cb/packages/providers/codex.ts#L221-L297)) | Topsl declines every approval request ([manager.ts:1026-1030](https://github.com/Piore-Galore/Topsl/blob/10b95cb/packages/runtime/manager.ts#L1026-L1030)) |
| Codex chat, **Workspace edits · ask** | Sandbox writable in the workspace only, no network, `untrusted` | The owner decides each approval request, one at a time |
| Workflow roles and the qualification | The same two profiles as the chats | The qualification covers exactly these two profiles |

The approval card showed the raw request as JSON, with **Deny** and **Review & allow once** ([main.tsx:1214-1248](https://github.com/Piore-Galore/Topsl/blob/10b95cb/apps/desktop/renderer/main.tsx#L1214-L1248)). It did not say what allowing does. The first live qualification, on 16 October 2026, suggested that Codex 0.163.0 runs an approved command outside its sandbox when the sandbox blocks it; that is an inference, not confirmed. A file change's `grantRoot`, which asks for write access to a folder for the rest of the session, was not shown on its own ([codex.ts:421-442](https://github.com/Piore-Galore/Topsl/blob/10b95cb/packages/providers/codex.ts#L421-L442)).

## Terminals

When Topsl opens a terminal for a project, the owner picks a mode from the provider's own list. **Provider default** passes nothing, as today, and is preselected. Topsl builds the arguments from a fixed table, so no free text reaches the command line, and records the chosen mode on the run.

Claude Code, through `--permission-mode` ([CLI reference](https://code.claude.com/docs/en/cli-reference) and [permission modes](https://code.claude.com/docs/en/permission-modes), read on 16 October 2026):

| Mode in Topsl | Passed to `claude` | What Claude Code does, per its docs |
| --- | --- | --- |
| Provider default | Nothing | Its own settings decide; auto unless they say otherwise |
| Manual | `--permission-mode default` | Asks on the first use of each tool |
| Plan | `--permission-mode plan` | Reads and plans; edits stay blocked until the plan is approved |
| Accept edits | `--permission-mode acceptEdits` | Accepts file edits and common file commands in the working folders, and asks for the rest |
| Auto | `--permission-mode auto` | Runs without routine prompts; a classifier reviews each action first. Needs a supported plan and model, and an admin can turn it off |
| Don't ask | `--permission-mode dontAsk` | Refuses anything that would prompt; only pre-approved tools and reads run |
| Bypass (advanced) | `--permission-mode bypassPermissions` | Skips prompts. Its docs say to use it only in isolated environments, and that it offers no protection against prompt injection |

Codex CLI 0.163.0, through its own flags (`codex --help`):

| Mode in Topsl | Passed to `codex` | What Codex does, per its help |
| --- | --- | --- |
| Provider default | Nothing | Its `config.toml` decides |
| Read-only | `-s read-only -a on-request` | Commands cannot write; the model decides when to ask |
| Workspace, ask when needed | `-s workspace-write -a on-request` | Writes only in the workspace; the model decides when to ask |
| Workspace, never ask | `-s workspace-write -a never` | Never asks; a command the sandbox blocks fails and the model is told |
| Workspace, automatic review | `--approve-for-me` | Uses the workspace-write sandbox and sends approval requests to Codex's automatic review instead of the owner |
| Full access (advanced) | `--dangerously-bypass-approvals-and-sandbox` | No prompts and no sandbox. Its help calls this extremely dangerous and meant for environments sandboxed from outside |

Managed settings win over all of these. If the provider refuses a mode, the terminal shows the provider's own message, and Topsl does not try another mode. When Topsl opens Claude Code for a review handoff, it uses **Plan**, so the handoff's instruction not to modify the workspace is backed by Claude Code's own rules ([assisted.ts:116-119](https://github.com/Piore-Galore/Topsl/blob/10b95cb/packages/workflows/assisted.ts#L116-L119)). Plan mode is not an operating-system sandbox.

## Codex chats

Chats gain two presets between today's two. The new ones change only the approval policy; the sandbox stays the workspace, with no network.

| Preset | Sandbox | Approval policy | Who decides |
| --- | --- | --- | --- |
| Read-only review (today) | Read-only | `untrusted` | Topsl declines every request |
| Workspace edits · ask (today) | Workspace only, no network | `untrusted` | The owner, before any command outside Codex's known-safe list |
| Workspace edits · ask when needed | Workspace only, no network | `on-request` | The owner, when the model asks for more access |
| Workspace edits · no asking | Workspace only, no network | `never` | Nobody: the sandbox has the last word, and a blocked command fails |

**No asking** is offered only for a runtime whose current qualification passed `workspace-write`, because then Topsl has seen that runtime's sandbox block a write outside the workspace. Until a live qualification passes, the preset stays unavailable and the menu says why.

Codex reports the approval policy and sandbox it adopted in its answer to `thread/start`; both are required fields in the protocol schema Codex 0.163.0 generates. Topsl records them on the run and stops before the first prompt when they differ from what it asked, for example because managed requirements changed them. At `10b95cb`, Topsl did not read them.

## Approvals

The approval card says what allowing does, in words, before the raw request:

- The command and folder, or the files a change touches, as plain text. The JSON stays available behind a disclosure.
- For a command, **Review & allow once** lets Codex run it. Codex 0.163.0 appeared to run an approved command outside its sandbox when the sandbox blocked it, so the card says the command may run with the owner's own access. It labels this as seen once in a live qualification and not confirmed by Codex's documentation.
- For a file change with `grantRoot`, the card names the folder and says that allowing also lets Codex write there for the rest of the session.
- **Deny** stays first. There are still no session-wide or lasting choices; design section 11.5 treats a lasting rule as a separate configuration change.

Review chats keep declining every request without asking.

## Bypass modes

Claude Code's **Bypass** and Codex's **Full access** are offered only for terminals, under **Advanced**, and only on purpose:

- Choosing one opens Topsl's own confirmation dialog every time, naming the exact flag and quoting the provider's warning. As with Topsl's other trusted dialogs, the renderer cannot skip it.
- Topsl never remembers one as a project's default, never starts one for a workflow, a handoff, a qualification or a chat, and never writes one into a handoff or task file (design section 11.6).
- No code path picks one after a failure, a refusal or a safety check. Design section 11.3 says an advanced option "must not be chosen automatically to overcome an integration failure". A test checks that only the owner's choice plus a confirmation produces these flags.
- If managed settings disable the mode, the provider refuses it in the terminal, and Topsl leaves it at that.

## What Topsl will still not claim

- A mode Topsl asked for is not proof of the policy in force. For terminals, Topsl reports only what it passed; Claude Code shows its mode in its own status bar. Managed settings can override either provider.
- Plan, Manual, Don't ask and Accept edits are Claude Code's permission rules, not an operating-system sandbox. Claude Code's own sandbox is off by default and covers only shell commands ([sandboxing](https://code.claude.com/docs/en/sandboxing)).
- A Codex qualification with suite v4 shows Codex's sandbox blocking a write Topsl ran through it, not a model's own command.
- Nothing here changes how workflows are qualified, and none of it is a way around a provider's safety checks.

## Build steps

Four pull requests, in this order, after the Codex workflows plan's open pull requests. Each updates the docs it affects, passes its tests and both CI workflows, and is merged only on the owner's word. Steps 1 to 3 send no model requests.

1. **Approval card.** The command, folder and files in plain words, the sandbox note, and `grantRoot` named. Proof: renderer and desktop tests for a command request and for a file change with `grantRoot`.
2. **Terminal modes.** The mode menu, the fixed argument tables, Plan for Claude review handoffs, the Advanced section with its confirmation, and the mode on the run record. Proof: tests of the exact arguments for every mode, which `terminal()` has never had; refusal of an unknown mode; a bypass flag only after a confirmation and never from a workflow, handoff or retry path; a desktop test that opens the Claude stand-in in Plan.
3. **Codex chat presets.** The two new presets, the qualification gate for **No asking**, and the check of what Codex reports at `thread/start`. Proof: stand-in tests of each preset's `thread/start` and `turn/start` fields, the gate with and without a passing qualification, and a refusal when Codex reports a different policy.
4. **Live check.** On the owner's Mac, started by the owner in Terminal: a Claude Code terminal in Plan and a Codex terminal in Read-only with one short prompt each, and one Codex chat in **Ask when needed**. Proof: the live session reports, recorded in [Live provider sessions](Live_Provider_Sessions.md).

## Decisions

Approved on 16 October 2026, each with the recommended option:

1. **Bypass modes:** offered for terminals only, under Advanced, with a confirmation every time. Not chosen: leaving them out for now.
2. **No-asking chats:** offered only on a runtime whose current qualification passed `workspace-write`. Not chosen: always, with a warning; or not at all.
3. **Remembering the choice:** each project remembers its last ordinary mode per provider, never a bypass mode. Not chosen: every terminal starting at Provider default.
4. **Workflows:** they keep their qualified profiles, and Claude review handoffs open in Plan. Not chosen: a mode per role, which needs a qualification per profile.
5. **Live check:** three short prompts on the owner's Mac, started by the owner in Terminal, after step 3. Not chosen: stand-ins only.

## Delivery record

Each step adds its changes and validation here when it lands.

### Step 1: approval card (16 October 2026)

Built from `main` at `4b9f93e` while the Codex workflows plan's last three pull requests were still open. As the build order says, it merges after them.

**What changed**

- Codex approval requests are described in plain words. [codex-approvals.ts](../packages/providers/codex-approvals.ts) builds a summary from the fields Codex 0.163.0 sends, the Codex adapter attaches it to each request ([codex.ts](../packages/providers/codex.ts)), and the approval record stores it as `summary` ([types.ts](../packages/domain/types.ts)).
  - A command request (`item/commandExecution/requestApproval`) shows the command, its folder, the environment, the host and protocol of a network request, any extra file system or network access Codex asks for, and Codex's reason. Input for a running command (`kind: "writeStdin"`) has its own title.
  - A file change request (`item/fileChange/requestApproval`) names only its item. The runtime manager therefore keeps the file changes Codex reports starting in the run's thread and turn, at most 200, with each diff reduced to its SHA-256 digest ([manager.ts](../packages/runtime/manager.ts)). The card lists the files the change creates, edits, deletes or moves, or says that Codex did not report them. A `grantRoot` is shown as the folder Codex asks to write under.
  - Text from Codex is shown with control, zero-width, direction and tag characters written as escapes such as `\u{202e}`, and a long value is cut with a count of what was left out. A folder, file, host or permission also has its line breaks and tabs escaped, so it cannot pass for another line; a command and Codex's reason keep theirs.
- The approval card ([approval-card.tsx](../apps/desktop/renderer/components/approval-card.tsx)) shows the action, the details and what allowing does, then the request as Codex sent it under **Request as sent**. **Deny** stays first. What allowing does:
  - the command runs once, the input is sent once, or the change is applied once;
  - any extra permissions listed are granted with it;
  - for a command, the sandbox note: Codex 0.163.0 appeared to run an approved command outside its sandbox when the sandbox blocked it, so the command may run with the owner's own access. The note says that Topsl saw this once, in a live qualification on 16 October 2026, and that Codex's documentation does not confirm it;
  - a `grantRoot` also lets Codex write under that folder for the rest of the session;
  - when Codex proposes a lasting rule, allowing once does not add it. Topsl still answers only `accept` or `decline`.
- **Review & allow once** still opens Topsl's trusted confirmation, which now shows the same text before the run, request and digest ([approval-text.ts](../packages/domain/approval-text.ts)). A value on several lines is indented there, so none of its lines can pass for Topsl's own text.
- A file change's approval digest also covers the change as Codex reported it, so the approval is bound to the files the card shows.
- An approval without a summary, such as one recorded before this change, shows its raw request as before. Review chats still decline every request without showing a card.
- [`scripts/codex-schema-subset.mjs`](../scripts/codex-schema-subset.mjs) adds both approval requests, their responses and `item/started` to the [schema subset](../tests/fixtures/codex-app-server-0.163.0.schema.json) the tests check against; the definitions already there are unchanged. The scripted stand-in ([codex.cjs](../tests/fixtures/codex.cjs)) answers `--version`, so the desktop test can register it, and its prompt `file approval` starts a file change and asks to approve it with a `grantRoot`.

**Validation** (16 October 2026, Linux x64 container, `main` at `4b9f93e` plus this change)

- `npm run typecheck` passed.
- `npm test -- tests/approvals.test.ts`: 11 tests passed. The summaries, and every approval frame the stand-in and Topsl exchanged, match the schema Codex 0.163.0 generates. With the line-break escapes, the confirmation's indentation and the diff digests removed, the 4 tests that cover them failed.
- `npm run check` passed on `caf3272`: typecheck, 353 tests passed and 4 skipped in 42 files (the skipped ones need a real Codex or the stress flag), the release tests and the build.
- `xvfb-run --auto-servernum npm run test:desktop` passed on `caf3272`, including encrypted restart persistence. Through Topsl's screens it registers, trusts and connects the stand-in, starts a chat in **Workspace edits · ask**, denies a command approval from its card, and allows a file change from its card through the confirmation, whose text it checks. The stand-in replied with each decision it received: `decline`, then `accept`.
- No model requests were sent. Not established: how a live Codex fills these fields, which step 4 covers. The sandbox note is still an inference from one live run. macOS and Windows depend on CI.

**Follow-up: macOS Intel desktop test** (16 October 2026)

- After `main` was merged in at `72b96aa`, the [macOS Intel desktop test failed](https://github.com/Piore-Galore/Topsl/actions/runs/38917064747/job/117027139435): the **Change files** card was still showing 5 seconds after **Review & allow once**. The same test had passed on macOS Intel at `9e02b43`, and the merge brought in only qualification code.
- Cause: the card goes, and the transcript shows the stand-in's reply, only once the service has committed the decision and the stand-in's turn, and the vault syncs each commit to disk (`synchronous=FULL` in [store.ts](../packages/persistence/store.ts)). In the Linux container the round trip took 124 ms, or 257 ms on one CPU. With every sync in the service slowed by 800 ms (`strace -f -p <service pid> -e trace=fsync,fdatasync -e inject=fsync,fdatasync:delay_exit=800000`, attached from a local hook that paused the test before the click), it took 11 seconds, and the unchanged test failed with the same error at the same step.
- Fix: the chat steps that wait on a committed turn allow 30 seconds ([desktop-test.mjs](../scripts/desktop-test.mjs)): each card appearing and going, the transcript's `decline` and `accept`, and the lease release between the turns. With every sync slowed by 800 ms from the first turn, both turns were decided in 64 seconds and the desktop test passed, as it did at normal speed.

### Step 2: terminal modes (16 October 2026)

Built on step 1's branch, `claude/provider-permissions` at `a049284` (`main` at `c5d0700` merged in), because both steps change the same files. It merges after step 1.

**What changed**

- [terminal-modes.ts](../packages/domain/terminal-modes.ts) holds the two tables under [Terminals](#terminals): each mode's name, the exact arguments, what the provider says the mode does and, for **Bypass** and **Full access**, the provider's own warning. The arguments were checked against Claude Code's [permission modes](https://code.claude.com/docs/en/permission-modes) page and `codex --help` from Codex CLI 0.163.0 on 16 October 2026. That page now lists auto mode for all plans, so Topsl says Auto needs a supported model, and that where an administrator turns it off, Claude Code starts in Manual instead. No other product source file contains a bypass flag, and a test checks that.
- **Native terminal** on the Workspace page, and **Open folder** with a command-line runtime under Projects, have a **Terminal mode** menu with the provider's modes. **Bypass** or **Full access** sits under **Advanced**. Under the menu, Topsl says what it passes and what the mode does. **Provider default**, which passes nothing, stays selected until the owner opens a terminal in another mode.
- The runtime manager takes the arguments only from the table and refuses an unknown mode, another provider's mode, and a mode on a login terminal ([manager.ts](../packages/runtime/manager.ts)). The terminal's run records `permissionMode` and `permissionArgs`, exactly what Topsl passed, and the terminal's heading and the run's line show them.
- **Bypass** and **Full access** open Topsl's own warning dialog every time, in the main process before the request reaches the service ([main.ts](../apps/desktop/main.ts)). The dialog names the executable, the folder and the exact flag, and quotes the provider's warning; **Cancel** is the default. Only the owner's answer sets the confirmation the runtime manager requires for that exact mode, so the window cannot skip it, and declining starts nothing.
- Each project remembers the last ordinary mode per provider in a `terminal-mode-preference` record on this device, never a bypass mode. After each open, the menu returns to the remembered mode.
- When Topsl opens Claude Code for an assisted review handoff, it passes Plan. Build handoffs and Codex handoffs pass nothing, as before. Handoffs, workflows, the qualification and chats never pass a bypass mode, and nothing picks a mode after a failure: when a runtime refuses a mode, the terminal shows its message and the session ends.
- Claude Code's documentation says that Plan's blocks do not hold in an interactive session where bypass permissions are available, for example when the owner's Claude Code settings make bypass the default mode. Topsl does not read those settings, so a Plan handoff is backed by Claude Code's rules only when they are not set that way.
- A desktop app opened from Projects gets no mode from Topsl, and the service refuses one.
- The [terminal stand-in](../tests/fixtures/terminal-stand-in.cjs) prints the arguments it received and exits with a refusal for `--permission-mode auto`, standing in for a runtime that refuses a mode.

**Validation** (16 October 2026, Linux x64 container, `fea5b36` on step 1's branch at `a049284`)

- `npm run check` passed on `fea5b36`: typecheck, 366 tests passed and 4 skipped in 43 files (the skipped ones need a real Codex or the stress flag), the release tests and the build.
- [terminal-modes.test.ts](../tests/terminal-modes.test.ts) has 12 tests. Five check the tables: each mode's exact arguments; an unknown mode and another provider's mode are refused; only **Bypass** and **Full access** are bypass modes, and a handoff uses neither; the confirmation names the executable, the folder, the flag and the provider's warning; and no other file under `apps`, `packages` or `scripts`, apart from tests, contains a bypass flag. Seven run the service with the terminal stand-in as both Claude Code and Codex: every mode starts the executable with exactly its arguments, recorded on the run; a bypass mode starts only with the confirmation of that mode and is never remembered; each project remembers its last ordinary mode per provider; **Open folder** passes the chosen mode, and a desktop app takes none; a login terminal takes no mode; a mode the runtime refuses ends that terminal and Topsl starts no other; a Claude Code review handoff opens in Plan, and a build handoff passes nothing.
- The schema test in [projects.test.ts](../tests/projects.test.ts) now expects the default `permissionMode` on `project-open`, and that a mode which is not one of Topsl's ids is refused.
- Mutation check on `fea5b36`, each change made alone and reverted: with the table's arguments ignored, 5 of the 12 tests failed; without the runtime manager's confirmation check, 2; with bypass modes remembered, 1; with the review handoff not opening in Plan, 2.
- `xvfb-run --auto-servernum npm run test:desktop` passed on `fea5b36`, including encrypted restart persistence. Through Topsl's screens, with the terminal stand-in registered as Claude Code: the **Terminal mode** menu lists Claude Code's modes with **Bypass** alone under **Advanced**; a terminal opened in Plan shows `--permission-mode plan` in the stand-in's output and in the terminal's heading (the test's screenshot is `test-results/terminal-mode.png`, which is not committed), and the menu returns to Plan; **Bypass** declined in Topsl's warning starts nothing; **Bypass** confirmed starts with `--permission-mode bypassPermissions`; both runs record what was passed, and the project still remembers Plan after the restart. These waits allow 30 seconds, as in step 1's follow-up.
- No model requests were sent, and no real Claude Code or Codex was started in any mode. Not established: how each provider treats these modes under the owner's own settings, which step 4 covers. The service and desktop terminal tests use a shell wrapper and do not run on Windows, so there only the table tests run. macOS and Windows depend on CI.
