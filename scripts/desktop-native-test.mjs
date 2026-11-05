import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { navigate, selectProject } from "./desktop-navigation.mjs";

// Native harness journey (docs/Native_Harness_Plan.md): the real Electron
// window, proxy utility process, control service, kernel, sandbox and
// candidate flow, against a synthetic external model service on loopback.
// The profile starts as a schema 1 proxy database holding a direct Claude
// plan connection (scripts/desktop-legacy-proxy-seed.cjs), so the real proxy
// upgrades it. No provider account or model is contacted; this does not
// qualify the ChatGPT plan route or any live model.
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-native-ui-"));
execFileSync(
  createRequire(import.meta.url)("electron"),
  [path.resolve("scripts/desktop-legacy-proxy-seed.cjs"), profile],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" },
);
const project = path.join(profile, "native-project");
await mkdir(path.join(project, "src"), { recursive: true });
await writeFile(
  path.join(project, "src/math.js"),
  "export function add(a, b) {\n  return a - b;\n}\n",
);
const git = (...args) =>
  execFileSync("git", args, {
    cwd: project,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
git("init", "-q");
git("add", ".");
git("commit", "-q", "-m", "fixture");

const KEY = "gw-synthetic-key-0123456789";
const requests = [];
const capabilityReads = [];
const chunk = (body) =>
  `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "upstream-model", ...body })}\n\n`;
const gateway = http.createServer(async (req, res) => {
  const parts = [];
  for await (const part of req) parts.push(part);
  if (req.method === "GET" && req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "upstream-model" }] }));
    return;
  }
  if (req.method === "GET") {
    // No optional capability document: capabilities stay unknown.
    capabilityReads.push(req.url);
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  requests.push({ authorization: req.headers.authorization, body });
  const tools = body.messages.filter((m) => m.role === "tool");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const call = (id, name, args) =>
    chunk({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }) +
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  if (tools.length === 0)
    res.write(call("call_read", "read_file", { path: "src/math.js" }));
  else if (tools.length === 1) {
    const sha = /sha256: ([a-f0-9]{64})/.exec(tools[0].content)?.[1];
    res.write(
      call("call_edit", "edit_file", {
        path: "src/math.js",
        old_text: "a - b",
        new_text: "a + b",
        expected_sha256: sha,
      }),
    );
  } else {
    res.write(
      chunk({
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "Fixed add() to return the sum.",
            },
            finish_reason: null,
          },
        ],
      }),
    );
    res.write(
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    );
  }
  res.write(
    chunk({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } }),
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${gateway.address().port}/v1`;

const env = { ...process.env, TOPSL_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  args: [
    ...(process.platform === "linux" && process.env.CI ? ["--no-sandbox"] : []),
    ".",
  ],
  env,
  timeout: 90_000,
});
const errors = [];
const dialogs = [];
let success = false;
try {
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(
    page.getByRole("button", { name: "Connections", exact: true }),
  ).toBeVisible({ timeout: 45_000 });
  await app.evaluate(({ dialog, shell }, project) => {
    globalThis.__dialogs = [];
    globalThis.__authUrls = [];
    // Observe built-in browser sign-in without contacting a live provider.
    shell.openExternal = async (url) => {
      globalThis.__authUrls.push(url);
    };
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [project],
    });
    dialog.showMessageBox = async (...args) => {
      globalThis.__dialogs.push(args.at(-1).message);
      return { response: 1, checkboxChecked: false };
    };
  }, project);
  await page.evaluate(() => window.topsl.command({ type: "project-add" }));
  // The proxy utility process starts after the vault opens.
  await expect
    .poll(
      async () =>
        !!(await page.evaluate(() => window.topsl.command({ type: "state" })))
          .proxy,
      { timeout: 30_000 },
    )
    .toBe(true);

  // Connections: the upgraded legacy Claude connection is history only.
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue with Claude" }),
  ).toHaveCount(0);
  await expect(page.getByText("Claude plan connection")).toHaveCount(0);
  const retired = page.getByRole("article", {
    name: "Retired connection Claude plan",
  });
  await expect(retired).toBeVisible();
  await expect(retired).toContainText(
    "Direct Claude subscription sign-in was removed from Topsl",
  );
  await expect(retired).toContainText("claude-plan/legacy");
  await expect(retired.getByRole("button", { name: /sign in/i })).toHaveCount(
    0,
  );
  await retired
    .getByRole("button", { name: "Recent requests", exact: true })
    .click();
  await expect(retired).toContainText("claude-plan/legacy · completed");
  expect(await app.evaluate(() => globalThis.__authUrls)).toEqual([]);

  // An external model service, its key from the clipboard, and a route.
  await expect(page.getByLabel("Protocol", { exact: true })).toHaveValue(
    "chat",
  );
  await expect(page.getByLabel("Authentication", { exact: true })).toHaveValue(
    "bearer",
  );
  await page.getByLabel("Inference base URL").fill(endpoint);
  await page
    .getByRole("button", { name: "Add external service", exact: true })
    .click();
  const card = page.getByRole("article", {
    name: "Connection External service",
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Managed by external service");
  await expect(card).toContainText("Key as a Bearer token");
  await app.evaluate(({ clipboard }, key) => clipboard.writeText(key), KEY);
  await card
    .getByRole("button", { name: "Paste key from clipboard", exact: true })
    .click();
  await expect(card.locator(".badge")).toHaveText("Ready");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("");
  await card.getByRole("button", { name: "List models", exact: true }).click();
  await expect(card.getByRole("combobox", { name: "Model" })).toBeVisible();
  await card
    .getByRole("combobox", { name: "Model" })
    .selectOption("upstream-model");
  await card.getByRole("button", { name: "Add route", exact: true }).click();
  await expect(card).toContainText("external/upstream-model");
  await card
    .getByRole("button", { name: "Read service capabilities", exact: true })
    .click();
  await expect(card).toContainText("Not published; capabilities stay unknown");
  await expect(
    card.getByLabel("Capabilities of external/upstream-model"),
  ).toContainText("Tool calls: unknown");
  expect(capabilityReads).toEqual(["/v1/gateway/capabilities"]);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/native-connections.png",
    fullPage: true,
  });

  // Native tasks: an edit task on a private copy, reviewed, then applied.
  await selectProject(page, "native-project");
  await navigate(page, "Native tasks");
  await expect(
    page.getByRole("heading", { name: "Native tasks", exact: true }),
  ).toBeVisible();
  const form = page.getByRole("region", { name: "Start a native task" });
  await form.getByLabel("Mode", { exact: true }).selectOption("edit");
  await form
    .getByLabel("Task", { exact: true })
    .fill("Fix add() in src/math.js");
  await form.getByRole("button", { name: "Start task", exact: true }).click();
  const detail = page.getByRole("region", {
    name: "Native task Fix add() in src/math.js",
  });
  await expect(detail.locator(".badge")).toHaveText("Completed", {
    timeout: 60_000,
  });
  await expect(detail).toContainText("Fixed add() to return the sum.");
  await expect(detail).toContainText("→ edit_file");
  expect(await readFile(path.join(project, "src/math.js"), "utf8")).toContain(
    "a - b",
  );
  await detail
    .getByRole("button", { name: "Review changes", exact: true })
    .click();
  await expect(detail).toContainText("modified src/math.js");
  await detail
    .getByRole("button", { name: "Apply to project folder", exact: true })
    .click();
  await expect
    .poll(async () => readFile(path.join(project, "src/math.js"), "utf8"), {
      timeout: 20_000,
    })
    .toContain("a + b");
  await page.screenshot({
    path: "test-results/native-tasks.png",
    fullPage: true,
  });

  dialogs.push(...(await app.evaluate(() => globalThis.__dialogs)));
  expect(dialogs).toContain("Start a native task?");
  expect(dialogs).toContain(
    "Apply this native task's changes to your project folder?",
  );
  expect(
    dialogs.some((d) => d.startsWith("Store the API key from the clipboard")),
  ).toBe(true);
  // The key never reached the window, and every request carried it upstream.
  const state = JSON.stringify(
    await page.evaluate(() => window.topsl.command({ type: "state" })),
  );
  expect(state).not.toContain(KEY);
  // The retired credential is gone; the descriptor kept no contact details.
  expect(state).not.toContain("synthetic-legacy-claude");
  expect(state).not.toContain("legacy-person@example.invalid");
  expect(requests).toHaveLength(3);
  expect(requests.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
  expect(errors).toEqual([]);
  success = true;
  console.log(
    "Native harness Electron journey passed: a schema 1 profile's direct Claude connection upgraded to a retired, history-only record with its receipt and no sign-in control; external model service with protocol and Bearer key, absent capability document, clipboard key, native edit/candidate/apply; keys and the retired credential absent from window state.",
  );
} finally {
  await app.close();
  gateway.close();
  if (!success)
    console.error(`Native journey failed; profile kept at ${profile}`);
}
