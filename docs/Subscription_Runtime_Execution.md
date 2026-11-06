# Subscription runtime architecture — execution record

This records the work done against the [subscription runtime architecture plan](Subscription_Runtime_Architecture_Plan.md) (the owner's brief, reviewed at `b87f501`). Current behavior is summarized in [Implementation status](Implementation_Status.md#subscription-runtime-architecture--6-november-2026). Everything below is local and synthetic unless it says otherwise. No live Claude, ChatGPT or other provider request was made.

## Phase 0 baseline — 6 November 2026

### Checkout and environment

| Item | Value |
| --- | --- |
| Base commit | `b87f501` (`main`, clean), the plan's reviewed commit; work on branch `claude/subscription-runtime-architecture` |
| Host | macOS 27.0.1 (build 26A434), arm64 |
| Node | v26.0.0 (`package.json` requires `>=22.12.0`) |
| Live runtimes used | None. Claude Code, Codex and every model were stand-ins or synthetic upstreams |

### What the plan's baseline (§3) matches in source

Each claim was checked against the code at `b87f501`, not taken from older documents.

| Plan claim | Source | Finding |
| --- | --- | --- |
| `ExecutionEngine` has `native`, `codex`, `claude-code`; `ExecutionBinding` freezes route, model, account, funding and policy | `packages/harness/types.ts` | Matches. |
| Role groups allow more than two members; default 8, ceiling 64 | `packages/domain/role-groups.ts` (`DEFAULT_MEMBER_LIMIT`, `MEMBER_LIMIT_CEILING`) | Matches. |
| Claude: fresh session per connection, resume rejected, one turn per connection | `packages/providers/claude.ts` (`startSession`) | Matches. |
| Claude: Topsl's tools only on review sessions | `claudeArguments`, `startSession`, `startTurn` | Matches. Since the coordinator-reader change (29 October 2026), a Claude coordinator or information turn that a qualification observed reading also gets the candidate reader (`packages/orchestration/runtime-driver.ts`), always on a review-mode session. |
| Claude: nested `parent_tool_use_id` events rejected | `ClaudeStreamParser` | Matches. |
| Claude: hooks off and no setting sources with Topsl's tools; safe mode otherwise | `claudeArguments` | Matches. |
| Claude: API keys kept out of the environment; a turn reporting `apiKeySource` other than `none` is stopped | `nativeEnvironment()`, `billingConflicts()`, `ClaudeAdapter.start` | Matches. Review item R12 ([native harness plan](Native_Harness_Plan.md#11-review--5-november-2026)) on whether this filtering conflicts with Anthropic's conditions for products that run Claude Code remains open. |
| `claude auth status` read under the same environment as a launch | `readClaudeAccount` (`packages/providers/claude-allowance.ts`) | Matches: both use `nativeEnvironment()`; the profile ID comes from the reported config directory, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| Native child delegation copies the parent's binding | `NativeHarness.delegate` (`packages/harness/harness.ts`) | Matches (`binding: { ...parent.binding, … }`). |
| General context MCP has no administrative or execution authority | `tests/campaign-storage-authority-mcp.test.ts` (MCP-06) | Matches. |
| Retired Claude-plan bindings fail closed | `packages/proxy/retirement.ts`, `packages/harness/model-client.ts` | Matches (HTTP 410 `route_retired`). |
| ChatGPT plan serializer: `store:false`, `stream:true`, no `previous_response_id`, no system-role items, refused hosted tools and fields | `packages/proxy/protocols/responses.ts` | Matches, **except tool encoding** (see below). |
| ChatGPT OAuth: PKCE, state, nonce, ID token, granted-scope check, serialized refresh | `packages/proxy/oauth/chatgpt.ts`, `packages/proxy/credentials.ts` | Present; not re-audited line by line here beyond the scope check and refresh error list. |

### Gaps found

1. **ChatGPT plan tool encoding.** OpenAI's [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), re-read 6 November 2026, say the plan route accepts function and custom tools only grouped in namespaces or supplied through `additional_tools` input items. Topsl sent plain top-level `function` tools, which that page says are not supported. The synthetic upstream accepted them, so no test caught it.
2. **Claude tool binding not required at launch.** A turn that declares Topsl's MCP tools checked only that Claude Code reported no *extra* tools. It did not check that Topsl's server was reported `connected` or that its tools were loaded. Claude Code's [headless documentation](https://code.claude.com/docs/en/headless) notes that a clean exit can coexist with a rejected MCP configuration, so a reader-dependent answer could be accepted without the reader.
3. **No mixed Claude Code + native GPT team test.** `tests/native-members.test.ts` mixed Codex and native members only; nothing ran a Claude Code member and a native proxy member in one goal.

### Existing tests covering the plan's invariants

| Invariant | Existing coverage |
| --- | --- |
| Frozen binding; changed route refused before dispatch | `tests/native-harness.test.ts` ("a changed route is refused…"), `tests/proxy-followup.test.ts` (adapter upgrade) |
| Plan-route field refusals | `tests/proxy-protocols.test.ts` |
| Identity-only ChatGPT sign-in, refresh, account separation | `tests/proxy-chatgpt-auth.test.ts` |
| Claude extra tools / API-key credentials stopped at init | `tests/claude-route.test.ts` |
| Claude qualification and readiness | `tests/runtime-qualification.test.ts`, `tests/provider-readiness.test.ts` |
| More than two members, contribution and endorsement rules | `tests/orchestration*.test.ts`, `tests/native-sessions.test.ts` |
| Native members in teams and loops; shared allowance waits; Stop | `tests/native-members.test.ts`, `tests/native-loops.test.ts` |
| Retired Claude plan stays blocked | `tests/proxy-retirement.test.ts`, `tests/native-retirement.test.ts` |
| Context MCP authority | `tests/campaign-storage-authority-mcp.test.ts` |

## Phase checklist

Status of each plan phase after both passes on 6 November 2026 (the [first pass](#what-changed) and the [second pass](#second-pass--remaining-phases)). "Existing" means the behavior was already implemented at `b87f501`. "Implemented" means implemented and verified with local, synthetic tests. "Live" marks what the [live qualification](#live-qualification--6-november-2026) of 6 November 2026 established, for that host and those accounts only.

| Phase | Status | Notes |
| --- | --- | --- |
| 0 Baseline | Done | This document. |
| 1 Execution boundary | Existing, one field added | `MemberTurn`, `AttemptObservation`, `OrchestrationDriver` and `ExecutionBinding` already carried native, Codex and Claude Code turns. The second pass added only `AttemptObservation.funding`. |
| 2 Claude connection and funding | Implemented; live | Required MCP binding at `system/init` (first pass); requested-versus-observed funding on every turn, with `conflict` and `unknown` kept distinct (second pass). Existing: same-environment `auth status`, API-key stop, tool-grant stop, qualification fingerprints. Open: R12 (an owner decision). |
| 3 ChatGPT plan path | Implemented; live gate passed | Namespaced tool encoding and adapter revision `chatgpt-plan-responses-v2`. Existing: field refusals, stateless history, error classification, identity-only sign-in. Live: a native task with tool calls completed; the live runs also found and fixed the missing-`Content-Type` stream defect. |
| 4 Mixed-engine workflows | Implemented; live pilot | GPT → Claude → GPT and Claude → GPT → Claude through the real service, then live in both directions. |
| 5 Goal/Endless, quotas, recovery | Implemented | A Goal loop and an Endless loop with Stop across Claude Code and native members; a Claude reader defect in later loop iterations and continued sessions fixed. Existing: quota waits, restart recovery. |
| 6 Tool-driven delegation | Implemented behind an owner gate (off by default); one live job each way | `start_agent_job`, `get_agent_job`, `cancel_agent_job` for Claude Code and native coordinators; durable, idempotent, attempt-bound; admitted as plan tasks. Not separately qualified for Claude Code. |
| 7 Richer member capabilities | Implemented for native implementers | The goal's plain checks, run contained in the member's copy (macOS). Deferred: a Claude Code check tool (needs a tool profile on edit sessions and requalification), commands, MCP tools, hooks, persistent Claude sessions, native Claude subagents. |
| 8 UI and usage | Implemented | Member cards show engine and requested-versus-observed funding; the plan shows agent jobs with their requester; Settings has the agent-jobs switch; a native route's readiness button opens Connections. No cost estimate is shown anywhere. |
| 9 Migration and release | Implemented, release open | No schema change: new record kinds and optional fields; turns recorded earlier read as "not recorded". Release notes wait for a version decision; packaged-platform checks were not run. |

## What changed

### ChatGPT plan route: tools in a namespace

- `packages/proxy/protocols/responses.ts`: on the proxy's upstream hop to a `chatgpt-plan` connection, the serializer sends function tools inside one tool `{ type: "namespace", name: "topsl", description, tools: [...] }`, and a replayed `function_call` item carries `namespace: "topsl"`. The shape follows OpenAI's Responses API reference: a namespace tool has `type`, `name`, `description` and `tools`, and a function call has an optional `namespace`. The name `topsl` fits the `^[a-zA-Z0-9_-]+$`, 64-character pattern the reference gives for a namespace.
- A named `tool_choice` on the plan route is refused before dispatch, because how a named choice addresses a namespaced function is not documented. The harness only sends `"auto"` (`packages/harness/context.ts`), so no current flow is affected.
- The stream reader fails a response that calls a tool in any namespace other than `topsl`, on every route. Without namespaces nothing changes.
- `SerializeOptions.upstream` (all three protocol modules) marks the proxy's upstream hop. The harness still serializes with its route's profile so route refusals happen before anything is sent, but its body to the local proxy keeps plain function tools, which the proxy's client parser reads. Only `dispatchUpstream` (`packages/proxy/adapters.ts`) sets `upstream: true`.
- `packages/proxy/registry.ts`: `adapterRevisions["chatgpt-plan"]` is now `chatgpt-plan-responses-v2`.

`additional_tools` input items were not used: the reference's excerpt read here did not confirm their `type` value.

#### Upgrade effect

The adapter revision is part of each route's revision, so every ChatGPT plan route gets a new revision on upgrade. Native tasks and members bound to a plan route before the upgrade are refused with HTTP 409 on their next request, as for any route change ([README](../README.md#connections-and-native-tasks)); start a new task. History is kept. No other connection kind's revision changed.

### Claude Code: Topsl's tools must be loaded

- `packages/providers/claude.ts`: `ClaudeTurnTools` gains an optional `server`, the MCP server name the configuration gives Topsl's tools. `startTurn` sets it from the session's toolset namespace. It is not an argument, so `claudeArguments` and the qualification's fingerprinted launch profile (`packages/providers/runtime-binding.ts`) are unchanged and existing qualifications stay valid.
- When `server` is set, the turn is stopped at `system/init` unless Claude Code reports that server with status `connected` and every granted tool name in its `tools` list. A successful result that arrives with no `system/init` before it is not accepted either. Topsl's own stall and interrupt endings are unaffected.
- Unlike the extra-tool and API-key stops, which still stop before the init record is passed on, the binding stop passes the init record on first and then stops the turn. What Claude Code reported (its session, tools and servers) stays observable, so a qualification whose reader probe fails still judges `fresh-session` and `native-subscription` from that probe.
- A turn stopped at init ends the same way as the existing stops: the process is killed and the outcome is left uncertain, because Claude Code may already have started its first model request. That is existing behavior, kept deliberately.

### Tests and fixtures

| File | Change |
| --- | --- |
| `tests/proxy-protocols.test.ts` | Three tests: plan-route namespace encoding (tools, replayed calls, no system role, named-choice refusal, local body and API route unchanged); a call into a foreign namespace fails the response; the same call seen only in the terminal response's output or in a lone `output_item.done` fails cleanly. The last one failed with `TypeError: Cannot read properties of undefined (reading 'text')` before `itemDone` returned early on a refused call, a defect introduced and fixed during this work. |
| `tests/native-fixture.ts` | The synthetic upstream now applies the plan route's documented restrictions (`store`, `stream`, `previous_response_id`, system-role items, top-level tools) and answers the route's `subscription_sharing_unsupported_capability` error shape. It detects plan requests by bearer: test API keys all start with `sk-`. |
| `tests/native-harness.test.ts` | The MCP-tool assertion reads the namespaced tool list. |
| `tests/claude-route.test.ts` | Three tests: Topsl's server reported `failed`; server connected but tools not loaded; a result without `system/init`. |
| `tests/fixtures/claude-qualify.cjs` | `FIXTURE_MCP_STATUS` and `FIXTURE_MCP_DROP` switches. |
| `tests/fixtures/claude-orchestration.cjs` | The existing Claude Code team stand-in already loaded Topsl's candidate reader through its `--mcp-config` but left `mcp_servers` out of its init record. It now reports the reader's server as `connected`, as Claude Code does. |
| `tests/native-members.test.ts` | The service fixture adds Claude Code through that stand-in. Two tests over the real control service, proxy and harness: native coordinator → Claude Code implementer → native reviewer, and Claude Code coordinator → native implementer → Claude Code reviewer. Each checks the engine of every round's member and that the implementer's edit is the goal's candidate. |

## Validation

### First pass

Run on the host above, branch `claude/subscription-runtime-architecture` (uncommitted changes on `b87f501`). Desktop journeys (`npm run test:desktop`) were not run in the first pass: it changed no renderer or main-process code. The [second pass](#second-pass-validation) has its own results.

| Command | Result |
| --- | --- |
| `npx vitest run tests/proxy-*.test.ts tests/native-*.test.ts tests/external-service.test.ts` with `ANTHROPIC_BASE_URL` unset | 13 files: 12 passed, 1 skipped; 201 tests passed, 1 skipped (before the two mixed-engine tests were added) |
| `npx vitest run tests/native-members.test.ts` with `ANTHROPIC_BASE_URL` unset | 12 passed |
| `npx vitest run tests/claude-route.test.ts` | 31 passed |
| `npx vitest run tests/campaign-claude-codex.test.ts tests/claude-route.test.ts tests/runtime-qualification.test.ts tests/claude-provider.test.ts` with `ANTHROPIC_BASE_URL` unset, after the init-ordering fix | 79 passed, 1 skipped |
| `npm run check` with `ANTHROPIC_BASE_URL` unset, final tree | Passed: typecheck; 102 test files (99 passed, 3 skipped), 1,421 tests passed, 6 skipped; 18 release tests passed; production build completed |

**Environment note.** The Claude Code session this work ran in sets `ANTHROPIC_BASE_URL`. With it set, `billingConflicts()` stops Codex members, so three existing `tests/native-members.test.ts` tests fail on the untouched base commit too (`API or third-party billing environment is present (ANTHROPIC_BASE_URL)`). They pass with it unset. This is the existing subscription-only guard working as designed, not a regression; the runs below unset it.

**Regression found and fixed during validation.** The first run of the wider suites failed five `tests/campaign-loops-state-service.test.ts` tests that pass on the base commit: the team stand-in did not report `mcp_servers`, so the new binding check stopped its reader turns. The stand-in was corrected as described above. The first full `npm run check` then failed one test that passes on the base commit, `CL-06` in `tests/campaign-claude-codex.test.ts`: its scripted runtime loads no MCP server, and the binding stop, which then threw before passing the init record on, cost the qualification that probe's session observation, so `fresh-session` failed. The stop now passes the init record on first.


## Second pass — remaining phases

The owner asked for every phase to be finished after reviewing the first pass. This pass implements Phases 2 (remaining), 5, 6, 7, 8 and 9 as far as they can be implemented and verified without live accounts or other platforms.

### Phase 2: requested versus observed funding

- `packages/domain/role-groups.ts`: `FundingSource` (`subscription`, `api-billing`, `cloud-provider`, `external-service`, `local`, `unknown`), `ObservedFunding`, `FundingObservation` (`matches`, `unknown`, `conflict`), `requestedFunding()` (from the assignment's native route or vendor billing route), `fundingObservation()` and `memberFunding()`. `unknown` on either side is never a match.
- Claude Code's init `apiKeySource` now reaches the run record: `ProviderEvent` `turn-started` carries `credentialSource` (`packages/providers/contract.ts`, `claude.ts`), and `RuntimeManager` saves it on the `Run` (`credentialSource`, `packages/domain/types.ts`).
- `RuntimeOrchestrationDriver` reports `AttemptObservation.funding`:
  - Claude Code: from the init record. `none` is Claude Code's own login (subscription); any other source is API billing, named in the detail.
  - Codex, or Claude Code without an init report: the account status Topsl read before launch, labelled `account status before launch`.
  - Native: the frozen proxy route's connection funding, labelled `proxy route binding`. The proxy refuses any changed route revision, so this is the turn's funding.
- The engine records `ParticipantContribution.funding` against the member's exact assignment revision. The goal view adds `engine`, `connection`, `requestedFunding` and `funding` to each round member. A turn recorded earlier reads as `unknown` with source `not recorded`.
- A live Claude turn that reports API-key credentials is still stopped at init, unchanged. A fixture turn is not stopped, so the conflict record is testable.

### Phase 5: loops across engines, and a reader defect

- New tests run a Goal loop with a Claude Code coordinator and native implementer and reviewer, and an Endless loop that improves once, monitors, then stops. After Stop, nothing new launches on either engine and no native kernel attempt is running.
- **Defect found and fixed.** In the Endless loop's second iteration the Claude coordinator's candidate reader was refused: `Candidate grant subject is not an attributed attempt/task/session in this project/workflow`. A loop boundary turn, a continued session's intake and a loop goal read a candidate an earlier workflow made, and the reader admitted only candidates of the reading task's own workflow. Codex and native members read their copies directly, so only Claude Code members were affected. The same applied to Claude coordinators in continued sessions (inferred from the same code path, not separately tested).
  - The driver now records the turn's input candidate per attempt as an immutable `candidate-input-binding` before it creates the grant, and names the reading goal as the grant's workflow (`packages/orchestration/runtime-driver.ts`).
  - `validateCandidateAccess` (`packages/context/candidate-reader.ts`) admits a candidate from the subject's workflow or that one recorded input, for that attempt and project only.
  - `candidateTools` sends the grant's workflow (`packages/context/candidate-tools.ts`).
  - `tests/candidate-input-binding.test.ts` covers refusal without the binding, with another attempt's binding and with another project's binding, and a read through the tools with it.

### Phase 6: agent jobs

`packages/orchestration/agent-jobs.ts` (service), `packages/domain/agent-job-tools.ts` (shared tool definitions).

- **Gate.** Owner preference `agent-jobs`, command `agent-jobs-set`, **Settings → Agent jobs**. Off by default; only an explicit `true` reads as on. Turning it on needs no Topsl dialog: it widens no member's permissions.
- **Authority.** At launch the driver records an immutable `agent-job-authority` for a coordinator's initial contribution turn on an engine goal while the gate is on. Goals started from a session are engine goals and qualify; loop goals, loop decision turns and session intake turns (which have no engine goal) do not. Its fields are project, goal, round, member and control generation. Tools resolve the caller only from the attempt they are bound to. A job ID the model supplies is only a reference, checked against the caller's goal. Children are ordinary task rounds and get no authority, so they cannot start jobs.
- **Start.** The request is validated with the same `validateActions` a coordinator's proposal faces: known role, role purpose matching the kind, kind within the goal's grant, permitted outputs for implementation, and the grant's remaining delegated tasks counting pending jobs. Each turn may make at most 8 requests.
  - The job ID is `hash(attempt, idempotency_key or tool-call ID)`. An identical retry returns the same job; the same key with different arguments is a conflict.
  - The job is recorded (`agent-job`, state `requested`) before anything runs.
  - A stopped, paused or restarted goal (changed control generation) refuses new jobs.
- **Admission (supervisor continuation).** While a coordinator turn runs, the engine dispatches nothing for its goal, and a plan revision during coordination would make the round's decision stale. So jobs are admitted only once the plan has committed: in `tickGoal`, before `dispatch()` for a `running` goal, every requested job becomes a plan task through `admitTask(…, "job")`. That is the generalized `admitRepairTask`; a job counts as a delegated task, not a repair round. The child is then scheduled, executed on whatever engine its role resolves to, captured, integrated and reviewed with the goal. A coordinator therefore never waits on a child inside its own turn, so a capacity of one cannot deadlock. Its result reaches later rounds through the goal, and `get_agent_job` reports it.
- **Stop and cancel.** A stop or restart cancels requested jobs (`settle`). Admitted tasks are stopped by the existing goal stop. `cancel_agent_job` cancels a requested job, or withdraws an admitted task no round has started as a new plan revision without it, so the plan can still finish; a withdrawn job still counts against the goal's delegated-task grant. A running child is refused with an explanation: it stops with its goal.
- **Exposure.**
  - Claude Code: the job tools join Topsl's candidate-reader toolset, under its MCP server, for coordinator turns that already get the reader. That means the runtime's qualification observed the reader, and the binding check requires the tools to load. Tool names are not part of the fingerprinted launch profile, so existing qualifications stay valid. The job tools themselves have **not been qualified** against a live Claude Code.
  - Native: core tools gated by `ToolGrants.agentJobs`, effect `control`, so a call replayed after a restart returns the same job. The harness's `agentJobs` callback is set by the control service (`apps/service/service.ts`). Codex coordinators get no job tools.

### Phase 7: checks for native implementers

`NativeMemberStartInput.checks` (`packages/harness/harness.ts`). The driver passes the goal's checks without an environment recipe to an implementation member as `run_check` grants, which run contained in the member's own copy. Where containment is unavailable (any platform other than macOS today) none are granted. Topsl's required checks on the integrated candidate are unchanged and still gate acceptance.

### Phase 8: interface

- Member cards (`apps/desktop/renderer/coordinator/role-editor.tsx`) add **Engine** ("Claude through Claude Code", "Through Topsl · alias (connection)", "Codex") and a **Funding** line. The line reads "as requested (observed by …)", "requested; not observed (…)" or, as an alert, "Funding conflict: … requested, … observed (…)". The existing "Requested: …" line is unchanged.
- The plan pane (`goal-card.tsx`) lists agent jobs with their kind, role, state, requesting member and task key.
- Settings has **Agent jobs** On/Off. The session coordinator picker's readiness button reads **Open Connections** for a native route; it opened Providers before.
- Token usage, cost and subscription allowance remain separate. The interface shows no cost estimate, and allowance is shown only as each runtime reports it.

### Phase 9: migration

No store schema change. New record kinds: `agent-job`, `agent-job-authority`, `candidate-input-binding`. New optional fields: `Run.credentialSource`, `ParticipantContribution.funding`, `ToolGrants.agentJobs`, `AppState.agentJobs`. Earlier records read as unknown, as "not recorded" or as off. A native attempt resumed from an earlier spec admits no job tools, so its tool hash is unchanged. An older Topsl ignores the new kinds and fields: its coordinators get no job tools and requested jobs stay requested. Retired Claude-plan bindings are untouched. Release notes wait for the owner's version decision.

### Second-pass tests

| File | Tests |
| --- | --- |
| `tests/native-members.test.ts` | Funding on member cards; a Claude API-key report recorded as a conflict; the funding combiner; turns recorded earlier read as "not recorded"; a Goal loop and an Endless loop with Stop across engines; agent jobs from a native coordinator to a Claude Code child (retry, conflict, goal view, tools only on coordinator turns) and from a Claude Code coordinator to a native child through MCP; no job tools with the gate off; a native implementer's contained check (macOS) |
| `tests/agent-jobs.test.ts` | 6: no authority or gate off; idempotency and conflict; other goal or project invisible; stop fences and cancels; admission only after commit within the grant; cancel before start and refusal once started |
| `tests/candidate-input-binding.test.ts` | 2: the reader's input binding |
| `tests/fixtures/claude-orchestration.cjs` | `--fixture-api-key-source`; `--fixture-agent-job` and `--fixture-agent-job-log` |
| `scripts/desktop-coordinator-test.mjs` | Review member cards show "Engine: Codex" and a Funding line; the service's round members carry `engine` and `funding` |

### Second-pass validation

Same host, branch and environment note as the first pass (`ANTHROPIC_BASE_URL` unset); uncommitted changes on `b87f501`.

| Command | Result |
| --- | --- |
| `npx vitest run tests/native-members.test.ts` (during the pass) | Each new test passed when added; the reader defect, a placeholder assertion and a wrong regular expression were fixed along the way |
| `npx vitest run tests/agent-jobs.test.ts tests/candidate-input-binding.test.ts` | 6 and 2 passed |
| `npm run build && npm run test:desktop -- scripts/desktop-coordinator-test.mjs` (before the final tree) | Passed, including the new engine and funding assertions; its screenshot `test-results/coordinator-round.png` shows "Engine: Codex" and the funding line on member cards |
| `npm run check`, final tree | Passed: typecheck; 104 test files (101 passed, 3 skipped), 1,438 tests passed, 6 skipped; 18 release tests passed; production build completed |
| `npm run test:desktop`, final tree | All eight default journeys passed: desktop, coordinator, Atlas, loop, session, Claude usage, Providers, native harness |

The desktop journeys show that existing flows still work in Electron with these changes. No journey turns on agent jobs or pins a native member alongside Claude Code; that is covered at service level only.

## Remaining gates and limits

*Updated after the [live qualification](#live-qualification--6-november-2026) later on 6 November 2026.* The first three items below were written before it. For that host and those accounts it closed:

- the Phase 3 live gate;
- the Phase 2 live gate for Claude Code (binding check, `apiKeySource`);
- the mixed-engine pilot with one agent job each way.

Still open from those items: live acceptance of a goal, a live loop, live job cancellation, and other platforms and packaged builds.

- **Live ChatGPT plan inference.** Whether the plan route accepts the namespace encoding, `text.format`, `parallel_tool_calls` and `include` is not verified. Phase 3's live gate (an authorized account completing a native task with a Topsl tool call through the public route) is open.
- **Live Claude Code.** The MCP binding check, the funding observation and the agent-job tools were exercised only with stand-ins. Two behaviors of real Claude Code are unobserved: `mcp_servers` statuses other than `connected` (such as `pending` during a slow start, which would now stop the turn), and `apiKeySource` values other than `none`. Phase 2's live gate is open.
- **Mixed-engine and delegation evidence is synthetic.** A bounded live pilot with a native ChatGPT plan member and a Claude Code member (plan §9.3), including one agent job each way, is open.
- **Platforms.** Everything ran on macOS arm64 only. Contained native checks need macOS. Packaged-application and other-platform qualification were not run.
- **Not done:**
  - R12, an owner decision on whether to keep filtering API keys out of Claude Code's environment.
  - A Claude Code check tool, native member commands, MCP tools and hooks.
  - Persistent Claude sessions and native Claude subagents.
  - The optional Codex app-server route.
  - Release notes.

## Live qualification — 6 November 2026

At the owner's request, on the owner's Mac, with the owner's accounts. All runs used disposable `topsl-test-*` profiles. The owner signed in to ChatGPT in their own browser; no credential was entered by a script. Redacted reports are in [live-evidence/subscription-runtime-2026-11-06](live-evidence/subscription-runtime-2026-11-06/). Account-identity fields (`accountKey`, `profileId` and similar) are replaced with `<redacted>`.

| Item | Value |
| --- | --- |
| Host | macOS 27.0.1, arm64 |
| Claude Code | 2.1.305, `claude.ai` login (Max), model `claude-sonnet-5-5` |
| Codex | codex-cli 0.163.0, ChatGPT login, model `gpt-6.1-sol` (stage 1 only) |
| ChatGPT plan through Topsl | Topsl's own sign-in; route `chatgpt/live` → `gpt-6.1-sol`, adapter revision `chatgpt-plan-responses-v2` |
| Procedures | Stage 1: [scripts/live-loop.mjs](../scripts/live-loop.mjs) `--mixed-only --no-pin-run`, recording member funding. Stage 2: [scripts/live-subscription.mjs](../scripts/live-subscription.mjs) |
| Environment | `ANTHROPIC_BASE_URL` removed by both procedures (recorded in each report) |

### Runs

| Run | Topsl | Result |
| --- | --- | --- |
| Stage 1, live loop | `9028b1b` | Codex qualified: 8 of 8. Claude Code: 6 of 7. `candidate-reader` passed with Claude Code reporting Topsl's server `connected` and its tools loaded, which is the binding check live. `native-subscription`: 4 of 4 turns reported `apiKeySource` `none`. `read-only` failed only because the turn exceeded 240 s: Claude Code reported no tools and no file was written. Topsl therefore refused the Claude coordinator ("read-only is not qualified"), and the mixed loop waited without starting. No loop iteration ran. |
| Stage 2, run 1 | `34069d1` | The ChatGPT plan sign-in reached `ready` and the account's models were listed. The native task did not start: the procedure cancelled Topsl's **Start a native task?** dialog, which it had not been told to expect. Claude Code qualified 7 of 7. Both teams blocked on the plan route. Every plan request ended "The model stream ended before a terminal event" after 4–7 s (proxy receipts, outcome `interrupted`), so no native member returned. In team B the Claude Code coordinator called `start_agent_job` and Topsl admitted the job. |
| Diagnosis | `34069d1` + trace | A copy of run 1's profile was started with `TOPSL_DEBUG_PROXY_TRACE=1`. The route answers **200 with no `Content-Type`**; the proxy read the body as one JSON document and lost every event. With the fix, a native task answered "OK" through `response.completed`. Another request on the route streamed and completed a function call under Topsl's `topsl` namespace. |
| Stage 2, run 2 | `4b7bdb1` | Stopped after the 15-minute sign-in wait; the connection stayed `signed-out`. Nothing else ran. |
| Stage 2, run 3 | `4b7bdb1` | **Passed.** Details below. |

### Stage 2, run 3

- **Native task (plan Phase 3 live gate).** Edit mode on `chatgpt/live`: completed in 3 requests with 2 tool calls (`read_file`, `edit_file`). It changed `value.ts` from 1 to 2 as a candidate. Usage was reported as 2,919 input and 129 output tokens; the reported model was `gpt-6.1-sol`. The frozen binding was `chatgpt-plan`, funding `subscription`.
- **Claude Code qualification:** 7 of 7, 4 turns.
- **Team A — GPT coordinator → Claude Code implementer → GPT reviewer, Claude Code researcher.**
  - The GPT coordinator called `start_agent_job` ("Summarize README guidance for value.ts"). Topsl admitted it, and it ran on the Claude Code researcher and completed.
  - The Claude Code implementer's change was integrated, and the GPT reviewer returned no findings.
  - The goal reached **awaiting acceptance**.
- **Team B — Claude Code coordinator → GPT implementer → Claude Code reviewer, GPT researcher.**
  - The Claude Code coordinator called `start_agent_job` ("Report what README.md says about value.ts"). Topsl admitted it, and it ran on the GPT researcher through Topsl and completed.
  - The GPT implementer's change was integrated. The Claude Code reviewer, reading the candidate through Topsl's reader, returned one low-severity finding. In substance it said "no defects found; only the current revision was available to compare".
  - The goal **blocked** for the owner's disposition, as Topsl requires for any finding.
- **Funding.** Every member of both teams recorded `subscription` requested and observed, `matches`. Claude Code members were observed by their init record and GPT members by the proxy route binding.
- **Dialogs.** The ten dialogs the procedure expected were approved; nothing else appeared.

### Defects found by the live runs

| Defect | Where | Fix |
| --- | --- | --- |
| The ChatGPT plan route sends event streams with no `Content-Type`. The proxy read them as JSON, and every plan request failed. This predates this plan's work. | `packages/proxy/adapters.ts` | A body with no or an unrecognised content type is read by its first non-blank bytes. `tests/proxy-undeclared-body.test.ts` (3); one of them fails on the earlier code. |
| The live procedure cancelled Topsl's native-task confirmation. | `scripts/live-subscription.mjs` | It approves exactly that dialog for its route. |
| The live procedure's goal text named "a researcher", which Topsl read as a team instruction and set that role to Auto for the goal (`parseMembership`, intended behaviour). | `scripts/live-subscription.mjs` | The text names no role; information jobs default to the researcher role. |

### What this establishes and what it does not

**Established for this host, these versions and these accounts:**

- The ChatGPT plan sign-in, model catalog and inference through Topsl's own harness and proxy, with Topsl's namespaced tools.
- Claude Code qualification with the MCP binding check.
- Requested-versus-observed funding on both engines.
- Structured teams in both directions, with an agent job each way that ran on the other engine and completed.

**Not established:**

- Acceptance and application of either goal (the procedure stops at awaiting acceptance or blocked).
- A completed live Goal or Endless loop: stage 1's loop never started, and there was no rerun.
- Agent-job cancellation or a stop during a live job.
- Live qualification on other platforms or in a packaged build.
- OpenAI API, Anthropic API, external service or Ollama routes.
- A `read-only` timeout of this kind was seen once in three Claude Code qualifications. Its cause is not established.

**Checks after the fix.** `npm run check` on the final tree passed: 106 test files (103 passed, 3 skipped), 1,443 tests passed, 6 skipped, 18 release tests and the build.
