import { z } from "zod";
const assignmentSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    workspaceId: z.string().min(1),
    installationId: z.string().min(1),
    provider: z.enum(["codex", "claude"]),
    model: z.string().trim().min(1).max(300),
    permittedOutputs: z.array(z.string().min(1)).max(100),
  })
  .strict();
const rubricSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    unit: z.string().min(1),
    direction: z.enum(["at-least", "at-most"]),
    threshold: z.number().finite(),
  })
  .strict();
const checkSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    executable: z.string().min(1),
    args: z.array(z.string().max(20000)).max(100),
    timeoutMs: z.number().int().min(100).max(300000),
  })
  .strict();
export const advancedCreateSchema = z
  .object({
    projectId: z.string().min(1),
    template: z.enum([
      "independent-proposals",
      "independent-test-design",
      "competing-implementations",
      "pair-debugging",
    ]),
    objective: z.string().trim().min(1).max(20000),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1).max(100),
    interfaces: z.array(z.string().max(20000)).max(100),
    participants: z.array(assignmentSchema).min(1).max(8),
    rubric: z.array(rubricSchema).min(1).max(30),
    protocol: z.string().trim().min(1).max(20000),
    protocolChecks: z.array(checkSchema).max(20).default([]),
    baselineCandidateId: z.string().nullable().default(null),
  })
  .strict();
export type AdvancedCreate = z.infer<typeof advancedCreateSchema>;
export type RoleAssignment = z.infer<typeof assignmentSchema>;
export const advancedMeasurementsSchema = z
  .array(
    z
      .object({
        criterionId: z.string(),
        value: z.number().finite(),
        evidenceArtifactId: z.string(),
      })
      .strict(),
  )
  .max(30);
