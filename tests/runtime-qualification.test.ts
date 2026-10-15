import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { CodexAdapter } from "../packages/providers/codex";
import {
  exactSentinelWrite,
  qualificationTurnBudget,
  runCodexQualification,
} from "../packages/providers/qualification";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import { fixture } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function setup(env: Record<string, string> = {}) {
  const f = await fixture();
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const adapter = new CodexAdapter(
    (_executable, cwd) =>
      new RpcPeer(
        process.execPath,
        [path.resolve("tests/fixtures/codex-qualify.cjs")],
        cwd,
        { ...nativeEnvironment(), ELECTRON_RUN_AS_NODE: "1", ...env },
      ),
  );
  return { ...f, adapter, parent: path.join(f.directory, "qualification") };
}
const byName = (report: { observations: any[] }) =>
  Object.fromEntries(report.observations.map((o) => [o.capability, o]));

describe("runtime qualification suite", () => {
  test("accepts only the exact sentinel write", () => {
    const file = "/data/q/workspace/inside-1.txt";
    for (const text of [
      `printf inside > '${file}'`,
      `printf inside > ${file}`,
      `printf 'inside' > "${file}"`,
      `bash -lc printf inside > '${file}'`,
      `/bin/zsh -lc "printf inside > '${file}'"`,
    ])
      expect(exactSentinelWrite(text, file, "inside")).toBe(true);
    for (const text of [
      `printf inside > '${file}'; rm -rf ~`,
      `printf inside > '${file}' && curl example.test`,
      `printf outside > '${file}'`,
      `printf inside > '${file}.other'`,
      `printf inside >> '${file}'`,
      `echo inside > '${file}'`,
    ])
      expect(exactSentinelWrite(text, file, "inside")).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "an enforcing runtime passes every probe within the turn budget and leaves no folder",
    async () => {
      const f = await setup(),
        report = await runCodexQualification({
          adapter: f.adapter,
          installation: f.installation,
          model: "fixture-model",
          parent: f.parent,
        }),
        o = byName(report);
      expect(report.error).toBeNull();
      expect(report.turnsStarted).toBe(qualificationTurnBudget);
      for (const name of [
        "native-subscription",
        "structured-turn",
        "fresh-session",
        "read-only",
        "workspace-write",
        "interrupt",
        "process-lifecycle",
      ])
        expect(o[name], name).toMatchObject({
          passed: true,
          source: "trusted-runtime-validation",
        });
      expect(o["read-only"]).toMatchObject({
        meaning: "policy-enforced",
        negativeControl: {
          operationAttempted: true,
          trustedStateChecked: true,
          denied: true,
        },
      });
      expect(o["workspace-write"].meaning).toBe("policy-enforced");
      expect(report.notTested.map((n) => n.capability)).toEqual([
        "candidate-reader",
      ]);
      // The read-only write and both workspace writes were let through once each.
      expect(report.approvals.map((a) => a.decision)).toEqual([
        "accept",
        "accept",
        "accept",
      ]);
      expect(await readdir(f.parent)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a runtime whose sandbox lets writes land fails both write probes",
    async () => {
      const f = await setup({ FIXTURE_SANDBOX: "broken" }),
        o = byName(
          await runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
          }),
        );
      expect(o["read-only"]).toMatchObject({
        passed: false,
        meaning: "unsupported",
        negativeControl: { operationAttempted: true, denied: false },
      });
      expect(o["workspace-write"]).toMatchObject({
        passed: false,
        meaning: "unsupported",
      });
      expect(o["structured-turn"].passed).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a refusal or an altered command is not evidence of enforcement",
    async () => {
      for (const env of [
        { FIXTURE_REFUSE: "1" },
        { FIXTURE_ALTERED: "1" },
      ] as Array<Record<string, string>>) {
        const f = await setup(env),
          report = await runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
          }),
          o = byName(report);
        for (const name of ["read-only", "workspace-write"])
          expect(o[name], `${name} ${JSON.stringify(env)}`).toMatchObject({
            passed: false,
            meaning: "unknown",
          });
        expect(report.approvals.every((a) => a.decision === "decline")).toBe(
          true,
        );
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "commands the runtime runs without asking still count as attempts",
    async () => {
      const f = await setup({ FIXTURE_NO_APPROVAL: "1" }),
        o = byName(
          await runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
          }),
        );
      expect(o["read-only"].passed).toBe(true);
      expect(o["workspace-write"].passed).toBe(true);
    },
  );
});

