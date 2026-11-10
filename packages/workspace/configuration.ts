import path from "node:path";
import os from "node:os";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  realpath,
  rm,
  open,
} from "node:fs/promises";
import { Store } from "../persistence/store";
import type { ConfigurationPlan, Project, Provider } from "../domain/types";
import { hash, now, stable, uid } from "../domain/invariants";
import { exists, isWithin, projectPath } from "../platform/system";
import { parse as parseToml } from "smol-toml";

/** Topsl refuses to read a configuration file over this many bytes, so an edit larger than this could be written but never read
 * back. The IPC schema bounds characters; this bounds UTF-8 bytes. */
export const configurationByteLimit = 1_000_000;
const assertWithinByteLimit = (text: string) => {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > configurationByteLimit)
    throw new Error(
      `The edited configuration is ${bytes.toLocaleString("en-US")} bytes. Topsl reads configuration files up to ${configurationByteLimit.toLocaleString("en-US")} bytes, so it was not written.`,
    );
};

/** A byte that is not UTF-8 throws rather than becoming U+FFFD, and a
 * leading byte order mark stays in the text, so what Topsl hashes, shows,
 * backs up and writes is the file's own bytes. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** JSON.parse rejects a leading byte order mark. It is removed only for
 * validation; the text that is written keeps it. */
const withoutMark = (text: string) => text.replace(/^\uFEFF/, "");

/**
 * The text of the configuration file, or "" when nothing is at the path.
 * lstat sees a link whose target is gone, which fs.access reports as no
 * file, so a dangling link is refused instead of being replaced.
 */
async function currentText(file: string, linked: string): Promise<string> {
  const entry = await lstat(file).catch(() => null);
  if (!entry) return "";
  if (entry.isSymbolicLink()) throw new Error(linked);
  if (!entry.isFile() || entry.size > configurationByteLimit)
    throw new Error("File is not a supported size or type.");
  const bytes = await readFile(file);
  if (bytes.length > configurationByteLimit)
    throw new Error("File is not a supported size or type.");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(
      "This configuration file is not valid UTF-8, so Topsl cannot show or replace it without changing its bytes. Edit it in the native application.",
    );
  }
}

