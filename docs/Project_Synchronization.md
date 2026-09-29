# Shared local projects

Topsl provides one local folder catalog for all four catalog applications. Native metadata discovery feeds that catalog. An independently enabled Codex connection synchronizes its native project registry through the experimental app-server API. Opening a project passes the same directory through a supported native route. Project files are shared through the filesystem, with no duplicate checkout or background file copying.

## Sources and compatibility

Discovery starts only after the native consent dialog. The enabled preference is bound to the exact source paths; changing provider homes requires enabling the new scope. The production service reads these files only. The isolated test service always uses a synthetic `native-home` inside its temporary profile.

| Source | Metadata read | Scope and limitation |
|---|---|---|
| Codex desktop | `$CODEX_HOME/.codex-global-state.json`, or `~/.codex/.codex-global-state.json`: `electron-saved-workspace-roots` and `local-projects` entries containing `name` and `rootPaths` | Compatibility reader for observed local schemas, not a public project-list API. Newer schemas or projects absent from this metadata are not covered. No remote connection, cloud project, thread, or credential state is retained. |
| Codex CLI | `$CODEX_HOME/config.toml`, or `~/.codex/config.toml`: keys of `projects` | Configured folders only. Does not claim every visited working directory is registered. Native trust values are ignored. |
| Claude shared local configuration | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json`: keys of `projects` | Shared local Code configuration, not a complete inventory of Claude Desktop, Cowork, or cloud projects. Native trust, history, MCP configuration, and account fields are not imported. |

Readers are bounded to 8 MB per file and 2,000 folder references per source. The existing Topsl state projection supports 5,000 projects. Unknown schemas, malformed/truncated input, changing files, missing files, and access failures show individual source status and preserve prior observations. JSON/TOML parser excerpts are not returned to the renderer. No home-directory traversal or transcript scanning occurs.

After opt-in, reconciliation runs at startup, every minute while Topsl is open, and on explicit refresh. Concurrent refreshes coalesce; pausing invalidates pending ingestion. Successful reads replace that source's references transactionally. Removal of a native reference does not delete the Topsl project, its history, or its files. A missing/unreadable source retains its prior references as last-known metadata.

## Identity and trust

Folders merge by canonical filesystem path, with Windows path-case normalization. Symlink aliases share one catalog entry. Each root of a native multi-root project remains a distinct Topsl folder with source project/name references. Display names and Git remotes are never used to merge identities or grant access to additional roots.

Metadata-discovered display names follow their original native project identity when that source reports a rename. Without the Codex API connection, manually added names remain unchanged. With that connection enabled, matched folders follow native project names, and stale legacy cache names cannot overwrite them. Explicit relinking retains the existing display name and clears its previous native name binding; the next Codex sync can register the newly approved path as a separate project without removing the old native group.

New native folders start untrusted regardless of native permission settings. Trusted manual adoption reuses an existing canonical project rather than duplicating it. Every execution checks that the directory still exists and resolves to the approved path. A detected symlink retarget revokes Topsl trust. Explicit relinking preserves the Topsl ID/history, requires a native folder selection and trust confirmation, rejects another project's directory, and is blocked by active or uncertain native work.

## Codex native project connection

Choose a trusted Codex executable under **Codex native projects** and enable synchronization. The native dialog identifies the exact executable and `CODEX_HOME`. The saved connection pins its executable content identity and canonical profile path. A replacement binary, changed profile path, missing runtime, or revoked trust blocks the connection until it is reviewed again. The application probes `project/list` after initialization with `experimentalApi: true`; unsupported APIs or unexpected schemas fail visibly rather than falling back to raw database writes. No API key, account login, model list, or model turn is needed for these metadata operations.

The adapter uses `project/list`, `project/read`, `project/create`, `project/update`, and `project/move`. It reads all pages within the 2,000-project / 5,000-root pilot limit and rejects inconsistent pagination. It persists only IDs, names, paths, order, and observation status; native metadata, timestamps, account fields, and transcripts are not retained. Per-project metadata and extra roots are preserved by name-only updates.

On startup, every minute, and on manual refresh, native projects are matched by canonical directory. New native folders are imported without trust. Trusted local folders absent from the registry are added. A durable idempotency key and the original request name are saved before each create; a lost reply is reconciled by listing native projects before retrying. No delete API is exposed by the synchronizer. Observed native memberships remain recorded so removals do not recreate themselves or delete Topsl history. A folder removed natively must be added again through Codex if the user wants it back.

Native names and project order feed Topsl's sidebar. Multi-root projects remain one native group in the management list and contiguous individual folders in Topsl's folder catalog. If several native groups share the same directory, Topsl keeps one folder/history identity, retains every reference, and uses the first native group for its display name. Folders without a current native reference follow the native groups in Topsl.

Rename and move controls compare the current native snapshot to the reviewed state before writing and refresh afterward. Codex does not expose a conditional-write transaction for these operations; a separate native edit in the interval between preflight and mutation remains a concurrency limitation. Refreshes and edits serialize within Topsl. Pausing invalidates outstanding ingestion and prevents later requests; an already dispatched native change may still finish and is reconciled after resuming.

**Registry synchronization is distinct from visible desktop sidebar synchronization.** The installed desktop has its own project cache and migration path. The app-server registry supports cross-connection readback, but that does not establish that another running desktop will consume external changes. Topsl therefore reports **Registry synced**, with an instruction to open the folder in Codex and check its visible entry. It does not rewrite `.codex-global-state.json`, force-restart Codex, or claim that sidebar pins, custom sections, sorting preferences, or conversations are mirrored. Claude's corresponding native project CRUD/order API has not been verified.

## Opening behavior

| Application | Implemented route | Result reported |
|---|---|---|
| Codex CLI | Existing trusted runtime in the project's canonical directory | Native terminal opened |
| Claude Code CLI | Existing trusted runtime in the same canonical directory | Native terminal opened |
| Codex desktop on macOS | macOS `open -a` with the selected existing application and canonical folder as separate arguments | Folder handed to the app; native picker confirmation remains necessary |
| Claude Desktop on macOS | `open -a` targets the selected existing app with the official `claude://code/new?folder=…` link | Link handed off; Claude's native folder confirmation is required |
| Claude Desktop on other platforms | Open the generated folder link through the system's registered Claude handler | Native confirmation required; system handler may differ from the selected installation |
| Other Codex desktop platforms | Open the selected existing application, show the exact path and native selection steps | Native folder selection required |

