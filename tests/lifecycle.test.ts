import { afterEach, describe, expect, test, vi } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { Lifecycle } from "../packages/applications/lifecycle";
import type {
  Installation,
  LifecycleJob,
  LifecyclePlan,
  Release,
} from "../packages/domain/types";
import { hash, now, planDigest } from "../packages/domain/invariants";
import { fixture, plan } from "./helpers";
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const payload = Buffer.from("verified installer fixture");
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
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function outcome(
  f: Awaited<ReturnType<typeof setup>>,
  id: string,
  states = [
    "completed",
    "unchanged",
    "failed",
    "cancelled",
    "uncertain",
    "awaiting-native",
    "waiting-for-idle",
  ],
) {
  await vi.waitFor(
    () => expect(states).toContain(f.store.get<LifecycleJob>("job", id)?.state),
    { timeout: 8000, interval: 20 },
  );
  return f.store.get<LifecycleJob>("job", id)!;
}
describe("application lifecycle", () => {
  test("native desktop updates open the existing application and cannot claim an unchanged version was updated", async () => {
    const f = await setup({ release: async () => null });
    const i = {
      ...f.installation,
      appId: "openai.desktop" as const,
      owner: "vendor" as const,
      channel: "native",
    };
    f.setInstallations([i]);
    const p = await f.lifecycle.preview(i.appId, i.id, "update");
    expect(p.nativeApplicationPath).toBe(i.path);
    expect(p.release).toBeNull();
    const j = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, j.id);
    expect(f.deps.nativeOpen).toHaveBeenCalledWith(i.path);
    f.deps.processes = vi.fn(async () => [42]);
    expect((await f.lifecycle.reconcile(j.id)).state).toBe("uncertain");
    f.setInstallations([
      { ...i, version: "2.0.0", revisionId: "new-revision" },
    ]);
    expect((await f.lifecycle.reconcile(j.id)).actualVersion).toBe("2.0.0");
  });
  test("a closed native flow can confirm unchanged without claiming an update or retaining its lock", async () => {
    const f = await setup({ release: async () => null });
    const p = await f.lifecycle.preview(
      f.installation.appId,
      f.installation.id,
      "update",
    );
    const j = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, j.id);
    expect((await f.lifecycle.reconcile(j.id)).state).toBe("unchanged");
    expect(
      f.store.get("installation-lock", p.managementUnitId),
    ).toBeUndefined();
    await expect(f.lifecycle.approve(p.id, p.digest)).rejects.toThrow(
      "already been used",
    );
    const fresh = await f.lifecycle.preview(
      f.installation.appId,
      f.installation.id,
      "update",
    );
    await outcome(f, (await f.lifecycle.approve(fresh.id, fresh.digest)).id);
    expect(f.deps.nativeOpen).toHaveBeenCalledTimes(2);
  });
  test("unknown native running state cannot confirm an unchanged flow is closed", async () => {
    const f = await setup({ release: async () => null });
    const p = await f.lifecycle.preview(
      f.installation.appId,
      f.installation.id,
      "update",
    );
    const j = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, j.id);
    f.deps.processes = vi.fn(async () => null);
    expect((await f.lifecycle.reconcile(j.id)).state).toBe("uncertain");
    expect(f.store.get("installation-lock", p.managementUnitId)).toBeDefined();
  });
  test("background checks never download or execute and obey the due time", async () => {
    const f = await setup();
    await f.lifecycle.check(f.installation.id);
    await f.lifecycle.check(f.installation.id);
    expect(f.deps.release).toHaveBeenCalledTimes(1);
    expect(f.deps.execute).not.toHaveBeenCalled();
    expect(f.deps.fetch).not.toHaveBeenCalled();
    await f.lifecycle.check(f.installation.id, true);
    expect(f.deps.release).toHaveBeenCalledTimes(2);
  });
  test("failed checks back off and display unknown, not current", async () => {
    const f = await setup({
      release: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const a = await f.lifecycle.check(f.installation.id);
    const b = await f.lifecycle.check(f.installation.id, true);
    expect(a.status).toBe("unknown");
    expect(b.failures).toBe(2);
    expect(Date.parse(b.nextCheckAt) - Date.parse(b.checkedAt)).toBeGreaterThan(
      86_400_000,
    );
  });
  test("download-only verifies bytes and never installs", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const job = await f.lifecycle.approve(p.id, p.digest);
    const result = await outcome(f, job.id);
    expect(result.state).toBe("completed");
    expect(await readFile(result.acquiredPath!)).toEqual(payload);
    expect(result.actualVersion).toBeNull();
    expect(f.deps.execute).not.toHaveBeenCalled();
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
  });
  test("integrity failures never expose an acquired artifact", async () => {
    const f = await setup({
      fetch: vi.fn(async () => new Response("wrong bytes")),
    });
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const job = await f.lifecycle.approve(p.id, p.digest);
    const result = await outcome(f, job.id);
    expect(result.state).toBe("failed");
    expect(result.acquiredPath).toBeNull();
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
  });
  test("interrupted transfer is failed without installation", async () => {
    const f = await setup({
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(payload.subarray(0, 4));
              c.error(new Error("connection lost"));
            },
          }),
        ),
    });
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const result = await outcome(
      f,
      (await f.lifecycle.approve(p.id, p.digest)).id,
    );
    expect(result.state).toBe("failed");
    expect(f.deps.execute).not.toHaveBeenCalled();
  });
  test("cancellation aborts a transfer and cannot execute its payload", async () => {
    const f = await setup({
      fetch: (_url: string, options: any) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(new Error("Cancelled")),
          ),
        ),
    });
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    const job = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, job.id, ["downloading"]);
    f.lifecycle.cancel(job.id);
    expect((await outcome(f, job.id)).state).toBe("cancelled");
  });
  test("approval is consumed once and binds the exact preview", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview("openai.codex-cli", null, "download");
    await expect(f.lifecycle.approve(p.id, "wrong")).rejects.toThrow("changed");
    const job = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, job.id);
    await expect(f.lifecycle.approve(p.id, p.digest)).rejects.toThrow(
      "already been used",
    );
  });
  test("external executable changes invalidate approval", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    await writeFile(f.installation.path, "different runtime");
    const job = await f.lifecycle.approve(p.id, p.digest);
    expect((await outcome(f, job.id)).state).toBe("failed");
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
  });
  test("active sessions defer an approved operation without closing them", async () => {
    let active = true;
    const f = await setup({ active: () => active });
    const p = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    const job = await f.lifecycle.approve(p.id, p.digest);
    expect((await outcome(f, job.id)).state).toBe("waiting-for-idle");
    expect(f.deps.nativeOpen).not.toHaveBeenCalled();
    active = false;
    await f.lifecycle.tick();
    expect((await outcome(f, job.id)).state).toBe("awaiting-native");
    expect(f.deps.nativeOpen).toHaveBeenCalledTimes(1);
  });
  test("uncertain running-state probe defers changes", async () => {
    const f = await setup({ processes: async () => null });
    const p = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    const job = await f.lifecycle.approve(p.id, p.digest);
    expect((await outcome(f, job.id)).state).toBe("waiting-for-idle");
  });
  test("one installation has one active job", async () => {
    const f = await setup({ active: () => true });
    const a = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    const b = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    const job = await f.lifecycle.approve(a.id, a.digest);
    await outcome(f, job.id);
    await expect(f.lifecycle.approve(b.id, b.digest)).rejects.toThrow(
      "Another job",
    );
  });
  test("crash recovery never repeats a possibly applied command", async () => {
    const f = await setup();
    const p = plan();
    p.digest = planDigest(p);
    f.store.put("plan", p);
    f.store.put("job", {
      id: "interrupted",
      planId: p.id,
      state: "applying",
      acquiredPath: null,
      bytes: 0,
      total: null,
      actualVersion: null,
      detail: "",
      createdAt: now(),
      updatedAt: now(),
    });
    new Lifecycle(f.store, f.directory, f.deps);
    expect(f.store.get<LifecycleJob>("job", "interrupted")?.state).toBe(
      "uncertain",
    );
    expect(f.deps.execute).not.toHaveBeenCalled();
  });
  test("successful installation does not claim runtime compatibility", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    const job = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, job.id);
    f.setInstallations([
      { ...f.installation, version: "2.0.0", compatibility: "incompatible" },
    ]);
    const result = await f.lifecycle.reconcile(job.id);
    expect(result.actualVersion).toBe("2.0.0");
    expect(result.state).toBe("completed");
    expect(result.detail).toContain("separately");
  });
  test("a separate installation with the target version cannot satisfy reconciliation", async () => {
    const f = await setup();
    const p = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    const job = await f.lifecycle.approve(p.id, p.digest);
    await outcome(f, job.id);
    f.setInstallations([
      {
        ...f.installation,
        id: "other",
        managementUnitId: "other-unit",
        version: "2.0.0",
      },
    ]);
    expect((await f.lifecycle.reconcile(job.id)).state).toBe("uncertain");
  });
  test("bundled Codex resolves to its parent desktop update owner", async () => {
    const f = await setup();
    const parent = {
      ...f.installation,
      id: "desktop",
      appId: "openai.desktop" as const,
      owner: "vendor" as const,
    };
    f.setInstallations([{ ...f.installation, owner: "desktop" }, parent]);
    const p = await f.lifecycle.preview(
      "openai.codex-cli",
      f.installation.id,
      "update",
    );
    expect(p.appId).toBe("openai.desktop");
    expect(p.installationId).toBe("desktop");
    expect(p.route).toBe("native");
  });
  test("an older metadata release cannot cause a downgrade", async () => {
    const f = await setup({
      release: async () => ({ ...release, version: "0.9.0" }),
    });
    expect((await f.lifecycle.check(f.installation.id)).status).toBe("current");
    await expect(
      f.lifecycle.preview("openai.codex-cli", f.installation.id, "update"),
    ).rejects.toThrow("newer version");
  });
  test("Homebrew updates the selected cask and preserves its channel", async () => {
    const f = await setup();
    const i = {
      ...f.installation,
      appId: "anthropic.claude-code-cli" as const,
      owner: "homebrew" as const,
      packageId: "claude-code@latest",
      channel: "latest",
    };
    f.setInstallations([i]);
    f.deps.packageManager = async () => i.path;
    f.deps.execute.mockImplementation(
      async (_executable: string, args: string[], options: any) => {
        expect(args).toEqual([
          "upgrade",
          "--cask",
          "--greedy",
          "claude-code@latest",
        ]);
        expect(options.env.HOMEBREW_NO_AUTO_UPDATE).toBe("1");
        f.setInstallations([{ ...i, version: "2.0.0" }]);
        return "";
      },
    );
    const p = await f.lifecycle.preview(i.appId, i.id, "update");
    expect(p.route).toBe("package-manager");
    const j = await f.lifecycle.approve(p.id, p.digest);
    expect((await outcome(f, j.id)).state).toBe("completed");
    expect(f.deps.execute).toHaveBeenCalledTimes(1);
  });
  test.each(["permission denied", "package manager locked", "disk full"])(
    "package failure %s becomes uncertain and is never automatically repeated",
    async (detail) => {
      const f = await setup();
      const i = {
        ...f.installation,
        owner: "homebrew" as const,
        packageId: "codex",
      };
      f.setInstallations([i]);
      f.deps.packageManager = async () => i.path;
      f.deps.execute.mockRejectedValue(new Error(detail));
      const p = await f.lifecycle.preview(i.appId, i.id, "update");
      const j = await f.lifecycle.approve(p.id, p.digest);
      expect((await outcome(f, j.id)).state).toBe("uncertain");
      await f.lifecycle.tick();
      expect(f.deps.execute).toHaveBeenCalledTimes(1);
      expect((await f.lifecycle.reconcile(j.id)).state).toBe("uncertain");
    },
  );
});
