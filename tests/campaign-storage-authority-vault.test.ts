// Campaign 2026-10-19-comprehensive, packet p2a-storage-authority.
// DATA-01/02/03/04 and the vault part of DATA-07 through the real
// apps/desktop/vault.ts. Only Electron's safeStorage (the OS key store) and one
// fs rename are replaced, because neither exists under ELECTRON_RUN_AS_NODE.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A stand-in OS key store: real AES-GCM under a key that lives only in this
// process, so the envelope on disk never carries the database key in clear.
const keyStore = vi.hoisted(() => ({
  available: true,
  backend: "keychain",
  decryptFails: false,
  encryptCalls: 0,
  failNextRename: false,
}));
const osSecret = randomBytes(32);
vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => keyStore.available,
    getSelectedStorageBackend: () => keyStore.backend,
    encryptString: (plain: string) => {
      keyStore.encryptCalls++;
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", osSecret, iv);
      const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString: (bytes: Buffer) => {
      if (keyStore.decryptFails)
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.decryptString.",
        );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        osSecret,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    rename: async (from: string, to: string) => {
      if (keyStore.failNextRename) {
        keyStore.failNextRename = false;
        throw Object.assign(new Error("ENOSPC: no space left on device, rename"), {
          code: "ENOSPC",
        });
      }
      return original.rename(from, to);
    },
  };
});

const { openVault } = await import("../apps/desktop/vault");
const { Store } = await import("../packages/persistence/store");

const directories: string[] = [];
const realPlatform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  Object.assign(keyStore, {
    available: true,
    backend: "keychain",
    decryptFails: false,
    encryptCalls: 0,
    failNextRename: false,
  });
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function profile() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-campaign-vault-"));
  directories.push(directory);
  return {
    directory,
    vault: path.join(directory, "vault.json"),
    database: path.join(directory, "history.sqlite"),
  };
}
async function files(directory: string) {
  return (await readdir(directory)).sort();
}
async function bytesOrNull(file: string) {
  try {
    return await readFile(file);
  } catch {
    return null;
  }
}

describe("DATA-01 new profile under a secure OS key store", () => {
  test("initializes once, reopens to the same key and history, and stores no plaintext key", async () => {
    const p = await profile();
    const key = await openVault(p.directory);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(keyStore.encryptCalls).toBe(1);
    const envelope = await readFile(p.vault, "utf8");
    expect(JSON.parse(envelope).method).toBe("os");
    expect(envelope.includes(key)).toBe(false);
    // POSIX mode bits only: on Windows Node reports 0o666 for any writable
    // file, whatever its ACL. Unverified on Windows: the vault file's ACL
    // (Topsl sets none explicitly; it inherits from the profile folder). The
    // rest of this test, including no plaintext key, runs on every OS.
    if (process.platform !== "win32") {
      expect((await stat(p.vault)).mode & 0o777).toBe(0o600);
      expect((await stat(p.directory)).mode & 0o077).toBe(0);
    }
    const store = new Store(p.database, key);
    store.message({
      id: "m",
      projectId: "p",
      conversationId: "c",
      role: "user",
      provider: "codex",
      text: "DATA01_HISTORY_CANARY",
      runId: null,
      nativeId: null,
      createdAt: new Date().toISOString(),
    });
    store.close();
    const before = await readFile(p.vault);
    // Reopen: same key, same envelope bytes, no second key generated.
    const again = await openVault(p.directory);
    expect(again).toBe(key);
    expect(keyStore.encryptCalls).toBe(1);
    expect((await readFile(p.vault)).equals(before)).toBe(true);
    const reopened = new Store(p.database, again);
    expect(reopened.searchPage("p", "DATA01_HISTORY_CANARY").items.map((m) => m.id)).toEqual(["m"]);
    reopened.close();
    // No temporary envelope, second vault or second profile was left behind.
    expect((await files(p.directory)).filter((n) => !n.startsWith("history.sqlite"))).toEqual([
      "vault.json",
    ]);
    // Negative control: a different key cannot open the same history.
    expect(() => new Store(p.database, randomBytes(32).toString("hex"))).toThrow();
  });
});

