/**
 * Project destinations (docs/UX_Cleanup_Plan.md §1). Sessions are the
 * workspace (`coordinator`: the New session page, one session or one loop);
 * the project menu holds All sessions, Project settings, Provider tools and
 * Advanced workflows.
 */
export const projectDestinations = [
  "coordinator",
  "all-sessions",
  "project-settings",
  "sessions",
  "advanced",
] as const;

/**
 * Destinations before the cleanup. Saved navigation may still name them, so
 * they stay valid values and open their replacement section.
 */
export const retiredProjectViews = [
  "overview",
  "tasks",
  "changes",
  "context",
  "history",
  "synchronization",
] as const;

/** Every value navigation can save or restore. */
export const projectViews = [
  ...projectDestinations,
  ...retiredProjectViews,
] as const;

export type ProjectView = (typeof projectDestinations)[number];

/** Sections of Advanced workflows. */
export const advancedSections = [
  "workflows",
  "changes",
  "activity",
  "context",
  "workspaces",
] as const;
export type AdvancedSection = (typeof advancedSections)[number];

const replacements: Record<
  (typeof retiredProjectViews)[number],
  { view: ProjectView; section: string }
> = {
  overview: { view: "advanced", section: "activity" },
  tasks: { view: "advanced", section: "workflows" },
  changes: { view: "advanced", section: "changes" },
  context: { view: "advanced", section: "context" },
  history: { view: "sessions", section: "history" },
  // Native synchronization is retired; Project settings says so once.
  synchronization: {
    view: "project-settings",
    section: "synchronization-retired",
  },
};

/** A saved destination as it opens now; unknown values open the project's sessions. */
export function projectView(value: unknown): ProjectView {
  if (projectDestinations.includes(value as ProjectView))
    return value as ProjectView;
  return (
    replacements[value as keyof typeof replacements]?.view ?? "coordinator"
  );
}

/** The section a retired destination maps to, if any. */
export function projectSection(value: unknown): string | null {
  return replacements[value as keyof typeof replacements]?.section ?? null;
}

/**
 * Direct Claude Code and Codex sessions are Provider tools: "session" now
 * names a Topsl session (docs/Native_Sessions_Plan.md). The stored view value
 * stays "sessions", so saved navigation keeps working.
 */
const viewLabels: Record<string, string> = {
  sessions: "Provider tools",
  coordinator: "Sessions",
  "all-sessions": "All sessions",
  "project-settings": "Project settings",
  advanced: "Advanced workflows",
};

export const viewLabel = (value: string) =>
  viewLabels[value] ??
  value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
