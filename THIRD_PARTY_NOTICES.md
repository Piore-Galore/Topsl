# Third-party notices

Topsl is distributed under the [MIT License](LICENSE). Packages that Topsl bundles keep their own licenses; each package's license text ships with it inside `node_modules` in the packaged application.

This file lists the dependencies and protocol references that the [native harness](docs/Native_Harness_Plan.md) added on 5 November 2026.

| Package | Version | License | Use in Topsl |
|---|---|---|---|
| [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) | 0.0.81 | Apache-2.0 | Runs each native tool command, hook and local MCP server in its own macOS Seatbelt sandbox, through the package's `srt` program (`packages/harness/sandbox.ts`). Unmodified. The package describes itself as a beta research preview. |
| `commander` (dependency of sandbox-runtime) | 12.1.0 | MIT | Used by `srt`. |
| `zod` (dependency of sandbox-runtime) | 3.25.76 | MIT | Used by `srt`. |
| `@pondwader/socks5-server` (dependency of sandbox-runtime) | 1.0.10 | MIT | Used by `srt`'s network proxy. |
| `node-forge` (dependency of sandbox-runtime) | 1.4.3 | BSD-3-Clause OR GPL-2.0 | Used by `srt`. Topsl distributes it under the BSD-3-Clause option. |

The sandbox-runtime package also contains `vendor/` helpers for Linux and Windows. They are packaged with it but not used: Topsl qualifies native containment on macOS only.

Apache-2.0 requires that redistributions include the license text and any NOTICE file the package provides. The sandbox-runtime package ships its `LICENSE` file and provides no separate NOTICE file at version 0.0.81.

## Retired: Claude subscription protocol reference

From commit `4f82336` to `837a1f7` (5 November 2026), Topsl's experimental direct Claude adapter was an independent TypeScript implementation of the OAuth and Messages protocol inspected in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/e6e5708e677adb2463d45accdd24bc9fd028ddd8) (MIT), and this file carried that project's license text. The adapter was removed later on 5 November 2026 ([plan §1.3](docs/Native_Harness_Plan.md#13-follow-up--direct-claude-plan-retired-again-and-external-model-services)). It lived in `packages/proxy/oauth/claude.ts`, the Claude request headers in `packages/proxy/adapters.ts`, and `tests/proxy-claude-auth.test.ts`; all three are gone, and the shared protocol serializers were never derived from that project. No code derived from it remains, so this revision no longer reproduces its license. Earlier commits that contain the adapter keep the license text in their own copy of this file.
