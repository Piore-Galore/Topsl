import { afterEach, describe, expect, test } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
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
import { CodexAdapter, sandboxPolicy } from "../packages/providers/codex";
import type { ProviderConnection } from "../packages/providers/contract";
import {
  assertQualificationParent,
  probeCommand,
  qualificationTurnBudget,
  runCodexQualification,
} from "../packages/providers/qualification";
import { RuntimeManager } from "../packages/runtime/manager";
import { RpcPeer } from "../packages/runtime/rpc";
import { identity, nativeEnvironment } from "../packages/platform/system";
import { now } from "../packages/domain/invariants";
import { fixture } from "./helpers";

const probeFixture = createRequire(import.meta.url)(
  "./fixtures/probe-command.cjs",
) as {
  probe: (argv: string[]) => { word: string; file?: string } | null;
};

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
  test("command/exec gets exactly the sandbox policy a turn in the same mode gets", async () => {
    const sent: Array<{ method: string; params: any }> = [],
      connection = {
        request: async (method: string, params: unknown) => {
          sent.push({ method, params });
          return method === "command/exec"
            ? { exitCode: 0, stdout: "", stderr: "" }
            : { turn: { id: "turn-1" } };
        },
      } as unknown as ProviderConnection,
      adapter = new CodexAdapter(),
      cwd = "/data/q/workspace";
    for (const mode of ["review", "edit"] as const) {
      await adapter.startTurn(
        connection,
        {
          prompt: "",
          cwd,
          requestedModel: "fixture-model",
          mode,
          contextPackageId: null,
          attemptId: "policy",
          workspaceIdentity: cwd,
        },
        "thread-1",
      );
      await adapter.sandboxCommand(connection, {
        argv: ["/bin/sh", "-c", "true"],
        cwd,
        mode,
      });
    }
    expect(sent.map((s) => s.method)).toEqual([
      "turn/start",
      "command/exec",
      "turn/start",
      "command/exec",
    ]);
    expect(sent.map((s) => s.params.sandboxPolicy)).toEqual([
      sandboxPolicy("review", cwd),
      sandboxPolicy("review", cwd),
      sandboxPolicy("edit", cwd),
      sandboxPolicy("edit", cwd),
    ]);
    expect(sandboxPolicy("review", cwd)).toEqual({ type: "readOnly" });
    expect(sandboxPolicy("edit", cwd)).toEqual({
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: false,
    });
    expect(sent[1].params).toMatchObject({
      command: ["/bin/sh", "-c", "true"],
      cwd,
    });
  });

  test("the sandbox probes are POSIX shell commands on macOS and Linux and encoded Windows PowerShell commands on Windows", () => {
    const file = "C:\\Users\\o'brien\\q\u2019s\\workspace\\inside.txt",
      content = "it's \u2018quoted\u2019";
    expect(probeCommand({ print: "readable" }, "darwin")).toEqual([
      "/bin/sh",
      "-c",
      'printf %s "$1"',
      "topsl",
      "readable",
    ]);
    expect(probeCommand({ write: content, file }, "linux")).toEqual([
      "/bin/sh",
      "-c",
      'printf %s "$1" > "$2"',
      "topsl",
      content,
      file,
    ]);
    const print = probeCommand({ print: "readable" }, "win32"),
      write = probeCommand({ write: content, file }, "win32");
    expect(print.slice(0, 5)).toEqual([
      expect.stringMatching(
        /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/,
      ),
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(print[5], "base64").toString("utf16le")).toBe(
      "$ErrorActionPreference = 'Stop'; try { [Console]::Out.Write('readable') } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }",
    );
    // Every quote PowerShell ends a literal at is doubled, and the stand-in
    // reads the values back unchanged.
    expect(Buffer.from(write[5], "base64").toString("utf16le")).toBe(
      "$ErrorActionPreference = 'Stop'; try { [IO.File]::WriteAllText('C:\\Users\\o''brien\\q\u2019\u2019s\\workspace\\inside.txt', 'it''s \u2018\u2018quoted\u2019\u2019') } catch { [Console]::Error.Write($_.Exception.Message); exit 1 }",
    );
    expect(probeFixture.probe(print)).toEqual({ word: "readable" });
    expect(probeFixture.probe(write)).toEqual({ word: content, file });
    expect(probeFixture.probe(probeCommand({ write: content, file }, "linux"))).toEqual({ word: content, file });
  });

  // Outside any sandbox: the commands themselves, in this host's Windows
  // PowerShell. Whether Codex's sandbox runs and confines them is what a live
  // qualification observes.
  test.runIf(process.platform === "win32")(
    "on Windows the probe commands print, write exactly, and exit 1 when a write fails",
    async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "topsl-probe-")),
        run = (argv: string[]) => {
          const result = spawnSync(argv[0], argv.slice(1), {
            encoding: "utf8",
            windowsHide: true,
          });
          return {
            exitCode: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
          };
        };
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      expect(run(probeCommand({ print: "readable" }))).toMatchObject({
        exitCode: 0,
        stdout: "readable",
      });
      const file = path.join(directory, "it's here.txt");
      expect(run(probeCommand({ write: "inside", file })).exitCode).toBe(0);
      expect(await readFile(file)).toEqual(Buffer.from("inside"));
      const missing = path.join(directory, "missing", "outside.txt"),
        failed = run(probeCommand({ write: "outside", file: missing }));
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).not.toBe("");
      expect(existsSync(missing)).toBe(false);
    },
  );

  test(
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
      expect(qualificationTurnBudget).toBe(3);
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
      for (const name of ["read-only", "workspace-write"])
        expect(o[name], name).toMatchObject({
          meaning: "policy-enforced",
          negativeControl: {
            operationAttempted: true,
            trustedStateChecked: true,
            denied: true,
          },
        });
      expect(o["candidate-reader"].meaning).toBe("behavior-observed");
      expect(report.notTested).toEqual([]);
      expect(report.approvals).toEqual([]);
      const denial = (file: string) =>
        JSON.stringify(
          process.platform === "win32"
            ? `Access to the path '${file}' is denied.`
            : `/bin/sh: ${file}: Operation not permitted`,
        );
      const nonce = o["read-only"].operationId.split(":").pop();
      expect(o["read-only"].detail).toBe(
        `Topsl ran the commands itself in the runtime's sandbox under the read-only policy, with no model turn. A command printing a word ran. The write to <folder>/workspace/readonly-${nonce}.txt exited with code 1 (${denial(path.join("<folder>", "workspace", `readonly-${nonce}.txt`))}), and no file was created.`,
      );
      expect(o["workspace-write"].detail).toBe(
        `Topsl ran the writes itself in the runtime's sandbox under the workspace-write policy, with no model turn. The write inside the workspace exited with code 0 and landed. The write to <folder>/outside/outside-${nonce}.txt exited with code 1 (${denial(path.join("<folder>", "outside", `outside-${nonce}.txt`))}) and was denied.`,
      );
      const frames = f.frames(),
        sent = (method: string) =>
          frames
            .filter(
              (entry) =>
                entry.from === "topsl" && entry.frame.method === method,
            )
            .map((entry) => entry.frame.params);
      // Every model turn is a review turn that asks before commands; only the
      // reader's thread declares tools.
      const starts = sent("thread/start"),
        turns = sent("turn/start"),
        commands = sent("command/exec");
      expect(starts.map((start) => start.sandbox)).toEqual([
        "read-only",
        "read-only",
        "read-only",
      ]);
      for (const params of [starts, turns])
        expect(params.map((p) => p.approvalPolicy)).toEqual([
          "untrusted",
          "untrusted",
          "untrusted",
        ]);
      expect(turns.map((turn) => turn.sandboxPolicy)).toEqual(
        turns.map((turn) => sandboxPolicy("review", turn.cwd)),
      );
      // The sandbox probes ran no model: Topsl sent the commands itself, under
      // the policies a review and an edit turn get.
      const workspace = turns[0].cwd;
      // This platform's probe commands: the POSIX shell on macOS and Linux,
      // Windows PowerShell on Windows.
      const outside = path.join(path.dirname(workspace), "outside");
      expect(
        commands.map((c) => [c.command, c.sandboxPolicy, c.cwd]),
      ).toEqual([
        [
          probeCommand({ print: "readable" }),
          sandboxPolicy("review", workspace),
          workspace,
        ],
        [
          probeCommand({
            write: "readonly",
            file: path.join(workspace, `readonly-${nonce}.txt`),
          }),
          sandboxPolicy("review", workspace),
          workspace,
        ],
        [
          probeCommand({
            write: "inside",
            file: path.join(workspace, `inside-${nonce}.txt`),
          }),
          sandboxPolicy("edit", workspace),
          workspace,
        ],
        [
          probeCommand({
            write: "outside",
            file: path.join(outside, `outside-${nonce}.txt`),
          }),
          sandboxPolicy("edit", workspace),
          workspace,
        ],
      ]);
      // The interrupt waited for the reply's first streamed text.
      const firstDelta = frames.findIndex(
          (entry) => entry.frame.method === "item/agentMessage/delta",
        ),
        interrupt = frames.findIndex(
          (entry) =>
            entry.from === "topsl" && entry.frame.method === "turn/interrupt",
        );
      expect(firstDelta).toBeGreaterThan(-1);
      expect(interrupt).toBeGreaterThan(firstDelta);
      expect(o.interrupt.detail).toBe(
        "Interrupt requested after the reply's first streamed text; the turn ended interrupted.",
      );
      expect(starts[1].dynamicTools).toEqual([
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
      for (const start of [starts[0], starts[2]])
        expect(start).not.toHaveProperty("dynamicTools");
      expect(await readdir(f.parent)).toEqual([]);
    },
  );

  test(
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

  test(
    "the reader passes only when Topsl answered read_range for the probe's file and the reply quotes its marker, and says how Codex reported the call",
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
        "dropped",
      ]) {
        const f = await setup(mode === "read" ? {} : { FIXTURE_READER: mode }),
          report = await runCodexQualification({
            adapter: f.adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
            readerProbe: f.quotingProbe,
          }),
          o = byName(report),
          // The text of Topsl's one answer to the tool call, if it made one.
          answered: string | undefined = f
            .frames()
            .find(
              (line) =>
                line.from === "topsl" && line.frame.result?.contentItems,
            )?.frame.result.contentItems[0].text;
        expect(report.error, mode).toBeNull();
        expect(report.turnsStarted, mode).toBe(qualificationTurnBudget);
        expect(o["structured-turn"].passed, mode).toBe(true);
        details[mode] = {
          passed: o["candidate-reader"].passed,
          // Codex's report counts the characters of Topsl's answer.
          detail: answered
            ? o["candidate-reader"].detail.replace(
                ` of ${answered.length} characters `,
                " of N characters ",
              )
            : o["candidate-reader"].detail,
        };
      }
      const detail = (
          reads: number,
          refused: number,
          quoted: boolean,
          calls: string,
          reported: string,
        ) =>
          `Turn completed. ${reads} read_range answer${reads === 1 ? "" : "s"} under the probe's grant returned the probe file's marker, and the reader refused ${refused} request${refused === 1 ? "" : "s"}. The reply ${quoted ? "quoted" : "did not quote"} the marker. Tool calls: ${calls}. ${reported}${quoted ? "" : ' The reply began: "I could not read the file."'}`,
        // How the stand-in reports its one read_range call when it completes.
        call = (status: string, success: boolean, content: string) =>
          `Codex reported read_range as ${status} (success: ${success}) with ${content}. Items completed: dynamicToolCall, agentMessage.`,
        holding = "1 content item of N characters that holds the marker",
        lacking =
          "1 content item of N characters that does not hold the marker",
        noCall =
          "Codex reported no completed tool call. Items completed: agentMessage.";
      expect(details).toEqual({
        read: {
          passed: true,
          detail: detail(
            1,
            0,
            true,
            "read_range answered",
            call("completed", true, holding),
          ),
        },
        // The model never calls the tool.
        skip: { passed: false, detail: detail(0, 0, false, "none", noCall) },
        // It quotes the marker without calling the tool.
        quote: { passed: false, detail: detail(0, 0, true, "none", noCall) },
        // It reads the file but does not quote it.
        unquoted: {
          passed: false,
          detail: detail(
            1,
            0,
            false,
            "read_range answered",
            call("completed", true, holding),
          ),
        },
        // It reads only part of the file, then quotes a marker it had anyway.
        partial: {
          passed: false,
          detail: detail(
            0,
            0,
            true,
            "read_range answered",
            call("completed", true, lacking),
          ),
        },
        // It reads a path outside the probe's build.
        other: {
          passed: false,
          detail: detail(
            0,
            1,
            false,
            "read_range failed",
            call("failed", false, lacking),
          ),
        },
        // Its call names another turn, so Topsl never runs the reader.
        stray: {
          passed: false,
          detail: detail(
            0,
            0,
            false,
            "read_range refused",
            call("failed", false, lacking),
          ),
        },
        // Topsl answers with the marker, but the runtime reports the call
        // without its content and the reply does not quote it.
        dropped: {
          passed: false,
          detail: detail(
            1,
            0,
            false,
            "read_range answered",
            call("completed", true, "no content items"),
          ),
        },
      });
    },
  );

  test(
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
        // The reader's turn is the one that did not start.
        expect(report.turnsStarted).toBe(qualificationTurnBudget - 1);
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

  test(
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
      expect(o["read-only"].detail).toMatch(
        /exited with code 0, and a file was created\.$/,
      );
      expect(o["workspace-write"]).toMatchObject({
        passed: false,
        meaning: "unsupported",
        negativeControl: { operationAttempted: true, denied: false },
      });
      expect(o["workspace-write"].detail).toMatch(
        /exited with code 0 and created a file\.$/,
      );
      expect(o["structured-turn"].passed).toBe(true);
    },
  );

  test(
    "a runtime that cannot run a command in its sandbox fails both write probes, and the other probes still run",
    async () => {
      const f = await setup({ FIXTURE_NO_EXEC: "1" }),
        // An adapter with no sandboxed command at all.
        bare = Object.assign(Object.create(f.adapter), {
          sandboxCommand: undefined,
        });
      for (const [adapter, detail] of [
        [f.adapter, "Unsupported fixture method."],
        [bare, "This runtime adapter cannot run a command in its sandbox."],
      ] as const) {
        const report = await runCodexQualification({
            adapter,
            installation: f.installation,
            model: "fixture-model",
            parent: f.parent,
          }),
          o = byName(report);
        expect(report.error, detail).toBeNull();
        expect(report.turnsStarted, detail).toBe(qualificationTurnBudget);
        for (const name of ["read-only", "workspace-write"]) {
          expect(o[name], `${name}: ${detail}`).toMatchObject({
            passed: false,
            meaning: "unknown",
          });
          expect(o[name].detail, `${name}: ${detail}`).toContain(detail);
        }
        for (const name of [
          "structured-turn",
          "candidate-reader",
          "fresh-session",
          "interrupt",
        ])
          expect(o[name].passed, `${name}: ${detail}`).toBe(true);
      }
    },
  );

  test(
    "an approval request during a turn is declined, so nothing runs",
    async () => {
      const f = await setup({ FIXTURE_ASK: "1" }),
        report = await runCodexQualification({
          adapter: f.adapter,
          installation: f.installation,
          model: "fixture-model",
          parent: f.parent,
        }),
        o = byName(report);
      expect(report.approvals).toEqual([
        {
          probe: "structured-turn",
          method: "item/commandExecution/requestApproval",
          decision: "decline",
        },
      ]);
      const frames = f.frames(),
        asked = frames
          .filter(
            (entry) =>
              entry.from === "fixture" &&
              entry.frame.method === "item/commandExecution/requestApproval",
          )
          .map((entry) => entry.frame.id),
        answers = frames
          .filter(
            (entry) => entry.from === "topsl" && asked.includes(entry.frame.id),
          )
          .map((entry) => entry.frame.result);
      expect(answers).toEqual([{ decision: "decline" }]);
      // The declined command never ran, so the read-only probe still found
      // the workspace untouched.
      for (const name of ["structured-turn", "read-only", "workspace-write"])
        expect(o[name].passed, name).toBe(true);
    },
  );

  test(
    "the stand-in refuses an interrupt sent before the reply streams, as Codex 0.163.0 did",
    async () => {
      const f = await setup(),
        root = await mkdtemp(path.join(f.parent, "live-")),
        workspace = path.join(root, "workspace");
      await mkdir(workspace);
      const connection = f.adapter.connect(f.installation.path, workspace),
        waiting = new Map<string, (status: string) => void>(),
        deltas: string[] = [];
      connection.onNotification = (method, params: any) => {
        if (method === "item/agentMessage/delta") deltas.push(params.turnId);
        if (method === "turn/completed")
          waiting.get(params.threadId)?.(params.turn.status);
      };
      cleanup.push(async () => void (await connection.close()));
      await connection.initialize();
      const prepared = {
          prompt: "Write the numbers from 1 to 3000.",
          cwd: workspace,
          requestedModel: "fixture-model",
          mode: "review" as const,
          contextPackageId: null,
          attemptId: "stand-in",
          workspaceIdentity: workspace,
        },
        thread = (await f.adapter.startSession(connection, prepared, null))
          .nativeSessionId,
        // Listen before the turn starts, so a completion that arrives with
        // the response that starts the turn is not missed.
        done = new Promise<string>((resolve) => waiting.set(thread, resolve)),
        turnId = (await f.adapter.startTurn(connection, prepared, thread))
          .nativeTurnId!;
      await expect(
        f.adapter.interrupt(connection, thread, turnId),
      ).rejects.toThrow("no active turn to interrupt");
      await expect
        .poll(() => deltas.includes(turnId), { timeout: 5000 })
        .toBe(true);
      await f.adapter.interrupt(connection, thread, turnId);
      expect(await done).toBe("interrupted");
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
    ).rejects.toThrow("structured route is off");
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
