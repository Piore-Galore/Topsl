// Campaign 2026-10-19-comprehensive, packet p3a-apps-providers-terminals.
// Application acquisition/lifecycle contracts (APP-04..APP-12) and local
// provider protocol contracts (PR-05, PR-07, PR-08, PR-09, PR-13) at the U/S/P
// layers. No network, no installers, no provider accounts: release metadata and
// artifact bytes come from stubs or a loopback HTTP server, and every lifecycle
// test uses the real Lifecycle class over a real encrypted store.
import { afterEach, describe, expect, test, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Lifecycle } from "../packages/applications/lifecycle";
import {
  assertArtifactPublisher,
  assertDownloadUrl,
  brewVariant,
  officialFetch,
  resolveRelease,
} from "../packages/applications/releases";
import type {
  Installation,
  LifecycleJob,
  LifecyclePlan,
  Release,
} from "../packages/domain/types";
import { hash, now } from "../packages/domain/invariants";
import { CodexAdapter } from "../packages/providers/codex";
import {
  ClaudeStreamParser,
  type ClaudeStreamEvent,
} from "../packages/providers/claude";
import {
  commandApprovalSummary,
  fileChangeApprovalSummary,
  visible,
} from "../packages/providers/codex-approvals";
import type { ProviderConnection } from "../packages/providers/contract";
import { fixture } from "./helpers";

