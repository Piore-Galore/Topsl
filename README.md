# Topsl

A local desktop workbench for native Codex and Claude tools, with an Applications manager for downloads and approved updates.

This repository now contains a working **personal pilot**, alongside the complete [v2.1 design](docs/Topsl_Design.md) and [design review](docs/Topsl_Design_Review.md). The [implementation and acceptance matrix](docs/Implementation_Status.md) distinguishes implemented behavior, automated evidence, native handoffs, and remaining release gates.

## Run locally

Use Node.js 24 LTS or newer and a native compiler toolchain if prebuilt dependencies are unavailable.

```sh
npm ci
npm start
```

`npm ci` rebuilds SQLite and the terminal module for Electron. `npm start` compiles the app and opens the desktop window. No provider app is installed, updated, trusted, or authenticated by these commands. The first launch discovers installations and checks eligible release metadata.

History and its search index are encrypted with SQLCipher. The database key uses the OS credential store where it is secure; otherwise Topsl asks for a passphrase of at least 12 characters. Linux's insecure `basic_text` backend is rejected. Keep both the database and `vault.json` when backing up a **closed** Topsl profile; losing the vault key loses access to history. Automatic backup/restore management is a later release gate.

## Use the workbench

1. Open **Applications**. Review the detected executable, then choose **Trust executable** before running it. Use **Locate a runtime** for paths that are not discovered automatically.
2. Add a trusted project folder. Its native instructions, extensions, MCP servers, and hooks remain active in native sessions.
3. Open **Native terminal** for either provider. Use **Native login** to authenticate through the provider's own CLI. Topsl does not read or broker native OAuth tokens. Terminal output is transient, including login output.
4. For structured Codex chats, choose **Connect / test**, load the native models, create a chat, and select read-only review or workspace edits. This is an explicitly experimental local stdio integration. Unknown native client requests are rejected, and unsupported features remain available in the native terminal.
5. Import a selected native JSONL transcript under **History**, then search it or prepare an attributed handoff. Imported transcripts are reference history; they are never silently resumed or written back into the provider's store.

The subscription-only pilot blocks known API billing environment overrides. Structured Codex turns require native ChatGPT authentication. Claude's native terminal owns its login, model choice, billing mode, and permissions; inspect these in the native UI before submitting work. Multiple isolated provider profiles, optional API accounts, and remote hosts remain separate roadmap items.

## Shared local projects

Open **Projects → Enable project discovery** to bring native project folders into one catalog. Topsl refreshes the approved sources on startup and every minute while open; **Refresh projects** checks immediately and **Pause discovery** stops observation. Manually added folders are available in the same catalog immediately.

- Codex desktop saved roots and local-project metadata, Codex CLI configured project paths, and Claude's shared project metadata are read from the selected local provider homes. The native dialog shows the exact source files. Only folder names, paths, source identities, and observation status are retained; native trust is not imported.
- Canonical paths merge references to the same folder, including symlink aliases. Every root of a native multi-folder project appears as a separate folder, with its native project reference retained. Separate folders and worktrees keep separate Topsl identities and histories.
- Trust a discovered folder before running a session. Missing or retargeted folders are shown explicitly; **Relink folder** keeps the existing Topsl project identity and history. Removing a folder from a native list never deletes Topsl history or files.
- **Codex native projects → Enable Codex sync** connects a trusted Codex runtime to its local profile. Trusted Topsl folders are registered through the experimental native project API; native names and order flow back into Topsl's catalog and sidebar. Expand the registered projects to rename or reorder native groups. Multi-folder groups retain all roots. **Sync now** refreshes immediately; **Pause Codex sync** stops this connection independently of metadata discovery.
- **Open folder** launches either CLI in the exact shared directory. On macOS, Codex desktop receives the folder through the existing selected application. Claude Desktop receives a `claude://code/new?folder=…` link and asks for native folder-access confirmation. macOS targets the selected Claude application; other platforms use the system's registered Claude handler. Other Codex desktop platforms retain the native folder-picker handoff.

Codex reports **Registry synced** only after native readback. Its desktop can keep a separate sidebar cache, so this does not certify immediate visible sidebar refresh, pins, sections, or chat mirroring. Claude's native sidebar creation/order API is not verified; its integration supplies folder discovery and native folder links. Native formats can change: unsupported or unreadable sources retain their last observation and display an error. Topsl does not edit raw provider registries, copy files between machines, synchronize cloud projects, or import conversations through folder discovery. The [project synchronization notes](docs/Project_Synchronization.md) describe the supported sources and boundaries.

## Applications

The catalog starts with Codex CLI, the desktop application providing Codex (ChatGPT, with legacy Codex discovery), Claude Code CLI, and Claude Desktop. Application lifecycle code is independent of the conversation adapters.

