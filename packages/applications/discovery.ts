import os from "node:os";
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
  "openai.desktop": "chatgpt",
  "anthropic.claude-code-cli": "claude-code",
  "anthropic.claude-desktop": "claude",
};
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
  const bundle = realPath.match(/^(.*\/(?:ChatGPT|Codex|Claude)\.app)\//);
  if (bundle)
    return {
      owner: "desktop",
      packageId: null,
      channel: "native",
      managementUnitId: hash(bundle[1]),
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
  if (file.endsWith(".app") && process.platform === "darwin") {
    try {
      return (
        await runFile("/usr/libexec/PlistBuddy", [
          "-c",
          "Print :CFBundleShortVersionString",
          path.join(file, "Contents/Info.plist"),
        ])
      ).trim();
    } catch {
      return null;
    }
  }
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
  const ownership = inferOwner(fingerprint.realPath);
  if (file.endsWith(".app")) {
    ownership.owner = "vendor";
    ownership.managementUnitId = hash(fingerprint.realPath);
    // A receipt identifies an adopted channel, without running a package manager during discovery.
    for (const prefix of ["/opt/homebrew", "/usr/local"]) {
      const receipt = path.join(prefix, "Caskroom", casks[appId]);
      if (await exists(receipt)) {
        ownership.owner = "homebrew";
        ownership.packageId = casks[appId];
        ownership.managementUnitId = hash(receipt);
        break;
      }
    }
  }
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
    for (const directory of [
      "/Applications",
      path.join(os.homedir(), "Applications"),
    ]) {
      for (const name of ["ChatGPT", "Codex", "Claude"]) {
        const bundle = path.join(directory, name + ".app");
        if (!(await exists(bundle))) continue;
        candidates.push([
          name === "Claude" ? "anthropic.claude-desktop" : "openai.desktop",
          bundle,
        ]);
        if (name !== "Claude")
          for (const suffix of [
            "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            "Contents/Resources/codex",
          ]) {
            const executable = path.join(bundle, suffix);
            if (await exists(executable))
              candidates.push(["openai.codex-cli", executable]);
          }
      }
    }
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
  } else if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? os.homedir();
    for (const [appId, suffix] of [
      ["anthropic.claude-desktop", "AnthropicClaude/claude.exe"],
      ["openai.desktop", "Programs/ChatGPT/ChatGPT.exe"],
      ["openai.desktop", "Programs/Codex/Codex.exe"],
    ] as const)
      if (await exists(path.join(local, suffix)))
        candidates.push([appId, path.join(local, suffix)]);
  }
  // Explicitly selected paths survive later discovery; missing installations are not fabricated.
  for (const i of previous)
    if (await exists(i.path)) candidates.push([i.appId, i.path]);
  const found = new Map<string, Installation>();
  for (const [appId, file] of candidates) {
    try {
      const item = await describeInstallation(appId, file, previous);
      if (!found.has(item.id)) found.set(item.id, item);
    } catch {
      /* A concurrently removed installation will be rediscovered later. */
    }
  }
  // Bundle and bundled runtime must share the same writer lock.
  for (const item of found.values())
    if (item.owner === "desktop") {
      const parent = [...found.values()].find(
        (i) =>
          i.path.endsWith(".app") &&
          item.realPath.startsWith(i.realPath + path.sep),
      );
      if (parent) {
        item.managementUnitId = parent.managementUnitId;
        item.revisionId = revision(item);
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
  if (installation.appId.endsWith("desktop")) return installation;
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
