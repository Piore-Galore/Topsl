import path from "node:path";
import { readdir } from "node:fs/promises";
import type { AppId, Installation } from "../domain/types";
import { hash } from "../domain/invariants";
import {
  affectedProcesses,
  candidatePaths,
  exists,
  identity,
  localHost,
  readBounded,
  runFile,
} from "../platform/system";

export const casks: Record<AppId, string> = {
  "openai.codex-cli": "codex",
  "anthropic.claude-code-cli": "claude-code",
};
/** The provider CLIs discovery looks for; desktop applications are not catalogued. */
const cliApps = new Set<string>([
  "openai.codex-cli",
  "anthropic.claude-code-cli",
]);
function revision(
  i: Pick<
    Installation,
    | "id"
    | "identity"
    | "version"
    | "owner"
    | "channel"
    | "managementUnitId"
    | "packageId"
  >,
): string {
  return hash(
    JSON.stringify([
      i.id,
      i.identity,
      i.version,
      i.owner,
      i.channel,
      i.managementUnitId,
      i.packageId,
    ]),
  );
}
export async function homebrew(): Promise<string | null> {
  for (const file of ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"])
    if (await exists(file)) return file;
  return null;
}
function inferOwner(
  realPath: string,
): Pick<Installation, "owner" | "channel" | "packageId" | "managementUnitId"> {
  const brew = realPath.match(/^(.*\/(?:Caskroom|Cellar))\/([^/]+)\//);
  if (brew)
    return {
      owner: "homebrew",
      packageId: brew[2],
      channel: brew[2].includes("@") ? brew[2].split("@")[1] : "stable",
      managementUnitId: hash(`${brew[1]}/${brew[2]}`),
    };
  // A CLI inside an application bundle is updated by that application,
  // which Topsl does not manage (docs/UX_Cleanup_Plan.md §2).
  if (/\.app[\\/]/i.test(realPath))
    return {
      owner: "external",
      packageId: null,
      channel: "native",
      managementUnitId: hash(realPath),
    };
  if (realPath.includes("node_modules"))
    return {
      owner: "npm",
      packageId: realPath.includes("@openai")
        ? "@openai/codex"
        : "@anthropic-ai/claude-code",
      channel: "native",
      managementUnitId: hash(realPath),
    };
  return {
    owner: "unknown",
    packageId: null,
    channel: "native",
    managementUnitId: hash(realPath),
  };
}
async function metadataVersion(
  file: string,
  realPath: string,
): Promise<string | null> {
  const version = realPath.match(
    /\/(?:Caskroom|Cellar)\/[^/]+\/([^/]+)\//,
  )?.[1];
  if (version && /^\d/.test(version)) return version;
  if (realPath.includes("node_modules")) {
    let parent = path.dirname(realPath);
    for (let i = 0; i < 5; i++, parent = path.dirname(parent)) {
      try {
        const pkg = JSON.parse(
          await readBounded(path.join(parent, "package.json")),
        );
        if (["@openai/codex", "@anthropic-ai/claude-code"].includes(pkg.name))
          return pkg.version;
      } catch {
        /* Not a package root. */
      }
    }
  }
  return null;
}
export async function describeInstallation(
  appId: AppId,
  file: string,
  previous: Installation[] = [],
): Promise<Installation> {
  const fingerprint = await identity(file);
  if (!cliApps.has(appId))
    throw new Error("Topsl manages the Codex and Claude Code CLIs only.");
  const ownership = inferOwner(fingerprint.realPath);
  const id = hash(
    `${localHost}:${appId}:${ownership.owner === "homebrew" ? ownership.managementUnitId : fingerprint.realPath}`,
  );
  const old = previous.find((i) => i.id === id);
  let version = await metadataVersion(file, fingerprint.realPath);
  const unchanged = old?.identity === fingerprint.identity;
  if (unchanged && !version) version = old?.version ?? null;
  const revisionId = revision({
    id,
    identity: fingerprint.identity,
    version,
    ...ownership,
  });
  return {
    id,
    appId,
    hostId: localHost,
    path: file,
    ...fingerprint,
    version,
    revisionId,
    ...ownership,
    nativeAutoUpdates: unchanged ? old.nativeAutoUpdates : "unknown",
    trusted: unchanged && old.trusted,
    compatibility: unchanged ? old.compatibility : "unverified",
  };
}
export async function discover(
  previous: Installation[] = [],
): Promise<Installation[]> {
  const candidates: Array<[AppId, string]> = [];
  for (const [name, appId] of [
    ["codex", "openai.codex-cli"],
    ["claude", "anthropic.claude-code-cli"],
  ] as const)
    for (const file of await candidatePaths(name))
      candidates.push([appId, file]);
  if (process.platform === "darwin") {
    for (const prefix of ["/opt/homebrew", "/usr/local"])
      for (const token of ["codex", "claude-code", "claude-code@latest"]) {
        const directory = path.join(prefix, "Caskroom", token);
        if (!(await exists(directory))) continue;
        for (const version of (await readdir(directory)).filter((v) =>
          /^\d/.test(v),
        )) {
          const file = path.join(
            directory,
            version,
            token === "codex" ? "codex" : "claude",
          );
          if (await exists(file))
            candidates.push([
              token === "codex"
                ? "openai.codex-cli"
                : "anthropic.claude-code-cli",
              file,
            ]);
        }
      }
  }
  // Explicitly selected CLI paths survive later discovery, even inside an
  // application bundle; missing installations are not fabricated.
  for (const i of previous)
    if (cliApps.has(i.appId) && (await exists(i.path)))
      candidates.push([i.appId, i.path]);
  const found = new Map<string, Installation>();
  for (const [appId, file] of candidates) {
    try {
      const item = await describeInstallation(appId, file, previous);
      if (!found.has(item.id)) found.set(item.id, item);
    } catch {
      /* A concurrently removed installation will be rediscovered later. */
    }
  }
  await Promise.all(
    [...found.values()].map(async (item) => {
      item.runningPids = await affectedProcesses([item.realPath]);
    }),
  );
  return [...found.values()];
}

export async function probeVersion(
  installation: Installation,
): Promise<Installation> {
  if (!installation.trusted)
    throw new Error("Approve this executable before probing or running it.");
  const current = await identity(installation.path);
  if (current.identity !== installation.identity)
    throw new Error("Executable changed; discover and review it again.");
  if (/\.cmd$/i.test(installation.path))
    return { ...installation, compatibility: "native-only" };
  const output = await runFile(installation.path, ["--version"]);
  const version =
    output.match(/\d+\.\d+\.\d+(?:[-+.][a-zA-Z0-9.-]+)?/)?.[0] ?? null;
  if (!version)
    throw new Error("Runtime did not report a recognizable version.");
  return {
    ...installation,
    version,
    revisionId: revision({ ...installation, version }),
    compatibility: "native-only",
  };
}
