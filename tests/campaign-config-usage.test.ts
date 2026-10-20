/**
 * Campaign 2026-10-19-comprehensive, packet p2b-config-usage.
 *
 * Native configuration (CONF-01..CONF-05, CONF-11) and usage reporting
 * (USAGE-02, USAGE-06, USAGE-08, USAGE-09, USAGE-11, USAGE-15) contracts that
 * the existing suite did not fully assert. Every service case runs the real
 * Service and encrypted Store in a temporary profile; CODEX_HOME and
 * CLAUDE_CONFIG_DIR always point into that profile so the owner's real native
 * homes are never read or written. Nothing here launches a real provider.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPty, spawn as ptySpawn } from "node-pty";
import { spawn as realPtySpawn } from "node-pty";
import { z } from "zod";
import { Service } from "../apps/service/service";
import { commandSchema } from "../packages/domain/commands";
import { hash, now } from "../packages/domain/invariants";
import type {
  AppState,
  ConfigurationPlan,
  Installation,
  Run,
  UsageFact,
} from "../packages/domain/types";
import { Configuration } from "../packages/workspace/configuration";
import { identity } from "../packages/platform/system";
import { budgetAlerts, summarizeUsage } from "../packages/domain/usage";
import {
  ALLOWANCE_STALE_AFTER_MS,
  applyAllowanceReport,
  budgetPeriodStart,
  providerBudgetStatus,
  windowView,
  type AllowanceSnapshot,
  type ObservedWindow,
  type ProviderBudget,
} from "../packages/domain/allowance";
import {
  allowanceStatus,
  budgetReadout,
} from "../apps/desktop/renderer/state/allowance-view";
import { ProviderUsage } from "../apps/desktop/renderer/components/allowance";
import { readClaudeUsage } from "../packages/providers/claude-allowance";
import { RuntimeManager } from "../packages/runtime/manager";
import { Store } from "../packages/persistence/store";
import { claudeRoutePreferenceId } from "../packages/domain/claude-route";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const step of cleanup.splice(0).reverse()) await step();
  vi.unstubAllEnvs();
});

/** Files in a folder other than the ones a test expects, such as a staged `.topsl-*.tmp`. */
const stray = async (directory: string) =>
  (await readdir(directory)).filter((name) => name.startsWith(".topsl-"));

/**
 * A started Service over a temporary encrypted profile with one trusted
 * project. `send` parses each command at the IPC boundary, as the worker does,
 * so renderer-supplied extra fields are stripped exactly as in production.
 */
