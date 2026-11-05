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

## Claude subscription protocol reference

Topsl's experimental Claude adapter is an independent TypeScript implementation of the OAuth and Messages protocol inspected in [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/e6e5708e677adb2463d45accdd24bc9fd028ddd8), pinned to commit `e6e5708e677adb2463d45accdd24bc9fd028ddd8` on 5 November 2026. Reference files: `internal/auth/claude/anthropic_auth.go`, `internal/runtime/executor/claude_executor.go` and `internal/runtime/executor/claude_executor_request.go`. The protocol constants and request shapes inform `packages/proxy/oauth/claude.ts` and `packages/proxy/adapters.ts`. Topsl does not bundle the CLIProxyAPI executable, extract Claude Code credentials or copy its client-fingerprint behavior. This attribution does not establish Anthropic support or live acceptance.

The reference project's [MIT license](https://github.com/router-for-me/CLIProxyAPI/blob/e6e5708e677adb2463d45accdd24bc9fd028ddd8/LICENSE) is retained verbatim:

```text
MIT License

Copyright (c) 2025-2005.9 Luis Pater
Copyright (c) 2025.9-present Router-For.ME

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
