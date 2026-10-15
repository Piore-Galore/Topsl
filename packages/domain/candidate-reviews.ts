import { z } from "zod";
const id = z.string().min(1).max(256);
const relative = z.string().min(1).max(4096);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const candidateReviewCommands = [
  z.object({
    type: z.literal("candidate-review-preview"),
    projectId: id,
    candidateId: id,
    capturePaths: z
      .array(z.object({ path: relative, hash: digest }))
      .max(50)
      .optional(),
    outputs: z
      .array(
        z.object({
          path: relative,
          hash: digest,
          decision: z.enum(["approved", "rejected"]),
        }),
      )
      .max(50)
      .default([]),
    binaries: z
      .array(
        z.object({
          path: relative,
          detail: z.string().trim().min(1).max(4000),
        }),
      )
      .max(10)
      .default([]),
  }),
  z.object({
    type: z.literal("candidate-review-apply"),
    requestId: id,
    projectId: id,
    id,
  }),
  z.object({
    type: z.literal("candidate-binary-preview"),
    projectId: id,
    candidateId: id,
    path: relative,
  }),
] as const;