async function serviceFixture() {
  const f = await fixture();
  f.store.close();
  const project = path.join(f.directory, "project"),
    other = path.join(f.directory, "other-project"),
    codexHome = path.join(f.directory, "codex-home"),
    claudeHome = path.join(f.directory, "claude-home"),
    outside = path.join(f.directory, "outside");
  for (const directory of [project, other, codexHome, claudeHome, outside])
    await mkdir(directory, { recursive: true });
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeHome);
  const holder = { service: new Service(f.directory, f.key, () => {}, true) };
  for (const [id, folder] of [
    ["p", project],
    ["q", other],
  ])
    holder.service.store.put("project", {
      id,
      name: id,
      path: folder,
      realPath: folder,
      trusted: true,
      createdAt: now(),
    });
  await holder.service.start();
  cleanup.push(async () => {
    await holder.service.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const send = (command: unknown, trusted: Record<string, unknown> = {}) =>
    holder.service.command(commandSchema.parse(command), trusted);
  /** Closes the service and opens the same encrypted profile again. */
  const restart = async () => {
    await holder.service.close();
    holder.service = new Service(f.directory, f.key, () => {}, true);
    await holder.service.start();
    return holder.service;
  };
  /** Read and preview through the public commands. */
  const edit = async (
    provider: "codex" | "claude",
    projectId: string | null,
    kind: "native" | "instructions",
    text: string,
  ) => {
    const read = await send({
      type: "configuration-read",
      provider,
      projectId,
      kind,
    });
    const plan: ConfigurationPlan = await send({
      type: "configuration-preview",
      path: read.path,
      expectedHash: read.hash,
      text,
    });
    return { read, plan };
  };
  /** The digest the desktop broker attaches after its native dialog: from the service's own review. */
  const approve = (planId: string) => ({
    digest: (
      holder.service.review("configuration-plan", planId) as ConfigurationPlan
    ).digest,
  });
  const apply = (planId: string, trusted = approve(planId)) =>
    send({ type: "configuration-apply", id: planId }, trusted);
  const write = (planId: string) =>
    holder.service.store.get<{ state: string; targetHash: string }>(
      "configuration-write",
      planId,
    );
  return {
    ...f,
    holder,
    project,
    other,
    codexHome,
    claudeHome,
    outside,
    send,
    restart,
    edit,
    approve,
    apply,
    write,
  };
}

describe("CONF-01 approved native configuration targets through the service", () => {
  test("each approved global and project target is read, previewed with exact before/after and source identity, and written exactly", async () => {
    const f = await serviceFixture();
    const tomlBefore =
      '# owner comment kept verbatim\nmodel = "a"\n\n[unknown_table]\nkeep = true\n';
    const jsonBefore =
      '{\n    "permissions": { "allow": [] },\n    "unknownField": { "x": 1 }\n}\n';
    await writeFile(path.join(f.codexHome, "config.toml"), tomlBefore);
    await writeFile(path.join(f.claudeHome, "settings.json"), jsonBefore);
    await writeFile(path.join(f.project, "AGENTS.md"), "Old agents text.\n");
    const targets = [
      {
        provider: "codex" as const,
        projectId: null,
        kind: "native" as const,
        file: path.join(f.codexHome, "config.toml"),
        before: tomlBefore,
        after: tomlBefore.replace('model = "a"', 'model = "b"'),
      },
      {
        provider: "claude" as const,
        projectId: null,
        kind: "native" as const,
        file: path.join(f.claudeHome, "settings.json"),
        before: jsonBefore,
        after: jsonBefore.replace('"allow": []', '"allow": ["Read"]'),
      },
      {
        provider: "codex" as const,
        projectId: "p",
        kind: "native" as const,
        file: path.join(f.project, ".codex", "config.toml"),
        before: "",
        after: '# project\nmodel = "c"\n',
      },
      {
        provider: "claude" as const,
        projectId: "p",
        kind: "native" as const,
        file: path.join(f.project, ".claude", "settings.json"),
        before: "",
        after: '{"permissions":{"deny":["Bash"]}}',
      },
      {
        provider: "codex" as const,
        projectId: "p",
        kind: "instructions" as const,
        file: path.join(f.project, "AGENTS.md"),
        before: "Old agents text.\n",
        after: "New agents text.\n",
      },
      {
        provider: "claude" as const,
        projectId: "p",
        kind: "instructions" as const,
        file: path.join(f.project, "CLAUDE.md"),
        before: "",
        after: "Claude project notes.\n",
      },
    ];
    for (const target of targets) {
      const { read, plan } = await f.edit(
        target.provider,
        target.projectId,
        target.kind,
        target.after,
      );
      const label = `${target.provider} ${target.kind} ${target.projectId ?? "global"}`;
      // Source identity: the exact file, its bytes and their hash.
      expect(read.path, label).toBe(target.file);
      expect(read.text, label).toBe(target.before);
      expect(read.hash, label).toBe(hash(target.before));
      expect(read.ownership, label).toMatch(/runtime reload is unverified/);
      // The preview the native dialog shows binds exactly this before/after.
      expect(plan, label).toMatchObject({
        path: target.file,
        expectedHash: read.hash,
        before: target.before,
        after: target.after,
      });
      expect(await f.apply(plan.id), label).toEqual({
        applied: true,
        loaded: false,
      });
      expect(await readFile(target.file, "utf8"), label).toBe(target.after);
      expect(f.write(plan.id), label).toMatchObject({
        state: "written-unverified",
        targetHash: hash(target.after),
      });
      expect(await stray(path.dirname(target.file)), label).toEqual([]);
    }
    // Project writes are recorded as configured, never as effective native state.
    const evidence = f.holder.service.synchronization.configuration("p");
    const configured = evidence.filter((e) => e.stage === "configured");
    expect(configured.map((e) => e.value).sort()).toEqual(
      targets
        .filter((t) => t.projectId)
        .map((t) => t.file)
        .sort(),
    );
    expect(evidence.some((e) => e.stage === "effective")).toBe(false);
    // Global files are not attributed to any project.
    expect(
      f.holder.service.synchronization
        .configuration("q")
        .some((e) => e.stage === "configured"),
    ).toBe(false);
  });
});

describe("CONF-02 malformed, oversized and arbitrary configuration input", () => {
  async function unit() {
    const f = await fixture();
    const project = path.join(f.directory, "project");
    await mkdir(path.join(project, ".claude"), { recursive: true });
    await mkdir(path.join(project, ".codex"), { recursive: true });
    cleanup.push(async () => {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    const p = {
      id: "p",
      name: "p",
      path: project,
      realPath: project,
      trusted: true,
      createdAt: now(),
    };
    return { ...f, project, p, config: new Configuration(f.store, () => false) };
  }

  test.each([
    ["broken JSON", "{oops"],
    ["empty text", ""],
    ["a JSON array", "[]"],
    ["an array of values", "[1,2]"],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"text"'],
    ["a boolean", "true"],
  ])(
    "Claude settings that are %s are refused with no plan and no file change",
    async (_label, text) => {
      const f = await unit();
      const file = path.join(f.project, ".claude", "settings.json");
      await writeFile(file, '{"kept":true}');
      const read = await f.config.read("claude", f.p, "native");
      await expect(f.config.preview(read.path, read.hash, text)).rejects.toThrow();
      expect(f.store.list("configuration-plan")).toEqual([]);
      expect(await readFile(file, "utf8")).toBe('{"kept":true}');
      // Negative control: a JSON object on the same file is accepted.
      await expect(
        f.config.preview(read.path, read.hash, '{"kept":false}'),
      ).resolves.toMatchObject({ after: '{"kept":false}' });
    },
  );

  test.each([
    ["an unfinished value", "model = "],
    ["an unclosed table", "[table\nkey = 1"],
    ["a duplicated key", "a = 1\na = 2"],
  ])(
    "Codex TOML with %s is refused with no plan and no file change",
    async (_label, text) => {
      const f = await unit();
      const file = path.join(f.project, ".codex", "config.toml");
      await writeFile(file, 'model = "kept"\n');
      const read = await f.config.read("codex", f.p, "native");
      await expect(f.config.preview(read.path, read.hash, text)).rejects.toThrow();
      expect(f.store.list("configuration-plan")).toEqual([]);
      expect(await readFile(file, "utf8")).toBe('model = "kept"\n');
    },
  );

  test("oversized input is refused at the IPC boundary and an oversized file is not read", async () => {
    const preview = (length: number) =>
      commandSchema.safeParse({
        type: "configuration-preview",
        path: "/x/settings.json",
        expectedHash: "h",
        text: "a".repeat(length),
      }).success;
    expect(preview(1_000_000)).toBe(true);
    expect(preview(1_000_001)).toBe(false);
    const f = await unit();
    const file = path.join(f.project, ".claude", "settings.json");
    await writeFile(file, `{"x":"${"a".repeat(1_000_000)}"}`);
    await expect(f.config.read("claude", f.p, "native")).rejects.toThrow(
      "not a supported size",
    );
    // Nothing became readable, so no preview of it can be made.
    await expect(f.config.preview(file, hash(""), "{}")).rejects.toThrow(
      "Read this provider configuration through Topsl first.",
    );
  });

  test("an edit of 600,000 two-byte characters passes the IPC limit, which counts characters", () => {
    expect(
      commandSchema.safeParse({
        type: "configuration-preview",
        path: "/x/AGENTS.md",
        expectedHash: "h",
        text: "é".repeat(600_000),
      }).success,
    ).toBe(true);
    expect(Buffer.byteLength("é".repeat(600_000))).toBe(1_200_000);
  });

  test(
    "an edit larger than the 1,000,000-byte configuration bound is refused before it is written",
    async () => {
      const f = await unit();
      const read = await f.config.read("codex", f.p, "instructions");
      const text = "é".repeat(600_000);
      await expect(
        (async () => {
          const plan = await f.config.preview(read.path, read.hash, text);
          await f.config.apply(plan.id, plan.digest);
        })(),
      ).rejects.toThrow();
      // Whatever was refused, Topsl must still be able to read the file afterwards.
      await expect(
        f.config.read("codex", f.p, "instructions"),
      ).resolves.toBeTruthy();
    },
  );

  test("only a file Topsl itself resolved and read can be previewed; a renderer path field is stripped", async () => {
    const f = await unit();
    const read = await f.config.read("claude", f.p, "native");
    for (const unread of [
      "/etc/passwd",
      path.join(f.project, ".claude", "settings.local.json"),
      // Same file, another spelling (path.join would normalize the "./" away).
      `${f.project}${path.sep}.claude${path.sep}.${path.sep}settings.json`,
      path.join(f.project, "AGENTS.md"),
    ])
      await expect(f.config.preview(unread, hash(""), "{}")).rejects.toThrow(
        "Read this provider configuration through Topsl first.",
      );
    expect(f.store.list("configuration-plan")).toEqual([]);
    // configuration-read has no path: one the window adds is removed before the service sees it.
    expect(
      commandSchema.parse({
        type: "configuration-read",
        provider: "claude",
        projectId: "p",
        kind: "native",
        path: "/etc/passwd",
      }),
    ).toEqual({
      type: "configuration-read",
      provider: "claude",
      projectId: "p",
      kind: "native",
    });
    // Negative control: the file Topsl resolved can be previewed.
    await expect(f.config.preview(read.path, read.hash, "{}")).resolves.toBeTruthy();
  });

  test("through the service, malformed, non-object and oversized edits are refused with no plan, no write record and no file change", async () => {
    const f = await serviceFixture();
    const folder = path.join(f.project, ".claude");
    await mkdir(folder);
    const file = path.join(folder, "settings.json");
    await writeFile(file, '{"kept":true}');
    const read = await f.send({
      type: "configuration-read",
      provider: "claude",
      projectId: "p",
      kind: "native",
    });
    const preview = (text: string) =>
      f.send({
        type: "configuration-preview",
        path: read.path,
        expectedHash: read.hash,
        text,
      });
    // Broken JSON is refused by the JSON parser itself (configuration.ts:103),
    // not by a later check such as the hash or the readable-path guard.
    const broken = preview("{oops");
    await expect(broken).rejects.toThrow(SyntaxError);
    await expect(broken).rejects.toThrow(/in JSON at position 1/);
    // Valid JSON that is not an object is refused by the object check
    // (configuration.ts:104-105), with its exact reason.
    for (const text of ["[]", "null", "7"])
      await expect(preview(text)).rejects.toThrow(
        /^Settings must contain a JSON object\.$/,
      );
    // Oversized text never reaches the service: the IPC parse refuses it on
    // the `text` field's 1,000,000-character maximum (commands.ts:905).
    let oversized: unknown;
    try {
      f.send({
        type: "configuration-preview",
        path: read.path,
        expectedHash: read.hash,
        text: "{" + " ".repeat(1_000_000) + "}",
      });
    } catch (error) {
      oversized = error;
    }
    expect(oversized).toBeInstanceOf(z.ZodError);
    expect((oversized as z.ZodError).issues).toEqual([
      expect.objectContaining({
        code: "too_big",
        path: ["text"],
        maximum: 1_000_000,
      }),
    ]);
    // An unread path is refused by the service as well.
    await expect(
      f.send({
        type: "configuration-preview",
        path: path.join(folder, "settings.local.json"),
        expectedHash: hash(""),
        text: "{}",
      }),
    ).rejects.toThrow("Read this provider configuration through Topsl first.");
    expect(f.holder.service.store.list("configuration-plan")).toEqual([]);
    expect(f.holder.service.store.list("configuration-write")).toEqual([]);
    expect(await readFile(file, "utf8")).toBe('{"kept":true}');
    expect(await readdir(folder)).toEqual(["settings.json"]);
    // Negative control: the same path, hash and command accept a JSON object
    // and record exactly one plan, so the refusals above were not caused by a
    // stale hash, an unread path or a store that cannot record plans.
    const accepted = await preview('{"kept":false}');
    expect(accepted).toMatchObject({
      path: read.path,
      before: '{"kept":true}',
      after: '{"kept":false}',
    });
    expect(
      f.holder.service.store
        .list<ConfigurationPlan>("configuration-plan")
        .map((p) => p.id),
    ).toEqual([accepted.id]);
    expect(f.holder.service.store.list("configuration-write")).toEqual([]);
    expect(await readFile(file, "utf8")).toBe('{"kept":true}');
  });

  test("comments, formatting and unknown fields the owner left unchanged are written byte for byte", async () => {
    const f = await unit();
    const toml = path.join(f.project, ".codex", "config.toml");
    const tomlBefore =
      '# top comment\nmodel = "a" # trailing comment\n\n[profiles.unknown]\nfuture_key = [1, 2]\n';
    await writeFile(toml, tomlBefore);
    const json = path.join(f.project, ".claude", "settings.json");
    const jsonBefore =
      '{\n    "zeta": 1,\n    "permissions": {"allow": []},\n    "unknownFutureField": {"nested": [true]}\n}\n';
    await writeFile(json, jsonBefore);
    for (const [provider, file, before, after] of [
      ["codex", toml, tomlBefore, tomlBefore.replace('"a"', '"b"')],
      [
        "claude",
        json,
        jsonBefore,
        jsonBefore.replace('"allow": []', '"allow": ["Read"]'),
      ],
    ] as const) {
      const read = await f.config.read(provider, f.p, "native");
      expect(read.text).toBe(before);
      const plan = await f.config.preview(read.path, read.hash, after);
      await f.config.apply(plan.id, plan.digest);
      const written = await readFile(file, "utf8");
      expect(written).toBe(after);
      // Negative control: a normalizing writer would have changed these bytes.
      if (provider === "claude")
        expect(written).not.toBe(JSON.stringify(JSON.parse(after)));
      else expect(written).toContain("# trailing comment");
    }
  });
});

describe("CONF-03 external change, parent change and symlink replacement", () => {
  test("a change after read invalidates the preview; a change after preview invalidates the apply", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    await writeFile(file, "one\n");
    const read = await f.send({
      type: "configuration-read",
      provider: "codex",
      projectId: "p",
      kind: "instructions",
    });
    await writeFile(file, "external after read\n");
    await expect(
      f.send({
        type: "configuration-preview",
        path: read.path,
        expectedHash: read.hash,
        text: "mine\n",
      }),
    ).rejects.toThrow("changed externally");
    expect(f.holder.service.store.list("configuration-plan")).toEqual([]);
    const { plan } = await f.edit("codex", "p", "instructions", "mine\n");
    await writeFile(file, "external after preview\n");
    await expect(f.apply(plan.id)).rejects.toThrow("changed after approval");
    expect(await readFile(file, "utf8")).toBe("external after preview\n");
    // Rejected before durable intent: no backup and no write record.
    expect(f.write(plan.id)).toBeUndefined();
    expect(
      f.holder.service.store.get("configuration-backup", plan.id),
    ).toBeUndefined();
  });

  test("an external writer during apply, after the staged file exists, keeps its bytes and no staged file remains", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "CLAUDE.md");
    await writeFile(file, "before\n");
    const { plan } = await f.edit("claude", "p", "instructions", "mine\n");
    const store = f.holder.service.store;
    const immutable = store.immutable.bind(store);
    // Inject the external edit inside apply, after its first content check.
    vi.spyOn(store, "immutable").mockImplementation((kind, value) => {
      immutable(kind, value);
      if (kind === "configuration-backup")
        writeFileSync(file, "external during apply\n");
    });
    await expect(f.apply(plan.id)).rejects.toThrow("external writer");
    expect(await readFile(file, "utf8")).toBe("external during apply\n");
    expect(await stray(f.project)).toEqual([]);
    // Reconciled conservatively: never reported as written.
    expect(f.write(plan.id)?.state).toBe("uncertain");
  });

  test("a configuration folder replaced by a symlink after preview is not followed", async () => {
    const f = await serviceFixture();
    const folder = path.join(f.project, ".claude");
    await mkdir(folder);
    await writeFile(path.join(folder, "settings.json"), '{"a":1}');
    const { plan } = await f.edit("claude", "p", "native", '{"a":2}');
    await rename(folder, path.join(f.project, ".claude-moved"));
    await symlink(f.outside, folder, "dir");
    await expect(f.apply(plan.id)).rejects.toThrow("parent changed");
    await expect(stat(path.join(f.outside, "settings.json"))).rejects.toThrow();
    expect(
      await readFile(path.join(f.project, ".claude-moved", "settings.json"), "utf8"),
    ).toBe('{"a":1}');
    expect(await readdir(f.outside)).toEqual([]);
  });

  test("a configuration file that becomes a symlink is not replaced, and symlinked or escaping sources are not read", async () => {
    const f = await serviceFixture();
    const folder = path.join(f.project, ".claude");
    await mkdir(folder);
    const file = path.join(folder, "settings.json");
    await writeFile(file, '{"a":1}');
    const target = path.join(f.outside, "target.json");
    await writeFile(target, '{"outside":true}');
    const { plan } = await f.edit("claude", "p", "native", '{"a":2}');
    await rm(file);
    await symlink(target, file);
    await expect(f.apply(plan.id)).rejects.toThrow("became a symlink");
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe('{"outside":true}');
    // Reading a symlinked file is refused.
    await expect(
      f.send({
        type: "configuration-read",
        provider: "claude",
        projectId: "p",
        kind: "native",
      }),
    ).rejects.toThrow("does not replace symlinks");
    // A global configuration that is a symlink is refused the same way.
    await symlink(target, path.join(f.codexHome, "config.toml"));
    await expect(
      f.send({
        type: "configuration-read",
        provider: "codex",
        projectId: null,
        kind: "native",
      }),
    ).rejects.toThrow("does not replace symlinks");
    // A project configuration folder that escapes the project is refused.
    await symlink(f.outside, path.join(f.project, ".codex"), "dir");
    await expect(
      f.send({
        type: "configuration-read",
        provider: "codex",
        projectId: "p",
        kind: "native",
      }),
    ).rejects.toThrow("escapes the project");
    expect(await readdir(f.outside)).toEqual(["target.json"]);
  });
});

