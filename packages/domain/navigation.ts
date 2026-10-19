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

export const viewLabel = (value: string) =>
  value.replaceAll("-", " ").replace(/^./, (letter) => letter.toUpperCase());
