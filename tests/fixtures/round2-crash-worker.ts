import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Store } from "../../packages/persistence/store";
import { CoordinationRepository } from "../../packages/persistence/repositories/coordination";
import { now } from "../../packages/domain/invariants";
import { captureCandidate } from "../../packages/workflows/candidates";
import { bindCheckInputs } from "../../packages/workflows/check-inputs";
import { previewCheck } from "../../packages/workflows/verification";
import { CheckExecutions } from "../../packages/workflows/check-executions";

/** Test-only coordinator killed by its parent after the durable ready barrier.
 * No native provider, account, production profile or network route is opened. */
async function main() {
  const input = JSON.parse(
    await readFile(process.env.TOPSL_CRASH_INPUT!, "utf8"),
  ) as { directory: string; key: string };
  const store = new Store(
      path.join(input.directory, "history.sqlite"),
      input.key,
    ),
    repository = new CoordinationRepository(store),
    source = path.join(input.directory, "crash-source"),
    marker = path.join(input.directory, "crash-effect.jsonl");
  await mkdir(source);
  await mkdir(path.join(source, "tests"));
  await writeFile(path.join(source, "value.js"), "export const value=1;\n");
  await writeFile(
    path.join(source, "tests/check.cjs"),
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,effect:'once'})+'\\n');console.log('abrupt-crash-check-ready');setInterval(()=>{},10000);\n`,
  );
  const project = {
    id: "crash-project",
    name: "Abrupt coordinator crash fixture",
    path: source,
    realPath: source,
    trusted: true,
    createdAt: now(),
  };
  store.put("project", project);
  const workspace = repository.ensureWorkspace(project),
    workflow = repository.createWorkflow({
      projectId: project.id,
      objective: "Retain uncertain execution after actual coordinator death",
      template: "fixture",
      templateVersion: "1",
    }),
    task = repository.createTask({
      projectId: project.id,
      workflowId: workflow.id,
      workspaceId: workspace.id,
      title: "One effect and durable ready barrier",
      role: "tester",
    });
  const candidate = await captureCandidate(store, {
    root: source,
    projectId: project.id,
    workflowId: workflow.id,
    selectedPaths: ["value.js", "tests/check.cjs"],
    gitExecutable: "missing-fixture-git",
  });
  const definition = {
    id: "abrupt-check",
    label: "Real check retained across abrupt coordinator death",
    executable: process.execPath,
    args: ["tests/check.cjs"],
    timeoutMs: 60_000,
  };
  bindCheckInputs(store, workflow.id, candidate, [definition]);
  const plan = await previewCheck(
      repository,
      workflow.id,
      task.id,
      candidate,
      definition,
    ),
    checks = new CheckExecutions(store);
  let announced = false;
  const poll = setInterval(() => {
    const execution = checks.list(project.id).executions[0];
    if (
      !announced &&
      execution?.state === "running" &&
      execution.lifecycle?.pid &&
      checks
        .inspect(project.id, execution.id)
        .logs.some((log) => log.text.includes("abrupt-crash-check-ready"))
    ) {
      announced = true;
      clearInterval(poll);
      process.send?.({
        type: "ready",
        projectId: project.id,
        executionId: execution.id,
        planId: plan.id,
        pid: execution.lifecycle.pid,
        groupId: execution.lifecycle.groupId,
        marker,
        source,
        workerPid: process.pid,
      });
    }
  }, 10);
  try {
    await checks.execute(repository, plan, plan.digest);
    if (!announced) throw new Error("Check completed before crash barrier");
  } finally {
    clearInterval(poll);
    await checks.shutdown();
    store.close();
  }
}
void main().catch((error) => {
  process.send?.({ type: "failure", error: String(error) });
  process.exitCode = 1;
});
