# Navigator’s Atlas — delivery and validation

19 October 2026. This record covers the UI overhaul agreed on 18 October. The canonical product decisions are in [Topsl design, section 20](Topsl_Design.md#20-interface-design-navigators-atlas); current acceptance is summarized in [Implementation status](Implementation_Status.md).

## Delivered behavior

- A project command desk replaces the separate Activity and Workspace routes. Its sidebar contains Overview, Sessions, Coordinator, Tasks, Changes, Context, History and Synchronization. Projects, Applications and Settings remain globally available. Launch restores a valid saved project/view; another project opens Overview. An unknown view falls back to Overview without a database migration.
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

## Remaining acceptance boundaries

The local macOS package is a personal-pilot artifact. Windows/Linux native UI and packaged icon acceptance, remote CI, notarized distribution, full screen-reader/IME acceptance and live-provider qualification require their own evidence. Historical provider, synchronization and release gates retain their original scope. The UI captures and synthetic journeys do not close them.
