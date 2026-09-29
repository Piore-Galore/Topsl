import type { Installation, Project, ProjectOpenResult } from "../domain/types";
import { identity } from "../platform/system";
import { requireProjectFolder } from "./projects";

export function claudeFolderUrl(folder: string): string {
  return `claude://code/new?folder=${encodeURIComponent(folder)}`;
}

// The broker accepts only this exact generated folder link, never renderer URLs
// or prompt-bearing deep links. The selected native app still confirms access.
export function isClaudeFolderUrl(url: string, folder: string): boolean {
  return url === claudeFolderUrl(folder);
}

export async function desktopProjectRoute(
  installation: Installation,
  project: Project,
  platform: NodeJS.Platform = process.platform,
): Promise<ProjectOpenResult> {
  await requireProjectFolder(project);
  if (
    !["openai.desktop", "anthropic.claude-desktop"].includes(installation.appId)
  )
    throw new Error("Choose a desktop installation.");
  if (!installation.trusted)
    throw new Error("Review and trust this application in Applications first.");
  if ((await identity(installation.path)).identity !== installation.identity)
    throw new Error(
      "The installed application changed. Rediscover and trust it before opening the project.",
    );
  const folderOpen =
    platform === "darwin" && installation.appId === "openai.desktop";
  const claude = installation.appId === "anthropic.claude-desktop";
  return {
    projectPath: project.realPath,
    applicationPath: installation.realPath,
    route: claude
      ? "claude-folder-link"
      : folderOpen
        ? "folder-open"
        : "native-selection",
    nativeUrl: claude ? claudeFolderUrl(project.realPath) : undefined,
    detail: claude
      ? `${platform === "darwin" ? "Folder link sent to the selected Claude app" : "Folder link sent to the system's registered Claude app"}. Confirm folder access in Claude Code to continue.`
      : folderOpen
        ? "Folder sent to the desktop app. Confirm it appears in the native project picker."
        : "In the desktop app, add a local project and select this folder. Use Copy folder path to paste it into the folder picker.",
  };
}