describe("CONF-04 native approval and active sessions", () => {
  test("missing, renderer-forged, wrong, foreign, tampered, expired and replayed approvals change no file", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    await writeFile(file, "original\n");
    const { plan } = await f.edit("codex", "p", "instructions", "approved\n");
    const unchanged = async () =>
      expect(await readFile(file, "utf8")).toBe("original\n");
    // No native approval at all.
    await expect(
      f.send({ type: "configuration-apply", id: plan.id }),
    ).rejects.toThrow("A native approval is required.");
    await unchanged();
    // Approval fields the window adds are stripped at the IPC boundary.
    await expect(
      f.send({
        type: "configuration-apply",
        id: plan.id,
        digest: plan.digest,
        trusted: { digest: plan.digest, approved: true },
      }),
    ).rejects.toThrow("A native approval is required.");
    await unchanged();
    // A digest that is not this plan's.
    await expect(
      f.apply(plan.id, { digest: hash("something else") }),
    ).rejects.toThrow("does not match this preview");
    await unchanged();
    // Another plan's genuine approval.
    const otherFile = path.join(f.project, "CLAUDE.md");
    const other = await f.edit("claude", "p", "instructions", "other\n");
    await expect(
      f.apply(plan.id, { digest: other.plan.digest }),
    ).rejects.toThrow("does not match this preview");
    await unchanged();
    // A stored plan altered after the owner approved its digest.
    const store = f.holder.service.store;
    store.put("configuration-plan", { ...plan, after: "tampered\n" });
    await expect(f.apply(plan.id, { digest: plan.digest })).rejects.toThrow(
      "does not match this preview",
    );
    await unchanged();
    store.put("configuration-plan", plan);
    expect(f.write(plan.id)).toBeUndefined();
    // Negative control: the genuine approval applies once, then replay is refused.
    expect(await f.apply(plan.id)).toEqual({ applied: true, loaded: false });
    expect(await readFile(file, "utf8")).toBe("approved\n");
    await expect(f.apply(plan.id)).rejects.toThrow("make a new preview");
    expect(await readFile(file, "utf8")).toBe("approved\n");
    // The other plan's own approval still works and touched only its file.
    expect(await f.apply(other.plan.id)).toEqual({
      applied: true,
      loaded: false,
    });
    expect(await readFile(otherFile, "utf8")).toBe("other\n");
  });

  test("an approval expires after exactly 15 minutes", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    await writeFile(file, "original\n");
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-19T10:00:00.000Z");
    vi.setSystemTime(start);
    const late = await f.edit("codex", "p", "instructions", "late\n");
    vi.setSystemTime(start + 15 * 60_000 + 1);
    await expect(f.apply(late.plan.id)).rejects.toThrow(
      "Configuration approval expired.",
    );
    expect(await readFile(file, "utf8")).toBe("original\n");
    // At exactly the boundary, a fresh preview still applies.
    const t1 = start + 60 * 60_000;
    vi.setSystemTime(t1);
    const onTime = await f.edit("codex", "p", "instructions", "on time\n");
    vi.setSystemTime(t1 + 15 * 60_000);
    expect(await f.apply(onTime.plan.id)).toEqual({
      applied: true,
      loaded: false,
    });
    expect(await readFile(file, "utf8")).toBe("on time\n");
  });

  test.skipIf(process.platform === "win32")(
    "an open native terminal blocks the write; after it closes the same approval applies",
    async () => {
      const f = await serviceFixture();
      const wrapper = path.join(f.directory, "terminal-stand-in");
      await writeFile(
        wrapper,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/terminal-stand-in.cjs"))} "$@"\n`,
      );
      await chmod(wrapper, 0o700);
      const installation: Installation = {
        ...f.installation,
        path: wrapper,
        ...(await identity(wrapper)),
        id: "codex",
      };
      f.holder.service.store.put("installation", installation);
      const file = path.join(f.project, "AGENTS.md");
      await writeFile(file, "original\n");
      const { plan } = await f.edit("codex", "p", "instructions", "after\n");
      const terminal: string = await f.send({
        type: "terminal-open",
        projectId: "p",
        installationId: "codex",
        login: false,
        permissionMode: "read-only",
      });
      expect(f.holder.service.runtime.hasActive()).toBe(true);
      await expect(f.apply(plan.id)).rejects.toThrow(
        "Close active native sessions before changing configuration.",
      );
      expect(await readFile(file, "utf8")).toBe("original\n");
      expect(f.write(plan.id)).toBeUndefined();
      await f.send({ type: "terminal-close", id: terminal });
      await vi.waitFor(
        () => expect(f.holder.service.runtime.hasActive()).toBe(false),
        { timeout: 10_000 },
      );
      expect(await f.apply(plan.id)).toEqual({ applied: true, loaded: false });
      expect(await readFile(file, "utf8")).toBe("after\n");
    },
  );
});

