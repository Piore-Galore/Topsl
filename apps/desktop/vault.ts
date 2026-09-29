import { safeStorage } from "electron";
import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";
interface VaultFile {
  method: "os" | "passphrase";
  data: string;
  salt?: string;
  iv?: string;
  tag?: string;
}
export async function openVault(
  directory: string,
  passphrase?: string,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "vault.json");
  let existing: VaultFile | undefined;
  try {
    existing = JSON.parse(await readFile(file, "utf8"));
  } catch (e: any) {
    if (e.code !== "ENOENT") throw e;
  }
  const secureOS =
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      safeStorage.getSelectedStorageBackend() !== "basic_text");
  if (existing?.method === "os") {
    if (!secureOS)
      throw new Error(
        "The OS credential store is unavailable. Unlock it and reopen Topsl.",
      );
    return safeStorage.decryptString(Buffer.from(existing.data, "base64"));
  }
  if (existing?.method === "passphrase") {
    if (!passphrase)
      throw new Error("Enter your vault passphrase to unlock local history.");
    const key = scryptSync(passphrase, Buffer.from(existing.salt!, "hex"), 32);
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(existing.iv!, "hex"),
    );
    cipher.setAuthTag(Buffer.from(existing.tag!, "hex"));
    try {
      return Buffer.concat([
        cipher.update(Buffer.from(existing.data, "base64")),
        cipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Vault passphrase is incorrect.");
    }
  }
  if (existing)
    throw new Error(
      "Unknown vault format. Preserve the vault file and restore a compatible Topsl version.",
    );
  let databaseExists = false;
  try {
    await access(path.join(directory, "history.sqlite"));
    databaseExists = true;
  } catch {
    /* New vault. */
  }
  if (databaseExists)
    throw new Error(
      "The history database exists but its vault key is missing. Restore the original vault file; a new key cannot unlock it.",
    );
  const databaseKey = randomBytes(32).toString("hex");
  let value: VaultFile;
  if (passphrase) {
    if (passphrase.length < 12)
      throw new Error("Use at least 12 characters for the vault passphrase.");
    const salt = randomBytes(32),
      iv = randomBytes(12),
      key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([
      cipher.update(databaseKey, "utf8"),
      cipher.final(),
    ]);
    value = {
      method: "passphrase",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      data: data.toString("base64"),
    };
  } else {
    if (!secureOS)
      throw new Error(
        "No secure OS credential store is available. Create a passphrase vault to continue.",
      );
    value = {
      method: "os",
      data: safeStorage.encryptString(databaseKey).toString("base64"),
    };
  }
  const temporary = file + "." + randomBytes(8).toString("hex") + ".tmp";
  await writeFile(temporary, JSON.stringify(value), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, file);
  return databaseKey;
}
