import { utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { createHash } from "node:crypto";
import { safeError } from "../../packages/domain/invariants";
import { proxyDatabaseKey } from "../../packages/proxy/database";
import type { ProxyStateView } from "../../packages/proxy/service";
import { connectionTestPlan } from "../../packages/proxy/capabilities";
import type { Command } from "../../packages/domain/commands";

type ConnectionCommand = Extract<
  Command,
  { type: `connection-${string}` | `route-${string}` }
>;

/** Sign-in pages Topsl opens for a connection (ChatGPT's only); nothing else. */
const signInOrigins = new Set(["https://auth.openai.com"]);

export interface ProxyHostDeps {
  directory: string;
  vaultKey: string;
  bundle: string;
  onState(view: ProxyStateView | null): void;
  onEndpoint(
    endpoint: { port: number; token: string } | null,
    view: ProxyStateView | null,
  ): Promise<void>;
  confirm(
    title: string,
    detail: string,
    affirmative: string,
    type?: "question" | "warning",
  ): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  readClipboard(): string | Promise<string>;
  clearClipboard(expected: string): void | Promise<void>;
  report(message: string): void;
  quitting(): boolean;
}

/**
 * Starts and supervises the proxy utility process (docs/Native_Harness_Plan.md
 * §2) after the vault opens, and is the only path for account management:
 * the renderer asks, Topsl's own dialogs confirm, and credentials go straight
 * from the clipboard or the browser to the proxy.
 */
export class ProxyHost {
  private child: UtilityProcess | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private restarts: number[] = [];
  view: ProxyStateView | null = null;

  constructor(private deps: ProxyHostDeps) {}

  async start(): Promise<void> {
    const child = utilityProcess.fork(this.deps.bundle, [], {
      cwd: this.deps.directory,
      serviceName: "Topsl local proxy",
      stdio: "pipe",
    });
    this.child = child;
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("message", (message: any) => {
      if (message.event) {
        if (message.event.type === "proxy-state") {
          this.view = message.event.data;
          this.deps.onState(this.view);
        } else if (message.event.type === "proxy-open-url")
          void this.open(message.event.data?.url);
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) return;
      clearTimeout(task.timer);
      this.pending.delete(message.id);
      message.error
        ? task.reject(new Error(message.error))
        : task.resolve(message.value);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
      for (const task of this.pending.values()) {
        clearTimeout(task.timer);
        task.reject(
          new Error(
            "The Topsl proxy stopped. Native requests in flight were interrupted.",
          ),
        );
      }
      this.pending.clear();
      void this.deps.onEndpoint(null, this.view);
      if (this.deps.quitting()) return;
      // Supervision: restart after a crash, at most three times in ten minutes.
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10 * 60_000);
      if (this.restarts.length >= 3) {
        this.deps.report(
          "The Topsl proxy stopped repeatedly and was not restarted. Reopen Topsl to try again.",
        );
        return;
      }
      this.restarts.push(now);
      setTimeout(
        () =>
          void this.start().catch((error) =>
            this.deps.report(safeError(error)),
          ),
        1000 * this.restarts.length,
      );
    });
    const initialized = await this.request({
      kind: "initialize",
      directory: this.deps.directory,
      key: proxyDatabaseKey(this.deps.vaultKey),
    });
    this.view = initialized.state;
    this.deps.onState(this.view);
    await this.deps.onEndpoint(
      { port: initialized.port, token: initialized.token },
      this.view,
    );
  }

  private request(
    body: Record<string, unknown>,
    timeout = 60_000,
  ): Promise<any> {
    if (!this.child)
      return Promise.reject(new Error("The Topsl proxy is not running."));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The Topsl proxy did not answer in time."));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.postMessage({ id, ...body });
    });
  }

  private async open(url: unknown): Promise<void> {
    if (typeof url !== "string") return;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    if (!signInOrigins.has(origin)) {
      this.deps.report(
        "The proxy asked to open an unrecognized page; Topsl did not open it.",
      );
      return;
    }
    await this.deps.openExternal(url);
  }

  private label(connectionId: string): string {
    return (
      this.view?.connections.find((c) => c.id === connectionId)?.label ??
      "this connection"
    );
  }

  async command(command: ConnectionCommand): Promise<unknown> {
    const send = (payload: Record<string, unknown>, timeout?: number) =>
      this.request({ kind: "command", command: payload }, timeout);
    switch (command.type) {
      case "connection-key-paste": {
        const key = (await this.deps.readClipboard()).trim();
        if (!key)
          throw new Error(
            "Copy the API key to the clipboard first, then choose Paste key.",
          );
        const fingerprint = `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
        if (
          !(await this.deps.confirm(
            `Store the API key from the clipboard for ${this.label(command.connectionId)}?`,
            `Fingerprint ${fingerprint}. Topsl's local proxy keeps it encrypted in its own connection database and uses it only for requests you start through this connection; it is never shown again, sent to the window, or given to tools. Requests through it are billed to that key's account. Topsl clears the clipboard afterwards.`,
            "Store key",
          ))
        )
          return null;
        const result = await send({
          type: "connection-api-key",
          connectionId: command.connectionId,
          key,
        });
        await this.deps.clearClipboard(key);
        return result;
      }
      case "connection-sign-in": {
        if (
          this.view?.connections.find((c) => c.id === command.connectionId)
            ?.kind !== "chatgpt-plan"
        )
          throw new Error("Only a ChatGPT plan connection signs in.");
        if (
          !(await this.deps.confirm(
            "Continue with ChatGPT?",
            "Your browser opens ChatGPT's sign-in page. Topsl's proxy keeps this sign-in encrypted and uses its plan allowance for native tasks you start. You can disconnect at any time.",
            "Continue with ChatGPT",
          ))
        )
          return null;
        return send({
          type: "connection-sign-in",
          connectionId: command.connectionId,
        });
      }
      case "connection-test": {
        const route = this.view?.routes.find((r) => r.id === command.routeId);
        const connection = this.view?.connections.find(
          (c) => c.id === route?.connectionId,
        );
        if (!route || !connection) throw new Error("The route does not exist.");
        if (
          !(await this.deps.confirm(
            `Test ${route.alias}?`,
            `Topsl sends ${connectionTestPlan.requests} small requests to ${connection.endpoint} for model ${route.upstreamModel}: ${connectionTestPlan.description}, each capped at 64 output tokens. They are billed or counted by ${connection.label} like any other request, and each appears under Recent requests. The results are recorded for this route's current configuration only.`,
            "Run test",
          ))
        )
          return null;
        return send({ ...command }, 4 * 60_000);
      }
      case "connection-capabilities":
        return send({ ...command }, 30_000);
      case "connection-disconnect":
      case "connection-remove": {
        const remove = command.type === "connection-remove";
        if (
          !(await this.deps.confirm(
            `${remove ? "Remove" : "Disconnect"} ${this.label(command.connectionId)}?`,
            `New requests through it stop and requests in flight are cancelled. Topsl deletes its stored credential${remove ? " and the connection's routes" : ""}. Native tasks bound to it fail at their next request.`,
            remove ? "Remove" : "Disconnect",
            "warning",
          ))
        )
          return null;
        return send({ type: command.type, connectionId: command.connectionId });
      }
      case "connection-receipts":
        return send({
          type: "receipts",
          connectionId: command.connectionId,
          attemptId: command.attemptId,
          limit: command.limit,
        });
      case "connection-models":
        return send({ ...command }, 30_000);
      default:
        return send({ ...command });
    }
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    await this.request({ kind: "close" }, 10_000).catch(() => child.kill());
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
  }
}

export const proxyBundle = (directory: string) =>
  path.join(directory, "proxy.cjs");
