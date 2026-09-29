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
import { exists, isWithin, projectPath, readBounded } from "../platform/system";
import { parse as parseToml } from "smol-toml";

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
    if ((await exists(file)) && (await lstat(file)).isSymbolicLink())
      throw new Error(
        "Edit symlinked configuration in the native application. Topsl does not replace symlinks.",
      );
    const text = (await exists(file)) ? await readBounded(file) : "";
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
    const before = (await exists(file)) ? await readBounded(file) : "";
    if (hash(before) !== expectedHash)
      throw new Error(
        "Configuration changed externally. Read it again before editing.",
      );
    if (file.endsWith(".json")) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Settings must contain a JSON object.");
    }
    if (file.endsWith(".toml")) parseToml(text);
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
      if (
        (await exists(plan.path)) &&
        (await lstat(plan.path)).isSymbolicLink()
      )
        throw new Error("Configuration became a symlink.");
      if ((await this.destination(plan.path)) !== this.readable.get(plan.path))
        throw new Error(
          "Configuration parent changed after preview. No file was written.",
        );
      const current = (await exists(plan.path))
        ? await readBounded(plan.path)
        : "";
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
        await staged.sync();
      } finally {
        await staged.close();
      }
      // A second read catches ordinary external editor changes during preview/apply.
      if (
        hash(
          (await exists(plan.path)) ? await readFile(plan.path, "utf8") : "",
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
        if (
          (await exists(entry.path)) &&
          (await lstat(entry.path)).isSymbolicLink()
        )
          throw new Error("Symlink changed.");
        const currentHash = hash(
          (await exists(entry.path)) ? await readBounded(entry.path) : "",
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