Desktop handoffs verify installation identity and project trust. The broker accepts only the exact Claude Code folder URL it generates from the canonical project path: no prompt, extra folder, alternate route, or arbitrary renderer URL is allowed. Opening does not install a missing application, submit a prompt, or establish that a native project was saved. Independently launched desktop sessions remain outside Topsl's writer tracking.

Official behavior references checked on 29 September 2026:

- [OpenAI projects and chats](https://learn.chatgpt.com/docs/projects): local projects reference folders; the CLI uses its working directory.
- [OpenAI developer commands](https://learn.chatgpt.com/docs/developer-commands): `codex app` can open a workspace on macOS; Windows displays the path. Topsl targets the selected existing app directly on macOS to avoid the CLI's missing-app installation behavior.
- [Claude desktop](https://code.claude.com/docs/en/desktop): select a local project folder in the Code surface; native CLI and desktop share local configuration but keep their session history separately.
- [Claude local directory reference](https://code.claude.com/docs/en/claude-directory): per-project entries in `~/.claude.json` belong to Claude. Topsl reads only their path keys.
- [Open Claude Desktop with a link](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link): Code folder deep links and required native confirmation.
- [OpenAI app-server](https://learn.chatgpt.com/docs/app-server): generate version-specific protocol schemas. The installed `0.158.0-alpha.2.1` CLI exposes the project methods in `generate-json-schema --experimental`, not its default schema.

## Validation boundary

Unit and service fixtures cover source parsing, multi-root metadata, aliases, idempotent replay and lost replies, opt-in/trust, invalid/partial/missing sources, native additions/removals, pause/resume, concurrent refresh cancellation, moved/retargeted directories, history preservation, executable/profile changes, stale rename/order checks, Topsl sidebar order, and desktop route/trust checks. Claude link tests include spaces, Unicode, reserved characters, and rejected prompt/route injection. The real Electron smoke exercises discovery, duplicate merging, per-folder trust, native registry creation/rename/order/pause/resume, filtering, compact layout, and encrypted restart using synthetic provider homes.

Real Claude folder-picker acceptance, visible Codex desktop-cache refresh, other native registry versions, other OS desktop launch behavior, and cloud/remote/device synchronization require separate validation. Tests do not mutate the user's real native project lists or submit any model turns.

Recorded local validation: `npm run check` passed strict TypeScript, all 111 deterministic tests, and the application build. `npm run test:desktop` passed the Electron journeys and encrypted restart on macOS arm64. The optional `tests/codex-projects-native.test.ts` probe passed separately against the installed Codex `0.158.0-alpha.2.1`, exercising actual create/readback/rename/reorder and independent-connection visibility, followed by a native deletion that retained Topsl history. It used an empty temporary native home, not the user's profile. Normal and compact Projects captures and the native-management view were visually reviewed. A separate read-only smoke parsed the installed Codex desktop, Codex CLI, and Claude metadata schemas without retaining their content in a Topsl profile.
