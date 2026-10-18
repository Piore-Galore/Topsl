import { z } from "zod";
import {
  MEMBER_LIMIT_CEILING,
  groupScopeLevels,
  roleGroupSettingsSchema,
  roleIdSchema,
} from "./role-groups";

const id = z.string().min(1).max(256);
const commandId = z.string().min(8).max(256);

/** Service commands for the coordinator feature (docs/Coordinator_Teams.md). */
export const orchestrationCommands = [
  z.object({ type: z.literal("orchestration-query"), projectId: id }),
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
      .enum(["auto", "new-goal", "update-goal", "related-goal", "status"])
      .default("auto"),
    kind: z.enum(["code", "information"]).default("code"),
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
] as const;