describe("DATA-02 secure storage absent, locked or Linux basic_text", () => {
  test("no secure store and no passphrase refuses without writing an unprotected key", async () => {
    const p = await profile();
    keyStore.available = false;
    await expect(openVault(p.directory)).rejects.toThrow("Create a passphrase vault");
    expect(await files(p.directory)).toEqual([]);
    expect(keyStore.encryptCalls).toBe(0);
  });
  test("Linux basic_text is treated as no secure store", async () => {
    const p = await profile();
    Object.defineProperty(process, "platform", { value: "linux" });
    keyStore.backend = "basic_text";
    await expect(openVault(p.directory)).rejects.toThrow("Create a passphrase vault");
    expect(await files(p.directory)).toEqual([]);
    expect(keyStore.encryptCalls).toBe(0);
    // Control: the same Linux host with a real backend may use the OS store.
    keyStore.backend = "gnome_libsecret";
    const key = await openVault(p.directory);
    expect(JSON.parse(await readFile(p.vault, "utf8")).method).toBe("os");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
  test("a locked OS store keeps the existing envelope and gives an actionable lock error", async () => {
    const p = await profile();
    const key = await openVault(p.directory);
    new Store(p.database, key).close();
    const before = await readFile(p.vault);
    keyStore.available = false;
    await expect(openVault(p.directory)).rejects.toThrow(
      "OS credential store is unavailable",
    );
    expect((await readFile(p.vault)).equals(before)).toBe(true);
    keyStore.available = true;
    expect(await openVault(p.directory)).toBe(key);
  });
  test("the passphrase path is the supported fallback and its envelope holds no plaintext key", async () => {
    const p = await profile();
    keyStore.available = false;
    const key = await openVault(p.directory, "correct horse battery");
    const envelope = await readFile(p.vault, "utf8");
    expect(JSON.parse(envelope).method).toBe("passphrase");
    expect(envelope.includes(key)).toBe(false);
    expect(keyStore.encryptCalls).toBe(0);
    expect(await openVault(p.directory, "correct horse battery")).toBe(key);
  });
});

describe("DATA-03 passphrase minimum, Unicode and wrong passphrase", () => {
  test("11 characters is refused, 12 is accepted, and nothing is written for the refusal", async () => {
    const p = await profile();
    keyStore.available = false;
    await expect(openVault(p.directory, "a".repeat(11))).rejects.toThrow(
      "at least 12 characters",
    );
    expect(await files(p.directory)).toEqual([]);
    const key = await openVault(p.directory, "a".repeat(12));
    expect(key).toMatch(/^[a-f0-9]{64}$/);
  });
  test("a Unicode passphrase reopens; a wrong one fails and leaves the vault for a later correct unlock", async () => {
    const p = await profile();
    keyStore.available = false;
    const phrase = "密码短语-🔐-Topsl-ünïcødé";
    const key = await openVault(p.directory, phrase);
    new Store(p.database, key).close();
    const before = await readFile(p.vault);
    await expect(openVault(p.directory, phrase + "x")).rejects.toThrow(
      "Vault passphrase is incorrect",
    );
    await expect(openVault(p.directory)).rejects.toThrow("Enter your vault passphrase");
    expect((await readFile(p.vault)).equals(before)).toBe(true);
    expect(await openVault(p.directory, phrase)).toBe(key);
  });
  test("observation: the minimum counts UTF-16 code units, so six emoji meet the 12-character rule", async () => {
    // Documented, not asserted as a defect: the plan does not say whether the
    // minimum counts user-perceived characters. See summary.md.
    const p = await profile();
    keyStore.available = false;
    const sixEmoji = "🔐".repeat(6);
    expect(sixEmoji.length).toBe(12);
    expect([...new Intl.Segmenter().segment(sixEmoji)].length).toBeLessThan(12);
    await expect(openVault(p.directory, sixEmoji)).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("DATA-04 unrecoverable vault states preserve files and never generate a replacement key", () => {
  async function existingProfile(method: "os" | "passphrase") {
    const p = await profile();
    if (method === "passphrase") keyStore.available = false;
    const key = await openVault(
      p.directory,
      method === "passphrase" ? "correct horse battery" : undefined,
    );
    const store = new Store(p.database, key);
    store.put("project", { id: "p", canary: "DATA04_DATABASE_CANARY" });
    store.close();
    keyStore.available = true;
    keyStore.encryptCalls = 0;
    return { ...p, key, database: p.database };
  }
  async function snapshot(p: { directory: string; vault: string; database: string }) {
    return {
      names: await files(p.directory),
      vault: await bytesOrNull(p.vault),
      database: await bytesOrNull(p.database),
    };
  }
  async function expectPreserved(
    p: { directory: string; vault: string; database: string },
    before: Awaited<ReturnType<typeof snapshot>>,
  ) {
    const after = await snapshot(p);
    expect(after.names).toEqual(before.names);
    expect(after.vault?.equals(before.vault!) ?? after.vault === before.vault).toBe(true);
    expect(after.database!.equals(before.database!)).toBe(true);
    expect(keyStore.encryptCalls).toBe(0);
  }
  test("missing vault with an existing database", async () => {
    const p = await existingProfile("os");
    await rm(p.vault);
    const before = await snapshot(p);
    await expect(openVault(p.directory)).rejects.toThrow("vault key is missing");
    await expect(openVault(p.directory, "a new passphrase!")).rejects.toThrow(
      "vault key is missing",
    );
    await expectPreserved(p, before);
    expect(before.names.includes("vault.json")).toBe(false);
  });
  test.each([
    ["truncated JSON", '{"method":"os","da'],
    ["empty file", ""],
    ["binary noise", "\u0000\u0001\u0002"],
  ])("malformed envelope (%s)", async (_label, content) => {
    const p = await existingProfile("os");
    await writeFile(p.vault, content);
    const before = await snapshot(p);
    await expect(openVault(p.directory)).rejects.toThrow();
    await expectPreserved(p, before);
  });
  test("invalid authentication tag on a passphrase envelope", async () => {
    const p = await existingProfile("passphrase");
    const envelope = JSON.parse(await readFile(p.vault, "utf8"));
    envelope.tag = (envelope.tag[0] === "0" ? "1" : "0") + envelope.tag.slice(1);
    await writeFile(p.vault, JSON.stringify(envelope));
    const before = await snapshot(p);
    await expect(openVault(p.directory, "correct horse battery")).rejects.toThrow(
      "Vault passphrase is incorrect",
    );
    await expectPreserved(p, before);
  });
  test("unknown vault format", async () => {
    const p = await existingProfile("os");
    await writeFile(p.vault, JSON.stringify({ method: "hardware-token", data: "x" }));
    const before = await snapshot(p);
    await expect(openVault(p.directory)).rejects.toThrow("Unknown vault format");
    await expect(openVault(p.directory, "correct horse battery")).rejects.toThrow(
      "Unknown vault format",
    );
    await expectPreserved(p, before);
  });
  test("unavailable original OS key", async () => {
    const p = await existingProfile("os");
    keyStore.decryptFails = true;
    const before = await snapshot(p);
    await expect(openVault(p.directory)).rejects.toThrow("decrypt");
    await expectPreserved(p, before);
    // Control: once the original key returns, the same database opens.
    keyStore.decryptFails = false;
    const key = await openVault(p.directory);
    expect(key).toBe(p.key);
    const store = new Store(p.database, key);
    expect(store.get<any>("project", "p").canary).toBe("DATA04_DATABASE_CANARY");
    store.close();
  });
  test("a JSON null envelope next to an existing database still refuses", async () => {
    const p = await existingProfile("os");
    await writeFile(p.vault, "null");
    const before = await snapshot(p);
    await expect(openVault(p.directory)).rejects.toThrow("vault key is missing");
    await expectPreserved(p, before);
  });
  // CAMPAIGN DEFECT DATA-04: a parseable but falsy envelope (null/false/0) with no database is overwritten by a new key instead of being preserved.
  test.fails.each([["null"], ["false"], ["0"]])(
    "a falsy JSON envelope (%s) without a database is preserved, not replaced",
    async (content) => {
      const p = await profile();
      await writeFile(p.vault, content);
      await expect(openVault(p.directory)).rejects.toThrow();
      expect(await readFile(p.vault, "utf8")).toBe(content);
      expect(keyStore.encryptCalls).toBe(0);
    },
  );
});

describe("DATA-07 vault creation interrupted at the rename", () => {
  test("a failed rename leaves no vault, no plaintext key, and a later open starts cleanly", async () => {
    const p = await profile();
    keyStore.failNextRename = true;
    await expect(openVault(p.directory)).rejects.toThrow("ENOSPC");
    const names = await files(p.directory);
    expect(names.includes("vault.json")).toBe(false);
    expect(names.includes("history.sqlite")).toBe(false);
    // Whatever temporary envelope remains is encrypted, never the raw key.
    for (const name of names) {
      const text = await readFile(path.join(p.directory, name), "utf8");
      expect(JSON.parse(text).method).toBe("os");
      expect(text).not.toMatch(/"data":"[a-f0-9]{64}"/);
    }
    const key = await openVault(p.directory);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(await readFile(p.vault, "utf8")).method).toBe("os");
    // Record how many temporary envelopes were left, for the summary.
    const leftovers = (await files(p.directory)).filter((n) => n.endsWith(".tmp"));
    expect(leftovers.length).toBe(names.length);
  });
});