// ---------------------------------------------------------------------------
// Shared lifecycle harness (copied from tests/lifecycle.test.ts idioms)
// ---------------------------------------------------------------------------
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
const payload = Buffer.from("verified installer fixture, campaign bytes");
const release: Release = {
  version: "2.0.0",
  url: "https://github.com/openai/codex/releases/download/test/fixture.zip",
  sha256: hash(payload),
  size: payload.length,
  source: "fixture",
  artifactName: "fixture.zip",
};
async function setup(overrides: any = {}) {
  const f = await fixture();
  fixtures.push(f);
  let installations = [f.installation];
  const deps = {
    installations: () => installations,
    discover: async () => installations,
    active: () => false,
    changed: () => {},
    nativeOpen: vi.fn(async () => {}),
    release: vi.fn(async () => release),
    fetch: vi.fn(async () => new Response(payload)),
    processes: vi.fn(async () => []),
    execute: vi.fn(async () => ""),
    ...overrides,
  };
  const lifecycle = new Lifecycle(f.store, f.directory, deps);
  return {
    ...f,
    lifecycle,
    deps,
    setInstallations: (next: Installation[]) => {
      installations = next;
    },
  };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const terminal = [
  "completed",
  "unchanged",
  "failed",
  "cancelled",
  "uncertain",
  "awaiting-native",
  "waiting-for-idle",
];
async function outcome(f: Setup, id: string, states = terminal) {
  await vi.waitFor(
    () => expect(states).toContain(f.store.get<LifecycleJob>("job", id)?.state),
    { timeout: 8000, interval: 20 },
  );
  return f.store.get<LifecycleJob>("job", id)!;
}
/** What the job left on disk in its private download folder. */
async function downloads(f: Setup, jobId: string): Promise<string[]> {
  try {
    return (await readdir(path.join(f.directory, "downloads", jobId))).sort();
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
/** A loopback publisher whose handler decides how each transfer behaves. */
async function publisher(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // The Lifecycle's injected transport: real fetch over a real socket to the
  // loopback server, with the Lifecycle's own abort signal.
  return (_url: string, options: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}/artifact`, { signal: options.signal });
}

// ---------------------------------------------------------------------------
// APP-04 artifact selection
// ---------------------------------------------------------------------------
const codexAssets = [
  ["aarch64-apple-darwin", "tar.gz"],
  ["x86_64-apple-darwin", "tar.gz"],
  ["aarch64-unknown-linux-musl", "tar.gz"],
  ["x86_64-unknown-linux-musl", "tar.gz"],
  ["aarch64-pc-windows-msvc.exe", "zip"],
  ["x86_64-pc-windows-msvc.exe", "zip"],
].map(([target, ext]) => {
  const name = `codex-${target}.${ext}`;
  return {
    name,
    browser_download_url: `https://github.com/openai/codex/releases/download/rust-v9.1.0/${name}`,
    digest: `sha256:${hash(name)}`,
    size: name.length * 1000,
  };
});
function stubMetadata(body: unknown, calls: string[] = []) {
  const fetchStub = vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

describe("APP-04 artifact selection and publisher allowlist", () => {
  test.each([
    ["darwin", "arm64", "codex-aarch64-apple-darwin.tar.gz"],
    ["darwin", "x64", "codex-x86_64-apple-darwin.tar.gz"],
    ["linux", "arm64", "codex-aarch64-unknown-linux-musl.tar.gz"],
    ["linux", "x64", "codex-x86_64-unknown-linux-musl.tar.gz"],
    ["win32", "arm64", "codex-aarch64-pc-windows-msvc.exe.zip"],
    ["win32", "x64", "codex-x86_64-pc-windows-msvc.exe.zip"],
  ])(
    "Codex CLI on %s/%s selects exactly %s with its own digest",
    async (platform, arch, expected) => {
      const calls: string[] = [];
      stubMetadata({ tag_name: "rust-v9.1.0", assets: codexAssets }, calls);
      const selected = await resolveRelease(
        "openai.codex-cli",
        undefined,
        platform,
        arch,
      );
      expect(calls).toEqual([
        "https://api.github.com/repos/openai/codex/releases/latest",
      ]);
      expect(selected).toEqual({
        version: "9.1.0",
        url: `https://github.com/openai/codex/releases/download/rust-v9.1.0/${expected}`,
        sha256: hash(expected),
        size: expected.length * 1000,
        source: "OpenAI GitHub release",
        artifactName: expected,
      });
    },
  );
  test("unsupported architecture or platform resolves nothing before any request", async () => {
    const fetchStub = stubMetadata({ tag_name: "rust-v9.1.0", assets: [] });
    for (const [platform, arch] of [
      ["darwin", "ia32"],
      ["linux", "riscv64"],
      ["freebsd", "x64"],
      ["aix", "arm64"],
    ])
      expect(
        await resolveRelease("openai.codex-cli", undefined, platform, arch),
        `${platform}/${arch}`,
      ).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
    // A host with no advertised asset resolves nothing (not a neighbour's asset).
    stubMetadata({
      tag_name: "rust-v9.1.0",
      assets: codexAssets.filter((a) => !a.name.includes("aarch64-apple")),
    });
    expect(
      await resolveRelease("openai.codex-cli", undefined, "darwin", "arm64"),
    ).toBeNull();
  });
  test("an asset from another publisher path or host is rejected, and a missing digest leaves no trusted hash", async () => {
    for (const url of [
      "https://github.com/someone-else/codex/releases/download/rust-v9.1.0/codex-aarch64-apple-darwin.tar.gz",
      "https://objects.githubusercontent.com/codex-aarch64-apple-darwin.tar.gz",
      "https://downloads.claude.ai/codex-aarch64-apple-darwin.tar.gz",
    ]) {
      stubMetadata({
        tag_name: "rust-v9.1.0",
        assets: [
          { ...codexAssets[0], browser_download_url: url, name: codexAssets[0].name },
        ],
      });
      await expect(
        resolveRelease("openai.codex-cli", undefined, "darwin", "arm64"),
        url,
      ).rejects.toThrow(/publisher/);
    }
    for (const digest of [undefined, "sha256:short", `md5:${hash("x")}`]) {
      stubMetadata({
        tag_name: "rust-v9.1.0",
        assets: [{ ...codexAssets[0], digest }],
      });
      expect(
        (await resolveRelease("openai.codex-cli", undefined, "darwin", "arm64"))
          ?.sha256,
      ).toBeNull();
    }
  });
  test("Homebrew cask metadata: wrong architecture, wrong OS, unapproved host and bad checksum never become a release", async () => {
    const sha = hash("dmg");
    const cask = (url: string, extra: object = {}) => ({
      version: "1.4.0,abcdef",
      url,
      sha256: sha,
      ...extra,
    });
    stubMetadata(cask("https://downloads.claude.ai/releases/darwin/arm64/Claude.dmg"));
    expect(
      await resolveRelease("anthropic.claude-desktop", undefined, "darwin", "arm64"),
    ).toMatchObject({ version: "1.4.0", sha256: sha, artifactName: "Claude.dmg" });
    for (const [url, arch, message] of [
      ["https://downloads.claude.ai/releases/darwin/x64/Claude.dmg", "arm64", "architecture"],
      ["https://downloads.claude.ai/releases/darwin/arm64/Claude.dmg", "x64", "architecture"],
      ["https://downloads.claude.ai/releases/linux-arm64/claude", "arm64", "architecture"],
      ["https://downloads.claude.ai/releases/windows/Claude.exe", "arm64", "architecture"],
      ["https://example.com/Claude.dmg", "arm64", "allowlist"],
      ["http://downloads.claude.ai/Claude.dmg", "arm64", "allowlist"],
    ] as const) {
      stubMetadata(
        arch === "x64"
          ? cask("https://downloads.claude.ai/x", { variations: { sequoia: { url } } })
          : cask(url),
      );
      await expect(
        resolveRelease("anthropic.claude-desktop", undefined, "darwin", arch),
        `${url} on ${arch}`,
      ).rejects.toThrow(message);
    }
    stubMetadata(cask("https://downloads.claude.ai/releases/darwin/arm64/Claude.dmg", { sha256: "not-a-hash" }));
    expect(
      await resolveRelease("anthropic.claude-desktop", undefined, "darwin", "arm64"),
    ).toBeNull();
    // Claude Code on Linux uses only the advertised Linux variant for the host.
    stubMetadata(
      cask("https://downloads.claude.ai/x", {
        variations: {
          arm64_linux: { url: "https://downloads.claude.ai/claude-code/linux-arm64/claude" },
        },
      }),
    );
    expect(
      await resolveRelease("anthropic.claude-code-cli", undefined, "linux", "arm64"),
    ).toMatchObject({ url: "https://downloads.claude.ai/claude-code/linux-arm64/claude" });
    await expect(
      resolveRelease("anthropic.claude-code-cli", undefined, "linux", "x64"),
    ).rejects.toThrow("No Linux artifact");
    await expect(
      resolveRelease("anthropic.claude-code-cli", undefined, "win32", "x64"),
    ).rejects.toThrow("Windows installer");
    expect(() => brewVariant({}, "darwin", "ia32")).toThrow("native installer");
  });
  test("publisher redirects are re-checked on every hop and bounded", async () => {
    const hops: string[] = [];
    const redirectTo = (location: string | null) =>
      vi.fn(async (url: string) => {
        hops.push(url);
        return new Response(null, {
          status: 302,
          headers: location ? { location } : {},
        });
      });
    vi.stubGlobal("fetch", redirectTo("https://evil.example/codex.tar.gz"));
    await expect(
      officialFetch("https://github.com/openai/codex/releases/download/x/a"),
    ).rejects.toThrow("publisher allowlist");
    // The unapproved destination was never requested.
    expect(hops).toEqual(["https://github.com/openai/codex/releases/download/x/a"]);
    hops.length = 0;
    vi.stubGlobal("fetch", redirectTo("https://github.com:8443/openai/codex"));
    await expect(officialFetch("https://github.com/a")).rejects.toThrow("allowlist");
    expect(hops).toHaveLength(1);
    hops.length = 0;
    vi.stubGlobal("fetch", redirectTo(null));
    await expect(officialFetch("https://github.com/a")).rejects.toThrow(
      "omitted its destination",
    );
    hops.length = 0;
    vi.stubGlobal("fetch", redirectTo("/openai/codex/releases/download/loop"));
    await expect(officialFetch("https://github.com/a")).rejects.toThrow(
      "Too many publisher redirects",
    );
    expect(hops).toHaveLength(6);
    // A redirect to an approved host is followed (positive control).
    hops.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        hops.push(url);
        return hops.length === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://release-assets.githubusercontent.com/a" },
            })
          : new Response("ok");
      }),
    );
    expect(await (await officialFetch("https://github.com/a")).text()).toBe("ok");
    expect(hops).toEqual(["https://github.com/a", "https://release-assets.githubusercontent.com/a"]);
    for (const url of [
      "http://github.com/a",
      "https://user:pass@github.com/a",
      "https://github.com.evil.example/a",
      "file:///etc/passwd",
    ])
      expect(() => assertDownloadUrl(url), url).toThrow("allowlist");
    expect(() =>
      assertArtifactPublisher(
        "openai.desktop",
        "https://persistent.oaistatic.com/elsewhere/ChatGPT.dmg",
      ),
    ).toThrow("does not match");
  });
  test("oversized release metadata is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.alloc(5_000_001, 0x20))),
    );
    await expect(
      resolveRelease("openai.codex-cli", undefined, "darwin", "arm64"),
    ).rejects.toThrow("too large");
  });
  test("an incorrect length or hash fails verification and leaves no artifact or partial file on disk", async () => {
    for (const [name, rel] of [
      ["length", { ...release, size: payload.length + 1 }],
      ["hash", { ...release, sha256: hash("other bytes") }],
    ] as const) {
      const f = await setup({ release: vi.fn(async () => rel) });
      const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
      const job = await f.lifecycle.approve(p.id, p.digest);
      const result = await outcome(f, job.id);
      expect(result.state, name).toBe("failed");
      expect(result.detail).toMatch(name === "length" ? /length/ : /Integrity/);
      expect(result.acquiredPath).toBeNull();
      expect(await downloads(f, job.id)).toEqual([]);
      expect(f.deps.nativeOpen).not.toHaveBeenCalled();
      expect(f.deps.execute).not.toHaveBeenCalled();
    }
    // Without a trusted SHA-256 there is no direct download route at all.
    const f = await setup({ release: vi.fn(async () => ({ ...release, sha256: null })) });
    await expect(
      f.lifecycle.preview("openai.codex-cli", null, "download"),
    ).rejects.toThrow("No verified direct download");
  });
});

