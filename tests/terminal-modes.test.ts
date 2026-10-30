import path from "node:path";
import { chmod, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { Service } from "../apps/service/service";
import { identity } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import {
  bypassConfirmation,
  handoffTerminalMode,
  isBypassMode,
  terminalMode,
  terminalModeIds,
  terminalModes,
  type TerminalModeId,
} from "../packages/domain/terminal-modes";
import type {
  Installation,
  Provider,
  Run,
  ServiceEvent,
} from "../packages/domain/types";
import { captureCandidate } from "../packages/workflows/candidates";
import { AssistedWorkflows } from "../packages/workflows/assisted";
import { startingTerminalMode } from "../apps/desktop/renderer/components/terminal-mode";
import { fixture } from "./helpers";

/** The line in which the terminal stand-in reports the arguments it received. */
const argumentsLine = /Stand-in arguments: (\[[^\r\n]*\])\r*\n/;
const table = (provider: Provider) =>
  Object.fromEntries(
    terminalModes[provider].map((mode) => [mode.id, mode.args.join(" ")]),
  );

describe("terminal modes", () => {
  test("each mode passes exactly the arguments in the plan's tables", () => {
    expect(table("claude")).toEqual({
      "provider-default": "",
      manual: "--permission-mode default",
      plan: "--permission-mode plan",
      "accept-edits": "--permission-mode acceptEdits",
      sandboxed:
        '--permission-mode acceptEdits --settings {"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true,"allowUnsandboxedCommands":false,"failIfUnavailable":true,"network":{"strictAllowlist":true}}}',
      auto: "--permission-mode auto",
      "dont-ask": "--permission-mode dontAsk",
      bypass: "--permission-mode bypassPermissions",
    });
    expect(table("codex")).toEqual({
      "provider-default": "",
      "read-only": "-s read-only -a on-request",
      "workspace-on-request": "-s workspace-write -a on-request",
      "workspace-never": "-s workspace-write -a never",
      "workspace-auto-review": "--approve-for-me",
      "full-access": "--dangerously-bypass-approvals-and-sandbox",
    });
    expect(
      new Set([
        ...terminalModes.claude.map((m) => m.id),
        ...terminalModes.codex.map((m) => m.id),
      ]),
    ).toEqual(new Set(terminalModeIds));
  });
  test("an unknown mode, or another provider's mode, is refused", () => {
    expect(() => terminalMode("claude", "full-access")).toThrow(
      'Claude Code has no terminal mode "full-access" in Topsl.',
    );
    expect(() => terminalMode("codex", "plan")).toThrow(
      'Codex has no terminal mode "plan" in Topsl.',
    );
    expect(() => terminalMode("codex", "--yolo")).toThrow("no terminal mode");
  });
  test("only Bypass and Full access bypass checks, and a handoff never uses either", () => {
    expect(terminalModeIds.filter(isBypassMode)).toEqual([
      "bypass",
      "full-access",
    ]);
    expect(handoffTerminalMode("claude", "reviewer")).toBe("plan");
    expect(handoffTerminalMode("claude", "builder")).toBe("provider-default");
    expect(handoffTerminalMode("codex", "reviewer")).toBe("provider-default");
    expect(handoffTerminalMode("codex", "builder")).toBe("provider-default");
  });
  test("the confirmation names the executable, the folder, the exact flag and the provider's warning", () => {
    const text = bypassConfirmation(
      "codex",
      terminalMode("codex", "full-access"),
      "/bin/codex",
      "/work/project",
    );
    expect(text.message).toBe("Start Codex with no approvals and no sandbox?");
    expect(text.detail).toContain(
      "Executable: /bin/codex\nFolder: /work/project\nTopsl passes: --dangerously-bypass-approvals-and-sandbox",
    );
    expect(text.detail).toContain("EXTREMELY DANGEROUS");
    expect(text.detail).toContain("does not remember this mode");
    expect(text.affirmative).toBe("Start in Full access");
    expect(() =>
      bypassConfirmation("claude", terminalMode("claude", "plan"), "", ""),
    ).toThrow("not a bypass mode");
  });
  test("no other source file can produce a bypass flag", async () => {
    const found: string[] = [];
    async function walk(directory: string) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        // Test scripts may name the flags in their assertions.
        else if (
          /\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) &&
          !entry.name.includes("test")
        ) {
          const text = await readFile(file, "utf8");
          if (
            /bypassPermissions|dangerously-bypass-approvals-and-sandbox|dangerously-skip-permissions/.test(
              text,
            )
          )
            found.push(path.relative(process.cwd(), file));
        }
      }
    }
    for (const root of ["apps", "packages", "scripts"]) await walk(root);
    expect(found).toEqual([
      path.join("packages", "domain", "terminal-modes.ts"),
    ]);
  });
});