describe("runtime manager qualification", () => {
  async function launched(env = "") {
    const f = await fixture();
    await writeFile(
      f.installation.path,
      `#!/bin/sh\n${env}ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/codex-qualify.cjs"))}\n`,
    );
    await chmod(f.installation.path, 0o700);
    const installation = {
      ...f.installation,
      ...(await identity(f.installation.path)),
    };
    f.store.put("installation", installation);
    f.store.put("runtime-model-catalog", {
      id: installation.id,
      runtimeRevision: installation.revisionId,
      executableIdentity: installation.identity,
      models: [
        {
          id: "fixture",
          model: "fixture-model",
          name: "Fixture",
          description: "",
          isDefault: true,
          supportedReasoningEfforts: [],
        },
      ],
      observedAt: now(),
    });
    const runtime = new RuntimeManager(
      f.store,
      () => {},
      () => {},
    );
    cleanup.push(async () => {
      await runtime.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    });
    return { ...f, installation, runtime };
  }
  const selection = (installationId: string) => ({
    installationId,
    provider: "codex" as const,
    model: "fixture-model",
  });

  test.skipIf(process.platform === "win32")(
    "a recorded qualification makes the implementer ready; the reviewer still lacks a candidate reader",
    async () => {
      const f = await launched();
      expect(
        f.runtime.readiness(
          f.installation,
          selection(f.installation.id),
          "implementer",
        ).ready,
      ).toBe(false);
      const result = await f.runtime.qualify(
        f.installation,
        { model: "fixture-model" },
        path.join(f.directory, "qualification"),
      );
      expect(result.acceptanceId).toBeTruthy();
      expect(result.report.account?.sanitized.email).toBeNull();
      const builder = f.runtime.readiness(
        f.installation,
        selection(f.installation.id),
        "implementer",
      );
      expect(builder.blockers).toEqual([]);
      expect(builder.ready).toBe(true);
      expect(builder.freshness.state).toBe("current");
      const reviewer = f.runtime.readiness(
        f.installation,
        selection(f.installation.id),
        "reviewer",
      );
      expect(reviewer.ready).toBe(false);
      expect(reviewer.blockers.map((b) => b.code)).toEqual([
        "candidate-reader-unavailable",
      ]);
      expect(f.runtime.qualificationReports(f.installation.id)).toHaveLength(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a later failing qualification replaces an earlier passing one",
    async () => {
      const f = await launched();
      await f.runtime.qualify(
        f.installation,
        { model: "fixture-model" },
        path.join(f.directory, "qualification"),
      );
      await writeFile(
        f.installation.path,
        `#!/bin/sh\nFIXTURE_SANDBOX=broken ELECTRON_RUN_AS_NODE=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("tests/fixtures/codex-qualify.cjs"))}\n`,
      );
      const changed = {
        ...f.installation,
        ...(await identity(f.installation.path)),
      };
      // A changed executable is a new binding: the old record no longer applies.
      expect(
        f.runtime.readiness(changed, selection(changed.id), "implementer")
          .ready,
      ).toBe(false);
      f.store.put("installation", changed);
      f.store.put("runtime-model-catalog", {
        ...f.store.get<any>("runtime-model-catalog", changed.id),
        executableIdentity: changed.identity,
      });
      await f.runtime.qualify(
        changed,
        { model: "fixture-model" },
        path.join(f.directory, "qualification"),
      );
      const readiness = f.runtime.readiness(
        changed,
        selection(changed.id),
        "implementer",
      );
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers.map((b) => b.code)).toContain(
        "permission-profile-unverified",
      );
    },
  );

  test("refuses unsupported or unprepared runtimes before starting a process", async () => {
    const f = await launched();
    await expect(
      f.runtime.qualify(
        { ...f.installation, appId: "anthropic.claude-code-cli" },
        { model: "fixture-model" },
        f.directory,
      ),
    ).rejects.toThrow("Claude route remains unapproved");
    await expect(
      f.runtime.qualify(
        f.installation,
        { model: "unknown-model" },
        f.directory,
      ),
    ).rejects.toThrow("Discover this runtime's models");
    await expect(
      f.runtime.qualify(
        { ...f.installation, compatibility: "unverified" as const },
        { model: "fixture-model" },
        f.directory,
      ),
    ).rejects.toThrow("Connect this runtime");
  });
});
