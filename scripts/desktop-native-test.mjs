import { _electron as electron, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { navigate, selectProject } from "./desktop-navigation.mjs";

// Native harness journey (docs/Native_Harness_Plan.md): the real Electron
// window, proxy utility process, control service, kernel, sandbox and
// candidate flow, against a synthetic OpenAI-compatible gateway on loopback.
// No provider account or model is contacted; this does not qualify the
// ChatGPT plan route or any live model.
const profile = await mkdtemp(path.join(os.tmpdir(), "topsl-test-native-ui-"));
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

  // Connections: a gateway, its key from the clipboard, and a route.
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue with Claude", exact: true })
    .click();
  const claude = page.getByRole("article", { name: "Connection Claude plan" });
  await expect(
    claude.getByRole("button", { name: "Cancel sign-in", exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await app.evaluate(() => globalThis.__authUrls)).length)
    .toBe(1);
  const authUrl = new URL((await app.evaluate(() => globalThis.__authUrls))[0]);
  expect(authUrl.origin).toBe("https://claude.ai");
  const callback = new URL(authUrl.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", authUrl.searchParams.get("state"));
  callback.searchParams.set("error", "access_denied");
  await fetch(callback);
  await expect(claude).toContainText("Sign-in was declined");
  await claude
    .getByRole("button", { name: "Continue with Claude", exact: true })
    .click();
  await expect(
    claude.getByRole("button", {
      name: "Complete sign-in from clipboard",
      exact: true,
    }),
  ).toBeVisible();
  await claude
    .getByRole("button", { name: "Cancel sign-in", exact: true })
    .click();
  await expect(
    claude.getByRole("button", { name: "Cancel sign-in", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Gateway protocol")).toBeVisible();
  await page.getByLabel("Gateway base URL").fill(endpoint);
  await page.getByRole("button", { name: "Add gateway", exact: true }).click();
  const card = page.getByRole("article", { name: "Connection Gateway" });
  await expect(card).toBeVisible();
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
  await expect(card).toContainText("gateway/upstream-model");
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
  expect(requests).toHaveLength(3);
  expect(requests.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
  expect(errors).toEqual([]);
  success = true;
  console.log(
    "Native harness Electron journey passed: built-in Claude browser sign-in, declined callback and cancellation (no live provider); gateway connection, clipboard key, native edit/candidate/apply; key absent from window state.",
  );
} finally {
  await app.close();
  gateway.close();
  if (!success)
    console.error(`Native journey failed; profile kept at ${profile}`);
}