describe("CONF-05 encrypted backup, atomic replacement and crash reconciliation", () => {
  test("success keeps an encrypted backup of the exact prior bytes and leaves no staged file", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    const prior = "CANARY_PRIOR_CONFIGURATION_7f3a91\n";
    await writeFile(file, prior);
    const { plan } = await f.edit("codex", "p", "instructions", "replaced\n");
    await f.apply(plan.id);
    expect(await readFile(file, "utf8")).toBe("replaced\n");
    expect(
      f.holder.service.store.get<{ content: string; path: string }>(
        "configuration-backup",
        plan.id,
      ),
    ).toMatchObject({ content: prior, path: file });
    expect(await stray(f.project)).toEqual([]);
    await f.holder.service.close();
    // The backup lives only in the encrypted vault: no plaintext on disk.
    for (const name of await readdir(f.directory))
      if (name.startsWith("history.sqlite"))
        expect(
          (await readFile(path.join(f.directory, name))).includes(
            Buffer.from("CANARY_PRIOR_CONFIGURATION"),
          ),
          name,
        ).toBe(false);
    // Reopened with the key, the backup is intact.
    const service = await f.restart();
    expect(
      service.store.get<{ content: string }>("configuration-backup", plan.id)
        ?.content,
    ).toBe(prior);
  });

  /** Runs apply with an injected crash and no in-process reconcile, then restarts from disk. */
  async function crash(
    f: Awaited<ReturnType<typeof serviceFixture>>,
    planId: string,
    at: "after-intent" | "after-replacement",
  ) {
    const service = f.holder.service,
      store = service.store;
    vi.spyOn(service.configuration, "reconcile").mockResolvedValue(undefined);
    if (at === "after-intent") {
      const transaction = store.transaction.bind(store);
      let depth = 0,
        armed = true;
      vi.spyOn(store, "transaction").mockImplementation(((fn: () => unknown) => {
        depth++;
        let result: unknown;
        try {
          result = transaction(fn);
        } finally {
          depth--;
        }
        if (
          armed &&
          depth === 0 &&
          store.get<{ state: string }>("configuration-write", planId)?.state ===
            "applying"
        ) {
          armed = false;
          throw new Error("simulated crash after durable intent");
        }
        return result;
      }) as typeof store.transaction);
    } else {
      const save = store.save.bind(store);
      vi.spyOn(store, "save").mockImplementation(((
        kind: string,
        value: any,
        event?: string,
      ) => {
        if (kind === "configuration-write" && value.state === "written-unverified")
          throw new Error("simulated crash after replacement");
        return save(kind, value, event);
      }) as typeof store.save);
    }
    await expect(f.apply(planId)).rejects.toThrow("simulated crash");
    expect(f.write(planId)?.state).toBe("applying");
    vi.restoreAllMocks();
  }

  test("a crash after durable intent and before replacement reconciles as not applied on restart, without replay", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    await writeFile(file, "before\n");
    const { plan } = await f.edit("codex", "p", "instructions", "after\n");
    await crash(f, plan.id, "after-intent");
    expect(await readFile(file, "utf8")).toBe("before\n");
    const mtime = (await stat(file)).mtimeMs;
    const service = await f.restart();
    expect(f.write(plan.id)?.state).toBe("not-applied");
    expect(await readFile(file, "utf8")).toBe("before\n");
    expect((await stat(file)).mtimeMs).toBe(mtime);
    // The interrupted plan is never applied blindly after the restart.
    await expect(f.apply(plan.id)).rejects.toThrow("make a new preview");
    expect(await readFile(file, "utf8")).toBe("before\n");
    expect(
      service.state().configurationWrites.map((w: any) => w.state),
    ).toEqual(["not-applied"]);
  });

  test("a crash after replacement reconciles as written-unverified on restart, and is not written again", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    await writeFile(file, "before\n");
    const { plan } = await f.edit("codex", "p", "instructions", "after\n");
    await crash(f, plan.id, "after-replacement");
    expect(await readFile(file, "utf8")).toBe("after\n");
    const mtime = (await stat(file)).mtimeMs;
    await f.restart();
    expect(f.write(plan.id)?.state).toBe("written-unverified");
    expect((await stat(file)).mtimeMs).toBe(mtime);
    await expect(f.apply(plan.id)).rejects.toThrow("make a new preview");
  });

  test("an interrupted write whose file then changed elsewhere reconciles as uncertain", async () => {
    const f = await serviceFixture();
    const file = path.join(f.project, "AGENTS.md");
    await writeFile(file, "before\n");
    const { plan } = await f.edit("codex", "p", "instructions", "after\n");
    await crash(f, plan.id, "after-intent");
    await writeFile(file, "third party\n");
    await f.restart();
    expect(f.write(plan.id)?.state).toBe("uncertain");
    expect(await readFile(file, "utf8")).toBe("third party\n");
  });
});

