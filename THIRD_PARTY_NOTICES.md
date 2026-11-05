# Third-party notices

Topsl is distributed under the [MIT License](LICENSE). Packages that Topsl bundles keep their own licenses; each package's license text ships with it inside `node_modules` in the packaged application.

This file lists the dependencies that the [native harness](docs/Native_Harness_Plan.md) added on 5 November 2026. No third-party source code was copied into Topsl's own files for this work.

| Package | Version | License | Use in Topsl |
|---|---|---|---|
| [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime) | 0.0.81 | Apache-2.0 | Runs each native tool command, hook and local MCP server in its own macOS Seatbelt sandbox, through the package's `srt` program (`packages/harness/sandbox.ts`). Unmodified. The package describes itself as a beta research preview. |
| `commander` (dependency of sandbox-runtime) | 12.1.0 | MIT | Used by `srt`. |
| `zod` (dependency of sandbox-runtime) | 3.25.76 | MIT | Used by `srt`. |
| `@pondwader/socks5-server` (dependency of sandbox-runtime) | 1.0.10 | MIT | Used by `srt`'s network proxy. |
| `node-forge` (dependency of sandbox-runtime) | 1.4.3 | BSD-3-Clause OR GPL-2.0 | Used by `srt`. Topsl distributes it under the BSD-3-Clause option. |

The sandbox-runtime package also contains `vendor/` helpers for Linux and Windows. They are packaged with it but not used: Topsl qualifies native containment on macOS only.

Apache-2.0 requires that redistributions include the license text and any NOTICE file the package provides. The sandbox-runtime package ships its `LICENSE` file and provides no separate NOTICE file at version 0.0.81.
