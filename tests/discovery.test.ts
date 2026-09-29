import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describeInstallation } from "../packages/applications/discovery";
const directories: string[] = [];
async function directory() {
  const dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "topsl-test-discovery-")),
  );
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const d of directories.splice(0))
    await rm(d, { recursive: true, force: true });
});
test.skipIf(process.platform === "win32")(
  "Homebrew preserves installation identity while immutable executable revisions change",
  async () => {
    const d = await directory();
    const first = path.join(
      d,
      "Caskroom",
      "claude-code@latest",
      "1.0.0",
      "claude",
    );
    const second = path.join(
      d,
      "Caskroom",
      "claude-code@latest",
      "2.0.0",
      "claude",
    );
    await mkdir(path.dirname(first), { recursive: true });
    await mkdir(path.dirname(second), { recursive: true });
    await writeFile(first, "version one");
    await writeFile(second, "version two");
    const a = await describeInstallation("anthropic.claude-code-cli", first);
    const b = await describeInstallation("anthropic.claude-code-cli", second, [
      { ...a, trusted: true },
    ]);
    expect(a.id).toBe(b.id);
    expect(a.managementUnitId).toBe(b.managementUnitId);
    expect(a.revisionId).not.toBe(b.revisionId);
    expect(b.version).toBe("2.0.0");
    expect(b.channel).toBe("latest");
    expect(b.trusted).toBe(false);
  },
);
test("separate custom versions remain distinct and symlink aliases resolve to one identity", async () => {
  const d = await directory();
  const first = path.join(d, "codex-one");
  const second = path.join(d, "codex-two");
  const alias = path.join(d, "codex-alias");
  await writeFile(first, "one");
  await writeFile(second, "two");
  const a = await describeInstallation("openai.codex-cli", first);
  const b = await describeInstallation("openai.codex-cli", second);
  expect(a.id).not.toBe(b.id);
  if (process.platform !== "win32") {
    await symlink(first, alias);
    const c = await describeInstallation("openai.codex-cli", alias);
    expect(c.id).toBe(a.id);
  }
});