describe("CONF-11 transcript-read setting takes effect immediately", () => {
  test("turning the transcript read off refuses the next transcript hand-back, and turning it on needs Topsl's dialog", async () => {
    const f = await serviceFixture();
    const handBack = () =>
      f.send({
        type: "claude-step-return",
        projectId: "p",
        workflowId: "no-workflow",
        stepId: "no-step",
        source: "claude-transcript",
        claudeCodeStopped: true,
      });
    const gate =
      "Turn on reading Claude Code's transcripts in Settings, or paste Claude's final reply.";
    await expect(handBack()).rejects.toThrow(gate);
    // The window cannot turn it on, even with a forged confirmation field.
    await expect(
      f.send({
        type: "claude-transcript-read-set",
        enabled: true,
        confirmedTranscriptRead: true,
      }),
    ).rejects.toThrow("needs your confirmation in Topsl's own dialog");
    await f.send(
      { type: "claude-transcript-read-set", enabled: true },
      { confirmedTranscriptRead: true },
    );
    // On: the gate passes and the request fails later, on the unknown workflow.
    const on = await handBack().then(
      () => null,
      (error: Error) => error.message,
    );
    expect(on).not.toBeNull();
    expect(on).not.toBe(gate);
    await f.send({ type: "claude-transcript-read-set", enabled: false });
    await expect(handBack()).rejects.toThrow(gate);
    expect(f.holder.service.state().claudeTranscriptRead).toBe(false);
    expect(
      f.holder.service.store.db
        .prepare(
          "SELECT body, created_at FROM events WHERE kind = 'claude-transcript-read.set' ORDER BY rowid",
        )
        .all()
        .map((row: any) => [JSON.parse(row.body).enabled, !!row.created_at]),
    ).toEqual([
      [true, true],
      [false, true],
    ]);
    // The decision survives an encrypted restart.
    const service = await f.restart();
    expect(service.state().claudeTranscriptRead).toBe(false);
  });

  test("the structured route's decision time is kept, and turning it off is persisted across restart", async () => {
    const f = await serviceFixture();
    // Only Date is faked, so the service's own timers and I/O run normally.
    // Each decision is made at a distinct, known instant, so a reused (stale)
    // decision time cannot satisfy the exact assertions below.
    const onAt = "2026-10-19T08:00:00.000Z",
      offAt = "2026-10-19T09:30:00.000Z",
      restartAt = "2026-10-19T11:45:00.000Z";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(onAt));
    const on = await f.send(
      { type: "claude-structured-route-set", enabled: true },
      { confirmedClaudeRoute: true },
    );
    expect(on).toEqual({ enabled: true, decidedAt: onAt });
    vi.setSystemTime(new Date(offAt));
    const off = await f.send({
      type: "claude-structured-route-set",
      enabled: false,
    });
    expect(off).toEqual({ enabled: false, decidedAt: offAt });
    expect(Date.parse(off.decidedAt)).toBeGreaterThan(Date.parse(on.decidedAt));
    // The durable preference row holds the latest decision and its own time.
    expect(
      f.holder.service.store.get("preference", claudeRoutePreferenceId),
    ).toMatchObject({ value: false, decidedAt: offAt });
    // Historical provenance: each decision's event keeps its own time.
    const history = () =>
      f.holder.service.store.db
        .prepare(
          "SELECT body FROM events WHERE kind = 'claude-structured-route.set' ORDER BY rowid",
        )
        .all()
        .map((row: any) => JSON.parse(row.body));
    expect(history()).toEqual([
      { enabled: true, decidedAt: onAt },
      { enabled: false, decidedAt: offAt },
    ]);
    // A restart later neither re-stamps the decision nor loses it.
    vi.setSystemTime(new Date(restartAt));
    const service = await f.restart();
    expect(service.state().claudeStructuredRoute).toEqual({
      enabled: false,
      decidedAt: offAt,
    });
    expect(service.runtime.claudeRoute()).toEqual({
      enabled: false,
      decidedAt: offAt,
    });
    expect(history()).toEqual([
      { enabled: true, decidedAt: onAt },
      { enabled: false, decidedAt: offAt },
    ]);
  });
});

describe("USAGE-02 known quantities across providers, cached input and estimates", () => {
  const fact = (overrides: Partial<UsageFact> = {}): UsageFact => ({
    id: "f",
    runId: "codex-run",
    provider: "codex",
    input: 100,
    output: 10,
    cached: 40,
    source: "native-runtime",
    scope: "turn-1",
    semantics: "cumulative",
    scopeLevel: "turn",
    cachedIncludedInInput: true,
    ...overrides,
  });
  test("mixed providers sum their own known tokens once; cached-included input is not added again", () => {
    const summary = summarizeUsage(
      [
        fact(),
        fact({
          id: "c",
          runId: "claude-run",
          provider: "claude",
          input: 7,
          output: 3,
          cached: 5,
          cachedIncludedInInput: false,
          scope: "turn-a",
        }),
      ],
      ["codex-run", "claude-run"],
    );
    expect(summary).toMatchObject({
      // 100 (cached included) + 7 + 5 (cached excluded, added once)
      input: 112,
      output: 13,
      cached: 45,
      complete: true,
    });
  });
  test("an absent cached value leaves cached unknown, and keeps input unknown only when it is excluded from input", () => {
    const included = summarizeUsage([fact({ cached: null })], ["codex-run"]);
    expect(included).toMatchObject({ input: 100, cached: null, complete: true });
    const excluded = summarizeUsage(
      [fact({ cached: null, cachedIncludedInInput: false })],
      ["codex-run"],
    );
    expect(excluded).toMatchObject({ input: null, complete: false });
    expect(excluded.knownInput).toBe(0);
  });
  test("imported and API estimates never enter native reported totals", () => {
    const summary = summarizeUsage(
      [
        fact(),
        fact({
          id: "e",
          runId: "imported",
          source: "imported-estimate",
          input: 9_000,
          output: 9_000,
        }),
      ],
      ["codex-run", "imported"],
    );
    expect(summary.knownInput).toBe(100);
    expect(summary.knownOutput).toBe(10);
    expect(summary.coveredRuns).toBe(1);
    expect(summary.complete).toBe(false);
    expect(summary.notes.join(" ")).toContain("estimates are excluded");
  });
});

