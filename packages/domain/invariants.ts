import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { LifecyclePlan, UpdateCheck, UsageFact } from "./types";
export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function planDigest(
  plan: Omit<LifecyclePlan, "digest"> | LifecyclePlan,
): string {
  const { digest: _, ...body } = plan as LifecyclePlan;
  return hash(stable(body));
}
export function validatePlan(
  plan: LifecyclePlan,
  currentRevision: string | null,
  at = Date.now(),
): void {
  if (plan.digest !== planDigest(plan))
    throw new Error("Plan integrity changed. Create a fresh preview.");
  if (Date.parse(plan.expiresAt) <= at)
    throw new Error("Approval expired. Create a fresh preview.");
  if (plan.expectedRevision !== currentRevision)
    throw new Error("Installation changed since preview. Check it again.");
  if (
    plan.route === "package-manager" &&
    (plan.command?.executable === "" || !plan.command)
  )
    throw new Error("Missing reviewed operation.");
}
export function nextCheck(failures: number, at = Date.now()): string {
  return new Date(
    at + Math.min(7, 2 ** Math.max(0, failures - 1)) * 86_400_000,
  ).toISOString();
}
export function checkDue(
  check: UpdateCheck | undefined,
  at = Date.now(),
): boolean {
  return !check || Date.parse(check.nextCheckAt) <= at;
}
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?$/.exec(v);
  const x = parse(a),
    y = parse(b);
  if (!x || !y) return a === b ? 0 : null;
  for (let i = 1; i <= 3; i++)
    if (+x[i] !== +y[i]) return +x[i] > +y[i] ? 1 : -1;
  if (x[4] === y[4]) return 0;
  if (!x[4]) return 1;
  if (!y[4]) return -1;
  return null;
}
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(
      /(sk-[\w-]{12,}|Bearer\s+\S+|(?:access_token|refresh_token|api_key|code)=([^\s&]+))/gi,
      "[redacted]",
    )
    .slice(0, 1500);
}
export function normalizeUsage(
  provider: "codex" | "claude",
  raw: any,
  runId: string,
  scope = "run",
): UsageFact {
  const number = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  if (provider === "codex")
    return {
      id: `${runId}:${scope}`,
      runId,
      provider,
      input: number(raw.inputTokens ?? raw.input_tokens),
      output: number(raw.outputTokens ?? raw.output_tokens),
      cached: number(raw.cachedInputTokens ?? raw.cached_input_tokens),
      source: "native-runtime",
      scope,
    };
  const input = number(raw.input_tokens),
    cached = number(raw.cache_read_input_tokens),
    created = number(raw.cache_creation_input_tokens);
  return {
    id: `${runId}:${scope}`,
    runId,
    provider,
    input:
      input === null || cached === null || created === null
        ? null
        : input + cached + created,
    output: number(raw.output_tokens),
    cached,
    source: "native-runtime",
    scope,
  };
}
