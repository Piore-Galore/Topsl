import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  writeFile,
  stat,
  mkdtemp,
  rm,
  appendFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const targets = {
  "mac-arm64": "zip",
  "mac-x64": "zip",
  "win-x64": "exe",
  "linux-x64": "AppImage",
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runCli = (executable, args, input) =>
  execFileSync(executable, args, {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 180_000,
    maxBuffer: 2_000_000,
  });

export function releaseContext(version, env) {
  const tag = env.RELEASE_TAG;
  if (
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
    tag !== `v${version}` ||
    env.GITHUB_REF_TYPE !== "tag"
  )
    throw new Error(
      "The release must run from a version tag matching package.json.",
    );
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""))
    throw new Error("The release commit must be an exact SHA.");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(
      env.GITHUB_REPOSITORY ?? "",
    )
  )
    throw new Error("Invalid release repository.");
  return { tag, version, sha: env.GITHUB_SHA, repo: env.GITHUB_REPOSITORY };
}
function packageName(version, target) {
  // electron-builder expands the AppImage architecture macro to x86_64.
  // The build runner and Node still identify the same architecture as x64.
  const artifactTarget = target === "linux-x64" ? "linux-x86_64" : target;
  return `Topsl-${version}-${artifactTarget}.${targets[target]}`;
}
export function packageNames(version) {
  return Object.keys(targets).map((target) => packageName(version, target));
}
export function requireDraft(release, context) {
  if (
    !release ||
    release.tag_name !== context.tag ||
    !release.body?.includes(`<!-- Topsl release commit: ${context.sha} -->`)
  )
    throw new Error(
      "The release does not belong to the reviewed tag and commit.",
    );
  if (!release.draft)
    throw new Error(
      "Published releases are never overwritten. Use a new version tag.",
    );
  if (!release.prerelease)
    throw new Error("Only personal-pilot prereleases are supported.");
}
function requireAsset(assets, name) {
  const matches = assets.filter((asset) => asset.name === name);
  if (
    matches.length !== 1 ||
    matches[0].state !== "uploaded" ||
    matches[0].size <= 0 ||
    !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest ?? "")
  )
    throw new Error(
      `Missing, incomplete, or unverifiable release asset: ${name}`,
    );
  return matches[0];
}
export function requireCompleteAssets(assets, version) {
  const names = packageNames(version).flatMap((name) => [
    name,
    `${name}.sha256`,
  ]);
  if (
    assets.length !== names.length ||
    assets.some((asset) => !names.includes(asset.name))
  )
    throw new Error(
      "Publication requires exactly four platform packages and four checksums.",
    );
  for (const name of names) requireAsset(assets, name);
}