describe("USAGE-06 allowance freshness boundaries and clock changes", () => {
  const observedAt = "2026-10-19T10:00:00.000Z",
    at = Date.parse(observedAt);
  const observed = (resetsAtSeconds: number | null): ObservedWindow => ({
    usedPercent: 40,
    windowMinutes: 300,
    resetsAtSeconds,
    observedAt,
    source: "read",
  });
  test("exactly 15 minutes is current, one millisecond later is stale", () => {
    expect(ALLOWANCE_STALE_AFTER_MS).toBe(15 * 60_000);
    const window = observed(at / 1000 + 3 * 3600);
    expect(windowView(window, "Primary", at + 15 * 60_000).freshness).toBe(
      "fresh",
    );
    expect(windowView(window, "Primary", at + 15 * 60_000 + 1).freshness).toBe(
      "stale",
    );
  });
  test("a reset one millisecond away keeps the reported share; at the reset second it becomes reset-since", () => {
    const reset = at + 10 * 60_000;
    const window = observed(reset / 1000);
    expect(windowView(window, "Primary", reset - 1).freshness).toBe("fresh");
    const after = windowView(window, "Primary", reset);
    expect(after.freshness).toBe("reset-since");
    // The reported share is kept as reported; it is not replenished to 100%.
    expect(after.usedPercent).toBe(40);
  });
  test("a clock moved back keeps an observation current until its reported reset; moved past the reset it is reset-since, not stale or current", () => {
    const reset = at + 60_000;
    const window = observed(reset / 1000);
    // Clock moved back: observation appears to be in the future.
    expect(windowView(window, "Primary", at - 3_600_000).freshness).toBe(
      "fresh",
    );
    // Clock moved forward past the reset: reset-since wins over stale.
    expect(windowView(window, "Primary", at + 86_400_000).freshness).toBe(
      "reset-since",
    );
  });
  test("the card shows a reset window as unknown, never as replenished, and the badge is not current", () => {
    const snapshot: AllowanceSnapshot = applyAllowanceReport(
      undefined,
      {
        provider: "codex",
        accountKey: "account-hash",
        installationId: "i",
        runtimeVersion: "0.163.0",
        interface: "account/rateLimits/read",
      },
      {
        kind: "read",
        ordinaryUsageAllowed: true,
        buckets: [
          {
            id: "codex",
            name: null,
            primary: {
              usedPercent: 90,
              windowMinutes: 300,
              resetsAtSeconds: Math.floor(Date.now() / 1000) - 60,
            },
            secondary: null,
            credits: null,
            planType: null,
            limitReached: null,
          },
        ],
      },
      new Date(Date.now() - 2 * 3_600_000).toISOString(),
    );
    expect(allowanceStatus("codex", [snapshot], Date.now()).label).toBe(
      "Reported · stale",
    );
    const html = renderToStaticMarkup(
      createElement(ProviderUsage, {
        state: {
          projects: [],
          installations: [],
          allowances: [snapshot],
          providerBudgets: [],
        } as unknown as AppState,
      }),
    );
    expect(html).toContain(
      "Unknown · this window reset after Topsl observed it",
    );
    expect(html).not.toContain("100% left");
    expect(html).not.toContain("10% left");
  });
});

