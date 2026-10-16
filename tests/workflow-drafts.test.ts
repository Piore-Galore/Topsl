import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { fixture } from "./helpers";
import { WorkflowDrafts } from "../packages/workflows/drafts";
import { workflowDraftInput } from "../packages/domain/workflow-drafts";
const opened: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
test("R2-AT-32/34 protected workflow drafts preserve project scope and reject stale updates", async () => {
  const f = await fixture();
  opened.push(f);
  f.store.put("project", { id: "one" });
  f.store.put("project", { id: "two" });
  f.store.put("workflow", { id: "workflow", projectId: "one" });
  const drafts = new WorkflowDrafts(f.store),
    input = workflowDraftInput.parse({
      objective: "修复 Unicode 路径",
      criteria: "Retain evidence",
    });
  const first = drafts.save("one", null, 0, input);
  expect(drafts.query("two", null)).toBeNull();
  expect(drafts.query("one", null)?.draft.objective).toBe(input.objective);
  expect(() => drafts.save("one", null, 0, input)).toThrow("changed");
  expect(() => drafts.query("two", "workflow")).toThrow("another project");
  const update = drafts.save("one", null, first.revision, {
    ...input,
    step: 3,
  });
  expect(() => drafts.delete("one", null, first.revision)).toThrow(
    "revision changed",
  );
  drafts.delete("one", null, update.revision);
  expect(drafts.query("one", null)).toBeNull();
});
test("a new draft pairs Codex with Codex, and an older saved draft keeps its pairing", async () => {
  const f = await fixture();
  opened.push(f);
  f.store.put("project", { id: "one" });
  const drafts = new WorkflowDrafts(f.store),
    fresh = workflowDraftInput.parse({});
  expect([fresh.builder, fresh.reviewer]).toEqual(["codex", "codex"]);
  const saved = drafts.save("one", null, 0, { ...fresh, reviewer: "claude" });
  expect(drafts.query("one", null)?.draft.reviewer).toBe("claude");
  // Drafts saved before the reviewer choice have no reviewer; the setup then
  // paired the builder with the other provider.
  for (const [builder, reviewer] of [
    ["codex", "claude"],
    ["claude", "codex"],
  ] as const) {
    const { reviewer: _, ...older } = { ...saved.draft, builder };
    f.store.put("workflow-draft", { ...saved, draft: older });
    expect(drafts.query("one", null)?.draft).toMatchObject({
      builder,
      reviewer,
    });
  }
});
