# Navigator’s Atlas — delivery and validation

19 October 2026. This record covers the UI overhaul agreed on 18 October. The canonical product decisions are in [Topsl design, section 20](Topsl_Design.md#20-interface-design-navigators-atlas); current acceptance is summarized in [Implementation status](Implementation_Status.md).

## Delivered behavior

- *Superseded on 28 October 2026 by coordinator conversations in the sidebar ([follow-up](#follow-up-coordinator-conversations-28-october-2026)).* A project command desk replaces the separate Activity and Workspace routes. Its sidebar contains Overview, Sessions, Coordinator, Tasks, Changes, Context, History and Synchronization. Projects, Applications and Settings remain globally available. Launch restores a valid saved project/view; another project opens Overview. An unknown view falls back to Overview without a database migration.
- Paper uses parchment and sailcloth; Night uses deep ocean surfaces. Serif headings, readable system controls, fine chart rules and compass details establish the Atlas identity. System retains its existing preference and vault-unlock behavior. Terminal colors update in place, preserving the PTY and xterm mount.
- Overview shows attention items and summaries. Coordinator has its own conversation and role editor. Tasks owns workflow setup; Changes owns candidate review. History combines paged conversations/imports and approved source observation. Settings groups the existing controls into Appearance, Agent behavior, Configuration and Context.
- Navigation becomes a native HTML dialog below 900px, with focus trapping and restoration; controls stack below 700px. Task inspectors use dialogs below 1200px. Hidden project sections retain drafts and terminals; project switches retain the existing scoped-read fencing.
- The [canonical vector topsail](../assets/brand/topsl.svg) supplies renderer and native identity. The original geometry was authored for this delivery. Generated PNG, ICNS and ICO assets are under `assets/brand/icons/`. `npm run icons:build` uses the installed electron-builder converter; the first conversion can download its tool bundle. Normal builds use the saved exports. Native macOS package verification now checks the signed bundle’s icon against that canonical export.

The allowance and budget work already present in the checkout was retained, including its unknown/stale states, explicit refresh controls and distinction between provider reports and owner-set budgets. This overhaul adds no provider execution or approval authority.

## Reproducible checks

Host: macOS 27.0.1 (26A434), arm64; Node 26.0.0; Electron 44.4.5. Base revision: `b3e5a187f27a865ca82ad47aa74e834bbaa54a5f`, plus the uncommitted working tree, including the pre-existing allowance changes. Results apply to that combined tree.

```sh
env -u ANTHROPIC_BASE_URL npm run check
env -u ANTHROPIC_BASE_URL npm run test:desktop
node scripts/round2-ui-test.mjs
npm run icons:build
npm run package
npm run verify:mac-package
node scripts/packaged-atlas-inspection.mjs
git diff --check
```

| Check | Result |
|---|---|
| Before UI changes: `npm run check` | Passed: 515 tests, 4 skipped tests; 48 test files passed, 3 skipped; 17 release checks; TypeScript and build passed. |
| Final application checks | Passed: TypeScript; 534 tests with 5 skipped tests, 50 test files passed and 3 skipped; 18 release checks; build. The pre-existing renderer chunk-size warning remains. |
| Main Electron journey | Passed all four workflow teams against local stand-ins, project discovery, history/import/search, approvals, terminal modes, themes, compact/enlarged layouts and encrypted restart. |
| Atlas Electron journey | Passed every destination in both themes at 1280 × 880 and 560 × 720, 150% zoom, reduced motion, Unicode, native navigation dialog, focus restoration, draft retention, terminal theme/view continuity, project switching to Overview and History restoration after restart. |
| Review-evidence Electron fixture | Passed guided drafts, stale/late reads, retained errors, findings, protected logs, cleanup, binary review, exact candidate confirmation, recapture and compact/enlarged layouts. Its 30 interaction samples had p95 116ms, maximum 125ms, against a 250ms target. |
| Native icon assets | Release checks validate ICNS, multi-size ICO and PNG dimensions. Regenerating all 11 exports preserved their SHA-256 digests. The topsail was visually inspected at 16, 32, 64, 256 and 1024px. |
| macOS package | Passed: local arm64 archive, extracted signature and canonical topsail resource; packaged startup in a fresh disposable profile; native Projects, About icon/credits and menu labels inspected. Dock visibility returned true; its pixels remain unverified. |

The older evidence fixture was brought forward to the current Claude terminal-step contract (`set-in-claude-code` and recorded step arrays), and its setup navigation now follows Tasks. Its inspector assertion follows the existing rule that a background refresh keeps the action available while newer evidence still wins. The main and coordinator harnesses wait for runtime registry publication before trust and for the unlocked shell before reading restored state. These changes do not weaken execution or approval checks.

## Visual and contrast evidence

Selected captures and machine-readable reports are retained under [ui-evidence/2026-10-19-atlas](ui-evidence/2026-10-19-atlas/). They contain synthetic fixture projects and local stand-ins. The Atlas journey produces the complete capture set under ignored `test-results/atlas/`; the review fixture writes `test-results/round2-ui/`.

| Rendered color pair | Paper | Night |
|---|---:|---:|
| Main text / background | 10.11:1 | 13.46:1 |
| Muted text / background | 4.94:1 | 9.68:1 |
| Primary action text / fill | 8.58:1 | 8.32:1 |
| Brass text / background | 4.83:1 | 8.47:1 |
| Essential boundary / panel | 3.76:1 | 4.61:1 |
| Focus / background | 6.25:1 | 8.47:1 |

The test reads the actual CSS tokens loaded in Electron and checks the used text/status/sidebar pairs against 4.5:1, and control/focus boundaries against 3:1. This is representative rendered-palette validation and visual inspection, not a complete screen-reader or accessibility certification. The primary desktop journey separately compares System with Paper/Night and the native window background. Terminal continuity is checked with a real PTY and a local echo stand-in; no vendor turn is submitted.

The final packaged app was inspected through Computer Use using its exact bundle path. The About dialog displayed the ivory topsail on navy, **Topsl Version 0.1.2**, and **Navigator’s Atlas · pronounced “topsail”**. The native menu displayed **About Topsl** and **Quit Topsl**. Dock observations timed out twice with error `-10005`; the Dock visibility API is only visibility evidence. An auxiliary `app.getFileIcon` diagnostic caused an Electron SIGTRAP on this host and was removed from the inspection helper; Topsl does not call that API. Subsequent normal packaged startup, Projects/About inspection and clean shutdown passed. This does not establish a general macOS crash/soak qualification.

## Follow-up: decluttering pass — 27 October 2026

The owner found the interface cluttered and asked for redundancy to be removed. This pass changes presentation only; no command, permission, or service behavior changed.

| Area | Before | After |
|---|---|---|
| Data freshness | A full freshness panel with a retry button and a disclaimer on every page, repeated inside Sessions, Tasks, Changes and Synchronization sections (up to three per screen). | One compact line per project page. Sections pass `quiet` to [`Freshness`](../apps/desktop/renderer/components/freshness.tsx) and appear only when their own read is stale, failed or disconnected. **Retry project reads** appears only when the status is not current. Coordinator keeps the line its team or loop view already shows. |
| Page headings | Eyebrow (`PROJECT COMMAND DESK / …`, `YOUR TOOLBOX`, `APPLICATION SETTINGS`, `SHARED LOCAL FOLDERS`), tagline, decorative compass and **Refresh activity** button. | Title only; Overview also shows the project path. Settings is titled **Settings**. The freshness retry replaces **Refresh activity**. |
| Window chrome | Topbar platform and “On this computer”; status bar taglines. | Topbar shows the breadcrumb; status bar shows **Ready** or **Operations pending**. |
| Overview | Two shortcut cards and two shortcut buttons repeating sidebar destinations; four-line capacity and usage cards. | Needs attention plus short Responsibility, Capacity and Usage summaries. |
| Sessions | **Manage shared projects** (repeats sidebar Projects), `PROVIDER ATTRIBUTION PRESERVED`, two adapter notes and a paragraph-length usage line computed three times. | One note, and a one-line usage summary only when the conversation has turns. The transcript's message count shows only when messages are loaded. |
| Applications | “You approve every Topsl update” strip, long usage disclaimer, the same two install notes on every card. | Test-profile notice kept; one-line usage note; uninstalled cards say **Not installed.** |
| Settings | Section index links; always-expanded Native capabilities with a link back to Applications. | Native capabilities is a collapsed section. |
| Synchronization | Unobserved dimensions repeated “Source: unavailable. Last successful observation: unknown.” | The “no observation recorded” line stands alone. |

Code redundancy removed in the same pass: the Coordination view's private label helper (now `viewLabel` from [navigation](../packages/domain/navigation.ts)), an unused `messages` computation in the renderer root, the handoff provider check (now `terminalProvider`), and dead CSS for the compass heading, shortcut cards, topbar divider, settings index and freshness disclaimer.

### Checks for this pass

Revision: branch `claude/project-thread-1vq93z` from `c50fac1`, Linux x64 cloud container, Node 22.22.0.

- `npx tsc --noEmit` passed.
- The renderer was built with Vite and driven in Playwright Chromium against a real `Service` (isolated test profile, synthetic project) through a local HTTP bridge standing in for the Electron preload. Every destination was captured before and after at 1440 px; no page errors. This is not an Electron, packaged or native-window run.
- Electron journeys (`npm run test:desktop`, `scripts/campaign-ui-test.mjs`) could not run here: the container cannot download Electron headers to rebuild the native modules. Their selectors were updated for the removed text (**Make it your workspace.** → **Settings**, **Manage shared projects** → sidebar **Projects**, the removed update strip) and remain unverified until run on a desktop.
  - *Follow-up, 28 October 2026:* those journeys ran in Electron on macOS arm64 after the coordinator conversations branch was rebased onto this pass (`fa1d934`): `npm run test:desktop` (all four journeys) and `scripts/campaign-ui-test.mjs` (31 of 31) passed. That run includes the conversation redesign, so it verifies the combined screens, not this pass alone ([record](Implementation_Status.md#coordinator-conversations--28-october-2026)).
- `npx vitest run` under plain Node (the container's `better-sqlite3-multiple-ciphers` is built for Node, not Electron, so `npm test` was not used): with `ANTHROPIC_BASE_URL` set by the container, 173 tests in 28 files failed on the billing preflight. Rerunning those 28 files with `env -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_USE_CCR_V2` left 5 failures in `campaign-checks-parallel`, `campaign-claude-codex` and `campaign-loops-state-service`; the same 5 fail identically on unmodified `origin/main` in this container, so they are environmental. No renderer test failed.

## Remaining acceptance boundaries

The local macOS package is a personal-pilot artifact. Windows/Linux native UI and packaged icon acceptance, remote CI, notarized distribution, full screen-reader/IME acceptance and live-provider qualification require their own evidence. Historical provider, synchronization and release gates retain their original scope. The UI captures and synthetic journeys do not close them.

## Follow-up: coordinator conversations (28 October 2026)

The project command desk's sidebar is replaced by a project tree with each project's coordinator conversations, **+ New conversation**, and the selected project's **Project tools** (the seven other destinations). Selecting a project opens its New conversation page rather than Overview. The Atlas tokens, typography and emblem are unchanged; the new sidebar markers use the existing brass `#dfbf7c`, measured at 7.31:1 on the Paper sidebar and 9.82:1 on Night, with `#142c38` text on brass at 8.21:1. The Atlas journey now visits **New conversation** instead of **Coordinator**, asserts one `h1` and one current location on every destination, and captures a goal conversation with its pane docked at 1200px and overlaid at 1199px. Design: [§20.4](Topsl_Design.md#204-main-window); record and results: [Coordinator teams](Coordinator_Teams.md#follow-up-conversations-as-threads-28-october-2026); captures: [ui-evidence/2026-10-28-conversations](ui-evidence/2026-10-28-conversations/).

## Follow-up: native sessions (29 October 2026)

The sidebar's **+ New session** replaces **+ New conversation**, each project lists its sessions (◆) and loop runs (↻, ∞), and the **Sessions** project tool is labelled **Provider tools** ([design §20.4](Topsl_Design.md#204-main-window)). The session view adds an **Auto / Discuss / Work** segmented control and a **Target** select to the composer bar, **Session controls** in the header, a warm attention banner for **Choose**, **Configure team** and **Choose model**, and **Contributions** disclosures under shared coordinator responses. The New session page adds the coordinator picker and the team setup side by side from 1200px and stacked below. New styles use the existing Atlas tokens only (`--line`, `--accent-soft`, `--warm-*`). The [session journey](../scripts/desktop-session-test.mjs) checks one heading and no horizontal overflow in Paper and Night at 1280 × 900 and 560 × 720 against stand-in providers; screen-reader, IME and packaged acceptance remain open as above.
