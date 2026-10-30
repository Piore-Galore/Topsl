import { z } from "zod";

const id = z.string().min(1).max(256);
const provider = z.enum(["codex", "claude"]);

/**
 * Explicit export imports (docs/UX_Cleanup_Plan.md §3). The file itself is
 * chosen in Topsl's native dialog; the renderer never names a path.
 */
export const importCommands = [
  /** Reads the chosen file and shows what an import would keep. */
  z.object({
    type: z.literal("history-import-preview"),
    projectId: id,
    provider,
  }),
  /** Commits exactly the previewed text. */
  z.object({
    type: z.literal("history-import-commit"),
    projectId: id,
    previewId: id,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  /** The project's imports, newest first, optionally searched. */
  z.object({
    type: z.literal("history-imports"),
    projectId: id,
    query: z.string().max(500).optional(),
    cursor: z.string().max(20).nullable().optional(),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  /** A slice of one import's full original text. */
  z.object({
    type: z.literal("history-import-read"),
    projectId: id,
    id,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200000).default(100000),
  }),
  /** What a new session would freeze from one import. */
  z.object({
    type: z.literal("history-import-excerpt"),
    projectId: id,
    id,
  }),
  /** Deletes an import; sessions that already use it keep their copy. */
  z.object({
    type: z.literal("history-import-delete"),
    projectId: id,
    id,
  }),
] as const;
