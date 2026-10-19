import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { verifyMacApp } from "./verify-mac-package.mjs";

if (process.platform !== "darwin")
  throw new Error("This inspection requires a local macOS package.");
const bundle = path.resolve(`release/mac-${process.arch}/Topsl.app`);
verifyMacApp(bundle);
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-packaged-atlas-"));
const output = path.resolve("test-results/atlas");
await mkdir(output, { recursive: true });
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.TOPSL_TEST_PROFILE;
delete environment.TOPSL_TEST_QUALIFICATION_DIR;
const app = await electron.launch({
  executablePath: path.join(bundle, "Contents/MacOS/Topsl"),
  args: [`--user-data-dir=${profile}`],
  env: environment,
  timeout: 90000,
});
try {
  const identity = await app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    userData: app.getPath("userData"),
    name: app.getName(),
    version: app.getVersion(),
    dockVisible: app.dock.isVisible(),
  }));
  expect(identity.packaged).toBe(true);
  expect(await realpath(identity.userData)).toBe(await realpath(profile));
  // Electron reports the package identifier here; the bundle/menu name is Topsl.
  expect(identity.name).toBe("topsl");
  const page = await app.firstWindow();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible({ timeout: 45000 });
  await page.screenshot({ path: path.join(output, "packaged-mac.png") });
  await writeFile(
    path.join(output, "packaged-report.json"),
    JSON.stringify(
      {
        ...identity,
        userData: "isolated disposable profile",
        recordedAt: new Date().toISOString(),
        scope:
          "Packaged startup, signed topsail resource and Dock visibility; no installation or provider execution",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `Packaged Atlas startup and signed topsail resource passed. Dock visible: ${identity.dockVisible}.`,
  );
  if (process.argv.includes("--hold")) {
    console.log(
      "Package remains open for native visual inspection. Send any line to close it.",
    );
    const input = createInterface({ input: process.stdin });
    await new Promise((resolve) => {
      input.once("line", resolve);
      input.once("close", resolve);
    });
    input.close();
  }
} finally {
  await app.close();
  await rm(profile, { recursive: true, force: true });
}
