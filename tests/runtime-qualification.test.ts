import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { candidateToolset } from "../packages/context/candidate-tools";
import { createReaderProbe } from "../packages/context/reader-probe";
import { CodexAdapter } from "../packages/providers/codex";
import {
  assertQualificationParent,
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
/** Qualifications refuse the temporary directory, where the fixture's own
 * folder lives, so each test gets a folder under the repository's cache. */
async function qualificationParent() {
  const cache = path.resolve("node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const parent = await mkdtemp(path.join(cache, "topsl-qualify-"));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  return parent;
}
async function setup(env: Record<string, string> = {}) {
  const f = await fixture();
  cleanup.push(async () => {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  });
  const log = path.join(f.directory, "frames.jsonl"),
    markerFile = path.join(f.directory, "reader-marker.txt");
  let connections = 0;
  const adapter = new CodexAdapter((_executable, cwd) => {
    connections++;
    return new RpcPeer(
      process.execPath,
      [path.resolve("tests/fixtures/codex-qualify.cjs")],
      cwd,
      {
        ...nativeEnvironment(),
        ELECTRON_RUN_AS_NODE: "1",
        FIXTURE_LOG: log,
        FIXTURE_READER_MARKER: markerFile,
        ...env,
      },
    );
  });
  return {
    ...f,
    adapter,
    parent: await qualificationParent(),
    connections: () => connections,
    frames: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { from: string; frame: any })
        : [],
    /** The real reader probe, with its marker written where the stand-in can
     * quote it without calling the tool. */
    quotingProbe: async (directory: string) => {
      const probe = await createReaderProbe(directory);
      await writeFile(markerFile, probe.marker);
      return probe;
    },
  };
}
/** Every file under `root`. */
async function files(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const name of await readdir(root, { recursive: true })) {
    const file = path.join(root, name);
    if ((await lstat(file)).isFile()) found.push(file);
  }
  return found;
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
        "candidate-reader",
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
      expect(o["candidate-reader"].meaning).toBe("behavior-observed");
      expect(report.notTested).toEqual([]);
      // The read-only write and both workspace writes were let through once each.
      expect(report.approvals.map((a) => a.decision)).toEqual([
        "accept",
        "accept",
        "accept",
      ]);
      // Only the first review thread declares the reader's tools.
      const starts = f
        .frames()
        .filter(
          (entry) =>
            entry.from === "topsl" && entry.frame.method === "thread/start",
        )
        .map((entry) => entry.frame.params);
      expect(starts.map((start) => start.sandbox)).toEqual([
        "read-only",
        "read-only",
        "workspace-write",
        "read-only",
      ]);
      expect(starts[0].dynamicTools).toEqual([
        {
          type: "namespace",
          name: candidateToolset.namespace,
          description: candidateToolset.description,
          tools: candidateToolset.tools.map((tool) => ({
            type: "function",
            ...tool,
          })),
        },
      ]);
      for (const start of starts.slice(1))
        expect(start).not.toHaveProperty("dynamicTools");
      expect(await readdir(f.parent)).toEqual([]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "the reader probe's file is only in its encrypted store before the runtime starts",
    async () => {
      const f = await setup();
      let checked = false;
      const report = await runCodexQualification({
        adapter: f.adapter,
        installation: f.installation,
        model: "fixture-model",
        parent: f.parent,
        readerProbe: async (directory) => {
          const sourceParent = await mkdtemp(path.join(f.directory, "source-")),
            probe = await createReaderProbe(directory, sourceParent);
          expect(f.connections()).toBe(0);
          // The file's own folder is gone once it is captured.
          expect(await readdir(sourceParent)).toEqual([]);
          const found = await files(path.dirname(directory));
          expect(found.some((file) => file.endsWith("reader.sqlite"))).toBe(
            true,
          );
          for (const file of found)
            expect((await readFile(file)).includes(probe.marker), file).toBe(
              false,
            );
          checked = true;
          return probe;
        },
      });
      expect(checked).toBe(true);
      expect(byName(report)["candidate-reader"].passed).toBe(true);
    },
  );

  test.skipIf(process.platform === "win32")(
    "the reader passes only when Topsl answered read_range for the probe's file and the reply quotes its marker",
    async () => {
      const details: Record<string, { passed: boolean; detail: string }> = {};
      for (const mode of [
        "read",
        "skip",
        "quote",
        "unquoted",
        "partial",
        "other",
        "stray",
      ]) {
        const f = await setup(mode === "read" ? {} : { FIXTURE_READER: mode }),
          report = await runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
            readerProbe: f.quotingProbe,
          }),
          o = byName(report);
        expect(report.error, mode).toBeNull();
        expect(report.turnsStarted, mode).toBe(qualificationTurnBudget);
        expect(o["structured-turn"].passed, mode).toBe(true);
        details[mode] = {
          passed: o["candidate-reader"].passed,
          detail: o["candidate-reader"].detail,
        };
      }
      const detail = (
        reads: number,
        refused: number,
        quoted: boolean,
        calls: string,
      ) =>
        `Turn completed. ${reads} read_range answer${reads === 1 ? "" : "s"} under the probe's grant returned the probe file's marker, and the reader refused ${refused} request${refused === 1 ? "" : "s"}. The reply ${quoted ? "quoted" : "did not quote"} the marker. Tool calls: ${calls}.`;
      expect(details).toEqual({
        read: {
          passed: true,
          detail: detail(1, 0, true, "read_range answered"),
        },
        // The model never calls the tool.
        skip: { passed: false, detail: detail(0, 0, false, "none") },
        // It quotes the marker without calling the tool.
        quote: { passed: false, detail: detail(0, 0, true, "none") },
        // It reads the file but does not quote it.
        unquoted: {
          passed: false,
          detail: detail(1, 0, false, "read_range answered"),
        },
        // It reads only part of the file, then quotes a marker it had anyway.
        partial: {
          passed: false,
          detail: detail(0, 0, true, "read_range answered"),
        },
        // It reads a path outside the probe's build.
        other: {
          passed: false,
          detail: detail(0, 1, false, "read_range failed"),
        },
        // Its call names another turn, so Topsl never runs the reader.
        stray: {
          passed: false,
          detail: detail(0, 0, false, "read_range refused"),
        },
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "the other probes still run when the reader cannot be prepared or its tools are refused",
    async () => {
      for (const [env, readerProbe, detail] of [
        [
          { FIXTURE_REFUSE_TOOLS: "1" },
          undefined,
          "The runtime refused the reader's tools when the thread started: thread/start.dynamicTools requires experimentalApi capability",
        ],
        [
          {},
          async () => {
            throw new Error("The fixture store is unavailable.");
          },
          "Topsl could not prepare the reader probe: The fixture store is unavailable.",
        ],
      ] as const) {
        const f = await setup(env),
          report = await runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
            ...(readerProbe ? { readerProbe } : {}),
          }),
          o = byName(report);
        expect(report.error, detail).toBeNull();
        expect(report.turnsStarted).toBe(qualificationTurnBudget);
        expect(o["candidate-reader"]).toMatchObject({
          passed: false,
          meaning: "unknown",
          detail,
        });
        for (const name of [
          "structured-turn",
          "fresh-session",
          "read-only",
          "workspace-write",
          "interrupt",
        ])
          expect(o[name].passed, `${name}: ${detail}`).toBe(true);
        expect(await readdir(f.parent)).toEqual([]);
      }
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

  test.skipIf(process.platform === "win32")(
    "refuses a folder in the temporary directory before starting the runtime",
    async () => {
      const f = await setup(),
        link = path.join(f.parent, "temporary");
      // A path outside it by name can still lead into it through a link.
      await symlink(f.directory, link);
      for (const parent of [
        path.join(f.directory, "qualification"),
        path.join(link, "qualification"),
        path.join("/tmp", `topsl-qualify-${process.pid}`, "qualification"),
      ]) {
        await expect(
          runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent,
          }),
          parent,
        ).rejects.toThrow("outside the system temporary folders");
        expect(existsSync(parent), parent).toBe(false);
      }
      expect(f.connections()).toBe(0);
      await expect(assertQualificationParent(f.parent)).resolves.toBe(
        undefined,
      );
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
    "a recorded qualification makes the implementer and the reviewer ready",
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
        await qualificationParent(),
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
      expect(reviewer.blockers).toEqual([]);
      expect(reviewer.ready).toBe(true);
      // Nothing qualifies an independent reviewer.
      expect(
        f.runtime
          .readiness(
            f.installation,
            selection(f.installation.id),
            "independent-reviewer",
          )
          .blockers.map((b) => b.code),
      ).toEqual(["permission-profile-unverified"]);
      expect(f.runtime.qualificationReports(f.installation.id)).toHaveLength(1);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a runtime that never calls the reader stays blocked for reviews",
    async () => {
      const f = await launched("FIXTURE_READER=skip ");
      await f.runtime.qualify(
        f.installation,
        { model: "fixture-model" },
        await qualificationParent(),
      );
      expect(
        f.runtime.readiness(
          f.installation,
          selection(f.installation.id),
          "implementer",
        ).ready,
      ).toBe(true);
      const reviewer = f.runtime.readiness(
        f.installation,
        selection(f.installation.id),
        "reviewer",
      );
      expect(reviewer.ready).toBe(false);
      expect(reviewer.blockers.map((b) => b.code)).toEqual([
        "candidate-reader-unavailable",
      ]);
    },
  );

  test.skipIf(process.platform === "win32")(
    "a later failing qualification replaces an earlier passing one",
    async () => {
      const f = await launched();
      await f.runtime.qualify(
        f.installation,
        { model: "fixture-model" },
        await qualificationParent(),
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
        await qualificationParent(),
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