const services: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const f of services.splice(0)) {
    await f.service.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
/** A service with a Claude Code and a Codex installation that are both the terminal stand-in. */
async function setup() {
  const f = await fixture();
  f.store.close();
  const output = new Map<string, string>();
  const service = new Service(
    f.directory,
    f.key,
    (event: ServiceEvent) => {
      if (event.type === "terminal")
        output.set(
          event.data.id,
          (output.get(event.data.id) ?? "") + event.data.data,
        );
    },
    true,
  );
  services.push({ service, directory: f.directory });
  const wrapper = path.join(f.directory, "terminal-stand-in");
  await writeFile(
    wrapper,
    `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/terminal-stand-in.cjs"))} "$@"\n`,
  );
  await chmod(wrapper, 0o700);
  const executable = { path: wrapper, ...(await identity(wrapper)) };
  const installations: Record<Provider, Installation> = {
    codex: { ...f.installation, ...executable, id: "codex" },
    claude: {
      ...f.installation,
      ...executable,
      id: "claude",
      appId: "anthropic.claude-code-cli",
      compatibility: "native-only",
    },
  };
  service.store.put("project", {
    id: "p",
    name: "terminal fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: now(),
  });
  for (const installation of Object.values(installations))
    service.store.put("installation", installation);
  await service.start();
  const released = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { leases } = await service.command({
        type: "coordination-query",
        projectId: "p",
      });
      if (
        !service.runtime.isProjectBusy("p") &&
        leases.every((lease: any) => lease.state === "released")
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("The terminal did not release the workspace.");
  };
  /** Waits until the terminal has written text matching the pattern. */
  const read = async (id: string, pattern: RegExp) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const text = output.get(id) ?? "";
      if (pattern.test(text)) return text;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(
      `Terminal output never matched ${pattern}: ${output.get(id)}`,
    );
  };
  /** Opens a terminal the way the owner does, reads the arguments the stand-in received, and closes it. */
  const open = async (
    provider: Provider,
    permissionMode: TerminalModeId,
    confirmedTerminalMode?: TerminalModeId,
  ) => {
    const id: string = await service.command(
      {
        type: "terminal-open",
        projectId: "p",
        installationId: provider,
        login: false,
        permissionMode,
      },
      confirmedTerminalMode ? { confirmedTerminalMode } : {},
    );
    const text = await read(id, argumentsLine);
    await service.command({ type: "terminal-close", id });
    await released();
    return {
      id,
      args: JSON.parse(argumentsLine.exec(text)![1]),
      run: service.store.get<Run>("run", id)!,
    };
  };
  const remembered = () =>
    service.state().terminalModes.find((entry) => entry.id === "p");
  /** A Claude Code handoff for the role, prepared over a pinned file. */
  const handoff = async (role: "builder" | "reviewer") => {
    await writeFile(path.join(f.directory, "source.ts"), "one\n");
    const candidate = await captureCandidate(service.store, {
      root: f.directory,
      projectId: "p",
      workflowId: "w",
      selectedPaths: ["source.ts"],
    });
    service.store.put("builder-reviewer", {
      id: "w",
      projectId: "p",
      candidateId: candidate.id,
      specificationId: "spec",
    });
    service.store.put("workflow-specification", {
      id: "spec",
      objective: "Review the pinned file",
    });
    return new AssistedWorkflows(service.store).prepare({
      projectId: "p",
      workflowId: "w",
      installationId: "claude",
      role,
      exportApproved: true,
    });
  };
  /** Turns auto-accept to the level, confirmed as Topsl's own dialog does. */
  const autoAccept = (level: "off" | "sandboxed" | "everything") =>
    service.command(
      { type: "auto-accept-set", level },
      level === "off" ? {} : { confirmedAutoAccept: level },
    );
  return {
    ...f,
    service,
    installations,
    output,
    read,
    released,
    open,
    remembered,
    handoff,
    autoAccept,
  };
}

