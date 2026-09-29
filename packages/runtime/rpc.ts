import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { nativeEnvironment } from "../platform/system";
import { safeError } from "../domain/invariants";

export class RpcPeer {
  readonly process: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private buffer = "";
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private closed = false;
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (id: string | number, method: string, params: any) => void = (
    id,
  ) => this.reject(id, "Unsupported client request.");
  onExit: (detail: string) => void = () => {};
  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env = nativeEnvironment(),
  ) {
    this.process = spawn(executable, args, {
      cwd,
      env,
      stdio: "pipe",
      shell: false,
      windowsHide: true,
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 8_000_000) {
        this.fail("Runtime protocol frame exceeded its limit.");
        this.close();
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.fail("Runtime emitted invalid protocol data.");
          this.close();
          return;
        }
      }
    });
    // Native diagnostic output can contain credentials or project content. Never log it wholesale.
    this.process.stderr.resume();
    this.process.stdin.on("error", (error) => this.fail(safeError(error)));
    this.process.on("error", (error) => this.fail(safeError(error)));
    this.process.on("exit", (code) =>
      this.fail(`Runtime connection closed (${code ?? "signal"}).`),
    );
  }
  private receive(message: any): void {
    if (!message || typeof message !== "object")
      throw new Error("Invalid frame.");
    if (typeof message.method === "string") {
      if (typeof message.id === "number" || typeof message.id === "string")
        this.onRequest(message.id, message.method, message.params);
      else this.onNotification(message.method, message.params);
    } else if (typeof message.id === "number") {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(message.id);
      if (message.error)
        request.reject(
          new Error(
            safeError(message.error.message ?? "Native request failed."),
          ),
        );
      else request.resolve(message.result);
    }
  }
  private send(message: unknown): void {
    if (this.closed) throw new Error("Runtime connection is closed.");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out. Its outcome may be uncertain; it was not retried.`,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  notify(method: string, params: unknown = {}): void {
    this.send({ method, params });
  }
  reply(id: number | string, result: unknown): void {
    this.send({ id, result });
  }
  reject(id: number | string, message: string): void {
    this.send({ id, error: { code: -32601, message } });
  }
  async initialize(): Promise<any> {
    const info = await this.request("initialize", {
      clientInfo: {
        name: "topsl",
        title: "Topsl personal pilot",
        version: "0.1.1",
      },
    });
    this.notify("initialized");
    return info;
  }
  private fail(message: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.onExit(message);
  }
  close(): void {
    this.fail("Runtime connection closed.");
    this.process.stdin.end();
    this.process.kill();
  }
}
