import { z } from "zod";
import { roleGroupSettingsSchema, roleIdSchema } from "./role-groups";
import {
  criterionVerificationSchema,
  loopPolicySchema,
} from "./recursive-loops";

const id = z.string().min(1).max(256);
const commandId = z.string().min(8).max(256);

const goalInput = z
  .object({
    text: z.string().min(1).max(4000),
    required: z.boolean().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
    kind: z.enum(["code", "information"]).optional(),
    criteria: z
      .array(
        z.object({
          text: z.string().min(1).max(2000),
          verification: criterionVerificationSchema,
        }),
      )
      .max(50)
      .optional(),
    dependsOn: z
      .array(z.union([z.number().int().min(0), id]))
      .max(50)
      .optional(),
    constraints: z.array(z.string().min(1).max(2000)).max(50).optional(),
  })
  .strict();

/**
 * Public commands for Recursive Looping (docs/Recursive_Looping.md). They
 * carry the owner's intent. Assessment, topology commits, iteration admission
 * and promotion are supervisor-internal service operations with no command a
 * window or model could send.
 */
export const loopCommands = [
  z.object({ type: z.literal("loop-feature-set"), enabled: z.boolean() }),
  z.object({ type: z.literal("loop-query"), projectId: id }),
  z.object({ type: z.literal("loop-inspect"), runId: id }),
  z.object({
    type: z.literal("loop-timeline"),
    runId: id,
    cursor: z.string().max(2000).nullable().default(null),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.object({
    type: z.literal("loop-create"),
    projectId: id,
    conversationId: id.nullable().default(null),
    mode: z.enum(["goal", "endless"]),
    title: z.string().max(200).optional(),
    text: z.string().max(20000).default(""),
    goals: z.array(goalInput).max(50).optional(),
    policy: loopPolicySchema.partial().optional(),
    commandId,
  }),
  /** Starts a run under the authority the owner confirms natively. */
  z.object({ type: z.literal("loop-start"), runId: id, commandId }),
  z.object({
    type: z.literal("loop-goals-update"),
    runId: id,
    add: z.array(goalInput).max(50).optional(),
    edit: z
      .array(
        z
          .object({
            goalId: id,
            text: z.string().min(1).max(4000).optional(),
            required: z.boolean().optional(),
            priority: z.number().int().min(-100).max(100).optional(),
            criteria: z
              .array(
                z.object({
                  text: z.string().min(1).max(2000),
                  verification: criterionVerificationSchema,
                }),
              )
              .max(50)
              .optional(),
            dependsOn: z.array(id).max(50).optional(),
            clearBlocker: z.boolean().optional(),
          })
          .strict(),
      )
      .max(50)
      .optional(),
    remove: z.array(id).max(50).optional(),
    commandId,
  }),
  /** A change that widens what the run may execute is confirmed natively. */
  z.object({
    type: z.literal("loop-policy-update"),
    runId: id,
    expectedRevision: z.number().int().nonnegative(),
    policy: loopPolicySchema.partial(),
    commandId,
  }),
  z.object({
    type: z.literal("loop-override-set"),
    runId: id,
    kind: z.enum([
      "role-settings",
      "role-presence",
      "active-role-count",
      "provider-exclusion",
      "role-frozen",
    ]),
    roleId: roleIdSchema.nullable().default(null),
    settings: roleGroupSettingsSchema.nullable().default(null),
    value: z
      .union([z.number(), z.string().max(200)])
      .nullable()
      .default(null),
    commandId,
  }),
  z.object({
    type: z.literal("loop-override-release"),
    runId: id,
    overrideId: id,
    commandId,
  }),
  z.object({
    type: z.literal("loop-control"),
    runId: id,
    action: z.enum(["pause", "resume", "stop"]),
    commandId,
  }),
  /** Steering through chat: membership words become overrides, other text new goals. */
  z.object({
    type: z.literal("loop-message"),
    runId: id,
    text: z.string().min(1).max(20000),
    commandId,
  }),
  z.object({
    type: z.literal("loop-checkpoint-export"),
    runId: id,
    checkpointId: id.nullable().default(null),
  }),
  z.object({ type: z.literal("loop-publication-preview"), runId: id }),
  /** Writes the accepted checkpoint into the folder after native confirmation. */
  z.object({ type: z.literal("loop-publication-apply"), runId: id, commandId }),
  z.object({
    type: z.literal("loop-publication-reconcile"),
    runId: id,
    commandId,
  }),
] as const;