export class Configuration {
  private readable = new Map<string, string>();
  private writing = false;
  constructor(
    private store: Store,
    private busy: () => boolean,
  ) {}
  private async destination(file: string): Promise<string> {
    let parent = path.dirname(file);
    const suffix = [path.basename(file)];
    while (!(await exists(parent))) {
      suffix.unshift(path.basename(parent));
      const next = path.dirname(parent);
      if (next === parent)
        throw new Error("Configuration has no existing parent directory.");
      parent = next;
    }
    return path.join(await realpath(parent), ...suffix);
  }
  async read(
    provider: Provider,
    project: Project | null,
    kind: "native" | "instructions",
  ): Promise<{ path: string; text: string; hash: string; ownership: string }> {
    let file: string;
    if (kind === "instructions") {
      if (!project)
        throw new Error("Choose a project for its instruction file.");
      file = await projectPath(
        project.realPath,
        provider === "codex" ? "AGENTS.md" : "CLAUDE.md",
      );
    } else if (project) {
      const directory = path.join(
        project.realPath,
        provider === "codex" ? ".codex" : ".claude",
      );
      if (
        (await exists(directory)) &&
        !isWithin(project.realPath, await realpath(directory))
      )
        throw new Error("Configuration directory escapes the project.");
      file = path.join(
        directory,
        provider === "codex" ? "config.toml" : "settings.json",
      );
    } else
      file = path.join(
        provider === "codex"
          ? (process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"))
          : (process.env.CLAUDE_CONFIG_DIR ??
              path.join(os.homedir(), ".claude")),
        provider === "codex" ? "config.toml" : "settings.json",
      );
    file = path.resolve(file);
    const text = await currentText(
      file,
      "Edit symlinked configuration in the native application. Topsl does not replace symlinks.",
    );
    const destination = await this.destination(file);
    if (project && !isWithin(project.realPath, destination))
      throw new Error("Configuration escapes the approved project.");
    this.readable.set(file, destination);
    return {
      path: file,
      text,
      hash: hash(text),
      ownership:
        "Provider-owned full text. Topsl writes only the exact reviewed file; runtime reload is unverified.",
    };
  }
  async preview(
    file: string,
    expectedHash: string,
    text: string,
  ): Promise<ConfigurationPlan> {
    if (!this.readable.has(file))
      throw new Error("Read this provider configuration through Topsl first.");
    assertWithinByteLimit(text);
    const before = await currentText(file, "Configuration became a symlink.");
    if (hash(before) !== expectedHash)
      throw new Error(
        "Configuration changed externally. Read it again before editing.",
      );
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(withoutMark(text));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Settings must contain a JSON object.");
    }
    if (file.endsWith(".toml")) parseToml(withoutMark(text));
    const value: ConfigurationPlan = {
      id: uid(),
      path: file,
      expectedHash,
      before,
      after: text,
      digest: "",
      createdAt: now(),
    };
    value.digest = hash(stable({ ...value, digest: "" }));
    this.store.immutable("configuration-plan", value);
    return value;
  }
  async apply(id: string, reviewedDigest: string): Promise<void> {
    if (this.writing || this.busy())
      throw new Error(
        "Close active native sessions before changing configuration.",
      );
    const plan = this.store.get<ConfigurationPlan>("configuration-plan", id);
    if (
      !plan ||
      plan.digest !== reviewedDigest ||
      plan.digest !== hash(stable({ ...plan, digest: "" }))
    )
      throw new Error("Configuration approval does not match this preview.");
    if (Date.now() - Date.parse(plan.createdAt) > 15 * 60_000)
      throw new Error("Configuration approval expired.");
    assertWithinByteLimit(plan.after);
    if (
      !this.readable.has(plan.path) ||
      this.store.get("configuration-write", id)
    )
      throw new Error(
        "Read the current file and make a new preview before applying.",
      );
    this.writing = true;
    let temporary: string | undefined;
    try {
      if ((await this.destination(plan.path)) !== this.readable.get(plan.path))
        throw new Error(
          "Configuration parent changed after preview. No file was written.",
        );
      const current = await currentText(
        plan.path,
        "Configuration became a symlink.",
      );
      if (hash(current) !== plan.expectedHash)
        throw new Error(
          "Configuration changed after approval. No file was written.",
        );
      this.store.transaction(() => {
        this.store.immutable("configuration-backup", {
          id,
          path: plan.path,
          content: current,
          createdAt: now(),
        });
        this.store.save("configuration-write", {
          id,
          path: plan.path,
          targetHash: hash(plan.after),
          state: "applying",
        });
      });
      await mkdir(path.dirname(plan.path), { recursive: true, mode: 0o700 });
      temporary = path.join(path.dirname(plan.path), `.topsl-${uid()}.tmp`);
      const staged = await open(temporary, "wx", 0o600);
      try {
        await staged.writeFile(plan.after);
        // The rename would otherwise leave an existing file with the staged
        // file's owner-only mode. A new file stays owner-only.
        const existing = await lstat(plan.path).catch(() => null);
        if (existing?.isFile()) await staged.chmod(existing.mode & 0o777);
        await staged.sync();
      } finally {
        await staged.close();
      }
      // A second read catches ordinary external editor changes during preview/apply.
      if (
        hash(
          await currentText(plan.path, "Configuration became a symlink."),
        ) !== plan.expectedHash
      )
        throw new Error(
          "An external writer changed configuration. The staged file was not applied.",
        );
      if ((await this.destination(plan.path)) !== this.readable.get(plan.path))
        throw new Error("Configuration parent changed during apply.");
      await rename(temporary, plan.path);
      temporary = undefined;
      this.store.save("configuration-write", {
        id,
        path: plan.path,
        targetHash: hash(plan.after),
        state: "written-unverified",
      });
    } finally {
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      this.writing = false;
    }
  }
  async reconcile(): Promise<void> {
    for (const entry of this.store
      .list<any>("configuration-write")
      .filter((e) => e.state === "applying")) {
      let state = "uncertain";
      try {
        const currentHash = hash(
          await currentText(entry.path, "Symlink changed."),
        );
        const plan = this.store.get<ConfigurationPlan>(
          "configuration-plan",
          entry.id,
        );
        state =
          currentHash === entry.targetHash
            ? "written-unverified"
            : currentHash === plan?.expectedHash
              ? "not-applied"
              : "uncertain";
      } catch {
        /* The file is unreadable or no longer bound to the reviewed source. */
      }
      this.store.save("configuration-write", { ...entry, state });
    }
  }
}
