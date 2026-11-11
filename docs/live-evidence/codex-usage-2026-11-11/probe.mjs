// One live Codex turn, to read thread/tokenUsage/updated. Records usage numbers
// and method names only; no prompt or answer text is kept.
import { spawn } from "node:child_process";
import path from "node:path";
const cwd = path.resolve("work");
const child = spawn("/opt/homebrew/bin/codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
let seq = 0, buffer = "", turns = 0;
const pending = new Map(), usage = [], methods = {}, declined = [];
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const request = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ id, method, params }); });
let done;
const finished = new Promise((r) => (done = r));
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.method === "string") {
      methods[m.method] = (methods[m.method] ?? 0) + 1;
      if (m.id !== undefined) { declined.push(m.method); send({ id: m.id, error: { code: -32601, message: "Declined by the probe." } }); }
      else if (m.method === "thread/tokenUsage/updated") usage.push({ turnId: m.params?.turnId, last: m.params?.tokenUsage?.last, total: m.params?.tokenUsage?.total });
      else if (m.method === "turn/completed") done("completed");
    } else if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(String(m.error.message).slice(0, 300))) : p.resolve(m.result); }
  }
});
child.on("exit", () => done("exited"));
const timer = setTimeout(() => done("timeout"), 180_000);
let outcome = "error", error = null, model = null;
try {
  await request("initialize", { clientInfo: { name: "topsl-usage-probe", title: "Topsl usage probe", version: "0.1.3" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const thread = await request("thread/start", { cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" });
  const threadId = thread?.thread?.id ?? thread?.threadId; model = thread?.model ?? null;
  turns += 1;
  await request("turn/start", { threadId, input: [{ type: "text", text: "Use the shell tool to run `cat note.txt` in the current folder, then reply with exactly the text it printed and nothing else." }], cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } });
  outcome = await finished;
} catch (e) { error = String(e.message ?? e).slice(0, 300); }
clearTimeout(timer);
console.log(JSON.stringify({ outcome, error, model, turnsStarted: turns, declined, methods, usage }, null, 1));
child.kill();
setTimeout(() => process.exit(0), 500);
