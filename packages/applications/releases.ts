import type { AppId, Installation, Release } from "../domain/types";
import { casks } from "./discovery";

const hosts = new Set([
  "api.github.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "formulae.brew.sh",
  "downloads.claude.ai",
  "persistent.oaistatic.com",
  "persistent.oaistatic.com.cdn.cloudflare.net",
]);
export function assertDownloadUrl(url: string): void {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443") ||
    !hosts.has(u.hostname)
  )
    throw new Error(
      "Artifact source is outside the reviewed publisher allowlist.",
    );
}
export function assertArtifactPublisher(appId: AppId, url: string): void {
  assertDownloadUrl(url);
  const u = new URL(url);
  const allowed =
    appId === "openai.codex-cli"
      ? u.hostname === "github.com" &&
        u.pathname.startsWith("/openai/codex/releases/download/")
      : appId === "openai.desktop"
        ? u.hostname === "persistent.oaistatic.com" &&
          /^\/(codex-app-prod|sidekick)\//.test(u.pathname)
        : u.hostname === "downloads.claude.ai";
  if (!allowed)
    throw new Error(
      "Artifact publisher does not match the selected application.",
    );
}
export async function officialFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  let target = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    assertDownloadUrl(target);
    const response = await fetch(target, {
      ...options,
      redirect: "manual",
      headers: { "User-Agent": "Topsl/0.1.1", ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(20000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Redirect omitted its destination.");
      target = new URL(location, target).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Publisher returned HTTP ${response.status}.`);
    }
    return response;
  }
  throw new Error("Too many publisher redirects.");
}
async function json(url: string): Promise<any> {
  const response = await officialFetch(url);
  const reader = response.body!.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 5_000_000) throw new Error("Release metadata is too large.");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function brewVariant(
  metadata: any,
  platform: string,
  arch: string,
): any {
  if (!["arm64", "x64"].includes(arch))
    throw new Error("This architecture needs a native installer.");
  if (platform === "darwin")
    return arch === "arm64"
      ? metadata
      : { ...metadata, ...metadata.variations?.sequoia };
  if (platform === "linux") {
    const variant =
      metadata.variations?.[arch === "arm64" ? "arm64_linux" : "x86_64_linux"];
    if (!variant)
      throw new Error("No Linux artifact is advertised for this application.");
    return { ...metadata, ...variant };
  }
  throw new Error("Use the official Windows installer or store.");
}
export async function resolveRelease(
  appId: AppId,
  installation?: Installation,
  platform = process.platform as string,
  arch = process.arch as string,
): Promise<Release | null> {
  // A vendor-managed desktop's private/managed channel is not the public download feed.
  if (installation?.owner === "vendor" && appId.endsWith("desktop"))
    return null;
  if (
    installation &&
    ["desktop", "npm", "system", "unknown"].includes(installation.owner)
  )
    return null;
  if (
    installation &&
    !["stable", "latest"].includes(installation.channel) &&
    installation.owner !== "vendor"
  )
    return null;
  if (appId === "openai.codex-cli" && installation?.owner !== "homebrew") {
    if (
      !["arm64", "x64"].includes(arch) ||
      !["darwin", "win32", "linux"].includes(platform)
    )
      return null;
    const metadata = await json(
      "https://api.github.com/repos/openai/codex/releases/latest",
    );
    const target = `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : platform === "win32" ? "pc-windows-msvc.exe" : "unknown-linux-musl"}`;
    const name = `codex-${target}.${platform === "win32" ? "zip" : "tar.gz"}`;
    const asset = metadata.assets?.find((a: any) => a.name === name);
    if (!asset) return null;
    assertArtifactPublisher(appId, asset.browser_download_url);
    return {
      version: String(metadata.tag_name).replace(/^rust-v/, ""),
      url: asset.browser_download_url,
      sha256: /^sha256:[a-f0-9]{64}$/.test(asset.digest)
        ? asset.digest.slice(7)
        : null,
      size: asset.size,
      source: "OpenAI GitHub release",
      artifactName: name,
    };
  }
  if (platform !== "darwin" && appId !== "anthropic.claude-code-cli")
    return null;
  const token =
    installation?.owner === "homebrew" ? installation.packageId! : casks[appId];
  if (![...Object.values(casks), "claude-code@latest"].includes(token))
    return null;
  const metadata = brewVariant(
    await json(`https://formulae.brew.sh/api/cask/${token}.json`),
    platform,
    arch,
  );
  if (!metadata.url || !/^[a-f0-9]{64}$/.test(metadata.sha256 ?? ""))
    return null;
  assertArtifactPublisher(appId, metadata.url);
  if (
    (platform === "darwin" && /linux|windows/.test(metadata.url)) ||
    (platform === "linux" && !metadata.url.includes("linux-"))
  )
    throw new Error("Release architecture does not match this host.");
  if (
    (arch === "arm64" && /(?:x64|x86_64)/.test(metadata.url)) ||
    (arch === "x64" && /(?:arm64|aarch64)/.test(metadata.url))
  )
    throw new Error("Release architecture does not match this host.");
  return {
    version: String(metadata.version).split(",")[0],
    url: metadata.url,
    sha256: metadata.sha256,
    size: null,
    source: "Official publisher artifact; Homebrew checksum metadata",
    artifactName: decodeURIComponent(
      new URL(metadata.url).pathname.split("/").pop()!,
    ),
  };
}
