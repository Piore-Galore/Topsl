# Claude workflows plan

Plan for running Topsl's **Build and review** workflow with Claude Code as builder, reviewer or both. Each Claude step runs in Claude Code's own terminal under the owner's login; Topsl hands it the input and takes the result. The plan starts with the live Codex-only workflow run that the [Codex workflows plan](Codex_Workflows_Plan.md#decisions) left for a later decision. The project owner approved it on 17 October 2026 with every recommendation under [Decisions](#decisions). Progress and validation for each step are recorded under [Delivery record](#delivery-record).

Code links are pinned to `1b81a49`, the `main` commit the plan was written against, because their line numbers drift as the steps land.

## Goal

When the plan is done, the owner can pick any of four teams in Build and review and run it to a result that they accept or reject.

| Team | Builder | Reviewer |
| --- | --- | --- |
| Codex builds · Codex reviews | Codex, run by Topsl | A fresh Codex session, read-only |
| Claude builds · Codex reviews | Claude Code, in its own terminal | A fresh Codex session, read-only |
| Codex builds · Claude reviews | Codex, run by Topsl | Claude Code in Plan, on a read-only copy of the build |
| Claude builds · Claude reviews | Claude Code, in its own terminal | A fresh Claude Code session in Plan, on a read-only copy |

Codex steps and the required checks run inside Topsl as they do today. Each Claude step runs in the unmodified Claude Code under the owner's own login, in a terminal Topsl opens. The owner pastes the step's instructions, which Topsl copies for them, and uses Claude Code as usual. After exiting Claude Code, the owner confirms that it has stopped and hands back Claude's reply, which becomes that step's result, and the workflow moves on. The required checks and the owner's explicit acceptance still decide the result, as they do for Codex.

Each team then gets one live run on the owner's Mac. The first is the Codex-only run that the Codex workflows plan left for the owner to decide (its decision 5).

