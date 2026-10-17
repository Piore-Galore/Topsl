import { rm } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { Service } from "../apps/service/service";
import {
  autoAcceptChatNote,
  autoAcceptConfirmation,
  autoAcceptLevel,
  autoAcceptOptions,
  autoAcceptPolicy,
  autoAcceptTerminalMode,
} from "../packages/domain/auto-accept";
import {
  chatPreset,
  chatPresetNote,
  noAskingBlocked,
} from "../packages/domain/chat-presets";
import { isBypassMode, terminalMode } from "../packages/domain/terminal-modes";
import { fixture } from "./helpers";

describe("auto-accept", () => {
  test("it is off until set, and Settings names each level", () => {
    expect(autoAcceptLevel(undefined)).toBe("off");
    expect(autoAcceptLevel("everything")).toBe("everything");
    expect(autoAcceptLevel("all")).toBe("off");
    expect(autoAcceptOptions.map((o) => [o.level, o.label])).toEqual([
      ["off", "Off"],
      ["sandboxed", "Sandboxed"],
      ["everything", "Everything"],
    ]);
  });

  test("Sandboxed terminals keep a sandbox, and only Everything's are bypass modes", () => {
    expect(autoAcceptTerminalMode("off", "claude")).toBeNull();
    expect(autoAcceptTerminalMode("off", "codex")).toBeNull();
    const sandboxed = [
      autoAcceptTerminalMode("sandboxed", "claude")!,
      autoAcceptTerminalMode("sandboxed", "codex")!,
    ];
    expect(sandboxed).toEqual(["sandboxed", "workspace-never"]);
    expect(sandboxed.filter(isBypassMode)).toEqual([]);
    expect(terminalMode("codex", "workspace-never").args).toEqual([
      "-s",
      "workspace-write",
      "-a",
      "never",
    ]);
    // Claude Code's own sandbox, with no unsandboxed retry and no start
    // without it, under Accept edits.
    const [, permissionMode, flag, settings] = terminalMode(
      "claude",
      "sandboxed",
    ).args;
    expect([permissionMode, flag]).toEqual(["acceptEdits", "--settings"]);
    expect(JSON.parse(settings)).toEqual({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        failIfUnavailable: true,
        network: { strictAllowlist: true },
      },
    });
    const everything = [
      autoAcceptTerminalMode("everything", "claude")!,
      autoAcceptTerminalMode("everything", "codex")!,
    ];
    expect(everything).toEqual(["bypass", "full-access"]);
    expect(everything.every(isBypassMode)).toBe(true);
  });

  test("only an edit turn under Sandboxed, on a runtime that can use it, is sent with no asking", () => {
    expect(autoAcceptPolicy("sandboxed", "edit", "untrusted", true)).toBe(
      "never",
    );
    expect(autoAcceptPolicy("sandboxed", "edit", "on-request", true)).toBe(
      "never",
    );
    expect(autoAcceptPolicy("sandboxed", "edit", "untrusted", false)).toBe(
      "untrusted",
    );
    expect(autoAcceptPolicy("sandboxed", "review", "untrusted", true)).toBe(
      "untrusted",
    );
    expect(autoAcceptPolicy("everything", "edit", "untrusted", true)).toBe(
      "untrusted",
    );
    expect(autoAcceptPolicy("off", "edit", "on-request", true)).toBe(
      "on-request",
    );
  });

  test("the composer says what auto-accept does to the selected preset", () => {
    expect(autoAcceptChatNote("off", chatPreset("edit"))).toBeNull();
    expect(
      autoAcceptChatNote("sandboxed", chatPreset("edit-never")),
    ).toBeNull();
    expect(autoAcceptChatNote("everything", chatPreset("review"))).toBe(
      "Commands cannot write. Topsl declines every request Codex makes. Auto-accept does not change reviews.",
    );
    expect(autoAcceptChatNote("sandboxed", chatPreset("edit"))).toBe(
      `Auto-accept is Sandboxed, so Topsl sends this with no asking. ${chatPresetNote(chatPreset("edit-never"))}`,
    );
    expect(
      autoAcceptChatNote(
        "sandboxed",
        chatPreset("edit-on-request"),
        noAskingBlocked.missing,
      ),
    ).toBe(
      `Auto-accept is Sandboxed, but this runtime cannot run without asking yet, so Codex asks you as before. ${noAskingBlocked.missing}`,
    );
    expect(autoAcceptChatNote("everything", chatPreset("edit"))).toBe(
      "Auto-accept is Everything, so Topsl allows every request Codex makes, and an allowed command may run outside the workspace sandbox with your own access. Topsl notes each one in this chat.",
    );
  });

  test("each confirmation says what the level allows, and Everything quotes both providers' warnings", () => {
    const sandboxed = autoAcceptConfirmation("sandboxed");
    expect(sandboxed.message).toBe(
      "Turn on auto-accept for work inside the sandbox?",
    );
    expect(sandboxed.affirmative).toBe("Turn on Sandboxed");
    expect(sandboxed.detail).toContain(
      "Terminals Topsl opens for editing start in Codex's Workspace, never ask and Claude Code's Sandboxed edits",
    );
    expect(sandboxed.detail).toContain("Reviews stay read-only");
    const everything = autoAcceptConfirmation("everything");
    expect(everything.message).toBe(
      "Let Topsl allow everything Codex and Claude Code ask for?",
    );
    expect(everything.affirmative).toBe("Allow everything");
    expect(everything.detail).toContain(
      "Terminals Topsl opens for editing start in Codex's Full access and Claude Code's Bypass, with no prompts and no sandbox.",
    );
    expect(everything.detail).toContain("EXTREMELY DANGEROUS");
    expect(everything.detail).toContain(
      "Only use this mode in isolated environments",
    );
    expect(everything.detail).toContain("Reviews stay read-only.");
  });
});

const services: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const f of services.splice(0)) {
    await f.service.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("turning auto-accept on takes the owner's confirmation of that level, and turning it off takes none", async () => {
  const f = await fixture();
  f.store.close();
  const service = new Service(f.directory, f.key, () => {}, true);
  services.push({ service, directory: f.directory });
  await service.start();
  const set = (level: "off" | "sandboxed" | "everything", confirmed?: any) =>
    service.command(
      { type: "auto-accept-set", level },
      confirmed ? { confirmedAutoAccept: confirmed } : {},
    );
  expect(service.state().autoAccept).toBe("off");
  for (const confirmed of [undefined, "sandboxed", "off"])
    await expect(set("everything", confirmed)).rejects.toThrow(
      "Turning on auto-accept needs your confirmation in Topsl's own dialog.",
    );
  // A generic approval is not a confirmation of the level.
  await expect(
    service.command(
      { type: "auto-accept-set", level: "sandboxed" },
      { approved: true },
    ),
  ).rejects.toThrow("needs your confirmation");
  expect(service.state().autoAccept).toBe("off");
  expect(await set("sandboxed", "sandboxed")).toEqual({ level: "sandboxed" });
  expect(service.state().autoAccept).toBe("sandboxed");
  await set("everything", "everything");
  expect(service.state().autoAccept).toBe("everything");
  await set("off");
  expect(service.state().autoAccept).toBe("off");
  expect(
    service.store.db
      .prepare("SELECT body FROM events WHERE kind = 'auto-accept.set'")
      .all()
      .map((row: any) => JSON.parse(row.body).level),
  ).toEqual(["sandboxed", "everything", "off"]);
});