describe.skipIf(process.platform === "win32")(
  "terminals through the service",
  () => {
    test("every mode starts the executable with exactly its arguments, recorded on the run", async () => {
      const f = await setup();
      for (const provider of ["claude", "codex"] as const)
        for (const mode of terminalModes[provider]) {
          const opened = await f.open(
            provider,
            mode.id,
            mode.warning ? mode.id : undefined,
          );
          expect(opened.args, `${provider} ${mode.id}`).toEqual(mode.args);
          expect(opened.run).toMatchObject({
            provider,
            mode: "native",
            permissionMode: mode.id,
            permissionArgs: mode.args,
          });
        }
    });
    test("a bypass mode starts only with the owner's confirmation of that mode, and is never remembered", async () => {
      const f = await setup();
      await f.open("claude", "accept-edits");
      expect(f.remembered()).toMatchObject({ claude: "accept-edits" });
      const runs = () => f.service.store.list<Run>("run").length;
      const before = runs();
      for (const confirmed of [undefined, "full-access", "plan"] as const)
        await expect(
          f.service.command(
            {
              type: "terminal-open",
              projectId: "p",
              installationId: "claude",
              login: false,
              permissionMode: "bypass",
            },
            confirmed ? { confirmedTerminalMode: confirmed } : {},
          ),
        ).rejects.toThrow("Bypass needs your confirmation");
      expect(runs()).toBe(before);
      const bypassed = await f.open("claude", "bypass", "bypass");
      expect(bypassed.args).toEqual(["--permission-mode", "bypassPermissions"]);
      expect(f.remembered()).toMatchObject({ claude: "accept-edits" });
    });
    test("each project remembers its last ordinary mode per provider", async () => {
      const f = await setup();
      expect(f.remembered()).toBeUndefined();
      await f.open("claude", "plan");
      await f.open("codex", "read-only");
      expect(f.remembered()).toMatchObject({
        claude: "plan",
        codex: "read-only",
      });
      await f.open("claude", "provider-default");
      expect(f.remembered()).toMatchObject({
        claude: "provider-default",
        codex: "read-only",
      });
    });
    test("opening a folder from Projects passes the chosen mode, and opens only a provider CLI", async () => {
      const f = await setup();
      const opened: { terminalId: string } = await f.service.command({
        type: "project-open",
        projectId: "p",
        installationId: "codex",
        permissionMode: "read-only",
      });
      const text = await f.read(opened.terminalId, argumentsLine);
      expect(JSON.parse(argumentsLine.exec(text)![1])).toEqual([
        "-s",
        "read-only",
        "-a",
        "on-request",
      ]);
      await f.service.command({
        type: "terminal-close",
        id: opened.terminalId,
      });
      await f.released();
      expect(f.remembered()).toMatchObject({ codex: "read-only" });
      await expect(
        f.service.command({
          type: "project-open",
          projectId: "p",
          installationId: "codex",
          permissionMode: "full-access",
        }),
      ).rejects.toThrow("Full access needs your confirmation");
      f.service.store.put("installation", {
        ...f.installations.codex,
        id: "desktop",
        appId: "openai.desktop",
      });
      await expect(
        f.service.command({
          type: "project-open",
          projectId: "p",
          installationId: "desktop",
          permissionMode: "read-only",
        }),
      ).rejects.toThrow(
        "Topsl opens projects in the Codex or Claude Code CLI.",
      );
    });
    test("a login terminal takes no permission mode", async () => {
      const f = await setup();
      await expect(
        f.service.command({
          type: "terminal-open",
          projectId: "p",
          installationId: "claude",
          login: true,
          permissionMode: "plan",
        }),
      ).rejects.toThrow("A login terminal takes no permission mode.");
      const id: string = await f.service.command({
        type: "terminal-open",
        projectId: "p",
        installationId: "claude",
        login: true,
        permissionMode: "provider-default",
      });
      expect(await f.read(id, argumentsLine)).toContain(
        'Stand-in arguments: ["auth","login"]',
      );
      expect(f.service.store.get<Run>("run", id)).not.toHaveProperty(
        "permissionMode",
      );
      await f.service.command({ type: "terminal-close", id });
      await f.released();
      expect(f.remembered()).toBeUndefined();
    });
    test("a mode the runtime refuses ends that terminal, and Topsl starts no other", async () => {
      const f = await setup();
      const id: string = await f.service.command({
        type: "terminal-open",
        projectId: "p",
        installationId: "claude",
        login: false,
        permissionMode: "auto",
      });
      expect(await f.read(id, /Native session exited: 1/)).toContain(
        "Auto mode is unavailable for this account.",
      );
      await f.released();
      expect(f.service.store.list<Run>("run")).toEqual([
        expect.objectContaining({
          id,
          status: "interrupted",
          permissionMode: "auto",
        }),
      ]);
    });
    test("a Claude review handoff opens in Plan, and a build handoff passes nothing", async () => {
      for (const role of ["reviewer", "builder"] as const) {
        const f = await setup();
        const handoff = await f.handoff(role);
        const opened = await f.service.openAssistedHandoff({
          projectId: "p",
          id: handoff.id,
        });
        const text = await f.read(opened.terminalId!, argumentsLine);
        expect(text).toContain(
          role === "reviewer"
            ? 'Stand-in arguments: ["--permission-mode","plan"]'
            : "Stand-in arguments: []",
        );
        expect(
          f.service.store.get<Run>("run", opened.terminalId!),
        ).toMatchObject({
          permissionMode: role === "reviewer" ? "plan" : "provider-default",
        });
        await f.service.command({
          type: "terminal-close",
          id: opened.terminalId!,
        });
        await f.released();
        expect(f.remembered()).toBeUndefined();
      }
    });
    test("while auto-accept is on, terminals start in its mode, and the project's remembered mode waits for it to be off", async () => {
      const f = await setup();
      const starting = (provider: Provider) =>
        startingTerminalMode(f.service.state(), "p", provider);
      await f.open("claude", "plan");
      expect(starting("claude")).toBe("plan");
      await f.autoAccept("sandboxed");
      expect(starting("claude")).toBe("sandboxed");
      expect(starting("codex")).toBe("workspace-never");
      const sandboxed = await f.open("claude", "sandboxed");
      expect(sandboxed.args).toEqual(terminalMode("claude", "sandboxed").args);
      expect(sandboxed.run).toMatchObject({ permissionMode: "sandboxed" });
      // The owner can still pick another mode, which is not remembered now.
      await f.open("codex", "read-only");
      expect(f.remembered()).toMatchObject({ claude: "plan" });
      expect(f.remembered()).not.toHaveProperty("codex");
      await f.autoAccept("everything");
      expect(starting("claude")).toBe("bypass");
      expect(starting("codex")).toBe("full-access");
      // Everything preselects a bypass mode; each terminal is still confirmed.
      await expect(
        f.service.command({
          type: "terminal-open",
          projectId: "p",
          installationId: "codex",
          login: false,
          permissionMode: "full-access",
        }),
      ).rejects.toThrow("Full access needs your confirmation");
      const bypassed = await f.open("codex", "full-access", "full-access");
      expect(bypassed.args).toEqual([
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
      await f.autoAccept("off");
      expect(starting("claude")).toBe("plan");
      expect(starting("codex")).toBe("provider-default");
    });
    test("under auto-accept a build handoff opens in its mode, a review handoff keeps Plan, and Everything's bypass is confirmed first", async () => {
      for (const [level, role, args] of [
        ["sandboxed", "builder", terminalMode("claude", "sandboxed").args],
        ["sandboxed", "reviewer", ["--permission-mode", "plan"]],
        ["everything", "reviewer", ["--permission-mode", "plan"]],
        ["everything", "builder", ["--permission-mode", "bypassPermissions"]],
      ] as const) {
        const f = await setup();
        await f.autoAccept(level);
        const handoff = await f.handoff(role);
        const bypass = level === "everything" && role === "builder";
        if (bypass) {
          // Refused before Topsl records the opening, so the owner can
          // still open it once confirmed.
          await expect(
            f.service.openAssistedHandoff({ projectId: "p", id: handoff.id }),
          ).rejects.toThrow(
            "Bypass needs your confirmation in Topsl's own dialog each time.",
          );
          expect(f.service.store.list<Run>("run")).toEqual([]);
        }
        const opened = await f.service.openAssistedHandoff(
          { projectId: "p", id: handoff.id },
          bypass ? "bypass" : undefined,
        );
        const text = await f.read(opened.terminalId!, argumentsLine);
        expect(
          JSON.parse(argumentsLine.exec(text)![1]),
          `${level} ${role}`,
        ).toEqual(args);
        await f.service.command({
          type: "terminal-close",
          id: opened.terminalId!,
        });
        await f.released();
      }
    });
  },
);
