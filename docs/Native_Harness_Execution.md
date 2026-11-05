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
