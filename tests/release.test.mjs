import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  packageNames,
  releaseContext,
  runRelease,
} from "../scripts/release.mjs";

const version = "0.1.0";
const sha = "a".repeat(40);
const tag = `v${version}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expectedPackages = [
  `Topsl-${version}-mac-arm64.zip`,
  `Topsl-${version}-mac-x64.zip`,
  `Topsl-${version}-win-x64.exe`,
  `Topsl-${version}-linux-x86_64.AppImage`,
];

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "topsl-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "docs", "releases"), { recursive: true });
  mkdirSync(path.join(cwd, "release"));
  writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    path.join(cwd, "docs", "releases", `${tag}.md`),
    "Pilot notes.\n",
  );
  const state = {
    release: null,
    checkout: sha,
    tagCommit: sha,
    annotated: true,
    earlierReleases: [],
    mutations: [],
    bytes: new Map(),
    nextAssetId: 1,
  };
  const env = {
    RELEASE_TAG: tag,
    GITHUB_REF_TYPE: "tag",
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: "example/Topsl",
    RELEASE_OS: "mac",
    RELEASE_ARCH: "arm64",
  };
  function addAsset(name, bytes) {
    const content = Buffer.from(bytes);
    state.bytes.set(name, content);
    state.release.assets = state.release.assets.filter(
      (asset) => asset.name !== name,
    );
    state.release.assets.push({
      id: state.nextAssetId++,
      name,
      state: "uploaded",
      size: content.length,
      digest: `sha256:${hash(content)}`,
    });
  }
  function draft() {
    state.release = {
      id: 42,
      tag_name: tag,
      target_commitish: "main",
      body: `<!-- Topsl release commit: ${sha} -->`,
      draft: true,
      prerelease: true,
      assets: [],
      html_url: `https://github.com/example/Topsl/releases/tag/${tag}`,
    };
  }
  function completeAssets() {
    for (const name of expectedPackages) {
      const content = Buffer.from(`fixture package ${name}`);
      addAsset(name, content);
      addAsset(`${name}.sha256`, `${hash(content)}  ${name}\n`);
    }
  }
  const run = (executable, args, input) => {
    if (executable === "git") return state.checkout;
    assert.equal(executable, "gh");
    if (args[0] === "api") {
      const method = args[args.indexOf("--method") + 1];
      const endpoint = args.find((arg) => arg.startsWith("repos/"));
      if (method === "GET") {
        if (endpoint.includes("/git/ref/tags/"))
          return JSON.stringify({
            object: {
              type: state.annotated ? "tag" : "commit",
              sha: state.annotated ? "b".repeat(40) : state.tagCommit,
            },
          });
        if (endpoint.includes("/git/tags/"))
          return JSON.stringify({
            object: { type: "commit", sha: state.tagCommit },
          });
        assert.match(endpoint, /\/releases\?per_page=100&page=\d+$/);
        if (state.listError) throw new Error("GitHub authentication failed");
        const page = Number(
          new URL(`https://api.github.com/${endpoint}`).searchParams.get(
            "page",
          ),
        );
        const releases = [
          ...state.earlierReleases,
          ...(state.release ? [state.release] : []),
        ];
        return JSON.stringify(releases.slice((page - 1) * 100, page * 100));
      }
      const body = JSON.parse(input);
      state.mutations.push({ method, body });
      if (method === "POST") {
        assert.equal(state.release, null);
        draft();
        Object.assign(state.release, body);
      } else {
        assert.equal(method, "PATCH");
        assert.ok(endpoint.endsWith("/releases/42"));
        Object.assign(state.release, body);
      }
      return JSON.stringify(state.release);
    }
    assert.equal(args[0], "release");
    if (args[1] === "upload") {
      state.mutations.push({ method: "upload" });
      for (const file of args.slice(3, args.indexOf("--repo")))
        addAsset(path.basename(file), readFileSync(file));
      if (state.corruptUpload)
        state.release.assets[0].digest = `sha256:${"0".repeat(64)}`;
    } else {
      assert.equal(args[1], "download");
      const directory = args[args.indexOf("--dir") + 1];
      for (const [name, bytes] of state.bytes) {
        if (name.endsWith(".sha256"))
          writeFileSync(
            path.join(directory, name),
            state.corruptDownload ? "corrupt checksum\n" : bytes,
          );
      }
      state.afterDownload?.();
    }
    return "";
  };
  return {
    cwd,
    env,
    state,
    draft,
    completeAssets,
    invoke: (mode, extra = {}) =>
      runRelease(mode, { cwd, env, run, host: "mac-arm64", ...extra }),
  };
}

test("only a matching version tag, repository, and exact commit are accepted", () => {
  const valid = {
    RELEASE_TAG: tag,
    GITHUB_REF_TYPE: "tag",
    GITHUB_SHA: sha,
    GITHUB_REPOSITORY: "example/Topsl",
  };
  for (const changes of [
    { RELEASE_TAG: "v0.2.0" },
    { GITHUB_REF_TYPE: "branch" },
    { GITHUB_SHA: "main" },
    { GITHUB_REPOSITORY: "../Topsl" },
  ]) {
    assert.throws(() => releaseContext(version, { ...valid, ...changes }));
  }
});

test("prepare creates a commit-bound draft prerelease and safely resumes it", async (t) => {
  const f = fixture(t);
  assert.equal((await f.invoke("prepare")).draft, true);
  assert.equal(f.state.release.target_commitish, sha);
  assert.equal(f.state.release.prerelease, true);
  assert.equal(f.state.release.make_latest, "false");
  assert.match(f.state.release.body, /Pilot notes/);
  await f.invoke("prepare");
  assert.equal(f.state.mutations.length, 1);
});