describe.skipIf(process.platform === "win32")(
  "USAGE-08 Claude display with a login prompt",
  () => {
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const prompt =
      "\x1b[1mSelect login method:\x1b[0m\r\n\u276f 1. Claude account with subscription\r\n  2. Anthropic Console account\r\nOAuth token: sk-ant-oat01-private-credential-must-not-leak\r\nPaste code here if prompted >";
    /**
     * A real PTY stand-in: an executable shell wrapper that runs Node in the
     * pseudo-terminal node-pty opens, prints a login screen, records its pid,
     * puts its terminal in raw mode and appends every byte it receives on
     * stdin to `stdin`. Nothing is answered for it; it never exits by itself.
     */
    async function standIn() {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "topsl-usage-08-"),
      );
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const script = path.join(directory, "login-prompt.cjs"),
        executable = path.join(directory, "claude");
      await writeFile(
        script,
        [
          'const fs = require("node:fs");',
          `const dir = ${JSON.stringify(directory)};`,
          'fs.writeFileSync(dir + "/stdin", "");',
          "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
          'process.stdin.on("data", (b) => fs.appendFileSync(dir + "/stdin", b));',
          'fs.writeFileSync(dir + "/args.json", JSON.stringify(process.argv.slice(2)));',
          `process.stdout.write(${JSON.stringify(prompt)});`,
          'fs.writeFileSync(dir + "/pid", String(process.pid));',
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );
      await writeFile(
        executable,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(script)} "$@"\n`,
      );
      await chmod(executable, 0o700);
      const opened: IPty[] = [];
      const written: string[] = [];
      let subscriptions = 0;
      const output: string[] = [];
      // The real node-pty spawn. The wrapper only observes: it records what
      // the reader writes and how many of its subscriptions stay attached.
      const spawn = ((...args: Parameters<typeof realPtySpawn>) => {
        const terminal = realPtySpawn(...args);
        opened.push(terminal);
        terminal.onData((chunk) => output.push(chunk));
        // node-pty exposes onData/onExit as prototype getters, so the
        // observers are defined on this instance rather than assigned. It also
        // replaces `write` with a no-op when the terminal closes
        // (node-pty/lib/terminal.js:171); the accessor keeps recording any
        // write, including one made after that.
        let inner: (data: string | Buffer) => void =
          terminal.write.bind(terminal);
        const recordingWrite = (data: string | Buffer) => {
          written.push(String(data));
          inner(data);
        };
        Object.defineProperty(terminal, "write", {
          configurable: true,
          get: () => recordingWrite,
          set: (replacement: (data: string | Buffer) => void) => {
            inner = replacement;
          },
        });
        for (const name of ["onData", "onExit"] as const) {
          const original = terminal[name];
          Object.defineProperty(terminal, name, {
            value: (listener: any) => {
              subscriptions++;
              const handle = (original as any)(listener);
              return {
                dispose: () => {
                  subscriptions--;
                  handle.dispose();
                },
              };
            },
          });
        }
        return terminal;
      }) as typeof ptySpawn;
      const pid = async () => {
        await expect
          .poll(() =>
            readFile(path.join(directory, "pid"), "utf8").then(
              () => true,
              () => false,
            ),
            // Starting Node in a PTY can take seconds on a loaded host.
            { timeout: 10_000 },
          )
          .toBe(true);
        return Number(await readFile(path.join(directory, "pid"), "utf8"));
      };
      const alive = (id: number) => {
        try {
          process.kill(id, 0);
          return true;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
      };
      const received = () => readFile(path.join(directory, "stdin"), "utf8");
      return {
        directory,
        executable,
        spawn,
        opened,
        written,
        output,
        subscriptions: () => subscriptions,
        pid,
        alive,
        received,
      };
    }
    const timeoutReason =
      "Claude did not return a supported /usage display. Run /usage in Claude Code to check sign-in, folder trust and runtime compatibility.";

    test("a sign-in prompt is never answered: the read times out with a sign-in hint and closes the terminal", async () => {
      const s = await standIn();
      const reading = readClaudeUsage(
        s.executable,
        s.directory,
        new AbortController().signal,
        { spawn: s.spawn, timeoutMs: 12_000 },
      );
      const outcome = reading.then(
        () => null,
        (error: Error) => error,
      );
      // Preconditions: the stand-in really runs in the PTY node-pty opened,
      // is alive while the reader waits, and its login screen reached the
      // reader (so the outcome below is not a start failure).
      const pid = await s.pid();
      expect(s.opened).toHaveLength(1);
      expect(s.opened[0].pid).toBe(pid);
      expect(s.alive(pid)).toBe(true);
      await expect
        .poll(() => s.output.join(""), { timeout: 10_000 })
        .toContain("Paste code here if prompted >");
      const args = JSON.parse(
        await readFile(path.join(s.directory, "args.json"), "utf8"),
      );
      expect(args).toContain("--safe-mode");
      expect(args.at(-1)).toBe("/usage");
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toBe(timeoutReason);
      expect(error!.message).not.toContain("sk-ant");
      // Authoritative observations: no byte ever reached the stand-in's
      // stdin, the reader never wrote to the terminal, the stand-in process
      // is gone, and every subscription the reader made was disposed.
      expect(await s.received()).toBe("");
      expect(s.written).toEqual([]);
      expect(s.alive(pid)).toBe(false);
      expect(s.subscriptions()).toBe(0);
    }, 40_000);

    test("control: the same stand-in records any byte written to its terminal, and stays alive until it is closed", async () => {
      const s = await standIn();
      const reading = readClaudeUsage(
        s.executable,
        s.directory,
        new AbortController().signal,
        { spawn: s.spawn, timeoutMs: 12_000 },
      );
      const outcome = reading.then(
        () => null,
        (error: Error) => error,
      );
      const pid = await s.pid();
      await expect
        .poll(() => s.output.join(""), { timeout: 10_000 })
        .toContain("Paste code here if prompted >");
      // An answer written to the real PTY reaches the stand-in's stdin, so
      // the empty-stdin assertion above can detect an answered prompt.
      s.opened[0].write("1\r");
      await expect.poll(() => s.received()).toBe("1\r");
      expect(s.alive(pid)).toBe(true);
      const error = await outcome;
      expect(error?.message).toBe(timeoutReason);
      expect(s.alive(pid)).toBe(false);
    }, 40_000);
  },
);

describe.skipIf(process.platform === "win32")(
  "USAGE-09 Claude profile identity during a usage read",
  () => {
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    async function setup(changeProfile: boolean) {
      const f = await fixture();
      vi.stubEnv("CLAUDE_CONFIG_DIR", f.directory);
      await writeFile(path.join(f.directory, "usage-fixture"), "");
      if (changeProfile)
        await writeFile(path.join(f.directory, "change-profile"), "");
      // Same account (email and organization), but a different profile folder
      // is reported by `auth status` once the /usage display has run.
      await writeFile(
        f.installation.path,
        [
          "#!/bin/sh",
          'if [ "$1 $2 $3" = "auth status --json" ] && [ -f "$CLAUDE_CONFIG_DIR/profile-changed" ]; then',
          `  echo '{"loggedIn":true,"authMethod":"claude.ai","email":"private@example.test","orgId":"private-organization","configDirectory":"/elsewhere/claude-profile","subscriptionType":"max"}'`,
          "  exit 0",
          "fi",
          'case "$*" in *"/usage") [ -f "$CLAUDE_CONFIG_DIR/change-profile" ] && : > "$CLAUDE_CONFIG_DIR/profile-changed";; esac',
          `ELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(path.resolve("tests/fixtures/claude-usage.cjs"))} "$@"`,
          "",
        ].join("\n"),
      );
      await chmod(f.installation.path, 0o700);
      const installation = {
        ...f.installation,
        ...(await identity(f.installation.path)),
        appId: "anthropic.claude-code-cli" as const,
        version: "2.1.302",
        compatibility: "native-only" as const,
      };
      f.store.put("installation", installation);
      f.store.put("project", {
        id: "project",
        name: "fixture",
        path: f.directory,
        realPath: f.directory,
        trusted: true,
      });
      const runtime = new RuntimeManager(
        f.store,
        () => {},
        () => {},
      );
      cleanup.push(async () => {
        await runtime.close();
        f.store.close();
        await rm(f.directory, { recursive: true, force: true });
      });
      return { ...f, installation, runtime };
    }
    /** Allowance rows read through a second, independent connection to the
     * same encrypted store file after the runtime has finished its writes. */
    async function durableAllowances(f: Awaited<ReturnType<typeof setup>>) {
      await f.runtime.close();
      const second = new Store(path.join(f.directory, "history.sqlite"), f.key);
      try {
        return second.list<AllowanceSnapshot>("allowance-snapshot");
      } finally {
        second.close();
      }
    }
    test("a profile that changes during the read is rejected; an unchanged one is stored", async () => {
      const changed = await setup(true);
      const snapshot = (await changed.runtime.refreshAllowance(
        changed.installation,
      )) as AllowanceSnapshot;
      expect(snapshot.buckets).toEqual([]);
      expect(snapshot.lastError?.detail).toContain("account changed");
      expect(changed.store.list("run")).toHaveLength(0);
      expect(changed.store.list("usage")).toHaveLength(0);
      // The stand-in really reached the /usage display (so the rejection is
      // the identity guard at manager.ts:325-332, not a failed start).
      expect(
        await readFile(path.join(changed.directory, "usage-starts"), "utf8"),
      ).toBe("start\n");
      expect(
        await readFile(path.join(changed.directory, "profile-changed"), "utf8"),
      ).toBe("");
      // At the store: the only allowance row is a failure record that holds
      // no reading at all; the mismatched 13/51/0 display was not persisted.
      const rejected = await durableAllowances(changed);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        provider: "claude",
        readAt: null,
        buckets: [],
        lastError: {
          detail:
            "The Claude account changed during the usage read. Refresh again for the current account.",
        },
      });
      expect(JSON.stringify(rejected[0])).not.toContain("usedPercent");
      // Negative control: the same stand-in without the profile change.
      const same = await setup(false);
      const good = (await same.runtime.refreshAllowance(
        same.installation,
      )) as AllowanceSnapshot;
      expect(good.lastError).toBeNull();
      expect(good.buckets.map((b) => b.primary?.usedPercent)).toEqual([
        13, 51, 0,
      ]);
      // ...and its matching reading is persisted at the store.
      const stored = await durableAllowances(same);
      expect(stored).toHaveLength(1);
      expect(stored[0].lastError).toBeNull();
      expect(stored[0].readAt).toBe(good.readAt);
      expect(typeof stored[0].readAt).toBe("string");
      expect(stored[0].buckets.map((b) => b.primary?.usedPercent)).toEqual([
        13, 51, 0,
      ]);
    });
  },
);

describe("USAGE-11 owner budget periods across time zones and month lengths", () => {
  const original = process.env.TZ;
  const inZone = <T>(zone: string, body: () => T): T => {
    process.env.TZ = zone;
    try {
      return body();
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  };
  test("days and Monday weeks start at local midnight on both sides of daylight-saving changes", () =>
    inZone("America/New_York", () => {
      // The host must honour TZ changes, or this test is not meaningful.
      expect(new Date(2026, 9, 31, 12).getTimezoneOffset()).toBe(240);
      expect(new Date(2026, 10, 2, 12).getTimezoneOffset()).toBe(300);
      const iso = (period: "day" | "week" | "month", d: Date) =>
        budgetPeriodStart(period, d).toISOString();
      // DST ends Sunday 1 November 2026 at 02:00.
      expect(iso("day", new Date(2026, 10, 1, 12))).toBe(
        "2026-11-01T04:00:00.000Z",
      );
      expect(iso("week", new Date(2026, 10, 1, 23, 59, 59, 999))).toBe(
        "2026-10-26T04:00:00.000Z",
      );
      expect(iso("week", new Date(2026, 10, 2, 0, 0, 0, 0))).toBe(
        "2026-11-02T05:00:00.000Z",
      );
      expect(iso("week", new Date(2026, 10, 4, 15))).toBe(
        "2026-11-02T05:00:00.000Z",
      );
      // DST starts Sunday 14 March 2027 at 02:00.
      expect(iso("week", new Date(2027, 2, 14, 12))).toBe(
        "2027-03-08T05:00:00.000Z",
      );
      expect(iso("week", new Date(2027, 2, 17, 12))).toBe(
        "2027-03-15T04:00:00.000Z",
      );
      expect(iso("day", new Date(2027, 2, 14, 3, 30))).toBe(
        "2027-03-14T05:00:00.000Z",
      );
    }));
  test("months start on the first whatever their length, including 29 February", () =>
    inZone("UTC", () => {
      const iso = (d: Date) => budgetPeriodStart("month", d).toISOString();
      expect(iso(new Date(2028, 1, 29, 23, 59))).toBe("2028-02-01T00:00:00.000Z");
      expect(iso(new Date(2027, 1, 28, 23, 59))).toBe("2027-02-01T00:00:00.000Z");
      expect(iso(new Date(2026, 0, 31, 23, 59, 59, 999))).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expect(iso(new Date(2026, 1, 1, 0, 0))).toBe("2026-02-01T00:00:00.000Z");
      expect(iso(new Date(2026, 3, 30, 12))).toBe("2026-04-01T00:00:00.000Z");
    }));
  test("the same instant falls in a different week in another time zone, and a run at the exact start counts", () => {
    const instant = new Date("2026-10-19T02:00:00.000Z");
    expect(
      inZone("Asia/Shanghai", () =>
        budgetPeriodStart("week", instant).toISOString(),
      ),
    ).toBe("2026-10-18T16:00:00.000Z");
    expect(
      inZone("America/Los_Angeles", () =>
        budgetPeriodStart("week", instant).toISOString(),
      ),
    ).toBe("2026-10-12T07:00:00.000Z");
    inZone("UTC", () => {
      const budget: ProviderBudget = {
        id: "provider-budget:codex",
        provider: "codex",
        tokens: 100,
        period: "day",
        updatedAt: now(),
      };
      const at = new Date("2026-10-19T12:00:00.000Z");
      const run = (id: string, createdAt: string) =>
        ({ id, provider: "codex", mode: "edit", createdAt }) as Run;
      const use = (runId: string, input: number): UsageFact => ({
        id: runId,
        runId,
        provider: "codex",
        input,
        output: 0,
        cached: 0,
        source: "native-runtime",
        scope: "turn",
        semantics: "cumulative",
        scopeLevel: "turn",
        cachedIncludedInInput: true,
      });
      const status = providerBudgetStatus(
        budget,
        [
          run("at-start", "2026-10-19T00:00:00.000Z"),
          run("just-before", "2026-10-18T23:59:59.999Z"),
        ],
        [use("at-start", 150), use("just-before", 1_000)],
        at,
      );
      expect(status).toMatchObject({
        observedTokens: 150,
        remaining: -50,
        totalRuns: 1,
      });
      expect(budgetReadout(status)).toBe(
        "Owner-set budget: 100 tokens today. Topsl observed 150 known tokens · over by 50 tokens · 1 run reported usage.",
      );
    });
  });
  test("an over-budget period with a silent run is shown as over, and says more may be used", () => {
    const status = providerBudgetStatus(
      {
        id: "provider-budget:claude",
        provider: "claude",
        tokens: 10,
        period: "week",
        updatedAt: now(),
      },
      [
        { id: "a", provider: "claude", mode: "edit", createdAt: now() } as Run,
        { id: "b", provider: "claude", mode: "edit", createdAt: now() } as Run,
      ],
      [
        {
          id: "a",
          runId: "a",
          provider: "claude",
          input: 20,
          output: 0,
          cached: 0,
          source: "native-runtime",
          scope: "t",
          semantics: "cumulative",
          scopeLevel: "turn",
          cachedIncludedInInput: true,
        },
      ],
      new Date(),
    );
    expect(status.complete).toBe(false);
    expect(budgetReadout(status)).toContain("over by 10 tokens");
    expect(budgetReadout(status)).toContain(
      "1 of 2 runs reported no usage, so more may be used",
    );
  });
  test.each([
    [0, false],
    [-1, false],
    [1.5, false],
    [Number.NaN, false],
    [Number.POSITIVE_INFINITY, false],
    [1e12 + 1, false],
    ["100", false],
    [1, true],
    [1e12, true],
    [null, true],
  ])("provider-budget-save tokens %s accepted: %s", (tokens, accepted) => {
    expect(
      commandSchema.safeParse({
        type: "provider-budget-save",
        provider: "codex",
        tokens,
        period: "week",
      }).success,
    ).toBe(accepted);
  });
});

describe("USAGE-15 per-project reporting thresholds", () => {
  test("token and wall-time thresholds are saved, cleared and queried per project, survive restart and never become admission limits", async () => {
    const f = await serviceFixture();
    const query = (projectId: string) =>
      f.send({ type: "usage-budget-query", projectId });
    expect(await query("p")).toMatchObject({ tokens: null, wallMs: null });
    expect(
      await f.send({
        type: "usage-budget-save",
        projectId: "p",
        tokens: 1000,
        wallMs: null,
      }),
    ).toEqual({ tokens: 1000, wallMs: null });
    expect(await query("p")).toMatchObject({
      tokens: 1000,
      wallMs: null,
      observation: { projectId: "p" },
    });
    // The other project has none, and saving there does not touch p.
    expect(await query("q")).toMatchObject({ tokens: null, wallMs: null });
    await f.send({
      type: "usage-budget-save",
      projectId: "q",
      tokens: null,
      wallMs: 120_000,
    });
    expect(await query("q")).toMatchObject({ tokens: null, wallMs: 120_000 });
    expect(await query("p")).toMatchObject({ tokens: 1000, wallMs: null });
    // Wall time alone, then both cleared.
    await f.send({
      type: "usage-budget-save",
      projectId: "p",
      tokens: null,
      wallMs: 60_000,
    });
    expect(await query("p")).toMatchObject({ tokens: null, wallMs: 60_000 });
    await expect(
      f.send({ type: "usage-budget-query", projectId: "missing" }),
    ).rejects.toThrow();
    await expect(
      f.send({
        type: "usage-budget-save",
        projectId: "missing",
        tokens: 1,
        wallMs: 1,
      }),
    ).rejects.toThrow();
    // Numeric boundaries are refused at the IPC boundary.
    for (const [tokens, wallMs] of [
      [0, null],
      [null, 0],
      [-5, null],
      [1.5, null],
      [null, 2.5],
      [2 ** 53, null],
      ["10", null],
    ])
      expect(
        commandSchema.safeParse({
          type: "usage-budget-save",
          projectId: "p",
          tokens,
          wallMs,
        }).success,
        `${tokens} ${wallMs}`,
      ).toBe(false);
    expect(
      commandSchema.safeParse({
        type: "usage-budget-save",
        projectId: "p",
        tokens: 1,
        wallMs: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    // Separate records: no provider budget, and a threshold far exceeded by
    // usage is not something loop admission consults.
    const service = f.holder.service;
    await f.send({
      type: "usage-budget-save",
      projectId: "p",
      tokens: 10,
      wallMs: 1,
    });
    service.store.put("run", {
      id: "r",
      conversationId: "c",
      projectId: "p",
      provider: "codex",
      mode: "edit",
      status: "completed",
      createdAt: now(),
    });
    service.store.put("usage", {
      id: "r:t",
      runId: "r",
      provider: "codex",
      input: 5_000,
      output: 5_000,
      cached: 0,
      source: "native-runtime",
      scope: "t",
      projectId: "p",
      semantics: "cumulative",
      scopeLevel: "turn",
      cachedIncludedInInput: true,
    });
    expect(service.state().providerBudgets).toEqual([]);
    expect(service.store.list("provider-budget")).toEqual([]);
    expect((service as any).loopProviderLimits(["codex", "claude"])).toEqual(
      [],
    );
    // Persisted in the encrypted profile.
    await f.restart();
    expect(await query("p")).toMatchObject({ tokens: 10, wallMs: 1 });
    expect(await query("q")).toMatchObject({ tokens: null, wallMs: 120_000 });
  });

  test("budgetAlerts: equality reaches a threshold, null thresholds never alert, incomplete coverage says so", () => {
    const summary = (input: number, output: number, complete = true) => ({
      input: complete ? input : null,
      output: complete ? output : null,
      cached: null,
      knownInput: input,
      knownOutput: output,
      coveredRuns: 1,
      totalRuns: complete ? 1 : 2,
      complete,
      notes: [],
    });
    expect(budgetAlerts(summary(6, 4), 0, { tokens: 10 }).tokenAlert).toBe(true);
    expect(budgetAlerts(summary(6, 3), 0, { tokens: 10 }).tokenAlert).toBe(
      false,
    );
    expect(budgetAlerts(summary(0, 0), 500, { wallMs: 500 }).wallAlert).toBe(
      true,
    );
    expect(budgetAlerts(summary(0, 0), 499, { wallMs: 500 }).wallAlert).toBe(
      false,
    );
    expect(
      budgetAlerts(summary(1e9, 1e9), 1e9, { tokens: null, wallMs: null }),
    ).toMatchObject({ tokenAlert: false, wallAlert: false, approximate: true });
    expect(budgetAlerts(summary(1e9, 1e9), 1e9, {})).toMatchObject({
      tokenAlert: false,
      wallAlert: false,
    });
    expect(budgetAlerts(summary(1, 1), 0, {}).detail).toBe(
      "Approximate reporting thresholds; native billing remains authoritative.",
    );
    const incomplete = budgetAlerts(summary(3, 0, false), 0, { tokens: 10 });
    expect(incomplete.tokenAlert).toBe(false);
    expect(incomplete.detail).toContain("Unknown usage may exceed");
  });
});

// Keeps the os import meaningful for reviewers: these tests never use the home folder.
test("campaign fixtures never point at the owner's native homes", async () => {
  const f = await serviceFixture();
  expect(process.env.CODEX_HOME?.startsWith(f.directory)).toBe(true);
  expect(process.env.CLAUDE_CONFIG_DIR?.startsWith(f.directory)).toBe(true);
  expect(f.directory.startsWith(os.homedir() + path.sep + ".codex")).toBe(
    false,
  );
});
