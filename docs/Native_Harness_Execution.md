# Native harness — execution record

**Plan:** [Topsl native harness and subscription proxy](Native_Harness_Plan.md), revised 5 November 2026 (§1.1).  
**Recorded:** 5 November 2026 (Asia/Shanghai).  
**Base revision:** `2efeed27490bc1b74070125f597eceb738a50f39`, plus the uncommitted working tree this record describes.  
**Machine:** the owner's Mac: Apple M5, 32 GB, macOS 27.0.1 (26A434). Node.js 26.0.0 for tooling; tests run under Electron 44.4.5's Node (24.21.0) through `scripts/test.mjs`.  
**Evidence scope:** Synthetic upstreams, a synthetic OpenAI-style authorization server, real macOS Seatbelt containment through `@anthropic-ai/sandbox-runtime` 0.0.81, one real Electron window journey, and one unsigned-distribution macOS package. **No live ChatGPT, OpenAI, Anthropic or Ollama request and no real ChatGPT sign-in** were made. CI and other platforms were not run.

## What was built

| Area | Files | Plan section |
|---|---|---|
| Canonical model and protocol converters for Responses, Messages and Chat Completions (client parsing, upstream serialization, stream reading and writing, errors) | `packages/proxy/canonical.ts`, `packages/proxy/sse.ts`, `packages/proxy/protocols/*` | §2 Local proxy interface |
| Connections, routes, receipts and the encrypted connection database | `packages/proxy/types.ts`, `packages/proxy/registry.ts`, `packages/proxy/database.ts` | §2 Credentials and funding |
| ChatGPT plan sign-in, refresh and revocation; ID-token verification | `packages/proxy/oauth/chatgpt.ts`, `packages/proxy/jwt.ts`, `packages/proxy/credentials.ts` | §2 Subscription adapters, R2 |
| Upstream adapters, failure classification, the proxy service and loopback server | `packages/proxy/adapters.ts`, `packages/proxy/service.ts`, `packages/proxy/server.ts` | §2, R4, R5 |
| Proxy utility process and its supervision in Electron main | `apps/proxy/worker.ts`, `apps/desktop/proxy-host.ts`, `apps/desktop/main.ts`, `scripts/build-config.mjs` | §2 Ownership |
| Schema 7: journal, projections, blob ownership; garbage collection respects owners | `packages/persistence/migrations/native.ts`, `packages/persistence/blobs.ts`, `packages/persistence/store.ts` | §3 Durable execution |
| Bindings, journal, kernel, context and compaction, resource ledger | `packages/harness/{types,journal,kernel,context,resources,model-client}.ts` | §3 Native step lifecycle, Recovery and context |
| Tools and path rules | `packages/harness/tools.ts`, `packages/harness/paths.ts` | §3 Tools and isolation |
| macOS containment | `packages/harness/sandbox.ts` | §3 Tools and isolation, R6 |
| Service harness: workspace copies, candidates, application, delegation, skills, memory, MCP, hooks, recovery | `packages/harness/harness.ts`, `packages/harness/mcp.ts`, `apps/service/native.ts`, `apps/service/service.ts`, `apps/service/worker.ts` | §3 Teams and extensions |
| Commands and the two views | `packages/domain/native-commands.ts`, `apps/desktop/renderer/screens/connections.tsx`, `apps/desktop/renderer/screens/native-tasks.tsx` | Phase 3 |
| License and notices | `LICENSE`, `THIRD_PARTY_NOTICES.md`, `package.json` | Phase 0, R11 |

Three of these modules were written by delegated agents from written briefs and reviewed and integrated afterwards: the protocol converters, the ChatGPT sign-in and credential store, and the containment module. Their own tests are listed below.

## Phase 0 — baseline and adapter evidence