// ---------------------------------------------------------------------------
// APP-05 / APP-06 acquisition over a real loopback transport
// ---------------------------------------------------------------------------
describe("APP-05/APP-06 download-only acquisition over a real socket", () => {
  test("a complete verified download is the only file left, is not executable, and nothing is opened or run", async () => {
    const transport = await publisher((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.length) });
      // Several writes so the body arrives in more than one chunk.
      res.write(payload.subarray(0, 5));
      setTimeout(() => res.end(payload.subarray(5)), 20);
    });
    const f = await setup({ fetch: vi.fn(transport) });
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    expect(p.route).toBe("download");
    const result = await outcome(f, (await f.lifecycle.approve(p.id, p.digest)).id);
    expect(result.state).toBe("completed");
    expect(result.bytes).toBe(payload.length);
    expect(await downloads(f, result.id)).toEqual(["fixture.zip"]);
    expect(await readFile(result.acquiredPath!)).toEqual(payload);
    if (process.platform !== "win32")
      expect((await stat(result.acquiredPath!)).mode & 0o777).toBe(0o600);
    expect(result.actualVersion).toBeNull();
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
    expect(f.deps.execute).not.toHaveBeenCalled();
  });
  test.each(["disconnect", "corrupt", "truncated"])(
    "a %s transfer fails and exposes no runnable partial artifact",
    async (scenario) => {
      const transport = await publisher((_req, res) => {
        res.writeHead(200, { "content-length": String(payload.length) });
        if (scenario === "disconnect") {
          res.write(payload.subarray(0, 6));
          setTimeout(() => res.socket?.destroy(), 30);
        } else if (scenario === "corrupt") {
          const bad = Buffer.from(payload);
          bad[3] ^= 0xff;
          res.end(bad);
        } else {
          // Fewer bytes than advertised, then a clean close of the socket.
          res.write(payload.subarray(0, payload.length - 4));
          setTimeout(() => res.socket?.end(), 30);
        }
      });
      const f = await setup({ fetch: vi.fn(transport) });
      const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
      const result = await outcome(f, (await f.lifecycle.approve(p.id, p.digest)).id);
      expect(result.state).toBe("failed");
      expect(result.acquiredPath).toBeNull();
      expect(await downloads(f, result.id)).toEqual([]);
      expect(f.deps.nativeOpen).not.toHaveBeenCalled();
      expect(f.deps.execute).not.toHaveBeenCalled();
      expect(f.store.get("installation-lock", p.managementUnitId)).toBeUndefined();
    },
  );
  test("cancellation mid-transfer ends cancelled and removes the partial file", async () => {
    let firstChunkSent!: () => void;
    const sent = new Promise<void>((resolve) => (firstChunkSent = resolve));
    const transport = await publisher((_req, res) => {
      res.writeHead(200, { "content-length": String(payload.length) });
      res.write(payload.subarray(0, 8), () => firstChunkSent());
      // The rest never arrives unless the client gives up.
    });
    const f = await setup({ fetch: vi.fn(transport) });
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const job = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, job.id, ["downloading"]);
    await sent;
    // The partial file exists while the transfer is live.
    await vi.waitFor(async () =>
      expect(await downloads(f, job.id)).toEqual(["fixture.zip.part"]),
    );
    f.lifecycle.cancel(job.id);
    const result = await outcome(f, job.id);
    expect(result.state).toBe("cancelled");
    expect(result.acquiredPath).toBeNull();
    expect(await downloads(f, job.id)).toEqual([]);
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
    expect(f.store.get("installation-lock", p.managementUnitId)).toBeUndefined();
  });
  test("APP-06 retry is a fresh reviewed operation that starts from byte zero; the failed attempt keeps its own error", async () => {
    let attempt = 0;
    const transport = await publisher((_req, res) => {
      attempt++;
      res.writeHead(200, { "content-length": String(payload.length) });
      if (attempt === 1) {
        res.write(payload.subarray(0, 10));
        setTimeout(() => res.socket?.destroy(), 30);
      } else res.end(payload);
    });
    const f = await setup({ fetch: vi.fn(transport) });
    const first = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const failed = await outcome(
      f,
      (await f.lifecycle.approve(first.id, first.digest)).id,
    );
    expect(failed.state).toBe("failed");
    // The consumed approval cannot be reused for the retry.
    await expect(f.lifecycle.approve(first.id, first.digest)).rejects.toThrow(
      "already been used",
    );
    const second = await f.lifecycle.preview("openai.codex-cli", null, "download");
    expect(second.id).not.toBe(first.id);
    const done = await outcome(
      f,
      (await f.lifecycle.approve(second.id, second.digest)).id,
    );
    expect(done.state).toBe("completed");
    // Byte zero: the second attempt counted exactly one full artifact.
    expect(done.bytes).toBe(payload.length);
    expect(await readFile(done.acquiredPath!)).toEqual(payload);
    expect(f.store.get<LifecycleJob>("job", failed.id)).toMatchObject({
      state: "failed",
      planId: first.id,
      acquiredPath: null,
    });
    expect(done.planId).toBe(second.id);
    expect(attempt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// APP-07 approval integrity, expiry, double submit and replay
// ---------------------------------------------------------------------------
describe("APP-07 approvals cannot execute stale, tampered or consumed plans", () => {
  test("a tampered stored preview or a changed installation revision is refused with no job, lock or consumed approval", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
    // Tamper with the stored preview but keep its digest (the reviewed one).
    f.store.put("plan", { ...p, effects: ["Nothing happens."] });
    await expect(f.lifecycle.approve(p.id, p.digest)).rejects.toThrow(
      "Plan integrity changed",
    );
    const q = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
    f.setInstallations([{ ...f.installation, revisionId: hash("fixture-v2") }]);
    await expect(f.lifecycle.approve(q.id, q.digest)).rejects.toThrow(
      "Installation changed since preview",
    );
    expect(f.store.list("job")).toEqual([]);
    expect(f.store.list("consumed-approval")).toEqual([]);
    expect(f.store.get("installation-lock", p.managementUnitId)).toBeUndefined();
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
  });
  test("the 15-minute expiry boundary: one millisecond before is accepted, at the boundary is refused", async () => {
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const f = await setup();
    const early = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const late = await f.lifecycle.preview("openai.codex-cli", null, "download");
    expect(Date.parse(late.expiresAt) - start).toBe(15 * 60_000);
    vi.setSystemTime(start + 15 * 60_000);
    await expect(f.lifecycle.approve(late.id, late.digest)).rejects.toThrow(
      "Approval expired",
    );
    expect(f.store.list("consumed-approval")).toEqual([]);
    vi.setSystemTime(start + 15 * 60_000 - 1);
    const job = await f.lifecycle.approve(early.id, early.digest);
    vi.useRealTimers();
    expect((await outcome(f, job.id)).state).toBe("completed");
    expect(f.store.list<LifecycleJob>("job").map((j) => j.planId)).toEqual([early.id]);
    expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  });
  test("a double submit of one approval creates exactly one job and one transfer", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const results = await Promise.allSettled([
      f.lifecycle.approve(p.id, p.digest),
      f.lifecycle.approve(p.id, p.digest),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const job = results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<LifecycleJob>;
    await outcome(f, job.value.id);
    expect(f.store.list("job")).toHaveLength(1);
    expect(f.store.list("consumed-approval")).toHaveLength(1);
    expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  });
  test("after a restart, replaying a consumed approval is refused and nothing is fetched again", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    await outcome(f, (await f.lifecycle.approve(p.id, p.digest)).id);
    const restarted = new Lifecycle(f.store, f.directory, f.deps);
    await expect(restarted.approve(p.id, p.digest)).rejects.toThrow("already been used");
    expect(f.store.list("job")).toHaveLength(1);
    expect(f.deps.fetch).toHaveBeenCalledTimes(1);
  });
  test("APP-08 expiry continues while an approved update waits for idle; it never proceeds after expiry", async () => {
    let active = true;
    const f = await setup({ active: () => active });
    const p = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
    const job = await f.lifecycle.approve(p.id, p.digest);
    expect((await outcome(f, job.id)).state).toBe("waiting-for-idle");
    // The plan's own expiry, plus one millisecond.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(p.expiresAt) + 1 });
    active = false;
    await f.lifecycle.tick();
    vi.useRealTimers();
    const result = await outcome(f, job.id);
    expect(result.state).toBe("failed");
    expect(result.detail).toContain("expired");
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
    expect(f.deps.execute).not.toHaveBeenCalled();
    expect(f.store.get("installation-lock", p.managementUnitId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// APP-09 one owner per management unit
// ---------------------------------------------------------------------------
describe("APP-09 concurrent lifecycle jobs", () => {
  test("concurrent approvals for one installation produce one owner", async () => {
    const f = await setup({ active: () => true });
    const a = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
    const b = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
    const results = await Promise.allSettled([
      f.lifecycle.approve(a.id, a.digest),
      f.lifecycle.approve(b.id, b.digest),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason)).toMatch(
      /Another job owns this installation/,
    );
    expect(f.store.list("job")).toHaveLength(1);
    const owner = f.store.get<any>("installation-lock", a.managementUnitId);
    expect(owner.owner).toBe(f.store.list<LifecycleJob>("job")[0].id);
    expect((await outcome(f, owner.owner)).state).toBe("waiting-for-idle");
  });
  test("different management units transfer at the same time; a second job for a busy unit is refused", async () => {
    let inFlight = 0,
      maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const f = await setup({
      fetch: vi.fn(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight--;
        return new Response(payload);
      }),
    });
    const codex = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const claude = await f.lifecycle.preview("anthropic.claude-code-cli", null, "download");
    expect(codex.managementUnitId).not.toBe(claude.managementUnitId);
    const jobs = [
      await f.lifecycle.approve(codex.id, codex.digest),
      await f.lifecycle.approve(claude.id, claude.digest),
    ];
    await vi.waitFor(() => expect(inFlight).toBe(2));
    const again = await f.lifecycle.preview("openai.codex-cli", null, "download");
    await expect(f.lifecycle.approve(again.id, again.digest)).rejects.toThrow(
      "Another job",
    );
    release();
    for (const job of jobs) expect((await outcome(f, job.id)).state).toBe("completed");
    expect(maxInFlight).toBe(2);
    expect(f.deps.fetch).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// APP-12 crash at each point: uncertainty retained, no blind replay
// ---------------------------------------------------------------------------
describe("APP-12 crash recovery of lifecycle jobs", () => {
  test.each(["queued", "waiting-for-idle", "downloading", "verifying", "applying"])(
    "a job interrupted while %s becomes uncertain, keeps its lock, blocks a duplicate and reconciles only by readback",
    async (state) => {
      const f = await setup();
      const p = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
      const job: LifecycleJob = {
        id: `crashed-${state}`,
        planId: p.id,
        state: state as LifecycleJob["state"],
        acquiredPath: null,
        bytes: 0,
        total: null,
        actualVersion: null,
        detail: "",
        createdAt: now(),
        updatedAt: now(),
      };
      f.store.put("job", job);
      f.store.put("installation-lock", { id: p.managementUnitId, owner: job.id });
      f.store.put("consumed-approval", { id: p.id, digest: p.digest, jobId: job.id });
      // Restart from the on-disk state.
      const restarted = new Lifecycle(f.store, f.directory, f.deps);
      expect(f.store.get<LifecycleJob>("job", job.id)?.state).toBe("uncertain");
      expect(f.store.get<any>("installation-lock", p.managementUnitId)?.owner).toBe(job.id);
      await expect(restarted.approve(p.id, p.digest)).rejects.toThrow("already been used");
      const fresh = await restarted.preview("openai.codex-cli", f.installation.id, "update");
      await expect(restarted.approve(fresh.id, fresh.digest)).rejects.toThrow("Another job");
      // Reconcile with the version unchanged keeps the uncertainty.
      expect((await restarted.reconcile(job.id)).state).toBe("uncertain");
      expect(f.store.get("installation-lock", p.managementUnitId)).toBeDefined();
      expect(f.deps.execute).not.toHaveBeenCalled();
      expect(f.deps.fetch).not.toHaveBeenCalled();
      expect(f.deps.nativeOpen).not.toHaveBeenCalled();
      // Readback of the intended installation at the target version completes it.
      f.setInstallations([{ ...f.installation, version: "2.0.0", revisionId: hash("v2") }]);
      const reconciled = await restarted.reconcile(job.id);
      expect(reconciled).toMatchObject({ state: "completed", actualVersion: "2.0.0" });
      expect(f.store.get("installation-lock", p.managementUnitId)).toBeUndefined();
      expect(f.deps.execute).not.toHaveBeenCalled();
    },
  );
  test("a job handed to a native installer survives restart as awaiting-native and is not reopened", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview("openai.codex-cli", f.installation.id, "update");
    const job = await f.lifecycle.approve(p.id, p.digest);
    expect((await outcome(f, job.id)).state).toBe("awaiting-native");
    expect(f.deps.nativeOpen).toHaveBeenCalledTimes(1);
    new Lifecycle(f.store, f.directory, f.deps);
    expect(f.store.get<LifecycleJob>("job", job.id)?.state).toBe("awaiting-native");
    expect(f.store.get("installation-lock", p.managementUnitId)).toBeDefined();
    expect(f.deps.nativeOpen).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PR-05 Codex model catalogue pagination
// ---------------------------------------------------------------------------
function catalogConnection(pages: (cursor: string | undefined, call: number) => any) {
  const calls: any[] = [];
  const connection = {
    initialize: async () => ({}),
    request: async (method: string, params: any) => {
      if (method === "model/list") {
        calls.push(params);
        return pages(params.cursor, calls.length);
      }
      if (method === "account/read") return { account: null };
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as ProviderConnection;
  return { connection, calls };
}
const entry = (n: number) => ({ id: `id-${n}`, model: `model-${n}` });

describe("PR-05 Codex model pagination", () => {
  test("zero, one and many pages are represented exactly, with no renamed models or invented efforts", async () => {
    const empty = catalogConnection(() => ({ data: [] }));
    expect((await new CodexAdapter().inspect(empty.connection)).models).toEqual([]);
    expect(empty.calls).toEqual([{ limit: 100 }]);

    const one = catalogConnection(() => ({
      data: [
        {
          id: "gpt-x-2026-10-01",
          model: "gpt-x",
          displayName: "GPT X",
          description: "runtime text",
          isDefault: true,
          supportedReasoningEfforts: [
            { reasoningEffort: "minimal" },
            { reasoningEffort: "xhigh" },
          ],
          defaultReasoningEffort: "xhigh",
          inputModalities: ["text"],
        },
        { id: "bare", model: "bare-model" },
      ],
      nextCursor: null,
    }));
    const models = (await new CodexAdapter().inspect(one.connection)).models;
    expect(models.map(({ observedAt: _o, ...m }) => m)).toEqual([
      {
        id: "gpt-x-2026-10-01",
        model: "gpt-x",
        name: "GPT X",
        description: "runtime text",
        isDefault: true,
        supportedReasoningEfforts: ["minimal", "xhigh"],
        defaultReasoningEffort: "xhigh",
        inputModalities: ["text"],
        metadataSource: "runtime",
      },
      {
        id: "bare",
        model: "bare-model",
        // The runtime's own model string, not a Topsl rename.
        name: "bare-model",
        description: "",
        isDefault: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        // Mirrors Codex's protocol default for an omitted field (see summary).
        inputModalities: ["text", "image"],
        metadataSource: "runtime",
      },
    ]);

    const many = catalogConnection((cursor) =>
      cursor === undefined
        ? { data: [entry(1), entry(2)], nextCursor: "c1" }
        : cursor === "c1"
          ? { data: [entry(3)], nextCursor: "c2" }
          : { data: [entry(4)], nextCursor: null },
    );
    expect(
      (await new CodexAdapter().inspect(many.connection)).models.map((m) => m.id),
    ).toEqual(["id-1", "id-2", "id-3", "id-4"]);
    expect(many.calls).toEqual([
      { limit: 100 },
      { limit: 100, cursor: "c1" },
      { limit: 100, cursor: "c2" },
    ]);
  });
  test("a repeated cursor is rejected after the page that repeats it", async () => {
    const loop = catalogConnection((cursor) =>
      cursor === undefined
        ? { data: [entry(1)], nextCursor: "a" }
        : cursor === "a"
          ? { data: [entry(2)], nextCursor: "b" }
          : { data: [entry(3)], nextCursor: "a" },
    );
    await expect(new CodexAdapter().inspect(loop.connection)).rejects.toThrow(
      "Invalid or unbounded runtime model pagination",
    );
    expect(loop.calls).toHaveLength(3);
  });
  test("exactly 5,000 entries may continue; more than 5,000 with a continuing cursor stops after a bounded number of requests", async () => {
    // 50 pages of 100 = 5,000, then a final page: accepted.
    const exact = catalogConnection((_cursor, call) =>
      call <= 50
        ? {
            data: Array.from({ length: 100 }, (_, i) => entry(call * 1000 + i)),
            nextCursor: `p${call}`,
          }
        : { data: [], nextCursor: null },
    );
    expect((await new CodexAdapter().inspect(exact.connection)).models).toHaveLength(5000);
    // A runtime that never stops paging is cut off just past 5,000 entries.
    const endless = catalogConnection((_cursor, call) => ({
      data: Array.from({ length: 100 }, (_, i) => entry(call * 1000 + i)),
      nextCursor: `p${call}`,
    }));
    await expect(new CodexAdapter().inspect(endless.connection)).rejects.toThrow(
      "unbounded runtime model pagination",
    );
    expect(endless.calls).toHaveLength(51);
    // 5,001 entries on a final page (no cursor) are not "continuing".
    const final = catalogConnection(() => ({
      data: Array.from({ length: 5001 }, (_, i) => entry(i)),
      nextCursor: null,
    }));
    expect((await new CodexAdapter().inspect(final.connection)).models).toHaveLength(5001);
    // Malformed page shape fails closed rather than producing a partial catalogue.
    const malformed = catalogConnection(() => ({ data: [{ id: 7 }] }));
    await expect(new CodexAdapter().inspect(malformed.connection)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PR-07 / PR-08 / PR-09 Claude NDJSON stream
// ---------------------------------------------------------------------------
const multibyte = "héllo 中文 😀 👩‍👩‍👧 ﷽";
function streamRecords(): string {
  const records = [
    { type: "system", subtype: "init", session_id: "s", uuid: "init", model: "m-eff" },
    { type: "stream_event", session_id: "s", uuid: "st", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", session_id: "s", uuid: "d1", event: { type: "content_block_delta", delta: { type: "text_delta", text: multibyte } } },
    { type: "assistant", session_id: "s", uuid: "a1", message: { id: "m1", content: [{ type: "thinking", thinking: "secret-thinking-canary" }] } },
    { type: "assistant", session_id: "s", uuid: "a2", message: { id: "m1", content: [{ type: "text", text: multibyte }] } },
    { type: "assistant", session_id: "s", uuid: "a3", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "secret-argument-canary" } }] } },
    // The same final record repeated under a new uuid (Claude Code does this).
    { type: "assistant", session_id: "s", uuid: "a4", message: { id: "m1", content: [{ type: "text", text: multibyte }] } },
    // Two distinct messages that intentionally repeat the same text.
    { type: "assistant", session_id: "s", uuid: "a5", message: { id: "m2", content: [{ type: "text", text: "again ✓" }] } },
    { type: "assistant", session_id: "s", uuid: "a6", message: { id: "m3", content: [{ type: "text", text: "again ✓" }] } },
    { type: "result", session_id: "s", uuid: "r", subtype: "success", is_error: false, result: multibyte, usage: { input_tokens: 7, output_tokens: 3 } },
    // The final result duplicated (same fingerprint, new uuid).
    { type: "result", session_id: "s", uuid: "r2", subtype: "success", is_error: false, result: multibyte, usage: { input_tokens: 7, output_tokens: 3 } },
  ];
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
/** Feeds byte chunks to a parser through the same decoder `setEncoding("utf8")` uses. */
function parseChunks(chunks: Buffer[], decode: "stream" | "naive" = "stream") {
  const events: ClaudeStreamEvent[] = [];
  const parser = new ClaudeStreamParser((e) => events.push(e));
  const decoder = new StringDecoder("utf8");
  for (const chunk of chunks)
    parser.push(decode === "stream" ? decoder.write(chunk) : chunk.toString("utf8"));
  if (decode === "stream") parser.push(decoder.end());
  parser.finish();
  return events;
}
function expectExactStream(events: ClaudeStreamEvent[]) {
  const by = (type: string) => events.filter((e) => e.type === type) as any[];
  expect(by("delta").map((e) => e.text)).toEqual([multibyte]);
  expect(by("message").map((e) => [e.sourceId, e.text])).toEqual([
    ["m1", multibyte],
    ["m2", "again ✓"],
    ["m3", "again ✓"],
  ]);
  expect(by("usage")).toHaveLength(1);
  expect(by("usage")[0].usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  expect(by("completed")).toHaveLength(1);
  expect(by("completed")[0]).toMatchObject({ failed: false, text: multibyte, reportedModel: "m-eff" });
  expect(by("tool")).toEqual([{ type: "tool", sourceId: "t1", name: "Read", toolId: "t1" }]);
  const serialized = JSON.stringify(events);
  expect(serialized).not.toContain("�");
  expect(serialized).not.toContain("secret-thinking-canary");
  expect(serialized).not.toContain("secret-argument-canary");
}
/** A small deterministic PRNG so arbitrary chunkings are reproducible. */
function prng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

describe("PR-07 chunked UTF-8 NDJSON yields exact attributed text once", () => {
  test("every two-way split, including inside each multibyte character, gives identical events", () => {
    const bytes = Buffer.from(streamRecords(), "utf8");
    const reference = parseChunks([bytes]);
    expectExactStream(reference);
    let insideCodePoint = 0;
    for (let at = 1; at < bytes.length; at++) {
      if ((bytes[at] & 0xc0) === 0x80) insideCodePoint++;
      const events = parseChunks([bytes.subarray(0, at), bytes.subarray(at)]);
      expect(events, `split at byte ${at}`).toEqual(reference);
    }
    // The sweep really did split inside multibyte sequences.
    expect(insideCodePoint).toBeGreaterThan(40);
  });
  test("arbitrary multi-way chunkings (seeded) give identical events", () => {
    const bytes = Buffer.from(streamRecords(), "utf8");
    const reference = parseChunks([bytes]);
    const random = prng(20261019);
    for (let round = 0; round < 300; round++) {
      const chunks: Buffer[] = [];
      for (let at = 0; at < bytes.length; ) {
        const size = 1 + Math.floor(random() * 9);
        chunks.push(bytes.subarray(at, at + size));
        at += size;
      }
      expect(parseChunks(chunks), `round ${round}`).toEqual(reference);
    }
  });
  test("negative control: decoding each chunk on its own corrupts a split character, which the assertions reject", () => {
    const bytes = Buffer.from(streamRecords(), "utf8");
    const emoji = bytes.indexOf(Buffer.from("😀"));
    const events = parseChunks(
      [bytes.subarray(0, emoji + 2), bytes.subarray(emoji + 2)],
      "naive",
    );
    expect(() => expectExactStream(events)).toThrow();
    expect(JSON.stringify(events)).toContain("�");
  });
});

describe("PR-08 exact parser limits fail closed with bounded errors", () => {
  const padded = (bytes: number, uuid = "u") => {
    const head = `{"type":"user","uuid":"${uuid}","pad":"`,
      tail = `"}`;
    const line = head + "x".repeat(bytes - head.length - tail.length) + tail;
    expect(Buffer.byteLength(line)).toBe(bytes);
    return line;
  };
  test("a record of exactly 2,000,000 bytes is accepted; 2,000,001 bytes is refused, complete or partial", () => {
    expect(() => new ClaudeStreamParser(() => {}).push(padded(2_000_000) + "\n")).not.toThrow();
    expect(() => new ClaudeStreamParser(() => {}).push(padded(2_000_001) + "\n")).toThrow(
      "exceeds the bounded parser limit",
    );
    // A partial record is refused as soon as it passes the limit, before its newline.
    const partial = new ClaudeStreamParser(() => {});
    expect(() => partial.push(padded(2_000_000))).not.toThrow();
    expect(() => partial.push("y")).toThrow("exceeds the bounded parser limit");
    // The limit counts bytes, not characters.
    const wide = `{"type":"user","uuid":"w","pad":"${"é".repeat(1_000_000)}"}`;
    expect(wide.length).toBeLessThan(2_000_000);
    expect(() => new ClaudeStreamParser(() => {}).push(wide + "\n")).toThrow(
      "exceeds the bounded parser limit",
    );
  });
  test("20,000 distinct event identities are accepted; the 20,001st is refused, while an identical duplicate is not counted", () => {
    const parser = new ClaudeStreamParser(() => {});
    const lines = Array.from({ length: 20_000 }, (_, i) => `{"type":"user","uuid":"e${i}"}`);
    expect(() => parser.push(lines.join("\n") + "\n")).not.toThrow();
    expect(() => parser.push(`{"type":"user","uuid":"e0"}\n`)).not.toThrow();
    expect(() => parser.push(`{"type":"user","uuid":"e20000"}\n`)).toThrow(
      "exceeds the bounded event limit",
    );
  });
  test("1,000 distinct text blocks in one message are accepted; the 1,001st is refused", () => {
    const parser = new ClaudeStreamParser(() => {});
    const block = (i: number) =>
      JSON.stringify({ type: "assistant", session_id: "s", uuid: `b${i}`, message: { id: "m", content: [{ type: "text", text: `t${i}` }] } });
    parser.push(Array.from({ length: 1000 }, (_, i) => block(i)).join("\n") + "\n");
    expect(() => parser.push(block(1000) + "\n")).toThrow("exceeds the bounded block limit");
  });
  test("unknown, sessionless, unterminated or post-result records never yield success, and errors stay bounded", () => {
    let error = "";
    try {
      new ClaudeStreamParser(() => {}).push(JSON.stringify({ type: "x".repeat(100_000) }) + "\n");
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error).toMatch(/^Unsupported Claude event type/);
    expect(error.length).toBeLessThan(1700);
    const events: ClaudeStreamEvent[] = [];
    expect(() =>
      new ClaudeStreamParser((e) => events.push(e)).push(
        '{"type":"result","subtype":"success","is_error":false,"result":"ok"}\n',
      ),
    ).toThrow("omitted native session identity");
    const open = new ClaudeStreamParser((e) => events.push(e));
    open.push('{"type":"system","subtype":"init","session_id":"s","uuid":"i"}\n');
    expect(() => open.finish()).toThrow("dispatch outcome is unknown");
    expect(() => open.push('{"type":"result","session_id":"s","subtype":"success"')).not.toThrow();
    expect(() => open.finish()).toThrow();
    expect(events.some((e) => e.type === "completed")).toBe(false);
    const ended = new ClaudeStreamParser(() => {});
    ended.push('{"type":"result","session_id":"s","uuid":"r","subtype":"success","is_error":false,"result":"a"}\n');
    expect(() =>
      ended.push('{"type":"result","session_id":"s","uuid":"r9","subtype":"success","is_error":false,"result":"b"}\n'),
    ).toThrow("after the final result");
    expect(() =>
      ended.push('{"type":"assistant","session_id":"s","uuid":"late","message":{"content":[]}}\n'),
    ).toThrow("after the final result");
  });
});

describe("PR-09 informational and additive records", () => {
  test("each supported informational record becomes a notice only, and additive fields are neither retained nor authoritative", () => {
    const events: ClaudeStreamEvent[] = [];
    const parser = new ClaudeStreamParser((e) => events.push(e));
    const informational = ["rate_limit_event", "tool_progress", "tool_use_summary", "auth_status", "prompt_suggestion"];
    parser.push(
      [
        { type: "system", subtype: "init", session_id: "s", uuid: "i", futureField: { allow: true } },
        ...informational.map((type, n) => ({ type, session_id: "s", uuid: `n${n}`, payload: "additive-canary", allow: true })),
        { type: "system", subtype: "api_retry", session_id: "s", uuid: "retry", attempt: 2 },
        { type: "assistant", session_id: "s", uuid: "a", message: { id: "m", content: [{ type: "text", text: "hi", citations: ["additive-canary"] }], newMeta: 1 } },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );
    expect(events.filter((e) => e.type === "notice").map((e) => (e as any).detail)).toEqual([
      ...informational.map((type) => `Native informational event: ${type}`),
      "Native system event: api_retry",
    ]);
    expect(events.filter((e) => e.type === "completed")).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("additive-canary");
    // Authority-bearing records that Topsl does not know stay blocked.
    for (const type of ["control_request", "permission_request", "tool_approval"])
      expect(() =>
        new ClaudeStreamParser(() => {}).push(JSON.stringify({ type, session_id: "s", request: { allow: true } }) + "\n"),
        type,
      ).toThrow("Unsupported Claude event type");
  });
});

// ---------------------------------------------------------------------------
// PR-13 approval summaries: hidden characters, scope bounds, lasting rules
// ---------------------------------------------------------------------------
const esc = (cp: number) => `${String.fromCharCode(92)}u{${cp.toString(16)}}`;
const base = { threadId: "thread", turnId: "turn", itemId: "item", startedAtMs: 1 };

describe("PR-13 approval summaries show the real bounded scope", () => {
  test("every C0/C1 control except tab and newline, the bidi embeddings/overrides/isolates, LRM/RLM and line separators are escaped", () => {
    const codePoints = [
      ...Array.from({ length: 0x20 }, (_, i) => i).filter((c) => c !== 0x09 && c !== 0x0a),
      ...Array.from({ length: 0xa0 - 0x7f }, (_, i) => 0x7f + i),
      0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
      0x2066, 0x2067, 0x2068, 0x2069, 0x2028, 0x2029, 0x200b, 0x200d, 0xfeff, 0x00ad, 0xe0001, 0xe007f,
    ];
    for (const cp of codePoints) {
      const ch = String.fromCodePoint(cp);
      expect(visible(`a${ch}b`), cp.toString(16)).toBe(`a${esc(cp)}b`);
    }
    // Negative control: ordinary visible text is unchanged.
    expect(visible("a-b é 中 😀")).toBe("a-b é 中 😀");
  });
  // CAMPAIGN DEFECT PR-13: U+061C ARABIC LETTER MARK (a Unicode Bidi_Control
  // direction mark) is not in codex-approvals.ts `hidden`, so it reaches the
  // approval summary unescaped and can reorder the displayed text invisibly.
  test.fails("every Unicode Bidi_Control character, including U+061C ARABIC LETTER MARK, is escaped", () => {
    const bidi: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++)
      if ((cp < 0xd800 || cp > 0xdfff) && /\p{Bidi_Control}/u.test(String.fromCodePoint(cp))) bidi.push(cp);
    expect(bidi).toContain(0x061c);
    const unescaped = bidi.filter(
      (cp) => visible(`a${String.fromCodePoint(cp)}b`) !== `a${esc(cp)}b`,
    );
    expect(unescaped.map((cp) => cp.toString(16))).toEqual([]);
  });
  test("a multi-file rename with hidden characters shows each move escaped on its own line", () => {
    const rlo = String.fromCodePoint(0x202e),
      zw = String.fromCodePoint(0x200b);
    const summary = fileChangeApprovalSummary(base, {
      changes: [
        { path: `/w/a${rlo}st.ts`, kind: { type: "update", move_path: `/w/b${zw}.ts` } },
        { path: "/w/c.ts", kind: { type: "update", move_path: "/w/d.ts" } },
        { kind: { type: "add" } },
        { path: "/w/e.ts", kind: { type: "mystery" } },
      ],
    });
    expect(summary.details[0]).toEqual({
      label: "Files",
      value: [
        `Move /w/a${esc(0x202e)}st.ts to /w/b${esc(0x200b)}.ts`,
        "Move /w/c.ts to /w/d.ts",
        "Create an unnamed file",
        "Change /w/e.ts",
      ].join("\n"),
    });
  });
  test("long lists and long commands are bounded with an explicit remainder count", () => {
    const files = Array.from({ length: 53 }, (_, i) => ({ path: `/w/f${i}.ts`, kind: { type: "add" } }));
    const value = fileChangeApprovalSummary(base, { changes: files }).details[0].value;
    expect(value.split("\n")).toHaveLength(51);
    expect(value.endsWith("\nand 3 more")).toBe(true);
    const entries = Array.from({ length: 55 }, (_, i) => ({ access: "write", path: { type: "path", path: `/p/${i}` } }));
    const extra = commandApprovalSummary({ ...base, command: "x", additionalPermissions: { fileSystem: { entries } } })
      .details.find((d) => d.label === "Extra permissions")!.value;
    expect(extra.split("\n")).toHaveLength(51);
    expect(extra.endsWith("and 5 more")).toBe(true);
    const command = commandApprovalSummary({ ...base, command: "y".repeat(5000) }).details[0].value;
    expect(command).toBe(`${"y".repeat(4000)}… (1000 more characters)`);
  });
  test("a proposed lasting network rule is distinguished from allow-once; empty proposals add nothing", () => {
    const withRule = commandApprovalSummary({
      ...base,
      command: "curl https://example.test",
      proposedNetworkPolicyAmendments: [{ host: "example.test", action: "allow" }],
    });
    expect(withRule.effects).toContain(
      "Codex also proposed a lasting rule for similar requests. Allowing once does not add it.",
    );
    expect(withRule.effects[0]).toBe("Allowing lets Codex run this command once.");
    const none = commandApprovalSummary({
      ...base,
      command: "ls",
      proposedNetworkPolicyAmendments: [],
      proposedExecpolicyAmendment: [],
    });
    expect(none.effects.join("\n")).not.toContain("lasting rule");
    // A network host with hidden characters cannot pass for another host.
    const spoof = commandApprovalSummary({
      ...base,
      command: "x",
      networkApprovalContext: { host: `good.test${String.fromCodePoint(0x202e)}\nevil`, protocol: "https" },
    });
    expect(spoof.details.find((d) => d.label === "Network")!.value).toBe(
      `good.test${esc(0x202e)}${esc(0xa)}evil (https)`,
    );
  });
});
