import { z } from "zod";
import { requiredCheckSchema } from "./orchestration-commands";
import { composerModes, sessionConfigurationPatchSchema } from "./sessions";

const id = z.string().min(1).max(256);
const commandId = z.string().min(8).max(256);

/** Service commands for native Topsl sessions (docs/Native_Sessions_Plan.md). */
export const sessionCommands = [
  /** A new session, with its configuration and optionally its first message. */
  z.object({
    type: z.literal("session-create"),
    projectId: id,
    title: z.string().max(200).optional(),
    configuration: sessionConfigurationPatchSchema.optional(),
    text: z.string().max(100000).optional(),
    mode: z.enum(composerModes).optional(),
    kind: z.enum(["code", "information"]).default("code"),
    checks: z.array(requiredCheckSchema).max(20).optional(),
    /**
     * An import of this project to attach as reference material; the
     * service freezes its excerpt (docs/UX_Cleanup_Plan.md §3).
     */
    referenceId: id.optional(),
    commandId,
  }),
  z.object({ type: z.literal("session-list"), projectId: id }),
  z.object({ type: z.literal("session-query"), sessionId: id }),
  /** Changes the configuration; applied at the active goal's next round boundary. */
  z.object({
    type: z.literal("session-update"),
    sessionId: id,
    expectedRevision: z.number().int().nonnegative(),
    configuration: sessionConfigurationPatchSchema,
    commandId,
  }),
  /** A message to the session's coordinators. */
  z.object({
    type: z.literal("session-message"),
    sessionId: id,
    text: z.string().min(1).max(100000),
    mode: z.enum(composerModes).optional(),
    /** "current": the session's current goal; a goal ID; null: New goal. */
    target: id.nullable().default(null),
    kind: z.enum(["code", "information"]).default("code"),
    checks: z.array(requiredCheckSchema).max(20).optional(),
    commandId,
  }),
  /** The owner's choice among the coordinators' unresolved alternatives. */
  z.object({
    type: z.literal("session-choose"),
    sessionId: id,
    intakeId: id,
    option: z.number().int().min(0).max(16),
    commandId,
  }),
  z.object({
    type: z.literal("session-queue"),
    sessionId: id,
    workItemId: id,
    action: z.enum(["remove", "up", "down"]),
    commandId,
  }),
  z.object({
    type: z.literal("session-control"),
    sessionId: id,
    action: z.enum(["pause", "resume", "stop"]),
    commandId,
  }),
  /** Saves a session role and its settings as project defaults. */
  z.object({
    type: z.literal("session-role-save"),
    sessionId: id,
    roleId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    commandId,
  }),
] as const;
