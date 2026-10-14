# Coordination baseline and Phase 0 evidence

Recorded 14 October 2026. This report separates repository checks, read-only runtime discovery, and live execution acceptance. The improvement plan's later phases are not established by these results.

## Reconciled starting point

- Reviewed/current commit: `2c6318d5d3d459086a5a796f82637c5db56c1994`.
- Host: macOS 27.0.1 (26A434), arm64; Node 26.0.0; npm 11.12.1; Electron 44.4.5; TypeScript 7.0.2; Vitest 5.0.2; SQLCipher driver 13.0.3.
- Existing local modifications were preserved: packaging workflows, README, implementation status, package configuration, package summary, macOS signature gate, and its tests. No branch, commit, publication, provider installation/update, authentication change, or model inference was performed for Phase 0.
- No applicable `AGENTS.md` was found in the checkout, its parents, or the edited package/test/document paths.

| Command / observation | Actual result | Boundary |
|---|---|---|
| `npm run check` before implementation | Passed TypeScript, 111 unit tests (one optional native test skipped), 17 release tests, and application build | Existing >500 kB renderer chunk warning; fixtures do not certify paid runtime execution |
| `npm run test:desktop` against that baseline build | Passed Electron journeys and encrypted restart on macOS arm64 | Root validation log: `/tmp/topsl-desktop-baseline-20261014.log`; synthetic provider homes |
| `npm test -- tests/context-pagination.test.ts tests/store.test.ts` after Phase 0 changes and encrypted migration wiring | Passed 22 tests | Actual local context sockets and encrypted temporary databases; no provider turns |
| `npm run typecheck` after initial migration wiring | Passed | Before concurrent later-phase source edits |
| `npm run check` while Phase 1/2 implementation was underway | Stopped at TypeScript: unresolved `PageScope` in coordination repository and `ExecException` type in verification | Log `/tmp/topsl-phase0-check-20261014.log`; these concurrent later-phase errors require final integrated checks and are not hidden as Phase 0 success |

## Provider capability inventory, version 1

Official pages were fetched on 14 October 2026. Installed-runtime discovery used only explicit executable paths and empty temporary homes. The reproducible probe is [probe-provider-capabilities.mjs](../scripts/probe-provider-capabilities.mjs); its sanitized result is [2026-10-14-local.json](provider-capabilities/2026-10-14-local.json). It contains no credentials, native user projects, transcript contents, or account identity.

```sh
node scripts/probe-provider-capabilities.mjs \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex \
  --claude /opt/homebrew/bin/claude
```

Observed Codex: `0.162.0-alpha.17.2`; Claude Code: `2.1.183`. Codex generated 447 version-specific JSON schema files containing 266 method/event names. A schema or help flag is discovery evidence, not successful execution or an entitlement guarantee.

| Capability / route | Classification at this baseline | Authentication and billing boundary |
|---|---|---|
| Codex app-server initialize, model catalog | Read-only locally tested: initialization and eight catalog entries | Empty native home; no account or inference. A catalog does not certify model access |
| Codex `account/read` | Read-only locally tested; account absent in fixture | Native credentials remain provider-owned; no login or refresh was requested |
| Codex `thread/list`, `project/list` | Read-only locally tested, zero records in isolated home | No real project/session contents accessed |
| Codex start/resume, turn streaming, approvals, interrupt, usage | Existing deterministic protocol fixtures; current authenticated runtime execution untested | Runtime-specific schemas and effective sandbox/tool policy must be validated before live acceptance |
| Codex project create/update/move and richer history methods | Current schema observed; current mutation/history acceptance untested | Earlier 0.158 registry acceptance remains historical evidence; visible desktop refresh remains unverified |
| Claude native terminal and explicit history import | Implemented; terminal/import fixture tested | Native login, permissions and subscription remain under the native application; no credential copying |
| Claude print/stream JSON, resume/fork, tools/permissions | Installed help flags observed; structured execution untested | Requires a verified selected auth arrangement, protocol and permission behavior; no silent fallback |
| Claude Agent SDK | Officially documented structured route; not enabled by this baseline | Official SDK guidance requires prior approval to offer third-party claude.ai login/rate limits; API authentication is a distinct billing route |
| Claude bare mode | Installed flag and official behavior observed; execution untested | Skips OAuth/keychain credentials and needs API credentials or a configured provider; cannot transparently use subscription login |
| Full Claude native project-list CRUD/sidebar mirroring | Unsupported by Topsl's verified baseline adapter | Native folder handoff does not certify sidebar synchronization |
| Visible Codex sidebar, native setting reload, enforced independent filesystem access | Unverified or unsupported by this context service | Context retrieval policy alone cannot isolate native files, terminals, transcripts or tools |

