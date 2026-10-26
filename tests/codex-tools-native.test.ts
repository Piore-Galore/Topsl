import { expect, test } from "vitest";
import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { fixture } from "./helpers";
import { nativeEnvironment } from "../packages/platform/system";
import { RpcPeer } from "../packages/runtime/rpc";
import { CodexAdapter } from "../packages/providers/codex";
import { candidateToolset as toolset } from "../packages/context/candidate-tools";

// Optional acceptance probe of an explicitly selected local executable. The
// native home is an empty fixture and no turn starts, so no model request is
// made; it checks the handshake and the thread Topsl's tool channel relies on,
// with the reviewer's own reader tools.
const executable = process.env.TOPSL_NATIVE_TOOLS_BINARY;
test.skipIf(!executable)(
  "selected native Codex accepts Topsl's reader tools on a fresh review thread, and only after the experimental opt-in",
  async () => {
    if (!executable || !path.isAbsolute(executable))
      throw new Error("Choose an absolute native executable path.");
    const f = await fixture(),
      home = path.join(f.directory, "native-home"),
      codexHome = path.join(home, ".codex"),
      workspace = path.join(f.directory, "workspace");
    await mkdir(codexHome, { recursive: true });
    await mkdir(workspace);
    const peers: RpcPeer[] = [];
    const connect = () => {
      const peer = new RpcPeer(
        executable,
        ["app-server"],
        workspace,
        nativeEnvironment({
          CODEX_HOME: codexHome,
          HOME: home,
          USERPROFILE: home,
        }),
      );
      peers.push(peer);
      return peer;
    };
    try {
      const adapter = new CodexAdapter(),
        connection = connect(),
        { models } = await adapter.inspect(connection),
        model = (models.find((m) => m.isDefault) ?? models[0])?.model;
      expect(model).toBeTruthy();
      const session = await adapter.startSession(
        connection,
        {
          prompt: "",
          cwd: workspace,
          requestedModel: model!,
          mode: "review",
          toolset,
          contextPackageId: null,
          attemptId: "native-fixture",
          workspaceIdentity: "native-fixture",
        },
        null,
      );
      expect(session.nativeSessionId).toMatch(/\S/);
      // The same tools without the opt-in are refused.
      const plain = connect();
      await plain.request("initialize", {
        clientInfo: {
          name: "topsl",
          title: "Topsl personal pilot",
          version: "0.1.3",
        },
      });
      plain.notify("initialized");
      await expect(
        plain.request("thread/start", {
          cwd: workspace,
          model,
          approvalPolicy: "untrusted",
          sandbox: "read-only",
          dynamicTools: [
            {
              type: "namespace",
              name: toolset.namespace,
              description: toolset.description,
              tools: toolset.tools.map((tool) => ({
                type: "function",
                ...tool,
              })),
            },
          ],
        }),
      ).rejects.toThrow("experimentalApi");
      console.log(
        "Native acceptance: experimental opt-in, fresh read-only review thread with Topsl's reader tools, refusal without the opt-in; isolated home; zero model turns.",
      );
    } finally {
      await Promise.all(peers.map((p) => p.close()));
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  },
  60_000,
);
