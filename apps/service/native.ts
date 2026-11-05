import { existsSync } from "node:fs";
import type { Command } from "../../packages/domain/commands";
import type { ServiceEvent } from "../../packages/domain/types";
import type { Store } from "../../packages/persistence/store";
import { NativeHarness, type RouteInfo } from "../../packages/harness/harness";
import type { ProxyEndpoint } from "../../packages/harness/model-client";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import {
  containmentStatus,
  runContained,
  type ContainmentStatus,
} from "../../packages/harness/sandbox";
import type { NativeAttemptView } from "../../packages/harness/types";
import type { ProxyStateView } from "../../packages/proxy/service";
import type { NativeMemberHost } from "../../packages/orchestration/runtime-driver";

type NativeCommand = Extract<Command, { type: `native-${string}` }>;

/**
 * The control service's side of the native harness. The proxy's endpoint
 * and sanitized connection state arrive from Electron main; credentials never
 * do. Attempt changes are batched to the renderer.
 */
export class NativeService {
  readonly harness: NativeHarness;
  private endpoint: ProxyEndpoint | null = null;
  private proxy: ProxyStateView | null = null;
  private changed = new Map<string, NativeAttemptView>();
  private provisional = new Map<string, string | null>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    store: Store,
    profileDirectory: string,
    private emit: (event: ServiceEvent) => void,
  ) {
    const git =
      ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"].find(
        (p) => existsSync(p),
      ) ?? "git";
    this.harness = new NativeHarness({
      store,
      profileDirectory,
      endpoint: () => this.endpoint,
      route: (alias) => this.route(alias),
      gitExecutable: git,
      onChange: (view) => {
        this.changed.set(view.attemptId, view);
        this.schedule();
      },
      onProvisional: (attemptId, text) => {
        this.provisional.set(attemptId, text);
        this.schedule();
      },
    });
  }

  /** Batches UI updates: at most one emission per 100 ms. */
  private schedule(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.changed.size) {
        this.emit({
          type: "native",
          data: { attempts: [...this.changed.values()] },
        });
        this.changed.clear();
      }
      if (this.provisional.size) {
        this.emit({
          type: "native-provisional",
          data: { outputs: Object.fromEntries(this.provisional) },
        });
        this.provisional.clear();
      }
    }, 100);
  }

  setProxy(endpoint: ProxyEndpoint | null, state: ProxyStateView | null): void {
    this.endpoint = endpoint;
    this.proxy = state;
  }
  setProxyState(state: ProxyStateView): void {
    this.proxy = state;
  }

  /**
   * The harness as coordinator teams, sessions and loops use it: member
   * turns on proxy routes (packages/orchestration/runtime-driver.ts).
   */
  memberHost(): NativeMemberHost {
    return {
      harness: this.harness,
      routes: () => this.routeInfos(),
      running: () => this.endpoint !== null,
    };
  }

  /** Every route the proxy reported, with its connection. */
  routeInfos(): RouteInfo[] {
    const state = this.proxy;
    if (!state) return [];
    return state.routes.flatMap((route) => {
      const connection = state.connections.find(
        (c) => c.id === route.connectionId,
      );
      return connection ? [{ route, connection }] : [];
    });
  }

  private route(alias: string): RouteInfo | null {
    const route = this.proxy?.routes.find((r) => r.alias === alias);
    const connection =
      route && this.proxy?.connections.find((c) => c.id === route.connectionId);
    return route && connection ? { route, connection } : null;
  }

  private containment: Promise<ContainmentStatus> | null = null;
  /**
   * Whether containment works here, established once by running a contained
   * no-op: an installed runtime that cannot start (a broken package, say)
   * is reported unavailable rather than assumed to work.
   */
  private containmentProbe(): Promise<ContainmentStatus> {
    this.containment ??= (async () => {
      const status = await containmentStatus();
      if (!status.available) return status;
      const root = await mkdtemp(path.join(os.tmpdir(), "topsl-probe-"));
      try {
        const work = path.join(root, "work");
        const temp = path.join(root, "temp");
        await mkdir(work);
        await mkdir(temp);
        const result = await runContained(["/usr/bin/true"], {
          cwd: work,
          policy: {
            workspaceRoot: work,
            writable: false,
            tempRoot: temp,
            allowedDomains: [],
          },
          timeoutMs: 20_000,
        });
        return result.started && result.exitCode === 0
          ? status
          : {
              ...status,
              available: false,
              reason: `The sandbox did not start a test command: ${result.stderr.trim().slice(0, 300) || "no output"}`,
            };
      } catch (error) {
        return {
          ...status,
          available: false,
          reason: `The sandbox could not be tested: ${(error as Error).message}`,
        };
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    })();
    return this.containment;
  }

  async recover(): Promise<number> {
    return this.harness.recoverAll();
  }

  async command(
    command: NativeCommand,
    trusted: { digest?: string } = {},
  ): Promise<unknown> {
    const h = this.harness;
    switch (command.type) {
      case "native-state": {
        const page = h.list(command.projectId, null, 50);
        return {
          proxyRunning: this.endpoint !== null,
          attempts: page.items,
          nextCursor: page.nextCursor,
          memories: h.memories(command.projectId),
          mcpServers: h.mcpServers(command.projectId),
          hooks: h.hooks(command.projectId),
          resources: h.resources.snapshot(),
          containment: await this.containmentProbe(),
        };
      }
      case "native-start": {
        const { type: _, ...input } = command;
        return h.start({ ...input, title: input.title });
      }
      case "native-events":
        return {
          view: h.view(command.attemptId),
          page: h.events(command.attemptId, command.after, command.limit),
        };
      case "native-attempt":
        return h.view(command.attemptId);
      case "native-steer":
        return h.steer(command.attemptId, command.text);
      case "native-pause":
        return h.pause(command.attemptId);
      case "native-resume":
        return h.resume(command.attemptId);
      case "native-cancel":
        await h.cancel(command.attemptId);
        return h.view(command.attemptId);
      case "native-reconcile":
        return h.reconcile(
          command.attemptId,
          command.callId,
          command.outcome,
          command.note,
        );
      case "native-apply-preview":
        return h.applyPreview(command.attemptId);
      case "native-apply":
        // Main showed this exact preview in its own dialog and passes its digest.
        if (!trusted.digest)
          throw new Error("Confirm the application in Topsl's own dialog.");
        return h.apply(command.attemptId, trusted.digest);
      case "native-discard":
        await h.discardWorkspace(command.attemptId);
        return null;
      case "native-memory-decide":
        return h.decideMemory(command.id, command.accept);
      case "native-mcp-inspect":
        return h.mcpInspect(
          command.projectId,
          command.name,
          command.argv,
          command.networkDomains,
        );
      case "native-mcp-admit":
        return h.mcpAdmit(command);
      case "native-mcp-remove":
        h.mcpRemove(command.id);
        return null;
      case "native-hook-admit":
        return h.hookAdmit(command);
      case "native-hook-remove":
        h.hookRemove(command.id);
        return null;
      case "native-quota-resume":
        h.resumeQuota(command.owner);
        return h.resources.snapshot();
    }
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const view of this.harness.journal.unfinished())
      this.harness.kernel.pause(view.attemptId, "Topsl is closing.");
    this.harness.close();
  }
}
