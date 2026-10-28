import { z } from "zod";
import {
  MEMBER_LIMIT_CEILING,
  groupScopeLevels,
  roleGroupSettingsSchema,
  roleIdSchema,
} from "./role-groups";

const id = z.string().min(1).max(256);
const commandId = z.string().min(8).max(256);

/** A required check definition, shared with Build and review and parallel workflows. */
export const requiredCheckSchema = z.object({
  id,
  label: z.string().min(1).max(1000),
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(20000)).max(100),
  timeoutMs: z.number().int().min(100).max(300000),
  environmentRecipeId: id.optional(),
  executionPolicy: z
    .object({
      maximumUses: z.number().int().min(1).max(10),
      allowCandidateChanges: z.boolean().optional(),
      expiresAfterMs: z.number().int().min(100).max(3600000).optional(),
    })
    .optional(),
});

/** Service commands for the coordinator feature (docs/Coordinator_Teams.md). */
export const orchestrationCommands = [
  /** With `conversationId`, only that conversation and its goals. */
  z.object({
    type: z.literal("orchestration-query"),
    projectId: id,
    conversationId: id.nullable().optional(),
  }),
  /** The sidebar's goal and loop threads for each project, newest first. */
  z.object({
    type: z.literal("coordinator-threads"),
    projectIds: z.array(id).max(500),
    limit: z.number().int().min(1).max(200).default(8),
  }),
  /** A new goal thread: a conversation and its first goal. */
  z.object({
    type: z.literal("orchestration-conversation-start"),
    projectId: id,
    text: z.string().min(1).max(100000),
    kind: z.enum(["code", "information"]).default("code"),
    checks: z.array(requiredCheckSchema).max(20).optional(),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-conversation-create"),
    projectId: id,
    title: z.string().max(200).default(""),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-message"),
    conversationId: id,
    text: z.string().min(1).max(100000),
    goalId: id.nullable().default(null),
    routing: z
      .enum([
        "auto",
        "follow-up",
        "new-goal",
        "update-goal",
        "related-goal",
        "status",
      ])
      .default("auto"),
    kind: z.enum(["code", "information"]).default("code"),
    /** Required checks for a new code goal; ignored when the message steers a goal. */
    checks: z.array(requiredCheckSchema).max(20).optional(),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-checks-set"),
    goalId: id,
    checks: z.array(requiredCheckSchema).max(20),
    commandId,
  }),
  z.object({ type: z.literal("orchestration-checks-preview"), goalId: id }),
  /** Runs one previewed check plan; the desktop shell confirms it natively. */
  z.object({ type: z.literal("orchestration-check-apply"), id }),
  z.object({
    type: z.literal("orchestration-conflict-resolve"),
    goalId: id,
    resolutions: z
      .array(z.object({ path: z.string().min(1).max(4096), candidateId: id }))
      .min(1)
      .max(10000),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-group-set"),
    projectId: id,
    goalId: id.nullable().default(null),
    level: z.enum(groupScopeLevels),
    taskKey: z.string().max(64).nullable().default(null),
    roleId: z.union([roleIdSchema, z.literal("*")]),
    settings: roleGroupSettingsSchema,
    mode: z.enum(["merge", "replace"]).default("replace"),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-member-release"),
    projectId: id,
    goalId: id.nullable().default(null),
    roleId: roleIdSchema,
    memberId: id,
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-roster-release"),
    projectId: id,
    goalId: id.nullable().default(null),
    roleId: roleIdSchema,
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-policy-set"),
    projectId: id,
    expectedRevision: z.number().int().nonnegative(),
    maxMembersPerRole: z.number().int().min(1).max(MEMBER_LIMIT_CEILING),
    defaults: roleGroupSettingsSchema.default({}),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-role-define"),
    projectId: id,
    roleId: roleIdSchema,
    title: z.string().min(1).max(200),
    instructions: z.string().min(1).max(20000),
    purpose: z.enum([
      "coordinator-contribution",
      "information",
      "implementation",
      "candidate-review",
    ]),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-control"),
    projectId: id,
    goalId: id.nullable().default(null),
    action: z.enum(["pause", "stop", "resume", "stop-member"]),
    roundId: id.optional(),
    memberId: id.optional(),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-round-restart"),
    goalId: id,
    roundId: id,
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-branch-choose"),
    goalId: id,
    roundId: id,
    contributionId: z.string().min(1).max(600),
    commandId,
  }),
  z.object({
    type: z.literal("orchestration-finding-decide"),
    goalId: id,
    findingKey: id,
    disposition: z.enum([
      "substantiated",
      "duplicate",
      "unsupported",
      "resolved-by-check",
      "waived",
    ]),
    rationale: z.string().min(1).max(10000),
    commandId,
  }),
  z.object({ type: z.literal("orchestration-repair"), goalId: id, commandId }),
  z.object({ type: z.literal("orchestration-accept"), goalId: id, commandId }),
  /** Writes the accepted candidate into the project folder after native confirmation. */
  z.object({ type: z.literal("orchestration-apply"), goalId: id, commandId }),
] as const;
