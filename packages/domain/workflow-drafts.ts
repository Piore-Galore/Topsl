import { z } from "zod";
const identity = z.string().min(1).max(256);
const text = z.string().max(100000);
export const workflowDraftInput = z.object({
  objective: text.default(""),
  criteria: text.default(""),
  interfaces: text.default(""),
  builder: z.enum(["codex", "claude"]).default("codex"),
  reviewer: z.enum(["codex", "claude"]).default("codex"),
  builderRuntime: z.string().max(256).default(""),
  reviewerRuntime: z.string().max(256).default(""),
  builderModel: z.string().max(200).default(""),
  reviewerModel: z.string().max(200).default(""),
  builderEffort: z.string().max(100).default(""),
  reviewerEffort: z.string().max(100).default(""),
  environmentRecipeId: z.string().max(256).default(""),
  selectedPaths: text.default(""),
  approvedUntracked: text.default(""),
  checkExecutable: z.string().max(4096).default(""),
  checkArguments: z.array(z.string().max(20000)).max(100).default(["--test"]),
  step: z.number().int().min(0).max(4).default(0),
});
const scope = {
  projectId: identity,
  workflowId: identity.nullable().default(null),
};
export const workflowDraftCommands = [
  z.object({ type: z.literal("workflow-draft-query"), ...scope }),
  z.object({
    type: z.literal("workflow-draft-save"),
    requestId: identity,
    ...scope,
    expectedRevision: z.number().int().nonnegative(),
    draft: workflowDraftInput,
  }),
  z.object({
    type: z.literal("workflow-draft-delete"),
    requestId: identity,
    ...scope,
    expectedRevision: z.number().int().positive(),
  }),
] as const;
export type WorkflowDraftInput = z.infer<typeof workflowDraftInput>;
export interface WorkflowDraft {
  id: string;
  projectId: string;
  workflowId: string | null;
  revision: number;
  draft: WorkflowDraftInput;
  updatedAt: string;
}
