import os from "node:os";
import path from "node:path";
import { readFileSync, statSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { hash, stable } from "../domain/invariants";
import type { Installation } from "../domain/types";
import { nativeEnvironment } from "../platform/system";
import { adapterProtocols, type RuntimeBinding } from "./acceptance";
import type { ProviderAccount } from "./contract";
/** Only digests of policy files are retained. Credentials and auth responses are never copied. */
export function runtimeBinding(
  installation: Installation,
  account: Pick<ProviderAccount, "accountKey" | "profileId" | "billingRoute">,
): RuntimeBinding {
  if (account.billingRoute !== "native-subscription")
    throw new Error(
      "This runtime profile requires separately authorized native subscription authentication.",
    );
  const provider = installation.appId.includes("claude") ? "claude" : "codex",
    env = nativeEnvironment(),
    root =
      provider === "codex"
        ? (env.CODEX_HOME ?? path.join(os.homedir(), ".codex"))
        : (env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")),
    paths =
      provider === "codex"
        ? [path.join(root, "config.toml")]
        : [
            path.join(root, "settings.json"),
            path.join(root, "settings.local.json"),
          ];
  const policies = paths.map((file) => {
    try {
      const stat = statSync(file);
      return [
        file,
        stat.size <= 2_000_000
          ? policyDigest(provider, readFileSync(file))
          : `oversize:${stat.size}:${stat.mtimeMs}`,
      ];
    } catch {
      return [file, "unavailable"];
    }
  });
  return {
    schemaVersion: 1,
    provider,
    installationId: installation.id,
    executableIdentity: installation.identity,
    runtimeRevision: installation.revisionId,
    runtimeVersion: installation.version,
    adapterProtocol: adapterProtocols[provider],
    profileId: account.profileId,
    accountKey: account.accountKey,
    authenticationRoute: "native-subscription",
    policyHash: hash(
      stable({
        policies,
        profileRoot: root,
        brokerPolicy: "r2-2-native-subscription/v1",
      }),
    ),
    sandboxHash: hash(
      stable({
        review: "readOnly",
        edit: "workspaceWrite",
        networkAccess: false,
        approvalPolicy: "untrusted",
        schema: 1,
      }),
    ),
    hostId: installation.hostId,
    platform: process.platform,
    arch: process.arch,
  };
}
/**
 * Codex adds an entry under `projects` to its own config.toml the first time it
 * works in a folder, which would void a qualification on every new project.
 * Those entries are left out; every other setting stays in the digest with its
 * type, and a file that does not parse is digested byte for byte.
 */
function policyDigest(provider: "claude" | "codex", bytes: Buffer) {
  if (provider === "codex")
    try {
      const { projects, ...settings } = parseToml(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        { integersAsBigInt: true },
      );
      return hash(
        stable({ codexConfigWithoutProjects: 1, settings: typed(settings) }),
      );
    } catch {}
  return hash(bytes);
}
const typed = (value: unknown): unknown =>
  typeof value === "bigint"
    ? { integer: String(value) }
    : typeof value === "number"
      ? { float: Object.is(value, -0) ? "-0" : String(value) }
      : value instanceof Date
        ? { datetime: value.toISOString() }
        : Array.isArray(value)
          ? value.map(typed)
          : value && typeof value === "object"
            ? Object.fromEntries(
                Object.entries(value).map(([key, item]) => [key, typed(item)]),
              )
            : value;