- **Download** creates a preview, then saves a complete checksum-verified official artifact without executing it. Failed and cancelled transfers can be reviewed and retried from byte zero. No partial installer is opened.
- **Install** uses an official native flow. Supported macOS desktop archives are downloaded, checksum-verified, quarantined, and opened for native placement/publisher verification. Other supported installations open the official setup/store route. Finish the native flow, then **Reconcile**. Opening a page or installer never means “installed.”
- **Update** preserves the selected installation's owner and channel. Supported Homebrew casks get one exact package update, with automatic Homebrew refresh disabled. A bundled Codex runtime updates with its desktop parent. Other owners use an explicitly labeled native route.
- Metadata checks run on startup when due, then at most daily per installation, with failure backoff and manual refresh. Discovery also observes local executable changes every five minutes. Topsl does not change native auto-update settings; unavailable settings are shown as unknown.
- Approved changes wait for affected native sessions to be idle. Topsl never force-closes an application to update it. Approvals expire after 15 minutes, including while waiting. Installation changes require a fresh review.
- Interrupted or uncertain jobs remain recorded and block another mutation of that installation. Reconcile against the actual installed version. If an interrupted native owner cannot establish the approved target, repair/finish through that owner; Topsl does not guess, automatically roll back, or blindly replay it.

Installers remain subject to native OS publisher checks and elevation. macOS, Windows, Linux, architectures, and installation channels have independent support gates. A Topsl build on an OS does not certify every vendor installation route on that OS.

## Configuration and context

Settings exposes full native settings/instruction files with before/after previews, source-hash checks, an encrypted backup, and a trusted native approval dialog. JSON and TOML syntax are validated. Active sessions block writes. Topsl reports a written file separately from whether a native runtime loaded it. Symlinked settings require the native editor.

The optional project context connection only searches one approved project's history. Its grant expires when Topsl closes. It has no API for updates, configuration writes, run execution, or approvals. With a locally installed Node.js runtime, configure a native MCP client using:

```sh
node /absolute/path/to/Topsl/dist/cli.cjs mcp /absolute/path/to/grant.json
```

The grant file is created through **Settings → Project context connection**. Keep it private. Topsl does not silently edit a provider's MCP configuration.

## Validate and package

```sh
npm run check          # strict TypeScript, deterministic tests, application compilation
npm run test:desktop   # real Electron UI and encrypted restart in a temporary profile
npm run package       # unsigned local package for this OS and architecture
```

The test suite runs with Electron's Node ABI so the same native SQLite and PTY modules are exercised. Desktop tests use synthetic projects/transcripts; no vendor account, paid model turn, or real application installation is involved. Linux GUI tests need a display, for example `xvfb-run --auto-servernum npm run test:desktop`. The Linux CI smoke process uses Chromium's `--no-sandbox` only for that isolated fixture run; shipped application configuration keeps renderer sandboxing enabled.

For an explicitly selected trusted Codex binary, a separate read-only protocol probe uses an empty temporary native home and submits no model turn:

```sh
node scripts/probe-codex.mjs /absolute/path/to/codex
```

To verify the selected runtime's experimental project API, run the optional native acceptance test. It creates, renames, reorders, and removes only temporary fixture projects in an empty native home, with zero model turns:

```bash
TOPSL_NATIVE_PROJECT_BINARY=/absolute/path/to/codex npm test -- tests/codex-projects-native.test.ts
```

The output packages are a macOS ZIP, Windows portable EXE, and Linux AppImage. They are personal-pilot builds without distribution signing/notarization. Native runtime compatibility and production eligibility are separate from compilation.

## GitHub builds

[Compile Topsl](https://github.com/Piore-Galore/Topsl/actions/workflows/build.yml) checks and packages macOS Apple silicon, macOS Intel, Windows x64, and Linux x64 on standard GitHub-hosted runners. It runs only while the repository is public. Standard public runners are free; larger runners are not. [GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

The workflow uses read-only repository permissions, pinned actions, bounded job timeouts, and no artifact/cache uploads. Package names, sizes, and checksums appear in the run summary. Packages are compiled on each runner but are not retained after it finishes; persistent downloads/releases can be configured separately against an explicit storage allowance. This avoids introducing artifact-storage charges. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

## Repository layout

```text
apps/desktop/          Trusted Electron broker, preload, React UI, protected vault
apps/service/          Separate utility process and typed command dispatch
apps/cli/              Read-only project context CLI / stdio MCP adapter
packages/applications Discovery, release metadata, approved lifecycle jobs
packages/runtime/     Codex stdio protocol and native PTY sessions
packages/persistence/ Encrypted SQLite records, search, event journal
packages/workspace/   Configuration previews, imports, handoffs, context grants
packages/domain/      Contracts, catalog, command validation, invariants
tests/                Controlled native process, lifecycle, privacy, persistence tests
docs/                 Full design, review, and implementation acceptance matrix
```
