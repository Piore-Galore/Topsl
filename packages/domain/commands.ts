import { z } from "zod";
const id = z.string().min(1).max(256);
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("state") }),
  z.object({
    type: z.literal("unlock"),
    passphrase: z.string().min(12).max(1024),
  }),
  z.object({
    type: z.literal("theme"),
    theme: z.enum(["paper", "night", "system"]),
  }),
  z.object({ type: z.literal("discover") }),
  z.object({ type: z.literal("trust-installation"), id }),
  z.object({ type: z.literal("select-runtime") }),
  z.object({ type: z.literal("check-updates"), id }),
  z.object({
    type: z.literal("lifecycle-preview"),
    appId: id,
    installationId: id.nullable(),
    action: z.enum(["download", "install", "update"]),
  }),
  z.object({ type: z.literal("lifecycle-apply"), id }),
  z.object({ type: z.literal("lifecycle-cancel"), id }),
  z.object({ type: z.literal("lifecycle-reconcile"), id }),
  z.object({ type: z.literal("lifecycle-retry-preview"), id }),
  z.object({ type: z.literal("open-application"), id }),
  z.object({
    type: z.literal("open-docs"),
    appId: id,
    kind: z.enum(["website", "docs", "releaseNotes"]),
  }),
  z.object({ type: z.literal("show-download"), id }),
  z.object({ type: z.literal("project-add") }),
  z.object({ type: z.literal("project-sync-enable"), enabled: z.boolean() }),
  z.object({ type: z.literal("project-sync-refresh") }),
  z.object({
    type: z.literal("codex-project-sync-enable"),
    installationId: id,
  }),
  z.object({ type: z.literal("codex-project-sync-pause") }),
  z.object({ type: z.literal("codex-project-sync-refresh") }),
  z.object({
    type: z.literal("codex-project-rename"),
    id,
    expectedRevision: id,
    name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\x00-\x1f\x7f]+$/),
  }),
  z.object({
    type: z.literal("codex-project-move"),
    id,
    beforeProjectId: id.nullable(),
    expectedOrderRevision: id,
  }),
  z.object({ type: z.literal("project-trust"), id }),
  z.object({ type: z.literal("project-relink"), id }),
  z.object({
    type: z.literal("project-open"),
    projectId: id,
    installationId: id,
  }),
  z.object({ type: z.literal("project-copy-path"), id }),
  z.object({
    type: z.literal("conversation-add"),
    projectId: id,
    title: z.string().min(1).max(200),
  }),
  z.object({
    type: z.literal("history-search"),
    projectId: id,
    query: z.string().max(500),
  }),
  z.object({
    type: z.literal("history-import"),
    projectId: id,
    provider: z.enum(["codex", "claude"]),
  }),
  z.object({ type: z.literal("history-delete"), id }),
  z.object({ type: z.literal("runtime-connect"), id }),
  z.object({ type: z.literal("runtime-login"), id }),
  z.object({ type: z.literal("runtime-models"), id }),
  z.object({ type: z.literal("runtime-account"), id }),
  z.object({
    type: z.literal("run-start"),
    conversationId: id,
    installationId: id,
    prompt: z.string().min(1).max(100000),
    model: z.string().min(1).max(200),
    mode: z.enum(["review", "edit", "native"]),
    snapshotId: id.nullable(),
  }),
  z.object({ type: z.literal("run-interrupt"), id }),
  z.object({ type: z.literal("run-reconcile"), id }),
  z.object({ type: z.literal("approval-decide"), id, allow: z.boolean() }),
  z.object({
    type: z.literal("handoff-preview"),
    conversationId: id,
    provider: z.enum(["codex", "claude"]),
    objective: z.string().min(1).max(10000),
  }),
  z.object({ type: z.literal("handoff-export"), id }),
  z.object({
    type: z.literal("terminal-open"),
    projectId: id,
    installationId: id,
    login: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("terminal-input"),
    id,
    data: z.string().max(65536),
  }),
  z.object({
    type: z.literal("terminal-resize"),
    id,
    cols: z.number().int().min(20).max(500),
    rows: z.number().int().min(5).max(200),
  }),
  z.object({ type: z.literal("terminal-close"), id }),
  z.object({
    type: z.literal("configuration-read"),
    provider: z.enum(["codex", "claude"]),
    projectId: id.nullable(),
    kind: z.enum(["native", "instructions"]),
  }),
  z.object({
    type: z.literal("configuration-preview"),
    path: z.string().max(4096),
    expectedHash: id,
    text: z.string().max(1000000),
  }),
  z.object({ type: z.literal("configuration-apply"), id }),
  z.object({ type: z.literal("context-enable"), projectId: id }),
]);
export type Command = z.infer<typeof commandSchema>;
