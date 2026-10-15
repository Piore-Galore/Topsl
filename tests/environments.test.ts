import { afterEach, expect, test, vi } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { fixture } from "./helpers";
import { now } from "../packages/domain/invariants";
import { runFile } from "../packages/platform/system";
import { CoordinationRepository } from "../packages/persistence/repositories/coordination";
import { captureCandidate } from "../packages/workflows/candidates";
import { bindCheckInputs } from "../packages/workflows/check-inputs";
import { CheckExecutions } from "../packages/workflows/check-executions";
import {
  previewCheck,
  reuseCheckAuthorization,
  type CheckDefinition,
} from "../packages/workflows/verification";
import {
  environmentSelection,
  PreparedEnvironments,
  type EnvironmentHook,
  type EnvironmentSelection,
} from "../packages/workflows/environments";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function tools() {
  const node = await realpath(
    process.env.npm_node_execpath ?? process.execPath,
  );
  const npm = await realpath(
    process.env.npm_execpath ??
      path.join(path.dirname(node), "node_modules/npm/bin/npm-cli.js"),
  );
  return { node, npm };
}
async function setup(
  options: {
    locked?: boolean;
    hooks?: EnvironmentHook[];
    hasHook?: boolean;
    missingRegistry?: boolean;
    script?: string;
    policy?: CheckDefinition["executionPolicy"];
    writablePaths?: string[];
    preparationTimeoutMs?: number;
  } = {},
) {
  const f = await fixture(),
    source = path.join(f.directory, "source"),
    repository = new CoordinationRepository(f.store),
    runtime = await tools();
  await mkdir(source);
  await mkdir(path.join(source, "tests"));
  const project = {
    id: "p",
    name: "Environment fixture",
    path: source,
    realPath: source,
    trusted: true,
    createdAt: now(),
  };
  f.store.put("project", project);
  const workspace = repository.ensureWorkspace(project),
    workflow = repository.createWorkflow({
      projectId: "p",
      objective: "Offline ordinary dependency fixture",
      template: "fixture",
      templateVersion: "1",
    }),
    task = repository.createTask({
      projectId: "p",
      workflowId: workflow.id,
      workspaceId: workspace.id,
      title: "Check",
      role: "tester",
    });
  const paths = ["tests/check.cjs", "src.cjs", "package.json"];
  await writeFile(path.join(source, "src.cjs"), "module.exports=42;\n");
  await writeFile(
    path.join(source, "tests/check.cjs"),
    options.script ??
      (options.locked
        ? "const assert=require('node:assert/strict');assert.equal(require('fixture-value'),42);assert(!require('node:fs').existsSync('node_modules/host-only.cjs'));assert(!process.env.OPENAI_API_KEY);assert(!process.env.CODEX_HOME);console.log('ordinary-check-passed');"
        : "const assert=require('node:assert/strict');assert.equal(require('../src.cjs'),42);console.log('self-contained-check-passed');"),
  );
  const manifest: any = {
    name: "ordinary-fixture",
    version: "1.0.0",
    scripts: { check: "node tests/check.cjs" },
  };
  if (options.locked) {
    const packageRoot = path.join(f.directory, "package");
    await mkdir(packageRoot);
    await mkdir(path.join(source, "vendor"));
    await writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "fixture-value",
        version: "1.0.0",
        main: "index.cjs",
        ...(options.hasHook
          ? {
              scripts: { postinstall: "node -e 'throw Error(\"unreviewed\")'" },
            }
          : {}),
      }),
    );
    await writeFile(
      path.join(packageRoot, "index.cjs"),
      "module.exports=42;\n",
    );
    await runFile(
      runtime.node,
      [
        runtime.npm,
        "pack",
        "--offline",
        "--ignore-scripts",
        "--pack-destination",
        path.join(source, "vendor"),
      ],
      {
        cwd: packageRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } as Record<
          string,
          string
        >,
      },
    );
    const archive = "vendor/fixture-value-1.0.0.tgz",
      bytes = await readFile(path.join(source, archive));
    const integrity =
      "sha512-" + createHash("sha512").update(bytes).digest("base64");
    manifest.dependencies = {
      "fixture-value": options.missingRegistry ? "1.0.0" : "file:" + archive,
    };
    const lock = {
      name: manifest.name,
      version: manifest.version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: manifest.name,
          version: manifest.version,
          dependencies: manifest.dependencies,
        },
        "node_modules/fixture-value": {
          version: "1.0.0",
          resolved: options.missingRegistry
            ? "https://registry.invalid/fixture-value.tgz"
            : "file:" + archive,
          integrity,
          ...(options.hasHook ? { hasInstallScript: true } : {}),
        },
      },
    };
    await writeFile(
      path.join(source, "package-lock.json"),
      JSON.stringify(lock),
    );
    paths.push("package-lock.json", archive);
    // Deliberately poisoned live dependencies must never enter the execution.
    await mkdir(path.join(source, "node_modules"));
    await writeFile(
      path.join(source, "node_modules/host-only.cjs"),
      "throw Error('host dependency copied');",
    );
  }
  await writeFile(path.join(source, "package.json"), JSON.stringify(manifest));
  const selection = environmentSelection(f.store, {
    projectId: "p",
    label: "Reviewed fixture",
    kind: options.locked ? "locked-node" : "self-contained",
    profile: "user-approved-local",
    nodeExecutable: runtime.node,
    ...(options.locked ? { npmCli: runtime.npm } : {}),
    preparationTimeoutMs: options.preparationTimeoutMs ?? 10000,
    writablePaths: options.writablePaths ?? [],
    hooks: options.hooks ?? [],
    values: {},
  });
  const candidate = await captureCandidate(f.store, {
    root: source,
    projectId: "p",
    workflowId: workflow.id,
    selectedPaths: paths,
  });
  const definition: CheckDefinition = {
    id: "check",
    label: "Ordinary project check",
    executable: runtime.node,
    args: options.locked ? [runtime.npm, "run", "check"] : ["tests/check.cjs"],
    timeoutMs: 5000,
    environmentRecipeId: selection.id,
    ...(options.policy ? { executionPolicy: options.policy } : {}),
  };
  bindCheckInputs(f.store, workflow.id, candidate, [definition]);
  const plan = await previewCheck(
    repository,
    workflow.id,
    task.id,
    candidate,
    definition,
  );
  cleanups.push(async () => {
    await CheckExecutions.for(f.store).shutdown();
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  return {
    ...f,
    source,
    repository,
    project,
    workflow,
    task,
    candidate,
    definition,
    plan,
    selection,
    runtime,
    paths,
  };
}

test("R2-AT-25: fresh locked dependencies run an actual project check without live developer dependencies or credential homes", async () => {
  vi.stubEnv("OPENAI_API_KEY", "fixture-provider-secret");
  vi.stubEnv("CODEX_HOME", "/fixture/provider-home");
  const f = await setup({ locked: true }),
    checks = CheckExecutions.for(f.store);
  const verification = await checks.execute(
    f.repository,
    f.plan,
    f.plan.digest,
  );
  expect(verification.result, checks.list("p").executions[0].error ?? "").toBe(
    "passed",
  );
  const inspected = checks.inspect("p", checks.list("p").executions[0].id);
  expect(inspected.environment?.instance).toMatchObject({
    state: "ready",
    candidateId: f.candidate.id,
    recipeDigest: f.plan.environmentRecipe!.digest,
  });
  expect(inspected.environment?.instance.dependencyIdentity).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(inspected.environment?.logs.map((l) => l.text).join("")).toContain(
    '"--offline","--ignore-scripts"',
  );
  expect(inspected.logs.map((l) => l.text).join("")).toContain(
    "ordinary-check-passed",
  );
  expect(inspected.cleanup?.state).toBe("completed");
  expect(f.plan.environmentRecipe!.restrictions.cpuMemory).toBe("not-enforced");
});

test.each([{ missingRegistry: true }, { hasHook: true }])(
  "R2-AT-26: dependency miss or unreviewed hook is environment failure, separate from candidate failure (%j)",
  async (options) => {
    const f = await setup({ locked: true, ...options }),
      checks = CheckExecutions.for(f.store);
    expect(
      (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
    ).toBe("error");
    const execution = checks.list("p").executions[0],
      env = checks.inspect("p", execution.id).environment!;
    expect(execution.failurePhase).toBe("environment");
    if (!options.hasHook)
      expect(execution.lifecycle?.pid ?? null).not.toBeNull();
    expect(env.instance.state).toBe("failed");
    expect(env.instance.failureKind).toBe(
      options.hasHook ? "policy" : "preparation",
    );
    expect(
      checks
        .inspect("p", execution.id)
        .logs.map((l) => l.text)
        .join(""),
    ).not.toContain("ordinary-check-passed");
  },
);

test("R2-AT-26: exact reviewed package hook can prepare generated dependencies; timeout remains environment failure", async () => {
  const runtime = await tools();
  const hook: EnvironmentHook = {
    packagePath: "node_modules/fixture-value",
    executable: runtime.node,
    args: [
      "-e",
      "require('fs').writeFileSync('generated.cjs','module.exports=42')",
    ],
    timeoutMs: 5000,
  };
  const f = await setup({
      locked: true,
      hasHook: true,
      hooks: [hook],
      script:
        "require('node:assert/strict').equal(require('fixture-value/generated.cjs'),42);",
    }),
    checks = CheckExecutions.for(f.store);
  expect(
    (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
  ).toBe("passed");
  const timed = await setup({
      locked: true,
      hasHook: true,
      hooks: [
        { ...hook, args: ["-e", "setInterval(()=>{},10000)"], timeoutMs: 100 },
      ],
    }),
    timedChecks = CheckExecutions.for(timed.store);
  expect(
    (await timedChecks.execute(timed.repository, timed.plan, timed.plan.digest))
      .result,
  ).toBe("error");
  const env = timedChecks.inspect(
    "p",
    timedChecks.list("p").executions[0].id,
  ).environment!;
  expect(env.instance).toMatchObject({
    state: "failed",
    failureKind: "timeout",
  });
  expect(env.instance.preparationLifecycle?.state).toBe("quiescent");
  expect(timed.store.list("environment-dispatch-intent")).toHaveLength(4);
});

test("R2-AT-27: lockfile changes alter recipe identity; modified dependency contents invalidate a run", async () => {
  const f = await setup({ locked: true });
  const lock = JSON.parse(
    await readFile(path.join(f.source, "package-lock.json"), "utf8"),
  );
  lock.packages[""].license = "MIT";
  await chmod(path.join(f.source, "package-lock.json"), 0o600);
  await writeFile(
    path.join(f.source, "package-lock.json"),
    JSON.stringify(lock),
  );
  const candidate = await captureCandidate(f.store, {
    root: f.source,
    projectId: "p",
    workflowId: f.workflow.id,
    selectedPaths: f.paths,
  });
  const plan = await previewCheck(
    f.repository,
    f.workflow.id,
    f.task.id,
    candidate,
    f.definition,
  );
  expect(plan.environmentRecipe!.digest).not.toBe(
    f.plan.environmentRecipe!.digest,
  );
  const tampered = new CheckExecutions(f.store, {
    beforeDispatch: async (execution) => {
      await writeFile(
        path.join(
          execution.materializedRoot,
          "node_modules/fixture-value/index.cjs",
        ),
        "module.exports=0;",
      );
    },
  });
  expect((await tampered.execute(f.repository, plan, plan.digest)).result).toBe(
    "error",
  );
  expect(tampered.list("p").executions[0].failurePhase).toBe("integrity");
  expect(tampered.list("p").executions[0].error).toContain(
    "dependency contents changed",
  );
  await tampered.shutdown();
});

test("R2-AT-27: preview is read-only even when selected npm CLI is an executable sentinel", async () => {
  const f = await setup({ locked: true }),
    sentinel = path.join(f.directory, "sentinel-tool/bin/npm-cli.js"),
    marker = path.join(f.directory, "must-not-execute");
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(
    sentinel,
    `require('fs').writeFileSync(${JSON.stringify(marker)},'unapproved');`,
  );
  const selection = environmentSelection(f.store, {
    ...f.selection,
    id: undefined,
    version: undefined,
    createdAt: undefined,
    npmCli: sentinel,
  } as unknown as Omit<EnvironmentSelection, "version" | "id" | "createdAt">);
  const definition = {
    ...f.definition,
    id: "sentinel-check",
    args: ["tests/check.cjs"],
    environmentRecipeId: selection.id,
  };
  bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
  await previewCheck(
    f.repository,
    f.workflow.id,
    f.task.id,
    f.candidate,
    definition,
  );
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["src.cjs", "tests/check.cjs"])(
  "R2-AT-28: persistent source/harness mutation invalidates success (%s)",
  async (target) => {
    const f = await setup({
        script: `const fs=require('fs');fs.chmodSync(${JSON.stringify(target)},0o600);fs.writeFileSync(${JSON.stringify(target)},'module.exports=0;');console.log('returned-zero');`,
      }),
      checks = CheckExecutions.for(f.store);
    expect(
      (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
    ).toBe("error");
    expect(checks.list("p").executions[0]).toMatchObject({
      eligibility: "ineligible",
      failurePhase: "integrity",
    });
    expect(await readFile(path.join(f.source, target), "utf8")).not.toBe(
      "module.exports=0;",
    );
  },
);

test("R2-AT-28: reviewed build outputs are allowed; unapproved shadow scripts are invalid", async () => {
  const script =
    "const fs=require('fs');fs.mkdirSync('build');fs.writeFileSync('build/output.cjs','module.exports=42');";
  const f = await setup({ script, writablePaths: ["build"] }),
    checks = CheckExecutions.for(f.store);
  expect(
    (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
  ).toBe("passed");
  const shadow = await setup({
      script:
        "require('fs').writeFileSync('shadow.test.cjs','process.exit(0)')",
    }),
    other = CheckExecutions.for(shadow.store);
  expect(
    (await other.execute(shadow.repository, shadow.plan, shadow.plan.digest))
      .result,
  ).toBe("error");
  expect(other.list("p").executions[0].error).toContain(
    "Unexpected execution output",
  );
});

test("R2-AT-29: concurrent checks have separate database, port, home, cache and output resources", async () => {
  const script =
    "const fs=require('fs');fs.mkdirSync('build');fs.writeFileSync('build/result.json',JSON.stringify({database:process.env.TOPSL_TASK_DATABASE,port:process.env.TOPSL_TASK_PORT,home:process.env.HOME}));fs.writeFileSync(process.env.TOPSL_TASK_DATABASE,'test-only-db');console.log(JSON.stringify({database:process.env.TOPSL_TASK_DATABASE,port:process.env.TOPSL_TASK_PORT,home:process.env.HOME}));";
  const a = await setup({ script, writablePaths: ["build"] }),
    b = await setup({ script, writablePaths: ["build"] });
  const ac = CheckExecutions.for(a.store),
    bc = CheckExecutions.for(b.store);
  expect(
    (
      await Promise.all([
        ac.execute(a.repository, a.plan, a.plan.digest),
        bc.execute(b.repository, b.plan, b.plan.digest),
      ])
    ).map((v) => v.result),
  ).toEqual(["passed", "passed"]);
  const ai = ac.inspect("p", ac.list("p").executions[0].id),
    bi = bc.inspect("p", bc.list("p").executions[0].id);
  const av = JSON.parse(
      ai.logs
        .filter((l) => l.stream === "stdout")
        .map((l) => l.text)
        .join(""),
    ),
    bv = JSON.parse(
      bi.logs
        .filter((l) => l.stream === "stdout")
        .map((l) => l.text)
        .join(""),
    );
  expect(av.database).not.toBe(bv.database);
  expect(av.port).not.toBe(bv.port);
  expect(av.home).not.toBe(bv.home);
  expect(ai.environment!.instance.cacheRoot).not.toBe(
    bi.environment!.instance.cacheRoot,
  );
  expect(ai.execution.lifecycle?.state).toBe("quiescent");
  expect(ai.cleanup?.state).toBe("completed");
});

test("R2-AT-30: bounded authorization creates new executions and fails exhausted, changed, expired or revoked reuse", async () => {
  const f = await setup({
      policy: { maximumUses: 2, allowCandidateChanges: true },
    }),
    checks = CheckExecutions.for(f.store);
  expect(
    (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
  ).toBe("passed");
  await writeFile(
    path.join(f.source, "src.cjs"),
    "module.exports=42; // repaired\n",
  );
  const candidate = await captureCandidate(f.store, {
    root: f.source,
    projectId: "p",
    workflowId: f.workflow.id,
    selectedPaths: f.paths,
  });
  const reused = await reuseCheckAuthorization(
    f.store,
    f.plan.authorizationId!,
    candidate.id,
  );
  expect(
    (await checks.execute(f.repository, reused, reused.digest)).result,
  ).toBe("passed");
  expect(checks.list("p").executions).toHaveLength(2);
  expect(checks.list("p").executions[0].id).not.toBe(
    checks.list("p").executions[1].id,
  );
  await expect(
    checks.execute(f.repository, reused, reused.digest),
  ).rejects.toThrow("exhausted");
  const revoked = await setup({ policy: { maximumUses: 2 } });
  revoked.store.put("check-authorization-revoked", {
    id: revoked.plan.authorizationId!,
    revokedAt: now(),
  });
  await expect(
    CheckExecutions.for(revoked.store).execute(
      revoked.repository,
      revoked.plan,
      revoked.plan.digest,
    ),
  ).rejects.toThrow("revoked");
  const expired = await setup({
    policy: { maximumUses: 2, expiresAfterMs: 100 },
  });
  await new Promise((resolve) => setTimeout(resolve, 110));
  await expect(
    CheckExecutions.for(expired.store).execute(
      expired.repository,
      expired.plan,
      expired.plan.digest,
    ),
  ).rejects.toThrow("stale");
});

test("R2-AT-30: required isolation is unsupported and feature disable cannot grant execution", async () => {
  const f = await setup();
  const isolated = environmentSelection(f.store, {
    ...f.selection,
    profile: "isolated-required",
  });
  const definition = {
    ...f.definition,
    id: "isolated",
    environmentRecipeId: isolated.id,
  };
  bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
  await expect(
    previewCheck(
      f.repository,
      f.workflow.id,
      f.task.id,
      f.candidate,
      definition,
    ),
  ).rejects.toThrow("isolation is unavailable");
  f.store.put("preference", {
    id: "round-2-rollout",
    disabled: ["prepared-verification"],
  });
  await expect(
    CheckExecutions.for(f.store).execute(f.repository, f.plan, f.plan.digest),
  ).rejects.toThrow("disabled");
  expect(f.store.list("check-dispatch-intent")).toHaveLength(0);
});

test("R2-AT-26/29: cancelled preparation stops before checks and retains bounded redacted preparation evidence", async () => {
  const runtime = await tools();
  const f = await setup({
      locked: true,
      hasHook: true,
      hooks: [
        {
          packagePath: "node_modules/fixture-value",
          executable: runtime.node,
          args: [
            "-e",
            "process.stdout.write('Bearer ');process.stdout.write('fixture-preparation-secret\\nready-for-cancel\\n');setInterval(()=>{},10000)",
          ],
          timeoutMs: 10000,
        },
      ],
    }),
    checks = CheckExecutions.for(f.store);
  const running = checks.execute(f.repository, f.plan, f.plan.digest);
  await vi.waitFor(
    () =>
      expect(
        f.store
          .list<any>("environment-log")
          .map((l) => l.text)
          .join(""),
      ).toContain("ready-for-cancel"),
    { timeout: 10000 },
  );
  checks.cancelWorkflow(f.workflow.id);
  expect((await running).result).toBe("error");
  const inspected = checks.inspect("p", checks.list("p").executions[0].id),
    env = inspected.environment!;
  expect(env.instance.state).toBe("cancelled");
  expect(env.instance.preparationLifecycle?.state).toBe("quiescent");
  expect(env.instance.outputBytes).toBeLessThanOrEqual(500000);
  const logs = env.logs.map((l) => l.text).join("");
  expect(logs).toContain("[redacted]");
  expect(logs).not.toContain("fixture-preparation-secret");
  expect(inspected.execution.state).toBe("cancelled");
  expect(inspected.cleanup?.state).toBe("completed");
});

test("R2-AT-27/30: dependency policy drift cannot reuse an old bounded authorization", async () => {
  const f = await setup({
    locked: true,
    policy: { maximumUses: 2, allowCandidateChanges: true },
  });
  const lock = JSON.parse(
    await readFile(path.join(f.source, "package-lock.json"), "utf8"),
  );
  lock.packages[""].license = "MIT";
  await writeFile(
    path.join(f.source, "package-lock.json"),
    JSON.stringify(lock),
  );
  const candidate = await captureCandidate(f.store, {
    root: f.source,
    projectId: "p",
    workflowId: f.workflow.id,
    selectedPaths: f.paths,
  });
  await expect(
    reuseCheckAuthorization(f.store, f.plan.authorizationId!, candidate.id),
  ).rejects.toThrow("recipe changed");
  const toolFile = path.join(f.directory, "npm-tool/bin/npm-cli.js");
  await mkdir(path.dirname(toolFile), { recursive: true });
  await writeFile(toolFile, "process.exit(0)");
  const selection = environmentSelection(f.store, {
      ...f.selection,
      npmCli: toolFile,
    }),
    definition = {
      ...f.definition,
      id: "changed-tool",
      environmentRecipeId: selection.id,
      args: ["tests/check.cjs"],
    };
  bindCheckInputs(f.store, f.workflow.id, candidate, [definition]);
  const preview = await previewCheck(
    f.repository,
    f.workflow.id,
    f.task.id,
    candidate,
    definition,
  );
  await writeFile(toolFile, "process.exit(1)");
  await expect(
    CheckExecutions.for(f.store).execute(f.repository, preview, preview.digest),
  ).rejects.toThrow("toolchain changed");
  expect(f.store.list("check-dispatch-intent")).toHaveLength(0);
});

test("R2-AT-29: restart in a later preparation dispatch gap cannot reconcile a previous quiescent command", async () => {
  const runtime = await tools(),
    f = await setup({
      locked: true,
      hasHook: true,
      hooks: [
        {
          packagePath: "node_modules/fixture-value",
          executable: runtime.node,
          args: ["-e", "console.log('reviewed-hook')"],
          timeoutMs: 5000,
        },
      ],
    }),
    checks = new CheckExecutions(f.store, {
      cleanup: async () => {
        throw new Error("retain fixture roots");
      },
    });
  const snapshots: any[] = [];
  const original = f.store.put.bind(f.store);
  const spy = vi
    .spyOn(f.store, "put")
    .mockImplementation((kind: string, body: any) => {
      const value = original(kind, body);
      if (
        kind === "environment-instance" &&
        body.commandIndex === 4 &&
        body.preparationLifecycle === null
      )
        snapshots.push(structuredClone(body));
      return value;
    });
  expect(
    (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
  ).toBe("passed");
  spy.mockRestore();
  expect(snapshots).toHaveLength(1);
  const execution = checks.list("p").executions[0],
    instance = snapshots[0];
  expect(
    f.store
      .list<any>("environment-command-outcome")
      .some((o) => o.lifecycle.state === "quiescent"),
  ).toBe(true);
  // Reproduce the durable snapshot of an interrupted next-command dispatch.
  f.store.put("environment-instance", instance);
  f.store.put("check-execution", {
    ...execution,
    state: "running",
    eligibility: "pending",
    lifecycle: null,
    failurePhase: "environment",
  });
  const restarted = new CheckExecutions(f.store);
  restarted.recover();
  expect(
    new PreparedEnvironments(f.store).inspect("p", instance.id).instance.state,
  ).toBe("uncertain");
  await expect(restarted.reconcileStopped("p", execution.id)).rejects.toThrow(
    "No native process identity",
  );
  expect(
    (
      await restarted.retryCleanup(
        "p",
        checks.inspect("p", execution.id).cleanup!.id,
      )
    ).state,
  ).toBe("blocked-by-active-process");
  // Test cleanup only: the actual commands already quiesced above.
  await checks.shutdown();
  await rm(execution.materializedRoot, { recursive: true, force: true });
  for (const resource of f.store.list<any>("task-resources"))
    await rm(resource.root, { recursive: true, force: true });
});

test("R2-AT-26: prepared environment remains ready when the actual candidate test fails", async () => {
  const f = await setup({
      locked: true,
      script: "require('node:assert/strict').equal(require('fixture-value'),0)",
    }),
    checks = CheckExecutions.for(f.store);
  expect(
    (await checks.execute(f.repository, f.plan, f.plan.digest)).result,
  ).toBe("failed");
  const execution = checks.list("p").executions[0];
  expect(execution.failurePhase).toBe("test");
  expect(checks.inspect("p", execution.id).environment!.instance.state).toBe(
    "ready",
  );
});

test("R2-AT-27: the check cannot substitute an external npm CLI for its reviewed toolchain", async () => {
  const f = await setup({ locked: true });
  const definition = {
    ...f.definition,
    id: "substituted-tool",
    args: [path.join(f.directory, "other/bin/npm-cli.js"), "run", "check"],
  };
  expect(() =>
    bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]),
  ).toThrow("exact reviewed environment toolchain");
});

test("R2-AT-25/30: registry preparation requires a distinct explicit recipe; enforceable allowlists remain unsupported", async () => {
  const f = await setup({ locked: true });
  const selection = environmentSelection(f.store, {
      ...f.selection,
      preparationNetwork: "package-manager-network",
    }),
    definition = {
      ...f.definition,
      id: "reviewed-registry",
      environmentRecipeId: selection.id,
    };
  bindCheckInputs(f.store, f.workflow.id, f.candidate, [definition]);
  const network = await previewCheck(
    f.repository,
    f.workflow.id,
    f.task.id,
    f.candidate,
    definition,
  );
  expect(network.environmentRecipe!.preparation!.args).not.toContain(
    "--offline",
  );
  expect(f.plan.environmentRecipe!.preparation!.args).toContain("--offline");
  expect(network.environmentRecipe!.network.preparation).toContain(
    "OS-network-not-enforced",
  );
  expect(network.environmentRecipe!.digest).not.toBe(
    f.plan.environmentRecipe!.digest,
  );
  expect(f.store.list("check-dispatch-intent")).toHaveLength(0);
  const unavailable = environmentSelection(f.store, {
      ...f.selection,
      preparationNetwork: "enforced-allowlist-required",
    }),
    required = {
      ...f.definition,
      id: "allowlist-required",
      environmentRecipeId: unavailable.id,
    };
  bindCheckInputs(f.store, f.workflow.id, f.candidate, [required]);
  await expect(
    previewCheck(f.repository, f.workflow.id, f.task.id, f.candidate, required),
  ).rejects.toThrow("allowlist is unavailable");
});

test("R2-AT-30: equal candidate content in a different workspace does not share execution authority", async () => {
  const f = await setup({
      policy: { maximumUses: 2, allowCandidateChanges: true },
    }),
    other = path.join(f.directory, "other-workspace");
  await mkdir(other);
  await mkdir(path.join(other, "tests"));
  for (const name of f.paths)
    await writeFile(
      path.join(other, name),
      await readFile(path.join(f.source, name)),
    );
  const candidate = await captureCandidate(f.store, {
    root: other,
    projectId: "p",
    workflowId: f.workflow.id,
    selectedPaths: f.paths,
  });
  expect(candidate.contentRevision).toBe(f.candidate.contentRevision);
  expect(candidate.workspaceIdentity).not.toBe(f.candidate.workspaceIdentity);
  await expect(
    reuseCheckAuthorization(f.store, f.plan.authorizationId!, candidate.id),
  ).rejects.toThrow("outside this execution authorization");
});
