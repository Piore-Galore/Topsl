import { z } from "zod";

const id = z.string().min(1).max(256);
const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.*:-]+$/);
const argv = z.array(z.string().min(1).max(4096)).min(1).max(100);

/**
 * Connection commands (docs/Native_Harness_Plan.md §2). Electron main sends
 * them to the proxy process over its trusted channel; they never reach the
 * control service, and no credential travels through the renderer: an API
 * key is read from the clipboard by main, and ChatGPT sign-in completes in
 * the browser.
 */
export const connectionCommands = [
  z.object({
    type: z.literal("connection-create"),
    kind: z.enum([
      "chatgpt-plan",
      "claude-plan",
      "openai-api",
      "anthropic-api",
      "openai-compatible",
      "ollama",
    ]),
    label: z.string().min(1).max(200),
    endpoint: z.string().max(2000).nullable().optional(),
    protocol: z.enum(["responses", "messages", "chat"]).optional(),
  }),
  z.object({
    type: z.literal("connection-rename"),
    connectionId: id,
    label: z.string().min(1).max(200),
  }),
  /** Main reads the key from the clipboard after the owner confirms. */
  z.object({ type: z.literal("connection-key-paste"), connectionId: id }),
  z.object({ type: z.literal("connection-sign-in"), connectionId: id }),
  z.object({ type: z.literal("connection-sign-in-complete"), attemptId: id }),
  z.object({ type: z.literal("connection-sign-in-cancel"), attemptId: id }),
  z.object({ type: z.literal("connection-models"), connectionId: id }),
  z.object({ type: z.literal("connection-disconnect"), connectionId: id }),
  z.object({ type: z.literal("connection-remove"), connectionId: id }),
  z.object({
    type: z.literal("route-save"),
    id: id.optional(),
    connectionId: id,
    upstreamModel: z.string().min(1).max(200),
    alias: z.string().min(1).max(128),
    disabled: z.boolean().optional(),
  }),
  z.object({ type: z.literal("route-remove"), routeId: id }),
  z.object({
    type: z.literal("connection-receipts"),
    connectionId: id.optional(),
    attemptId: id.optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
] as const;

export const connectionCommandTypes = new Set<string>(
  connectionCommands.map((c) => c.shape.type.value),
);

/** Native harness commands, handled by the control service. */
export const nativeCommands = [
  z.object({ type: z.literal("native-state"), projectId: id }),
  z.object({
    type: z.literal("native-start"),
    projectId: id,
    prompt: z.string().min(1).max(100_000),
    title: z.string().max(200).optional(),
    routeAlias: z.string().min(1).max(128),
    mode: z.enum(["investigate", "edit"]),
    processes: z.boolean().default(false),
    networkDomains: z.array(domain).max(50).default([]),
    checks: z
      .array(
        z.object({
          name: z.string().min(1).max(100),
          argv,
          timeoutMs: z.number().int().min(1000).max(3_600_000),
        }),
      )
      .max(20)
      .default([]),
    delegation: z.boolean().default(false),
    mcpServerIds: z.array(id).max(10).default([]),
    reasoningEffort: z.string().min(1).max(40).nullable().default(null),
    contextWindowTokens: z
      .number()
      .int()
      .min(2048)
      .max(4_000_000)
      .nullable()
      .default(null),
    maxRequests: z.number().int().min(1).max(500).nullable().default(null),
  }),
  z.object({
    type: z.literal("native-events"),
    attemptId: id,
    after: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(1000).default(200),
  }),
  z.object({ type: z.literal("native-attempt"), attemptId: id }),
  z.object({
    type: z.literal("native-steer"),
    attemptId: id,
    text: z.string().min(1).max(20_000),
  }),
  z.object({ type: z.literal("native-pause"), attemptId: id }),
  z.object({ type: z.literal("native-resume"), attemptId: id }),
  z.object({ type: z.literal("native-cancel"), attemptId: id }),
  z.object({
    type: z.literal("native-reconcile"),
    attemptId: id,
    callId: id,
    outcome: z.enum(["applied", "not-applied"]),
    note: z.string().max(2000).default(""),
  }),
  z.object({ type: z.literal("native-apply-preview"), attemptId: id }),
  z.object({ type: z.literal("native-apply"), attemptId: id }),
  z.object({ type: z.literal("native-discard"), attemptId: id }),
  z.object({
    type: z.literal("native-memory-decide"),
    id,
    accept: z.boolean(),
  }),
  z.object({
    type: z.literal("native-mcp-inspect"),
    projectId: id,
    name: z.string().min(1).max(40),
    argv,
    networkDomains: z.array(domain).max(20).default([]),
  }),
  z.object({
    type: z.literal("native-mcp-admit"),
    projectId: id,
    name: z.string().min(1).max(40),
    argv,
    networkDomains: z.array(domain).max(20).default([]),
    tools: z.record(z.string().max(200), z.string().regex(/^[a-f0-9]{64}$/)),
  }),
  z.object({ type: z.literal("native-mcp-remove"), id }),
  z.object({
    type: z.literal("native-hook-admit"),
    projectId: id,
    event: z.enum(["before-tool", "after-tool"]),
    argv,
    timeoutMs: z.number().int().min(1000).max(60_000).default(10_000),
  }),
  z.object({ type: z.literal("native-hook-remove"), id }),
  z.object({
    type: z.literal("native-quota-resume"),
    owner: z.string().min(1).max(500),
  }),
] as const;