Out of scope: running Claude Code headless (`claude --print`), the structured route [design section 8.2](Topsl_Design.md#82-claude-code-native-adapter) describes, which stays gated until it has an approved authentication and billing route ([claude.ts:315-329](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/providers/claude.ts#L315-L329)); the Agent SDK with a subscription login, which [design section 3](Topsl_Design.md#3-subscription-and-authentication-boundaries) rules out; Topsl typing into Claude Code or answering its questions, which only the live script does, for its own runs; folders where a reviewer's tests may write ([design section 11.3](Topsl_Design.md#113-task-presets)); isolation between builder and reviewer beyond what each tool enforces; Windows; packaged apps.

## Where it stood

At `1b81a49`, a team with Claude Code in either role could not run. What existed was a manual handoff that sat beside the workflow.

**What already worked**

- Topsl opened Claude Code in its own terminal under the owner's login, in the mode Topsl passed. A review handoff opened in Plan ([terminal-modes.ts:166-173](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/domain/terminal-modes.ts#L166-L173)). The live check in [pull request #19](https://github.com/Piore-Galore/Topsl/pull/19) passed Claude Code 2.1.300 in Plan on 17 October 2026.
- A live Codex runtime qualified for both roles in a disposable profile on 16 October 2026 ([results](Live_Provider_Sessions.md#results)).
- Topsl already read Claude Code transcripts for history import, and checked each record's session and folder ([reconcile.ts:140-181](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/history/reconcile.ts#L140-L181)).

**What stopped a team with Claude**

1. **A Claude role blocked the whole team before any turn.** Topsl refused Claude's structured route with `authentication-route-unapproved` ([manager.ts:277-283](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/runtime/manager.ts#L277-L283)), and the workflow checked both roles before every turn, the first build included ([builder-reviewer.ts:517-534](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/builder-reviewer.ts#L517-L534)).
2. **The manual handoff never moved the workflow.** The owner could prepare a handoff, open Claude Code and import its report, but the report was kept as evidence only, with `acceptanceEligible: false`, and the workflow never read it ([assisted.ts:281-298](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/assisted.ts#L281-L298)).
3. **Results came back only by pasting.** The import form always sent `user-supplied` ([assisted-handoff.tsx:139](https://github.com/Piore-Galore/Topsl/blob/1b81a49/apps/desktop/renderer/components/assisted-handoff.tsx#L139)). The service accepted `native-import` too ([commands.ts:141](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/domain/commands.ts#L141)), but nothing produced it.
4. **A Claude reviewer saw excerpts and the live folder.** The handoff carried bounded excerpts of the build ([assisted.ts:105-110](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/assisted.ts#L105-L110)), and Claude Code opened in the project folder, which could change during the review ([service.ts:603-614](https://github.com/Piore-Galore/Topsl/blob/1b81a49/apps/service/service.ts#L603-L614)). A Codex reviewer worked in a fresh copy instead ([builder-reviewer.ts:599](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/builder-reviewer.ts#L599)).
5. **Claude could not review Claude.** The setup screen offered three teams: Codex with Codex, and Codex with Claude either way ([workflow-setup.tsx:8-12](https://github.com/Piore-Galore/Topsl/blob/1b81a49/apps/desktop/renderer/components/workflow-setup.tsx#L8-L12)).
6. **No live workflow had run, and the live script could not run one.** It ran a chat, a handoff from Claude Code to Codex, or a qualification ([live-session.mjs:32](https://github.com/Piore-Galore/Topsl/blob/1b81a49/scripts/live-session.mjs#L32)). The live builder-and-reviewer acceptance tests, R2-AT-37 and R2-AT-38, were still pending ([Live provider sessions](Live_Provider_Sessions.md)).

## How a Claude step runs

A Claude role becomes a step of the workflow that the owner runs: Topsl prepares it and records it as that stage's turn, the owner runs it in Claude Code, and Topsl takes the result once Claude Code has stopped.

1. **Waiting for Claude Code.** When the workflow reaches a Claude step, it stops, and the workflow page says which step is next and what it needs. Nothing runs until the owner opens it.
2. **Open in Claude Code.** One click copies the step's instructions and opens Claude Code in Topsl's terminal, with a new session id that Topsl records.
   1. A build or repair opens in the project folder in Claude Code's own default mode, as builder handoffs open today ([terminal-modes.ts:166-173](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/domain/terminal-modes.ts#L166-L173)), which is whatever Claude Code's own settings start in. The owner can pick another ordinary mode on the button; Topsl never passes a bypass mode for a workflow step.
   2. A review opens in Plan, in a fresh copy of the captured build whose files and folders are read-only.
3. **The owner runs it.** The owner pastes the instructions and works with Claude Code as usual. Its permission prompts, folder trust and slash commands are unchanged, and Topsl answers none of them. Each review copy is a new folder, so Claude Code asks its folder trust question; Claude Code 2.1.300 selects **No, exit** first. If Claude Code offers to approve a plan during a review, the answer is **No, keep planning**.
4. **Hand back the result.** After Claude Code exits, the owner confirms that it has stopped and pastes Claude's final reply. With the transcript read turned on, Topsl takes that reply from the session's transcript instead. Until Topsl has a valid reply, the step waits: the owner can open Claude Code again, paste the reply, or cancel the workflow.
5. **The workflow continues.** After a build or repair, Topsl captures the folder as the new build, as it does after a Codex build. After a review, Topsl checks that the copy is unchanged and reads the findings, each of which must name a file and line in the build. Repairs (at most two, each started by the owner), the required checks and the owner's acceptance follow as today.

The instructions carry the specification, the acceptance criteria, any findings to repair and the reply format. A reviewer's instructions also say that the required checks run separately in Topsl, so it should not run commands that write. The instructions no longer carry file excerpts, because Claude Code reads the files in the folder it opens.

**Safeguards**

- **A Claude step counts like a Codex turn, with the same checks.** Topsl records it as that stage's turn, so the folder may change only during a build or repair, and a change at any other time stops the workflow ([builder-reviewer.ts:406-418](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/builder-reviewer.ts#L406-L418), [1925-1939](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/builder-reviewer.ts#L1925-L1939)). Topsl takes a review only if it names the build it reviewed and each finding names a file and line in that build, as the manual handoff checks today ([assisted.ts:228-279](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/assisted.ts#L228-L279)); otherwise the step keeps waiting and says why. If the specification changed or the build was replaced during the step, the result is kept as evidence and the workflow stops.
- **One writer at a time, until the owner says it stopped.** No Topsl-run writer starts while a Claude build or repair step holds the folder ([manager.ts:634-648](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/runtime/manager.ts#L634-L648)), and a Claude step cannot open while another writer runs ([service.ts:587-599](https://github.com/Piore-Galore/Topsl/blob/1b81a49/apps/service/service.ts#L587-L599)). The hold ends when the owner confirms Claude Code has stopped, as the manual handoff requires today ([assisted.ts:224-227](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/assisted.ts#L224-L227)). Its exit alone is not enough, because a session moved to the background keeps editing after its terminal closes ([agent view](https://code.claude.com/docs/en/agent-view)).
- **A transcript read only when the owner turns it on.** [Design section 14.3](Topsl_Design.md#143-ingestion-priority) allows reading transcripts only when that is enabled. Topsl then reads only the file for the session id it passed, checks that every record names that session and its folder, the project folder or the review copy, and takes Claude's final reply. Claude Code's documentation says the format is internal and changes between versions ([sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)), and Claude Code updates often, so Topsl pins the record shapes its fixtures cover, not version numbers. Anything else falls back to paste, and so does a reply that landed in a new session after `/clear` or `/branch`.
- **The copy, not Plan alone.** Plan is not a sandbox. Where auto mode is available, Claude Code's classifier can approve commands during planning without asking, and Plan's blocks do not hold where bypass permissions are available ([permission modes](https://code.claude.com/docs/en/permission-modes#analyze-before-you-edit-with-plan-mode)). So the copy's files and folders are read-only, and Topsl compares the copy with the build afterwards and blocks a review whose copy changed, as it does for Codex.
- **Provenance on every stage.** Each stage records the provider, that it ran in Claude Code's terminal under the owner's control, the session id, the Claude Code version, the mode Topsl passed, and whether the reply came from the transcript or from the owner. A Claude review is labelled that way, not as a provider's own report, and acceptance shows when the owner pasted a reply.
- **Readiness.** A Claude role is ready for a step when its Claude Code installation and the project are trusted. Signing in stays in Claude Code. Claude's structured route stays gated.
- **Claude reviewing Claude is named plainly.** The setup screen and the workflow page say: "Claude reviews Claude in a fresh Claude Code session. This is not an independent second model."

## Live runs

Each team gets one live run on the owner's Mac through Topsl's own screens, after the same run passes against the stand-ins. Each run needs the owner's go-ahead, the owner starts it in Terminal, and nothing is retried automatically.

| Run | Codex turns, at most | Claude Code sessions |
| --- | --- | --- |
| Codex builds · Codex reviews | 5: 3 to qualify the runtime in the run's profile, 1 build, 1 review | None |
| Claude builds · Codex reviews | 4: 3 to qualify, 1 review | 1 builder session |
| Codex builds · Claude reviews | 4: 3 to qualify, 1 build | 1 reviewer session |
| Claude builds · Claude reviews | None | 2 sessions: builder, then reviewer |

**What the script does.** A new `--workflow <team>` option in [`scripts/live-session.mjs`](../scripts/live-session.mjs):

- Uses a disposable profile and a small seeded project in a new `topsl-live-*` folder under `~/Library/Caches`, deleted afterwards. The project has the shape R2-AT-37/38 describe: a local dependency, a binary file and one required check on the exact build. Claude Code keeps its own record of the run's sessions and of the folders trusted for them, as for any session.
- Starts no repair, so each role runs once. If the review has findings, the run ends at them.
- Answers only Topsl's own dialogs for the run, including the confirmation that Claude Code stopped, and never decides a finding or accepts a result. It declines every approval Codex asks for, every permission prompt Claude Code shows and every offer to approve a plan, and answers Claude Code's folder trust question for the run's folders. Any other question stops the run.
- Pastes each Claude step's instructions once, as the owner would, then exits Claude Code after Claude's reply. Claude builders run in Accept edits and reviewers in Plan. The transcript read is on in the run's profile, so a Claude Code version whose transcript Topsl cannot read stops the run, and the run records that.
- Saves Topsl's workflow record and screenshots. The result goes into [Live provider sessions](Live_Provider_Sessions.md) and [Implementation status](Implementation_Status.md), including a failure.

**What a pass shows.** That team ran once on that Mac, with those versions, through Topsl's own screens: a build, a valid review of that build, and the workflow stopped for the owner, at acceptance if the review found nothing and the check passed, or at the findings. It does not show review quality, independence between the roles, Windows or a packaged app. The two mixed runs do not pass R2-AT-37/38 as written, because those require a qualified route for both roles and Claude's stays gated. They are recorded as assisted runs.

## Build steps

Five pull requests, in this order. Each updates the docs it affects, passes typecheck and its tests, goes green on both CI workflows, and is merged only on the owner's word. Steps 2 to 4 send no model requests; steps 1 and 5 wait for the owner's go-ahead before their live runs.

1. **Live Codex workflow run.** `--workflow codex-codex` in the live script: a disposable profile, the seeded project, a qualification, then one build and one review, with no repair started. This pull request also adds this plan as `docs/Claude_Workflows_Plan.md`. Proof: the stand-in run passes in the container and runs first on the owner's Mac; then one live run of up to 5 Codex turns, recorded with its result.
2. **Claude steps in the workflow.** A Claude builder or reviewer: readiness, the step recorded as that stage's turn, instructions without excerpts, and Claude Code opened with a session id in the project folder, or in Plan in the review copy with read-only files and folders, a folder Topsl's terminal cannot open in today. The step ends on the owner's confirmation and a pasted reply. Proof: workflow tests with the Claude Code terminal stand-in in each role; an exit without a reply, which leaves the step waiting; a stale result and an invalid reply; a changed copy that blocks the review; the writer gate; and a test that no bypass mode reaches a Claude step.
3. **Transcript read, when the owner turns it on.** A setting, off at first. On exit, Topsl reads that one session's transcript, a review session's in its copy included, using the record shapes in Claude Code 2.1.300 fixtures; anything else falls back to paste. Proof: fixture tests for a good reply, the setting off, a missing file, another session or folder, an unrecognized record, and a reply without valid findings.
4. **Claude reviews Claude, and the screens.** The setup screen offers all four teams, with the note for Claude builds · Claude reviews. The workflow page shows each Claude step, its session and how its reply arrived, and acceptance shows when the owner pasted a reply. Proof: a desktop test that runs all four teams against the stand-ins.
5. **Live runs of the three Claude teams.** `--workflow` for each team that includes Claude, checked against the stand-ins first. Proof: one live run each, recorded with its result.

## Decisions

Approved on 17 October 2026, each with the recommended option:

1. **How a Claude role runs:** a step the owner runs in Claude Code's own terminal, recorded as that stage's turn so its build and review count, rather than waiting for an approved structured route. It is the route Topsl allows today, at a few clicks per Claude step. Today's manual handoff keeps a report as evidence only and never adopts its edits ([Round 2 execution](Round_2_Execution.md#acceptance-boundaries)); this changes that for steps inside a workflow.
2. **How Topsl gets Claude's result:** the owner pastes it, recorded as supplied by the owner, and reading the session's transcript is a setting the owner can turn on. Paste always works. The transcript read saves the copying, but design section 14.3 allows it only when enabled, and a format Topsl does not recognize falls back to paste. A pasted review counts, so acceptance shows that it came from the owner.
3. **What the Claude reviewer reads:** a fresh copy of the build with read-only files and folders, in Plan, rather than the live project folder the manual handoff uses. Codex reviewers get the same copy, and Topsl checks it afterwards. Plan alone is not a sandbox.
4. **Claude reviewing Claude:** offered, with the note that it is not an independent second model. The owner asked to verify Claude alone. Like Codex reviewing Codex, it can share the builder's blind spots.
5. **Live runs:** Codex builds · Codex reviews first, up to 5 Codex turns; then each Claude team once, up to 8 more Codex turns and 4 Claude Code sessions; no repairs. Each run proves its team once through Topsl's own screens.

## Delivery record

Each step adds its changes and validation here when it lands.

### Step 1: live Codex workflow run (17 October 2026)

**What changed**

- `node scripts/live-session.mjs --workflow codex-codex --codex <path>` runs the [runtime qualification](Live_Provider_Sessions.md#codex-runtime-qualification) as `--qualify` does, then one build and one review of a seeded project through Topsl's own screens ([live-session.mjs](../scripts/live-session.mjs)). [Live provider sessions](Live_Provider_Sessions.md#codex-builds--codex-reviews) describes each step, and README lists the command. The other teams are refused until Topsl can run a Claude step.
- The seeded project goes into a new `topsl-live-*` folder in `~/Library/Caches` on macOS or `~/.cache` on Linux, which the script deletes after every run. It is the Round 2 receipt project in a live variant (`createDemoFixture({ live: true })` in [round2-demo-fixture.mjs](../scripts/round2-demo-fixture.mjs)): the same local dependency archive, binary logo and `npm run check`, with a one-line reference source, and a task that changes `src/order.mjs` and adds no file.
- In the guided setup, the script fills in the goal and four acceptance criteria, chooses **Locked JavaScript / TypeScript · offline** with the `check` script, and captures the workflow. It approves **Approve captured inputs and start?** once, only when the dialog names the captured workflow, the seeded project's folder and Codex with the selected runtime and model in both roles. Topsl then dispatches the build and, once the build is captured, the review on its own. With no findings, the script approves **Run this required check?** once, only for that check on that build.
- The script declines every approval Codex asks for. It never approves an output file, decides a finding, starts a repair or presses **Review final acceptance**. A run passes when Topsl stops the workflow at acceptance or at the review's findings, after a review of this build, within 5 turns.
- [`tests/fixtures/live-session/codex-workflow.cjs`](../tests/fixtures/live-session/codex-workflow.cjs) is the stand-in. It extends the qualification's scripted app-server, [`codex-qualify.cjs`](../tests/fixtures/codex-qualify.cjs), which now lets a wrapper answer turns the suite does not send.
- A test in [environments.test.ts](../tests/environments.test.ts) runs the seeded project's check through Topsl's check execution with the guided setup's recipe and no writable paths.

**Finding: a check set up through the guided setup cannot write.** Every recipe the guided setup offers has `writablePaths: []` ([environments.ts:336](https://github.com/Piore-Galore/Topsl/blob/1b81a49/packages/workflows/environments.ts#L336)), and no screen adds one, so a check may write nothing in its copy of the build except `node_modules` for a locked recipe and common tool caches. The first stand-in run used the Round 2 project, whose build writes `output/receipt.json`, and its check ended in an error in the integrity phase: `Unexpected execution output outside reviewed writable paths: output`. R2-AT-37/38 sets `output` as writable through the service ([round2-acceptance.test.ts](../tests/round2-acceptance.test.ts)), which the guided setup cannot do. The live variant's build prints the receipt instead, and its check reads it. Topsl itself is unchanged.
