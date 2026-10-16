import { _electron as electron, expect } from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-round2-ui-"));
const output = path.resolve("test-results/round2-ui");
await mkdir(output, { recursive: true });
const entry = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{Coordination}from'${path.resolve("apps/desktop/renderer/coordination.tsx")}';
import'${path.resolve("apps/desktop/renderer/style.css")}';
function Fixture(){const[project,setProject]=useState('project'),[view,setView]=useState('overview');return <main style={{maxWidth:1100,margin:'auto',padding:20}}><label>Fixture project<select value={project} onChange={e=>setProject(e.target.value)}><option value="project">项目 Alpha · /tmp/路径</option><option value="other">Project Beta</option></select></label><Coordination key={project} projectId={project} view={view} onView={setView}/></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`;
await build({
  stdin: { contents: entry, loader: "tsx", resolveDir: process.cwd() },
  bundle: true,
  platform: "browser",
  format: "iife",
  outfile: path.join(directory, "ui.js"),
  jsx: "automatic",
});
await writeFile(
  path.join(directory, "index.html"),
  '<html><head><meta charset="UTF-8"><link rel="stylesheet" href="ui.css"></head><body><div id="root"></div><script src="ui.js"></script></body></html>',
);
await writeFile(
  path.join(directory, "preload.cjs"),
  `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('topsl',{command:async command=>{const result=await ipcRenderer.invoke('fixture:command',command);if(result.error)throw Error(result.error);return result.value},subscribe:callback=>{const fn=(_,value)=>callback(value);ipcRenderer.on('topsl:event',fn);return()=>ipcRenderer.removeListener('topsl:event',fn)}});`,
);
await writeFile(
  path.join(directory, "main.cjs"),
  await readFile(path.resolve("tests/fixtures/round2-ui-main.cjs"), "utf8"),
);
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    path.join(directory, "main.cjs"),
  ],
  env: environment,
});
const errors = [];
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  const setup = page.locator(".guided-workflow");
  await setup.locator("summary").first().focus();
  await page.keyboard.press("Space");
  await expect(
    setup.getByRole("heading", { name: "Goal", exact: true }),
  ).toBeVisible();
  await setup.getByRole("textbox", { name: "Objective", exact: true }).focus();
  await page.keyboard.type("修复 Alpha · preserve tracked assets");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Original tests pass\nBinary asset preserved");
  await setup.getByRole("button", { name: "Save draft", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    setup.getByText(/Protected draft revision 1 saved/),
  ).toBeVisible();
  await page.getByLabel("Fixture project").selectOption("other");
  await expect(setup).toHaveAttribute("data-project-id", "other");
  await setup.locator("summary").first().click();
  await expect(
    setup.getByRole("textbox", { name: "Objective", exact: true }),
  ).toHaveValue("");
  await setup
    .getByRole("textbox", { name: "Objective", exact: true })
    .fill("Beta draft");
  await setup.getByRole("button", { name: "Save draft", exact: true }).click();
  await page.getByLabel("Fixture project").selectOption("project");
  await expect(setup).toHaveAttribute("data-project-id", "project");
  await setup.locator("summary").first().click();
  await expect(
    setup.getByRole("textbox", { name: "Objective", exact: true }),
  ).toHaveValue("修复 Alpha · preserve tracked assets");
  await app.evaluate(() => {
    global.fixture.holdNextDraft = true;
  });
  await page.getByLabel("Fixture project").selectOption("other");
  await expect
    .poll(() => app.evaluate(() => global.fixture.heldDrafts.length))
    .toBe(1);
  await page.getByLabel("Fixture project").selectOption("project");
  await expect(setup).toHaveAttribute("data-project-id", "project");
  await setup.locator("summary").first().click();
  await expect(
    setup.getByRole("textbox", { name: "Objective", exact: true }),
  ).toHaveValue("修复 Alpha · preserve tracked assets");
  await app.evaluate(() => global.fixture.rejectHeldDraft());
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(
    page.getByText("Previous project draft failure", { exact: true }),
  ).toHaveCount(0);
  await setup
    .getByRole("button", { name: "Continue to Team", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    setup.getByRole("heading", { name: "Team", exact: true }),
  ).toBeFocused();
  await expect(
    setup.getByText(/Select a trusted builder runtime/),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(output, "guided-normal.png"),
    fullPage: true,
  });
  await app.evaluate(() => {
    global.fixture.runtimes = [
      {
        installation: {
          id: "fixture-codex",
          appId: "openai.codex-cli",
          trusted: true,
          version: "fixture",
          realPath: "/fixture/路径/codex",
        },
        capabilities: [],
      },
      {
        installation: {
          id: "fixture-claude",
          appId: "anthropic.claude-code-cli",
          trusted: true,
          version: "fixture",
          realPath: "/fixture/路径/claude",
        },
        capabilities: [],
      },
    ];
    global.fixture.notify();
  });
  const pairing =
    "Codex reviews Codex in a fresh, read-only session. This is not an independent second model.";
  await expect(setup.getByLabel("Team preset")).toHaveValue("codex:codex");
  await expect(setup.getByText(pairing, { exact: true })).toBeVisible();
  await setup.getByLabel("Team preset").selectOption("codex:claude");
  await expect(setup.getByText(pairing, { exact: true })).toHaveCount(0);
  await setup
    .getByLabel("Selected builder runtime")
    .selectOption("fixture-codex");
  await setup
    .getByLabel("Selected reviewer runtime")
    .selectOption("fixture-claude");
  await setup
    .locator("summary")
    .filter({ hasText: "Explicit assisted model intent" })
    .first()
    .click();
  await setup
    .locator("summary")
    .filter({ hasText: "Explicit assisted model intent" })
    .last()
    .click();
  await setup
    .getByRole("textbox", {
      name: "Unverified builder native model intent",
      exact: true,
    })
    .fill("explicit-native-builder");
  await setup
    .getByRole("textbox", {
      name: "Unverified reviewer native model intent",
      exact: true,
    })
    .fill("explicit-native-reviewer");
  await setup
    .getByRole("button", { name: "3. Environment", exact: true })
    .click();
  await setup
    .getByLabel("Preparation and check recipe")
    .selectOption("fixture-recipe");
  await setup
    .getByRole("button", { name: "5. Review and start", exact: true })
    .click();
  await expect(
    setup.getByRole("button", {
      name: "Capture coordinated workflow",
      exact: true,
    }),
  ).toBeDisabled();
  await setup
    .getByRole("button", { name: "Capture for assisted handoff", exact: true })
    .click();
  await expect(setup.getByText(/Workflow captured/)).toBeVisible();
  expect(
    await app.evaluate(() => ({
      providers: [
        global.fixture.lastCapture.builder.provider,
        global.fixture.lastCapture.reviewer.provider,
      ],
      models: [
        global.fixture.lastCapture.builder.model,
        global.fixture.lastCapture.reviewer.model,
      ],
      recipe: global.fixture.lastCapture.checks[0].environmentRecipeId,
    })),
  ).toEqual({
    providers: ["codex", "claude"],
    models: ["explicit-native-builder", "explicit-native-reviewer"],
    recipe: "fixture-recipe",
  });
  await expect(
    page.getByRole("button", {
      name: "Approve captured inputs and start",
      exact: true,
    }),
  ).toBeDisabled();
  await setup.getByRole("button", { name: "2. Team", exact: true }).click();
  await app.evaluate(() => {
    global.fixture.workflows = [
      global.fixture.workflow("Old delayed response"),
    ];
    global.fixture.holdNext = true;
    global.fixture.notify();
  });
  await expect
    .poll(() => app.evaluate(() => global.fixture.held.length))
    .toBe(1);
  await app.evaluate(() => {
    global.fixture.workflows = [
      global.fixture.workflow("Newest accepted response"),
    ];
    global.fixture.notify();
  });
  await expect(
    page.getByRole("heading", {
      name: "Newest accepted response",
      exact: true,
    }),
  ).toBeVisible();
  await app.evaluate(() => global.fixture.resolveHeld());
  await expect(
    page.getByRole("heading", { name: "Old delayed response", exact: true }),
  ).toHaveCount(0);
  await app.evaluate(() => {
    global.fixture.failSnapshots = true;
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText(/Fixture transport interrupted/).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Newest accepted response",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(output, "retained-data-error.png"),
    fullPage: true,
  });
  await app.evaluate(() => {
    global.fixture.failSnapshots = false;
    global.fixture.epoch = "restored-fixture";
    global.fixture.sequence = 1;
    global.fixture.workflows = [
      global.fixture.workflow("Restored vault evidence"),
    ];
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Restored vault evidence", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Fixture transport interrupted/)).toHaveCount(0);
  await app.evaluate(() => {
    global.fixture.workflows = [
      {
        ...global.fixture.workflow("Decision evidence fixture"),
        stage: "ready-repair",
      },
    ];
    global.fixture.notify();
  });
  await page
    .getByRole("button", { name: "Inspect changes and context", exact: true })
    .click();
  const evidence = page.getByRole("region", {
    name: "Workflow evidence",
    exact: true,
  });
  const files = evidence.getByRole("region", {
    name: "Candidate files",
    exact: true,
  });
  await expect(files.locator("button.evidence-file")).toHaveCount(100);
  await files
    .getByRole("textbox", { name: "Filter candidate files", exact: true })
    .fill("source-0999.ts");
  await expect(files.locator("button.evidence-file")).toHaveCount(1);
  await files
    .getByRole("textbox", { name: "Filter candidate files", exact: true })
    .fill("");
  await files
    .getByRole("button", { name: "Show next 100 candidate files", exact: true })
    .click();
  await expect(files.locator("button.evidence-file")).toHaveCount(200);
  await evidence
    .getByRole("button", { name: /high · Recorded defect/ })
    .focus();
  await page.keyboard.press("Enter");
  await expect(
    evidence.getByRole("heading", { name: "src/路径.ts", exact: true }),
  ).toBeFocused();
  await expect(
    evidence.getByLabel("Baseline lines for src/路径.ts"),
  ).toContainText("count = 1");
  await expect(
    evidence.getByLabel("Candidate lines for src/路径.ts"),
  ).toContainText("count = 0");
  await evidence
    .getByRole("textbox", { name: "Finding decision rationale", exact: true })
    .fill("Fixture assertion does not apply; retain the rationale.");
  await evidence
    .getByRole("button", { name: "Reject with rationale", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(evidence.getByText(/Recorded decision: rejected/)).toBeVisible();
  await evidence
    .getByRole("button", { name: /Original project test · uncertain/ })
    .click();
  await expect(evidence.getByLabel("Protected check log")).toContainText(
    "[redacted]",
  );
  await expect(
    evidence.getByRole("heading", {
      name: "Environment preparation · failed",
      exact: true,
    }),
  ).toBeVisible();
  await expect(evidence.getByLabel("Protected preparation log")).toContainText(
    "[redacted]",
  );
  await expect(
    evidence.getByText(
      "Environment preparation failed. This is separate from a failing candidate test.",
      { exact: true },
    ),
  ).toBeVisible();
  await evidence
    .getByRole("button", {
      name: "Reconcile original check lifecycle",
      exact: true,
    })
    .click();
  await evidence
    .getByRole("button", { name: "Retry cleanup only", exact: true })
    .click();
  await expect(
    evidence.getByText("Cleanup: completed", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(output, "finding-check-evidence.png"),
    fullPage: true,
  });
  await evidence.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "finding-check-detail.png"),
  });
  const artifacts = evidence.getByRole("region", {
    name: "Candidate artifact review",
    exact: true,
  });
  await artifacts
    .getByRole("textbox", {
      name: "Successful manual verification details for assets/图像.png",
      exact: true,
    })
    .fill("Fixture image bytes passed the declared visual comparison.");
  await expect(
    artifacts.getByRole("button", {
      name: "Review exact artifact decisions",
      exact: true,
    }),
  ).toBeDisabled();
  await artifacts
    .getByRole("checkbox", {
      name: "These exact bytes passed my manual verification: assets/图像.png",
      exact: true,
    })
    .check();
  await artifacts
    .getByRole("combobox", {
      name: "Output decision for src/新增.ts",
      exact: true,
    })
    .selectOption("approved");
  await artifacts
    .getByRole("button", {
      name: "Preview pinned binary assets/图像.png",
      exact: true,
    })
    .click();
  await expect
    .poll(() =>
      artifacts
        .getByRole("img", {
          name: "Pinned candidate image assets/图像.png",
          exact: true,
        })
        .evaluate((image) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await artifacts
    .getByRole("button", {
      name: "Review exact artifact decisions",
      exact: true,
    })
    .focus();
  await page.keyboard.press("Enter");
  const artifactPlan = artifacts.getByRole("region", {
    name: "Exact artifact decision plan",
    exact: true,
  });
  await expect(
    artifactPlan.getByRole("heading", {
      name: "Confirm exact candidate artifacts",
      exact: true,
    }),
  ).toBeFocused();
  expect(
    await app.evaluate(
      () =>
        global.fixture.calls.filter((type) => type === "candidate-review-apply")
          .length,
    ),
  ).toBe(0);
  await artifactPlan.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "artifact-approval-plan.png"),
  });
  await artifactPlan
    .getByRole("button", {
      name: "Continue to native artifact confirmation",
      exact: true,
    })
    .click();
  await expect(
    artifacts.getByText(/Native confirmation cancelled/),
  ).toBeVisible();
  expect(await app.evaluate(() => global.fixture.outputReviews.length)).toBe(0);
  await expect(artifactPlan).toBeVisible();
  await artifactPlan
    .getByRole("button", {
      name: "Continue to native artifact confirmation",
      exact: true,
    })
    .click();
  await expect(
    artifacts.getByText("src/新增.ts · approved · required", { exact: true }),
  ).toBeVisible();
  await expect(
    artifacts.getByText("assets/图像.png · manual verification recorded", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await app.evaluate(() =>
      Object.keys(global.fixture.lastArtifactApply).sort(),
    ),
  ).toEqual(["id", "projectId", "requestId", "type"]);
  await expect(
    artifacts.getByRole("heading", {
      name: "Output and binary review",
      exact: true,
    }),
  ).toBeFocused();
  await evidence
    .locator("summary")
    .filter({ hasText: "Initial context packages" })
    .click();
  await expect(
    evidence.getByText(/Additional pinned retrieval is required/),
  ).toBeVisible();
  await evidence
    .locator("summary")
    .filter({ hasText: "Context acknowledgements and retrieved evidence" })
    .click();
  await expect(
    evidence.getByText(/1 of 201 retrieval observations shown/),
  ).toBeVisible();
  await artifacts
    .getByRole("checkbox", {
      name: "Capture proposed output src/proposed.ts",
      exact: true,
    })
    .check();
  await artifacts
    .getByRole("button", { name: "Review narrow output capture", exact: true })
    .click();
  await artifactPlan
    .getByRole("button", {
      name: "Continue to native artifact confirmation",
      exact: true,
    })
    .click();
  await expect(artifacts).toHaveAttribute(
    "data-artifact-candidate",
    "candidate-captured",
  );
  await expect(
    artifacts.getByRole("combobox", {
      name: "Output decision for src/proposed.ts",
      exact: true,
    }),
  ).toHaveValue("");
  await expect(
    artifacts.getByText("src/proposed.ts · pending · required", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Start review of current candidate",
      exact: true,
    }),
  ).toBeDisabled();
  await artifacts
    .getByRole("heading", { name: "Output and binary review", exact: true })
    .focus();
  await evidence
    .locator(".section-heading")
    .first()
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.screenshot({ path: path.join(output, "candidate-recapture.png") });
  const latencySamples = [];
  for (let index = 0; index < 30; index++) {
    const prefix = `Latency sample ${index} @`;
    await page.evaluate((prefix) => {
      window.__round2Latency = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          observer.disconnect();
          reject(new Error("Selected-scope update timed out"));
        }, 5000);
        const observer = new MutationObserver(() => {
          const heading = [
            ...document.querySelectorAll(".workflow-card > h3"),
          ].find((element) => element.textContent.startsWith(prefix));
          if (!heading) return;
          const committedAt = Number(heading.textContent.slice(prefix.length));
          observer.disconnect();
          clearTimeout(timer);
          requestAnimationFrame(() =>
            requestAnimationFrame(() =>
              resolve({
                committedAt,
                observedAt: Date.now(),
                latencyMs: Date.now() - committedAt,
              }),
            ),
          );
        });
        observer.observe(document.documentElement, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
    }, prefix);
    await app.evaluate((_, prefix) => {
      global.fixture.workflows = [global.fixture.workflow(prefix + Date.now())];
      global.fixture.notify();
    }, prefix);
    latencySamples.push(await page.evaluate(() => window.__round2Latency));
  }
  const ordered = latencySamples
    .map((sample) => sample.latencyMs)
    .sort((a, b) => a - b);
  const latency = {
    version: 1,
    recordedAt: new Date().toISOString(),
    fixtureOnly: true,
    deliveryQualified: false,
    host: {
      platform: process.platform,
      architecture: process.arch,
      osRelease: os.release(),
      cpu: os.cpus()[0]?.model,
      runnerNode: process.version,
      runtime: await app.evaluate(() => ({
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      })),
    },
    workload: {
      selectedProjects: 1,
      availableProjects: 2,
      workflows: 1,
      candidateManifestPaths: 1004,
      renderedManifestPathLimit: 100,
      update: "one stored workflow objective and control event",
      observation: "production renderer DOM update plus two animation frames",
      transport:
        "isolated local Electron IPC fixture; no provider inference or network",
    },
    samples: latencySamples,
    p50Ms: ordered[Math.ceil(ordered.length * 0.5) - 1],
    p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1],
    maxMs: ordered.at(-1),
    targetP95Ms: 250,
  };
  await writeFile(
    path.join(output, "latency.json"),
    JSON.stringify(latency, null, 2) + "\n",
  );
  expect(latency.p95Ms).toBeLessThanOrEqual(250);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "night";
  });
  const nightBackground = await page.evaluate(
    () => getComputedStyle(document.documentElement).backgroundColor,
  );
  await artifacts
    .getByRole("heading", { name: "Output and binary review", exact: true })
    .focus();
  await page.screenshot({ path: path.join(output, "artifact-night.png") });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "system";
  });
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
  ).toBe(nightBackground);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "paper";
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(390, 844),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await setup.getByRole("heading", { name: "Team", exact: true }).focus();
  await page.screenshot({ path: path.join(output, "guided-compact.png") });
  await artifacts
    .getByRole("combobox", {
      name: "Output decision for src/proposed.ts",
      exact: true,
    })
    .selectOption("approved");
  await artifacts
    .getByRole("button", {
      name: "Review exact artifact decisions",
      exact: true,
    })
    .click();
  await artifactPlan.evaluate((element) =>
    element.scrollIntoView({ block: "start" }),
  );
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: path.join(output, "artifact-approval-compact.png"),
  });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
  );
  await expect
    .poll(() => page.evaluate(() => window.innerWidth))
    .toBeLessThan(300);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await setup.getByRole("heading", { name: "Team", exact: true }).focus();
  await setup
    .getByRole("heading", { name: "Team", exact: true })
    .evaluate((element) => element.scrollIntoView({ block: "start" }));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const enlarged = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64"),
  );
  await writeFile(
    path.join(output, "guided-enlarged.png"),
    Buffer.from(enlarged, "base64"),
  );
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(1);
    window.setContentSize(1280, 1000);
    global.fixture.tasks = ["task-a", "task-b"].map((id) => ({
      id,
      title: id === "task-a" ? "Inspect Unicode 项目" : "Alternate task",
      role: "planner",
      state: "ready",
      detail: "Fixture task evidence only",
      dependencies: [],
      acceptanceCriteria: [id],
      createdAt: "2026-10-15T00:00:00.000Z",
      updatedAt: "2026-10-15T00:00:00.000Z",
    }));
    global.fixture.holdTaskInspections = true;
    global.fixture.notify();
  });
  await page
    .getByRole("navigation", { name: "Project navigation" })
    .getByRole("button", { name: "Tasks", exact: true })
    .click();
  const taskA = page.getByRole("button", { name: /Inspect Unicode 项目/ }),
    taskB = page.getByRole("button", { name: /Alternate task/ }),
    taskInspector = page.getByRole("complementary", { name: "Task inspector" });
  await taskA.click();
  await taskB.click();
  await expect
    .poll(() => app.evaluate(() => global.fixture.taskInspections.length))
    .toBe(2);
  await app.evaluate(() => global.fixture.taskInspections[1].complete());
  await expect(taskInspector).toContainText("Evidence for task-b");
  await app.evaluate(() => global.fixture.taskInspections[0].complete());
  await expect(taskA).toBeEnabled();
  await expect(taskInspector).not.toContainText("Evidence for task-a");
  await taskA.click();
  await expect
    .poll(() => app.evaluate(() => global.fixture.taskInspections.length))
    .toBe(3);
  await app.evaluate(() => global.fixture.notify());
  await expect
    .poll(() => app.evaluate(() => global.fixture.taskInspections.length))
    .toBe(4);
  await app.evaluate(() => global.fixture.taskInspections[2].complete());
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  await expect(taskA).toBeDisabled();
  await app.evaluate(() => global.fixture.taskInspections[3].complete());
  await expect(taskA).toBeEnabled();
  await expect(taskInspector).toContainText("Evidence for task-a");
  await expect(taskInspector).not.toContainText("Evidence for task-b");
  await taskA.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(output, "task-inspection-recovery.png"),
  });
  expect(errors).toEqual([]);
  expect(
    await app.evaluate(() =>
      global.fixture.calls.some(
        (type) => type === "builder-reviewer-advance" || type === "run-start",
      ),
    ),
  ).toBe(false);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        scope: "isolated renderer fixtures; no live provider qualification",
        assertions: [
          "keyboard draft setup",
          "project draft isolation",
          "late previous-project error isolation",
          "blocked coordinated route and explicit assisted capture",
          "same-project response ordering",
          "retained refresh errors",
          "epoch restore recovery",
          "finding decision keyboard navigation and rationale",
          "protected logs, lifecycle reconciliation and cleanup without rerun",
          "bounded large manifest and pinned context retrieval feedback",
          "affirmative manual binary attestation and exact-hash artifact approval with native cancel",
          "new output capture creates a fresh candidate requiring review",
          "Paper, Night and System themes",
          "compact and enlarged reduced-motion layout",
          "task selection pending recovery and same-task overlapping read fencing",
        ],
        latency: {
          p50Ms: latency.p50Ms,
          p95Ms: latency.p95Ms,
          maxMs: latency.maxMs,
          samples: latency.samples.length,
          targetP95Ms: latency.targetP95Ms,
          report: path.join(output, "latency.json"),
        },
        screenshots: output,
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
  await rm(directory, { recursive: true, force: true });
}