- **Provider pages re-read on 5 November 2026** with the results summarized in [plan §1.1](Native_Harness_Plan.md#11-review--5-november-2026): OpenAI's [overview](https://developers.openai.com/siwc/token-sharing-open-source), [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference), [errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery) and [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations); Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).
- **Not established from those pages:** the ID token's JWKS location beyond the discovery document, the format of `earliest_refresh_at`, and any rate limits. The implementation discovers JWKS through `/.well-known/openid-configuration`, accepts several `earliest_refresh_at` forms, and assumes nothing about rate limits.
- **Claude community source:** not pinned or reviewed further; the adapter is retired (R1).
- **Fixtures:** every upstream stream in the tests is synthetic, written from the public API references, and labelled as such in each test file's header.

## Automated tests

All commands ran from the repository root on the machine above.

| Command | Result | What it covers |
|---|---|---|
| `node scripts/test.mjs tests/proxy-protocols.test.ts` | 47 passed | SSE parsing at awkward chunk boundaries; each client protocol's parsing with tools, results and images; serialization to each upstream protocol with tool IDs preserved; reading text, parallel tool calls, reasoning continuation, usage, incomplete, failed (including `subscription_sharing_usage_limit_exceeded`), Messages errors, `[DONE]` and a truncated stream; writer → reader round trips; rejections (hosted tools, `previous_response_id`, `n: 2`, foreign reasoning, a late system message, `store: true`, plan-route temperature and output cap, Messages without a token cap, effort to Messages) |
| `node scripts/test.mjs tests/proxy-chatgpt-auth.test.ts` | 37 passed | First registration, missing issued client ID, wrong state ignored, `access_denied`, nonce, audience, expiry and signature failures, missing plan scope, reauthorization identity mismatch and client reuse, refresh rotation, terminal versus transient refresh errors, lock serialization, compare-and-swap conflicts, revocation confirmed and unconfirmed, no token text in errors, port fallback |
| `node scripts/test.mjs tests/harness-sandbox.test.ts` | 23 passed | Real `sandbox-exec`: workspace writes allowed or blocked by mode, writes outside blocked, denied reads, a symbolic link out of the workspace, a background descendant killed on timeout, network blocked (and a granted destination reachable), two concurrent different policies, no parent environment, credential-named variables refused, `cwd` outside refused, platform gating, a contained stdio round trip |
| `node scripts/test.mjs tests/proxy-service.test.ts` | 8 passed | One refresh for concurrent requests with every field rotated; one same-identity renewal after a 401, then failure; a terminal refresh error stops requests; disconnect revokes, cancels a stream in flight and blocks new requests; Chat and Messages clients reaching a Responses upstream; unsupported features refused before dispatch; aliases, disabled routes, model lists in both shapes; endpoint rules |
| `node scripts/test.mjs tests/native-harness.test.ts` | 19 passed | See [acceptance coverage](#acceptance-coverage) |
| `node scripts/test.mjs tests/campaign-storage-authority.test.ts tests/coordination.test.ts tests/context-pagination.test.ts tests/candidate-manifests.test.ts tests/campaign-storage-authority-faults.test.ts tests/navigation.test.ts tests/store.test.ts` | 76 passed | Migration to schema 7 from schemas 2–6 with identical records, search and events, an encrypted restorable backup, rollback on a failed step, refusal of a newer schema, and full-disk faults. These tests assumed schema 6 was the newest and were updated for schema 7. |
| `npm run test:release` | 18 passed | Release and packaging checks, with the new `package.json` license and files |
| `npx tsc --noEmit` | no errors | Whole repository |

### Full suite

`node scripts/test.mjs` (the `npm test` suite) is recorded in the [follow-up below](#full-suite-and-desktop-journeys). On this machine 25 tests in `tests/environments.test.ts` and `tests/round2-acceptance.test.ts` fail looking for `npm-cli.js` beside Electron's executable. The same 25 fail identically on an unmodified checkout of `2efeed2` (run in a separate worktree on 5 November 2026), so they predate this work and come from this machine's environment. `npm run check` stops at that step for the same reason.

## Acceptance coverage

Each [plan §5](Native_Harness_Plan.md#5-acceptance-and-documentation) bullet, with the tests that cover it. All are synthetic or local.

| Plan requirement | Covered by | Not covered |
|---|---|---|
| The ChatGPT plan route completes read → tool call → result → edit → check → candidate without Codex or Claude Code | `native-harness`: "read → tool call → edit → check → candidate → apply"; `scripts/desktop-native-test.mjs` (gateway route, in the window) | A live ChatGPT account and model |
| Connection, account, model, route revision and funding preserved through streaming, retries, compaction and delegation | `native-harness`: receipts in the core test, retries, compaction, the child's binding in the delegation test | — |
| Expiry, concurrent refresh, revoked credentials, declined sign-in, unavailable models, mid-stream quota failures | `proxy-chatgpt-auth`, `proxy-service`, `native-harness`: usage-limit pause; `proxy-protocols`: `response.failed` usage limit | A provider-side revocation detected by a live request |
| Protocol conversion preserves tool IDs and results and rejects unsupported features | `proxy-protocols`, `proxy-service`, `native-harness` (Anthropic and gateway routes) | Live provider streams |
| Proxy restart, service restart and crashes around tool dispatch do not duplicate effects | `native-harness`: generation fencing and hash reconciliation of an applied edit; a running command killed and left uncertain | An actual proxy-process crash in Electron: proxy restarts are supervised but untested |
| Route changes cannot silently redirect an active attempt | `native-harness`: "a changed route is refused before upstream dispatch" | — |
| Two accounts isolated; routes on one account share quota ownership | `native-harness`: usage-limit test (two routes on one account wait; another account continues) | — |
| Credentials absent from renderer payloads, tool environments, logs and exports | `native-harness`: credential isolation (proxy view, receipts, journal, history documents, encrypted file); `harness-sandbox`: environment; the Electron journey checks window state | History exports were not inspected separately; they read the same history documents |
| Workspace, network, symlink, descendant-process and concurrent-policy containment | `harness-sandbox` | A daemon that detaches with `setsid` and outlives its parent is not killed when the command ends (it stays sandboxed and offline) |
| Compaction, cancellation, capacity exhaustion, candidate retention, old-profile migration | `native-harness`: compaction, cancel, request budget; migration suites | Inference-capacity contention between attempts is implemented but has no dedicated test |

The evaluation set (investigation, bug fix, refactor, test diagnosis, review, cross-provider handoff, compaction and restart tasks, three repetitions each with real models) has **not** been run.

## Phase 8 — qualification checks

### Electron journey

`npm run build`, then `node scripts/desktop-native-test.mjs`: **passed**. In a temporary profile with a synthetic OpenAI-compatible gateway on loopback, it adds a Git project, adds the gateway on **Connections**, stores the key from the clipboard (the clipboard is cleared), lists models, adds a route, starts an edit task under **Native tasks**, waits for **Completed**, reviews the change and applies it, then checks the folder, the confirmations Topsl showed, the absence of the key in window state, and that every gateway request carried the key. Screenshots: `test-results/native-connections.png` and `test-results/native-tasks.png` (not committed). The journey found one timing issue, recorded under limits: the proxy starts a moment after the vault opens.

### Journal latency

`TOPSL_NATIVE_BENCHMARK=1 node scripts/test.mjs tests/native-journal-benchmark.test.ts`: 120 attempts; 300 samples of each query, p95 in milliseconds. Synthetic 400-character tool results.

| Query | 10,080 events | 100,080 events | Ratio |
|---|---|---|---|
| One page of 50 events of an attempt | 0.056 | 0.379 | 6.8× |
| One attempt's projection | 0.011 | 0.013 | 1.2× |
| A project's 50 newest attempts | 0.073 | 0.079 | 1.1× |

The absolute target (p95 below 100 ms at 100,000 events) is met. The tenfold ratio target is met for projections and lists but **not** for event pages. With `PRAGMA cache_size=-131072` (128 MB) the 100,080-event page p95 fell to 0.052 ms, so the growth comes from SQLCipher's page cache on a larger encrypted file, not from the query plan. The store's cache size was not changed: that is a memory trade-off for the owner. Not measured: 60 goals, the chunk-to-screen latency target, and provider latency.

### macOS package

`npm run package` produced `release/Topsl-0.1.3-mac-arm64.zip` (a local build output; rebuilt after the last code change, SHA-256 `8438acc762e5d0c044dd2d8a608babf3caf6c8651e6305daa66f793976bdb2a5`); electron-builder's after-sign step reported "Verified Mac bundle signature and topsail icon". The bundle contains `dist/proxy.cjs`, `LICENSE` and `THIRD_PARTY_NOTICES.md`, and unpacks `@anthropic-ai/sandbox-runtime` and its dependencies.

A packaged containment check (a scratch script, not in the repository) ran the packaged `Topsl.app/Contents/MacOS/Topsl` with `ELECTRON_RUN_AS_NODE=1`, launching the unpacked `srt` the way the harness does, with one writable folder. The first package **failed**: electron-builder had hoisted `commander` 12 into `app.asar`, and the unpacked `srt` could not import it. After adding `**/node_modules/commander/**` to `asarUnpack` and repackaging, the check passed, and passed again on the final package: the write inside the allowed folder succeeded, and a write outside it and an `https://example.com` request were both blocked. Because of that defect, **Native tasks** now runs one contained no-op the first time it is opened and reports containment unavailable if it does not start.

Not done: the packaged app's own Electron journey (a packaged app ignores the test-profile variable), CI, Intel Mac, Windows and Linux packages, and signing or notarization changes.

## Limits found while implementing

- **The proxy starts after the vault opens.** For a moment the Connections page says the proxy is not running.
- **Capture rules apply.** A native task needs a Git project folder; untracked files are not in the task's copy unless they are tracked. These are the existing candidate capture rules.
- **Quota waits are kept in memory.** After a restart, a task that was waiting for allowance is paused like any other interrupted task, and the owner resumes it.
- **Usage is as reported.** A request whose provider reported no usage is counted as unknown, never as zero.
- **Tool-result error flags** are not carried on Responses and Chat Completions routes (R10).
- **MCP servers** must be readable inside the sandbox: inside the project, or in a toolchain folder (`/opt/homebrew`, `/usr/local`, the Command Line Tools). The admitted tool list is checked by name and schema hash when each task starts.
- **MCP servers are not restarted on resume.** A task resumed after a restart keeps its admitted MCP tool names, but their calls answer that the server is not running. Child agents get no MCP tools.
- **ChatGPT plan, live:** not exercised. The flow follows OpenAI's pages as read on 5 November 2026; the first live sign-in may reveal differences.

## Full suite and desktop journeys

- **`node scripts/test.mjs`, started 02:56:46:** 1,331 passed, 26 failed, 6 skipped (1,363 tests in 96 files). 25 of the failures are the pre-existing environment failures described [above](#full-suite). The 26th, "a native task needs a Git project folder", ran against `packages/harness/harness.ts` from before that check was added during the run; it is the only failure in `tests/native-harness.test.ts`.
- **The six native suites together, after the last code change:** `node scripts/test.mjs tests/proxy-protocols.test.ts tests/proxy-chatgpt-auth.test.ts tests/harness-sandbox.test.ts tests/proxy-service.test.ts tests/native-harness.test.ts tests/native-journal-benchmark.test.ts`: 134 passed, 1 skipped (the opt-in benchmark).
- **Desktop journeys:** `npm run build`, then `env -u ANTHROPIC_BASE_URL npm run test:desktop` after the last code change: **all eight journeys passed** (main desktop harness with encrypted restart, coordinator, Atlas, loop, session, Claude usage, Providers, and the native harness journey).
  - The first runs were invalid: the shell that ran them had `ANTHROPIC_BASE_URL` set (from the agent session doing this work), and Topsl refuses to launch providers while a billing override is set. `scripts/test.mjs` removes such variables; the desktop scripts pass the environment through. Every desktop result above was then rerun with `env -u ANTHROPIC_BASE_URL`, as a Dock launch would have it. Run that way on an unmodified `2efeed2` worktree, the loop journey passed twice.
  - **Two regressions found and fixed.** (1) The project menu gained **Native tasks** as its last item, so ArrowUp from the first item no longer wrapped to **Advanced workflows** (Atlas journey); Native tasks now comes before Advanced workflows. (2) Proxy updates were published to the window as full state events. One could arrive between "+ Add folder" returning and the service's own state update, and an existing check then reset the window to Projects because the new project was not yet in state (loop journey, every run; coordinator journey, once). Proxy updates are now a separate `proxy-state` event held apart from the app state, and the window receives main's merged state for service updates, so the connection list no longer drops out after them.

## Phases 6b and 7 — native members in teams, sessions and loops

**Recorded:** 5 November 2026 (Asia/Shanghai), later the same day, on branch `claude/elated-kare-7a2d5b`: commit `3bf36c6` is a verbatim snapshot of the uncommitted working tree this record describes above (on `2efeed2`), and the commits after it are this work.  
**Plan:** [§1.1 R8](Native_Harness_Plan.md#11-review--5-november-2026), Phases 6b and 7.  
**Evidence scope:** the same machine and toolchain as above; synthetic upstreams through the real local proxy, the real harness and the real control service, with the Codex stand-in process for vendor members. No live model, account or provider was contacted.

### What was built

| Area | Files |
|---|---|
| Member engines. `MemberProvider` is `codex`, `claude` or `native`; an assignment records its `engine` and, for a native member, the frozen proxy route (`native`: route, revision, connection, account, funding, quota owner). A pin can name a native route (`routeId`). Session model references and loop provider exclusions accept `native` | `packages/domain/role-groups.ts`, `packages/domain/sessions.ts`, `packages/domain/recursive-loops.ts` |
| Route selection over vendor installations and proxy routes (`RouteCandidate.native`, `routeKey`) | `packages/orchestration/selection.ts` |
| Native readiness: the proxy running, the route on, its connection ready or paused at its usage limit, and for a structured turn a route not recorded as unable to enforce a schema. No installation or vendor qualification | `packages/providers/readiness.ts` (`nativeRouteReadiness`) |
| The orchestration driver's native path: routes, launch on the member's own copy, observation with waits, Stop as cancel, post-run capture, capacity | `packages/orchestration/runtime-driver.ts` |
| Harness member turns (`startMember`): a frozen output schema, read (and for implementation edit) tools only, capture left to the driver, and automatic continuation of waiting members when their allowance is resumed. The attempt view records why it paused and the model the upstream reported | `packages/harness/{harness,kernel,context,journal,types}.ts` |
| Structured output end to end: `CanonicalRequest.outputFormat`, carried as Responses `text.format`, Chat Completions `response_format` and Messages `output_config.format`; route capability `structuredOutput`; the proxy names the upstream-reported model to harness requests | `packages/proxy/canonical.ts`, `packages/proxy/protocols/*`, `packages/proxy/types.ts`, `packages/proxy/registry.ts`, `packages/proxy/service.ts` |
| The engine shows a waiting member's reason, and its capacity view counts native members | `packages/orchestration/engine.ts`, `packages/orchestration/schedule.ts` |
| Loops: native allowance limits by quota owner before an iteration starts, quota and `no-progress` waits during one, native usage in loop accounting | `packages/orchestration/loop-engine.ts`, `packages/orchestration/loop-checkpoints.ts`, `packages/domain/threads.ts` |
| Service wiring and the window: native routes in the role editor and the session coordinator picker | `apps/service/service.ts`, `apps/service/native.ts`, `apps/desktop/renderer/coordinator/{role-editor,session-panes}.tsx` |

### Decisions

- **A native member is one proxy route.** Its catalog is the route's single upstream model, so the assignment's model is the upstream model and model evidence compares what the upstream reported. Before this work the proxy wrote the alias back to every client; it now names the upstream-reported model to requests that carry a frozen route revision (the harness), and other clients still see the alias they asked for.
- **Only vendor members need an installation.** A native assignment has no installation; a round's `installationId` for a native member holds its route ID. Launch refuses a member whose route revision, connection, account or model changed since it resolved; it is never redirected to another route or account.
- **A member turn is a bounded episode** of the harness's default 50 requests. A turn that pauses at its budget is ended by the driver and reads as failed with that reason; the round's retry allowance decides what follows.
- **Waits are not restarts.** A member waiting on its allowance (every route with the same quota owner waits), paused after three identical failures (no progress) or paused by the owner stays running for the engine, with its reason on the round; nothing replaces it. Resuming the allowance under **Native tasks** continues every waiting member on it; a stalled member is resumed there too. A member paused by a Topsl restart continues on its own: member turns run no commands and edits reconcile by content hash, whereas a native task stays paused for its owner.
- **Output contracts are the vendor ones.** A member gets the same JSON Schema a vendor runtime enforces for its purpose, protocol and stage (`purposeOutputSchema`, or the review schema), sent `strict` when OpenAI's strict mode can take it. On a Messages route the harness relaxes its own schema to what Anthropic accepts (constraint keywords removed, objects closed); the proxy refuses a client's schema it would have to weaken. The engine validates the full schema in every case. A route recorded as unable to enforce a schema is refused for structured turns; routes record `unknown` by default, which is not evidence either way. The ChatGPT-plan limitations page (re-read 5 November 2026) neither lists `text.format` as refused nor as accepted, so it is sent as on the API; that is not verified live.
- **Capacity.** An executing native member holds one slot of the engine's shared capacity (two by default); a waiting one holds none. The harness's own inference pool of two still bounds model requests.
- **Loops.** Before an iteration starts, a native allowance in a quota wait, or a connection paused at its usage limit, holds it: the run waits with kind `quota` and names the routes sharing that allowance. Topsl infers no reset time. During an iteration, a member's quota or no-progress wait is shown as the run's wait while other work continues. Stopping a loop or goal interrupts its native members, which cancels their descendants; nothing further launches.
- **History keeps its reading.** An assignment without `engine` reads as its vendor's engine; a projection without a pause kind, or a route without `structuredOutput`, reads as unknown. No record was rewritten.
- **Vendor-only workflows stay vendor-only.** Builder–reviewer, parallel specialists and advanced routing presets dispatch through an installation, so their `roleAssignment` schema is unchanged.

### Automated tests

| Command | Result | What it covers |
|---|---|---|
| `node scripts/test.mjs tests/native-members.test.ts` | 10 passed | Service level: a team with a Codex and a native coordinator, a native implementer and a Codex reviewer runs a goal to acceptance and is accepted through Topsl's confirmation; a Goal loop whose native coordinator answers `recursive-loop-v1` turns (reading the target with `read_file`) and whose native implementer makes the change, promoted to checkpoint 1; a changed route refused before dispatch; a bounded episode ending at 50 requests and retried once; a no-progress pause waiting without a replacement, then cancelled by Stop; a session with a native and a Codex coordinator answering session-v1 intake. Harness level: two members on two routes of one ChatGPT account waiting on one allowance and both continuing when it is resumed; a Messages route's relaxed schema; a route recorded unable to carry a schema refused for a structured turn; cancelling a native task cancels its child waiting on the model |
| `node scripts/test.mjs tests/native-loops.test.ts` | 4 passed | An iteration waiting on an allowance two routes share and continuing after it is resumed; a native coordinator waiting in place mid-round and finishing the same turn; a no-progress wait; Stop during a quota wait |
| `node scripts/test.mjs tests/proxy-protocols.test.ts` | 52 passed (5 new) | Output formats parsed from and serialized to each protocol, every client → upstream conversion, Messages refusal and relaxation, strict detection, refusal of JSON mode without a schema, descriptions and bad names |

A scratch probe (not kept in the repository) passed each member schema through `memberOutputFormat`: the coordinator-v1 contribution, endorsement, information and implementation schemas, the review schema, the session-v1 intake schema and a recursive-loop-v1 boundary envelope are all strict-compatible for OpenAI, and after relaxation each passes the Messages checks.

### Acceptance — what "done" asked for

| Criterion | Covered by | Not covered |
|---|---|---|
| A stand-in-backed coordinator team with a native member on a synthetic route runs a goal to acceptance | `native-members`: "a coordinator team with a native coordinator and a native implementer on a synthetic route runs a goal to acceptance" (real control service, proxy and harness; Codex stand-in for the vendor members; owner acceptance through the digest) | A live model; an Electron journey that pins a native member |
| A loop that waits on a shared quota | `native-loops`: "an iteration waits on an allowance two routes share…" (and its early wake when the allowance is resumed) and the mid-round case; `native-members`: "members on two routes of one account share one allowance wait…" (real kernel and proxy) | A service-level loop that waits on a quota: the service-level Goal loop (`native-members`) runs without one |
| Loops run with native members | `native-members`: "a Goal loop with a native coordinator and implementer answers recursive-loop-v1 through the proxy and promotes its result" | Endless mode with native members |
| Topsl sessions | `native-members`: "a Topsl session takes a native coordinator beside a Codex one…" | Session work items with native implementers |
| Bounded episodes, no-progress waits, Stop cancelling native members and descendants | `native-members`: the bounded-episode and no-progress cases, and "stopping a native attempt cancels its running descendants" (a native task's child waiting on the model is cancelled with its parent); `native-loops`: no-progress and Stop | A member turn with descendants: member turns get no delegation tool yet |
| Historical records keep their reading | `memberEngine` and the optional fields; the existing orchestration, loop and session suites pass unchanged | A profile written before this work, opened and run again |

### Limits

- **Synthetic only.** No live ChatGPT, OpenAI, Anthropic, gateway or Ollama request; whether the ChatGPT plan route accepts `text.format`, and whether a given gateway or Ollama enforces `response_format`, is unknown.
- **Member turns are narrower than native tasks.** No commands, network, delegation, MCP tools or hooks, and no per-member request budget (the default 50).
- **No pinned effort for native members.** A route has no observed effort catalog, so a pinned effort is refused rather than sent unverified.
- **Quota waits are kept in memory.** After a restart a waiting member is resumed like any interrupted member and will wait again if the upstream still reports its limit.
- **Capacity is counted twice over.** The engine counts an executing native member against its shared capacity, and the harness bounds native requests with its own pool of two; the vendor concurrency budget does not see native requests, so chats and vendor workflows outside the engine can run beside them.
- **Native tasks lists member turns.** Member attempts are root attempts in the journal, so they appear under **Native tasks** (with titles such as `coordinator native-coordinator · initial`); that is where a stalled member is resumed. They offer no apply: their candidates belong to the goal.
- **No route capability editor.** `structuredOutput` defaults to `unknown`; nothing in the window records it yet.
- **Usage views.** The provider usage views still show vendor usage only; native usage is in the attempt's journal, the proxy's receipts and loop accounting.

### Full suite and desktop journeys

- **`npx tsc --noEmit`, then `env -u ANTHROPIC_BASE_URL node scripts/test.mjs`, on commit `b515f7b` (started 09:32:47):** typecheck clean; 1,351 passed, 25 failed, 6 skipped (1,382 tests in 98 files). The 25 failures are the ones described [above](#full-suite): all 21 in `tests/environments.test.ts` and 4 in `tests/round2-acceptance.test.ts`, every one the same missing `npm-cli.js` beside Electron's executable. No other test failed. An earlier run on `46ce891` gave the same 25 failures with 1,349 passed.
- **Desktop journeys:** `npm run build`, then `env -u ANTHROPIC_BASE_URL npm run test:desktop`, on commit `8e58e01` (the last change to window code): **all eight journeys passed** (main desktop harness with encrypted restart, coordinator, Atlas, loop, session, Claude usage, Providers, and the native harness journey). None of them pins a native member; they show that the role editor and session picker changes broke none of the existing paths.