Codex app-server exposes versioned schemas, sessions, approvals and account methods; native managed authentication and API authentication remain distinct. [Official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server), [authentication documentation](https://learn.chatgpt.com/docs/auth).

Claude's programmatic CLI supports JSON/streaming routes, but non-bare print sessions load repository hooks/MCP without a trust dialog. Bare mode requires different credential handling. The SDK's third-party subscription restriction is an explicit dispatch gate until an approved arrangement is evidenced; discovering flags does not resolve it. [Official Claude programmatic CLI documentation](https://code.claude.com/docs/en/headless), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [native authentication documentation](https://code.claude.com/docs/en/authentication).

No API key was requested, introduced or used. No model turn was submitted. No vendor installation, native project mutation, provider setting, subscription credential or billing route was changed. Missing usage remains unknown rather than zero.

## Grants and retrieval contract

`ContextServer.grant(project, options)` issues an independent random grant ID and token. Each grant has a server-held project scope, copied visibility policy, optional session/attempt/workflow/task attribution, and expiry. Default duration is eight hours; maximum duration is 24 hours. `revoke(id)`, `revokeProject(projectId)` and `revokeAttempt(attemptId)` independently invalidate grants. Closing Topsl discards all grants. Grant files use unique filenames and private permissions; they remain unusable after expiry/revocation/process close.

The server permits only status and attributed history/search reads. Request-supplied project IDs, visibility policies, grant-file expiry fields or subject labels cannot broaden the server-held scope. Message, conversation and run allowlists and exclusions apply in SQL before page limits. Empty allowlists deny all records; malformed policies fail. Status explicitly reports that this service does not enforce filesystem isolation. It does not claim independent review while another tool can read withheld content.

Legacy `history` and `search` return the first permitted page as arrays. `history-page` and `search-page` return `{items, nextCursor}`. The companion CLI supports both page commands with `--cursor` and `--limit`; MCP offers `topsl_history_page` and `topsl_search_page`. Page sizes are 1–50. Responses contain stable message/conversation/run references and bounded 2,000-character excerpts with a `truncated` marker. Full stored history is retained; these excerpts are not completeness claims for a context package.

## Storage and pagination contract

Schema 2 adds `document_index` with an immutable autoincrement sequence and indexed kind/project/conversation scopes. Triggers preserve the index for inserted, updated and deleted legacy document records. Existing documents backfill in insertion order. Schema 3 is the subsequent coordination migration; Phase 0 invokes it through the shared versioned migration path.

Before any existing database upgrade, the shared migration helper checkpoints WAL, leaves WAL mode, acquires an exclusive rollback-journal lock, copies the complete encrypted main database to a private versioned backup, and verifies it through keyed reopen, integrity check and schema read. Migration runs transactionally. It never copies a live database/WAL pair or creates a plaintext SQLite backup. New empty databases skip the schema-0 backup; existing schema-1 and schema-2 stages each receive a compatible encrypted backup.

- `Store.page<T>(kind, PageOptions)` returns indexed cursor pages; generic scope can be project/conversation scoped.
- `Store.iterate<T>(kind, DocumentScope)` traverses the complete scoped sequence without the global state window.
- `Store.messagesPage(MessagePageOptions)` requires a project and supports conversation/role/visibility predicates.
- `Store.searchPage(projectId, query, options)` applies the same visibility predicates to full-text search.
- Cursors bind ordering and actual query predicates and fix an upper sequence boundary. Equal timestamps do not collide, updates retain position, and new appends do not move the current sequence. Updates/deletions remain current observations rather than a historical content snapshot.
- `previewHandoff` selects its latest 30 permitted user/assistant messages by project and conversation before excerpting. It no longer loses older-project records to global unrelated activity.

`Store.list()` remains capped for the legacy application-state projection. Scoped context/history/handoff reads are independent of that cap. Handoff excerpt budgets and the later structured context package's mandatory-content/omission gates remain separate work.

The regression suite covers two concurrent grants and isolated revocation; exact expiry; wrong tokens; copied policy; every available retrieval route; client scope escalation; denied commands; invalid policies/cursors/page sizes; 137 target messages followed by 5,100 other-project messages; equal timestamps; append/delete/update paging; role filtering; tombstones/reopen; and encrypted schema-1 backup/readback.

## Execution and synchronization boundaries

At this baseline, runtime managed-writer exclusion is project-wide and does not control outside editors/native sessions. Later workspace leases must establish canonical workspace ownership before parallel execution. Context grants supply read-only retrieval authority and never approve tools, deployments or provider operations.

Local folder identity, native registry readback, folder opening, visible native presentation, context delivery, history coverage, effective configuration and code integration are separate observations. Registry success is not desktop-sidebar success; an imported transcript is not native resume; a compiled fixture is not a live runtime acceptance result. Private native stores remain read-only compatibility sources.

Large-history/UI performance, Windows/Linux context transports, authenticated inference/real approvals/sandbox enforcement, full native history fidelity, independent tool/filesystem isolation, packaged OS/runtime acceptance and later-phase integrated checks remain explicit gates. The 100,000-message benchmark is a target, not a Phase 0 measurement.
