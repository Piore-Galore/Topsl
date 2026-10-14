import { afterEach, expect, test } from "vitest";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fixture } from "./helpers";
import {
  captureCandidate,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import {
  assertCheckInputs,
  bindCheckInputs,
} from "../packages/workflows/check-inputs";
import {
  executeCheck,
  previewCheck,
  type CheckDefinition,
} from "../packages/workflows/verification";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const definition: CheckDefinition = {
  id: "acceptance",
  label: "Fixed acceptance protocol",
  executable: process.execPath,
  args: ["--test"],
  timeoutMs: 1000,
};
const packageDefinition: CheckDefinition = {
  ...definition,
  executable: "/tools/npm",
  args: ["run", "check"],
};
const manifest = [
  "src/value.js",
  "tests/accept.test.js",
  "scripts/check.mjs",
  "package.json",
];
const packageData = {
  scripts: { check: "npm test", test: "node --test", build: "node build.mjs" },
  dependencies: {},
};
async function setup(check = definition) {
  const f = await fixture();
  fixtures.push(f);
  await mkdir(path.join(f.directory, "src"));
  await mkdir(path.join(f.directory, "tests"));
  await mkdir(path.join(f.directory, "scripts"));
  await writeFile(
    path.join(f.directory, "src/value.js"),
    "export const value = 1;\n",
  );
  await writeFile(
    path.join(f.directory, "tests/accept.test.js"),
    "assert.equal(value, 2);\n",
  );
  await writeFile(
    path.join(f.directory, "scripts/check.mjs"),
    "runDeclaredChecks();\n",
  );
  await writeFile(
    path.join(f.directory, "package.json"),
    JSON.stringify(packageData),
  );
  const capture = (paths = manifest): Promise<CandidateSnapshot> =>
    captureCandidate(f.store, {
      root: f.directory,
      projectId: "p",
      workflowId: "w",
      selectedPaths: paths,
    });
  const baseline = await capture();
  bindCheckInputs(f.store, "w", baseline, [check]);
  return { ...f, capture, baseline, check };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("source changes and added tests keep the original acceptance protocol", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.directory, "src/value.js"),
    "export const value = 2;\n",
  );
  await writeFile(
    path.join(f.directory, "tests/additional.test.js"),
    "assert.equal(typeof value, 'number');\n",
  );
  const candidate = await f.capture([...manifest, "tests/additional.test.js"]);
  expect(() =>
    assertCheckInputs(f.store, "w", candidate, definition),
  ).not.toThrow();
  expect(() =>
    bindCheckInputs(f.store, "w", f.baseline, [definition]),
  ).not.toThrow();
});

test.each(["tests/accept.test.js", "scripts/check.mjs"])(
  "weakening %s cannot substantiate an accepted candidate",
  async (file) => {
    const f = await setup();
    await writeFile(path.join(f.directory, file), "process.exit(0);\n");
    const candidate = await f.capture();
    expect(() =>
      assertCheckInputs(f.store, "w", candidate, definition),
    ).toThrow("Required acceptance inputs changed");
  },
);

test("removing tests or replacing the command cannot silently redefine acceptance", async () => {
  const f = await setup();
  await rm(path.join(f.directory, "tests/accept.test.js"));
  const candidate = await f.capture();
  expect(() => assertCheckInputs(f.store, "w", candidate, definition)).toThrow(
    "Required acceptance inputs changed",
  );
  expect(() =>
    assertCheckInputs(f.store, "w", f.baseline, {
      ...definition,
      args: ["-e", "process.exit(0)"],
    }),
  ).toThrow("definition changed");
});

test("dependency edits and new scripts are allowed while an indirect check script stays frozen", async () => {
  const f = await setup(packageDefinition);
  await writeFile(
    path.join(f.directory, "package.json"),
    JSON.stringify({
      scripts: { ...packageData.scripts, extra: "node extra.mjs" },
      dependencies: { library: "1.0.0" },
    }),
  );
  const allowed = await f.capture();
  expect(() =>
    assertCheckInputs(f.store, "w", allowed, packageDefinition),
  ).not.toThrow();
  await writeFile(
    path.join(f.directory, "package.json"),
    JSON.stringify({
      ...packageData,
      scripts: { ...packageData.scripts, test: "node -e 'process.exit(0)'" },
    }),
  );
  const weakened = await f.capture();
  expect(() =>
    assertCheckInputs(f.store, "w", weakened, packageDefinition),
  ).toThrow("package-script check changed");
});

test("a different project/workflow or a replacement baseline is rejected", async () => {
  const f = await setup();
  expect(() =>
    assertCheckInputs(f.store, "other", f.baseline, definition),
  ).toThrow("no approved input protocol");
  expect(() =>
    assertCheckInputs(
      f.store,
      "w",
      { ...f.baseline, projectId: "other" },
      definition,
    ),
  ).toThrow("no approved input protocol");
  const replacement = await f.capture();
  expect(() =>
    bindCheckInputs(f.store, "w", replacement, [definition]),
  ).toThrow("Immutable record collision");
});