export async function runRelease(
  mode,
  {
    cwd = process.cwd(),
    env = process.env,
    run = runCli,
    host = `${{ darwin: "mac", win32: "win", linux: "linux" }[process.platform]}-${process.arch}`,
  } = {},
) {
  if (!["prepare", "upload", "publish"].includes(mode))
    throw new Error("Choose prepare, upload, or publish.");
  const { version } = JSON.parse(
    await readFile(path.join(cwd, "package.json"), "utf8"),
  );
  const context = releaseContext(version, env);
  const { tag, sha, repo } = context;
  if (run("git", ["-C", cwd, "rev-parse", "HEAD"]).trim() !== sha)
    throw new Error("The checkout does not match the release commit.");
  const api = (method, endpoint, body) => {
    const output = run(
      "gh",
      [
        "api",
        "--method",
        method,
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
        endpoint,
        ...(body === undefined ? [] : ["--input", "-"]),
      ],
      body === undefined ? undefined : JSON.stringify(body),
    );
    return output.trim() ? JSON.parse(output) : null;
  };
  const prefix = `repos/${repo}`;
  const verifyTag = () => {
    let object = api("GET", `${prefix}/git/ref/tags/${tag}`).object;
    for (let depth = 0; object.type === "tag" && depth < 5; depth++)
      object = api("GET", `${prefix}/git/tags/${object.sha}`).object;
    if (object.type !== "commit" || object.sha !== sha)
      throw new Error("The remote tag moved or does not match this build.");
  };
  const getRelease = () => {
    // The tag endpoint only promises published releases. The authenticated list
    // includes drafts, including when resuming a failed platform build.
    for (let page = 1; ; page++) {
      const releases = api(
        "GET",
        `${prefix}/releases?per_page=100&page=${page}`,
      );
      const matches = releases.filter((item) => item.tag_name === tag);
      if (matches.length > 1)
        throw new Error("Multiple releases use this tag.");
      if (matches.length === 1) return matches[0];
      if (releases.length < 100) return null;
    }
  };
  verifyTag();
  let release = getRelease();
  if (mode === "prepare") {
    if (release) requireDraft(release, context);
    else {
      const notes = await readFile(
        path.join(cwd, "docs", "releases", `${tag}.md`),
        "utf8",
      );
      release = api("POST", `${prefix}/releases`, {
        tag_name: tag,
        target_commitish: sha,
        name: `Topsl ${tag} — personal pilot`,
        body: `${notes.trim()}\n\n<!-- Topsl release commit: ${sha} -->\n`,
        draft: true,
        prerelease: true,
        make_latest: "false",
      });
      requireDraft(release, context);
    }
  } else {
    requireDraft(release, context);
    if (mode === "upload") {
      const target = `${env.RELEASE_OS}-${env.RELEASE_ARCH}`;
      if (!targets[target] || target !== host)
        throw new Error("The package target does not match its build runner.");
      const name = packageName(version, target);
      const file = path.join(cwd, "release", name);
      const info = await stat(file);
      if (!info.isFile() || info.size <= 0 || info.size >= 2 * 1024 ** 3)
        throw new Error(
          "The package must be a nonempty file smaller than 2 GiB.",
        );
      const digest = createHash("sha256");
      for await (const bytes of createReadStream(file)) digest.update(bytes);
      const checksum = digest.digest("hex");
      const checksumText = `${checksum}  ${name}\n`;
      await writeFile(`${file}.sha256`, checksumText);
      verifyTag();
      requireDraft(getRelease(), context);
      // Only a draft bound to this exact commit can be resumed. Each matrix job
      // owns one uniquely named package; published assets are never clobbered.
      run("gh", [
        "release",
        "upload",
        tag,
        file,
        `${file}.sha256`,
        "--repo",
        repo,
        "--clobber",
      ]);
      release = getRelease();
      requireDraft(release, context);
      const uploaded = requireAsset(release.assets, name);
      const uploadedChecksum = requireAsset(release.assets, `${name}.sha256`);
      if (
        uploaded.size !== info.size ||
        uploaded.digest !== `sha256:${checksum}` ||
        uploadedChecksum.digest !== `sha256:${sha256(checksumText)}`
      )
        throw new Error(
          "Uploaded bytes did not match the local package and checksum.",
        );
    } else {
      requireCompleteAssets(release.assets, version);
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "topsl-release-check-"),
      );
      try {
        run("gh", [
          "release",
          "download",
          tag,
          "--repo",
          repo,
          "--pattern",
          "*.sha256",
          "--dir",
          directory,
        ]);
        for (const name of packageNames(version)) {
          const asset = requireAsset(release.assets, name);
          const checksumAsset = requireAsset(release.assets, `${name}.sha256`);
          const checksumFile = path.join(directory, `${name}.sha256`);
          if ((await stat(checksumFile)).size > 1024)
            throw new Error("Invalid checksum file size.");
          const text = await readFile(checksumFile, "utf8");
          if (
            text !== `${asset.digest.slice(7)}  ${name}\n` ||
            `sha256:${sha256(text)}` !== checksumAsset.digest
          )
            throw new Error(`Checksum verification failed: ${name}`);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      verifyTag();
      const current = getRelease();
      requireDraft(current, context);
      requireCompleteAssets(current.assets, version);
      if (
        JSON.stringify(
          current.assets.map((a) => [a.id, a.name, a.digest, a.size]).sort(),
        ) !==
        JSON.stringify(
          release.assets.map((a) => [a.id, a.name, a.digest, a.size]).sort(),
        )
      )
        throw new Error(
          "Release assets changed during verification. Retry publication.",
        );
      release = api("PATCH", `${prefix}/releases/${release.id}`, {
        draft: false,
        prerelease: true,
        make_latest: "false",
      });
      if (release.draft || !release.prerelease || release.tag_name !== tag)
        throw new Error("GitHub did not confirm prerelease publication.");
      requireCompleteAssets(release.assets, version);
    }
  }
  const result = {
    mode,
    tag,
    sha,
    draft: release.draft,
    url: release.html_url,
  };
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `### Topsl ${tag}\n\n${mode}: ${release.draft ? "draft prerelease" : "published prerelease"} · commit \`${sha}\`\n\n[Release](${release.html_url})\n`,
    );
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(await runRelease(process.argv[2])));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
