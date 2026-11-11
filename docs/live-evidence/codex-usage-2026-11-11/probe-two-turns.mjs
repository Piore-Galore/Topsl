// Two short live Codex turns on one thread, to see whether tokenUsage.total
// carries across turns. Records usage numbers and method names only.
import { spawn } from "node:child_process";
import path from "node:path";
const cwd = path.resolve("work");
const child = spawn("/opt/homebrew/bin/codex", ["app-server"], { cwd, stdio: ["pipe", "pipe", "ignore"] });
let seq = 0, buffer = "";
const pending = new Map(), usage = [], declined = [];
let turnDone = () => {};
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const request = (method, params) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ id, method, params }); });
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.method === "string") {
      if (m.id !== undefined) { declined.push(m.method); send({ id: m.id, error: { code: -32601, message: "Declined by the probe." } }); }
      else if (m.method === "thread/tokenUsage/updated") usage.push({ turnId: m.params?.turnId, last: m.params?.tokenUsage?.last, total: m.params?.tokenUsage?.total });
      else if (m.method === "turn/completed") turnDone("completed");
    } else if (pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(String(m.error.message).slice(0, 300))) : p.resolve(m.result); }
  }
});
child.on("exit", () => turnDone("exited"));
const turn = async (threadId, text) => {
  const finished = new Promise((r) => (turnDone = r));
  const timer = setTimeout(() => turnDone("timeout"), 120_000);
  await request("turn/start", { threadId, input: [{ type: "text", text }], cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } });
  const outcome = await finished; clearTimeout(timer); return outcome;
};
const outcomes = []; let error = null, model = null;
try {
  await request("initialize", { clientInfo: { name: "topsl-usage-probe", title: "Topsl usage probe", version: "0.1.3" }, capabilities: { experimentalApi: true } });
  send({ method: "initialized", params: {} });
  const thread = await request("thread/start", { cwd, approvalPolicy: "untrusted", approvalsReviewer: "user", sandbox: "read-only" });
  const threadId = thread?.thread?.id ?? thread?.threadId; model = thread?.model ?? null;
  outcomes.push(await turn(threadId, "Do not use any tool. Reply with exactly the single word: one"));
  if (outcomes[0] === "completed") outcomes.push(await turn(threadId, "Do not use any tool. Reply with exactly the single word: two"));
} catch (e) { error = String(e.message ?? e).slice(0, 300); }
console.log(JSON.stringify({ outcomes, error, model, declined, usage }, null, 1));
child.kill();
setTimeout(() => process.exit(0), 500);
