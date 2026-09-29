import type { ApplicationDefinition, Capability } from "./types";
export const catalog: ApplicationDefinition[] = [
  {
    id: "openai.codex-cli",
    name: "Codex CLI",
    kind: "cli",
    platforms: ["darwin", "win32", "linux"],
    provider: "codex",
    description: "The official coding agent for your terminal.",
    website: "https://learn.chatgpt.com/docs/codex/cli",
    docs: "https://learn.chatgpt.com/docs/app-server",
    releaseNotes: "https://github.com/openai/codex/releases",
  },
  {
    id: "openai.desktop",
    name: "ChatGPT / Codex desktop",
    kind: "desktop",
    platforms: ["darwin", "win32", "linux"],
    provider: "codex",
    description: "Desktop home for Codex, Chat, and Work.",
    website: "https://chatgpt.com/download",
    docs: "https://learn.chatgpt.com/docs/quickstart",
    releaseNotes: "https://learn.chatgpt.com/docs/changelog",
  },
  {
    id: "anthropic.claude-code-cli",
    name: "Claude Code",
    kind: "cli",
    platforms: ["darwin", "win32", "linux"],
    provider: "claude",
    description: "Claude’s native coding environment.",
    website: "https://code.claude.com/docs/en/setup",
    docs: "https://code.claude.com/docs/en/cli-reference",
    releaseNotes:
      "https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md",
  },
  {
    id: "anthropic.claude-desktop",
    name: "Claude Desktop",
    kind: "desktop",
    platforms: ["darwin", "win32"],
    provider: "claude",
    description: "The Claude app and its Code workspace.",
    website: "https://claude.ai/download",
    docs: "https://code.claude.com/docs/en/desktop",
    releaseNotes:
      "https://support.claude.com/en/articles/12138966-release-notes",
  },
];
export const capabilities: Capability[] = [
  {
    id: "sessions",
    name: "Sessions & models",
    route: "structured",
    description:
      "Codex app-server: version-tested local stdio. Claude: native terminal with its own approvals.",
  },
  {
    id: "skills",
    name: "Skills & commands",
    route: "native-terminal",
    description:
      "Use /skills and the selected runtime’s native commands; normal discovery is preserved.",
  },
  {
    id: "plugins",
    name: "Plugins & marketplaces",
    route: "native-terminal",
    description:
      "Use the native /plugins or /plugin browser. Provider package ownership stays native.",
  },
  {
    id: "mcp",
    name: "MCP & connections",
    route: "native-terminal",
    description:
      "Manage native servers in the runtime. Topsl’s project context bridge exposes context only.",
  },
  {
    id: "hooks",
    name: "Hooks & subagents",
    route: "native-terminal",
    description:
      "Native configuration and terminal routes preserve provider-specific semantics.",
  },
  {
    id: "permissions",
    name: "Permissions & sandbox",
    route: "structured",
    description:
      "Codex structured runs use read-only or workspace-write sandboxes with native approvals. Native terminals remain native-controlled.",
  },
  {
    id: "configuration",
    name: "Native configuration",
    route: "structured",
    description:
      "Full text preview, revision checks, encrypted backups, and explicit application. Loaded state remains unverified.",
  },
];