test("draft lookup includes later pages and does not depend on target_commitish", async (t) => {
  const f = fixture(t);
  f.draft();
  f.state.earlierReleases = Array.from({ length: 100 }, (_, i) => ({
    tag_name: `v9.0.${i}`,
  }));
  await f.invoke("prepare");
  assert.equal(f.state.mutations.length, 0);
});

test("a mismatched checkout or moved remote tag prevents all writes", async (t) => {
  const f = fixture(t);
  f.state.checkout = "c".repeat(40);
  await assert.rejects(f.invoke("prepare"), /checkout/);
  f.state.checkout = sha;
  f.state.tagCommit = "c".repeat(40);
  await assert.rejects(f.invoke("prepare"), /remote tag/);
  assert.equal(f.state.mutations.length, 0);
});

test("authentication failures never create a replacement draft", async (t) => {
  const f = fixture(t);
  f.state.listError = true;
  await assert.rejects(f.invoke("prepare"), /authentication/);
  assert.equal(f.state.mutations.length, 0);
});

test("published releases cannot be overwritten by any release phase", async (t) => {
  const f = fixture(t);
  f.draft();
  f.state.release.draft = false;
  for (const mode of ["prepare", "upload", "publish"])
    await assert.rejects(f.invoke(mode), /never overwritten/);
  assert.equal(f.state.mutations.length, 0);
});

test("a draft from another commit or a stable release cannot be reused", async (t) => {
  const f = fixture(t);
  f.draft();
  f.state.release.body = `<!-- Topsl release commit: ${"c".repeat(40)} -->`;
  await assert.rejects(f.invoke("prepare"), /reviewed tag and commit/);
  f.draft();
  f.state.release.prerelease = false;
  await assert.rejects(f.invoke("prepare"), /personal-pilot/);
  assert.equal(f.state.mutations.length, 0);
});

test("upload verifies the platform and rejects absent or empty packages", async (t) => {
  const f = fixture(t);
  f.draft();
  await assert.rejects(
    f.invoke("upload", { host: "linux-x64" }),
    /build runner/,
  );
  await assert.rejects(f.invoke("upload"), /ENOENT/);
  writeFileSync(path.join(f.cwd, "release", packageNames(version)[0]), "");
  await assert.rejects(f.invoke("upload"), /nonempty/);
  assert.equal(f.state.mutations.length, 0);
});

test("upload verifies GitHub's digests against the actual package and checksum bytes", async (t) => {
  const f = fixture(t);
  f.draft();
  const name = packageNames(version)[0];
  writeFileSync(path.join(f.cwd, "release", name), "package bytes");
  await f.invoke("upload");
  assert.equal(f.state.release.assets.length, 2);
  assert.equal(
    f.state.bytes.get(`${name}.sha256`).toString(),
    `${hash("package bytes")}  ${name}\n`,
  );
  f.state.corruptUpload = true;
  await assert.rejects(f.invoke("upload"), /Uploaded bytes/);
});

test("the Linux x64 runner uploads electron-builder's x86_64 AppImage", async (t) => {
  const f = fixture(t);
  f.draft();
  f.env.RELEASE_OS = "linux";
  f.env.RELEASE_ARCH = "x64";
  const name = `Topsl-${version}-linux-x86_64.AppImage`;
  writeFileSync(path.join(f.cwd, "release", name), "Linux package bytes");
  await f.invoke("upload", { host: "linux-x64" });
  assert.deepEqual(
    f.state.release.assets.map((asset) => asset.name),
    [name, `${name}.sha256`],
  );
  assert.equal(
    f.state.bytes.get(`${name}.sha256`).toString(),
    `${hash("Linux package bytes")}  ${name}\n`,
  );
});

test("publication requires packages and checksum files for all four platforms", async (t) => {
  const f = fixture(t);
  f.draft();
  f.completeAssets();
  f.state.release.assets.pop();
  await assert.rejects(f.invoke("publish"), /exactly four/);
  assert.equal(f.state.mutations.length, 0);
});

test("publication rejects incomplete uploads even when all asset names are present", async (t) => {
  const f = fixture(t);
  f.draft();
  f.completeAssets();
  f.state.release.assets[0].state = "starter";
  await assert.rejects(f.invoke("publish"), /incomplete/);
  assert.equal(f.state.mutations.length, 0);
});

test("corrupt downloaded checksums prevent publication", async (t) => {
  const f = fixture(t);
  f.draft();
  f.completeAssets();
  f.state.corruptDownload = true;
  await assert.rejects(f.invoke("publish"), /Checksum verification failed/);
  assert.equal(f.state.mutations.length, 0);
});

test("asset replacement during verification prevents publication", async (t) => {
  const f = fixture(t);
  f.draft();
  f.completeAssets();
  f.state.afterDownload = () => {
    f.state.release.assets[0].id++;
  };
  await assert.rejects(f.invoke("publish"), /changed during verification/);
  assert.equal(f.state.mutations.length, 0);
});

test("a complete, verified draft is published as a prerelease without becoming latest", async (t) => {
  const f = fixture(t);
  f.draft();
  f.completeAssets();
  const result = await f.invoke("publish");
  assert.equal(result.draft, false);
  assert.equal(result.sha, sha);
  assert.deepEqual(f.state.mutations, [
    {
      method: "PATCH",
      body: { draft: false, prerelease: true, make_latest: "false" },
    },
  ]);
});