test("an explicitly selected root check script is frozen, including a dot-relative argument", async () => {
  const f = await setup(),
    paths = [...manifest, "check.cjs"];
  await writeFile(
    path.join(f.directory, "check.cjs"),
    "assert.equal(value, 2);\n",
  );
  const baseline = await f.capture(paths),
    check = { ...definition, id: "root-script", args: ["./check.cjs"] };
  bindCheckInputs(f.store, "w", baseline, [check]);
  await writeFile(path.join(f.directory, "check.cjs"), "process.exit(0);\n");
  const candidate = await f.capture(paths);
  expect(() => assertCheckInputs(f.store, "w", candidate, check)).toThrow(
    "check.cjs",
  );
});

test("omitted or external check harnesses cannot be authored after the approved baseline", async () => {
  const f = await setup();
  await writeFile(path.join(f.directory, "harness.cjs"), "process.exit(0);\n");
  for (const script of [
    "./harness.cjs",
    "tests/missing.test.js",
    path.join(path.dirname(f.directory), "external.py"),
  ]) {
    const check = { ...definition, id: script, args: [script] };
    expect(() => bindCheckInputs(f.store, "w", f.baseline, [check])).toThrow(
      "absent from the approved capture",
    );
  }
});

test("arbitrary harness names and selected check configuration stay frozen", async () => {
  const f = await setup();
  await writeFile(
    path.join(f.directory, "harness.cjs"),
    "assert.equal(value, 2);\n",
  );
  await writeFile(
    path.join(f.directory, "vitest.config.ts"),
    "export default { test: { include: ['tests/**'] } };\n",
  );
  const paths = [...manifest, "harness.cjs", "vitest.config.ts"],
    baseline = await f.capture(paths);
  const harness = {
    ...definition,
    id: "arbitrary-harness",
    args: ["harness.cjs"],
  };
  const configured = {
    ...definition,
    id: "configured",
    args: ["--config=vitest.config.ts"],
  };
  bindCheckInputs(f.store, "w", baseline, [harness, configured]);
  await writeFile(path.join(f.directory, "harness.cjs"), "process.exit(0);\n");
  const changedHarness = await f.capture(paths);
  expect(() =>
    assertCheckInputs(f.store, "w", changedHarness, harness),
  ).toThrow("Required acceptance inputs changed");
  await writeFile(
    path.join(f.directory, "vitest.config.ts"),
    "export default { test: { include: [] } };\n",
  );
  const candidate = await f.capture(paths);
  expect(() => assertCheckInputs(f.store, "w", candidate, configured)).toThrow(
    "Required acceptance inputs changed",
  );
});

test("two callers racing one approved check execute only one actual process", async () => {
  const f = await setup(),
    marker = path.join(f.directory, "check-executions.txt");
  const check: CheckDefinition = {
    ...definition,
    id: "single-dispatch",
    args: [
      "-e",
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'executed'+String.fromCharCode(10))`,
    ],
  };
  const repository = new CoordinationRepository(f.store);
  const project = {
    id: "p",
    name: "Race fixture",
    path: f.directory,
    realPath: f.directory,
    trusted: true,
    createdAt: new Date().toISOString(),
  };
  f.store.put("project", project);
  const workspace = repository.ensureWorkspace(project);
  const workflow = repository.createWorkflow({
    projectId: "p",
    objective: "Execute the approved check once",
    template: "fixture",
    templateVersion: "1",
  });
  let task = repository.createTask({
    projectId: "p",
    workflowId: workflow.id,
    workspaceId: workspace.id,
    title: "Run the pinned check",
    role: "tester",
  });
  task = repository.transitionTask(task.id, task.revision, "ready");
  task = repository.transitionTask(task.id, task.revision, "active");
  const baseline = await captureCandidate(f.store, {
    root: f.directory,
    projectId: "p",
    workflowId: workflow.id,
    selectedPaths: manifest,
  });
  bindCheckInputs(f.store, workflow.id, baseline, [check]);
  const plan = await previewCheck(
    repository,
    workflow.id,
    task.id,
    baseline,
    check,
  );
  const results = await Promise.allSettled([
    executeCheck(repository, plan, plan.digest),
    executeCheck(repository, plan, plan.digest),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const refused = results.find(
    (result) => result.status === "rejected",
  ) as PromiseRejectedResult;
  expect(refused.reason.message).toContain("already been consumed");
  expect(await readFile(marker, "utf8")).toBe("executed\n");
  expect(f.store.page("verification", { projectId: "p" }).items).toHaveLength(
    1,
  );
  expect(
    f.store.page<any>("protected-check-output", { projectId: "p" }).items[0]
      .resourceId,
  ).toBeTruthy();
});
