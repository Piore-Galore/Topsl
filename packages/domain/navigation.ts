/** Persisted project destinations. Existing preference values remain valid. */
export const projectViews = [
  "overview",
  "sessions",
  "coordinator",
  "tasks",
  "changes",
  "context",
  "history",
  "synchronization",
] as const;

export type ProjectView = (typeof projectViews)[number];

export function projectView(value: unknown): ProjectView {
  return projectViews.includes(value as ProjectView)
    ? (value as ProjectView)
    : "overview";
}

/**
 * Direct Claude Code and Codex sessions are Provider tools: "session" now
 * names a Topsl session (docs/Native_Sessions_Plan.md). The stored view value
 * stays "sessions", so saved navigation keeps working.
 */
const viewLabels: Record<string, string> = { sessions: "Provider tools" };

export const viewLabel = (value: string) =>
  viewLabels[value] ??
  value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
