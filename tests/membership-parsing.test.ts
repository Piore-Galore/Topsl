import { expect, test } from "vitest";
import { parseMembership } from "../packages/orchestration/membership";

/**
 * Goal messages are read for roster instructions. Sentences about the work
 * itself, and model names with a version number, must not be misread.
 */

test("a sentence about the work that starts with Use is not a roster", () => {
  expect(
    parseMembership("Add a login page. Use React hooks.", "m1"),
  ).toEqual([]);
  expect(parseMembership("Use TypeScript.", "m2")).toEqual([]);
  expect(parseMembership("Use Postgres for storage.", "m3")).toEqual([]);
  // The documented form still pins one member and its fallback.
  const [pinned] = parseMembership(
    "Use Sol; fall back to Fable if unavailable.",
    "m4",
  );
  expect(pinned.settings.members![0].pin?.label).toBe("Sol");
  expect(pinned.settings.members![0].fallbacks).toEqual([{ label: "Fable" }]);
});

test("a period inside a model name does not end the clause", () => {
  const [reviewers] = parseMembership(
    "Review with GPT-5.5 and Opus 4.7.",
    "m5",
  );
  expect(reviewers.roleId).toBe("reviewer");
  expect(reviewers.settings.members!.map((m) => m.pin?.label)).toEqual([
    "GPT-5.5",
    "Opus 4.7",
  ]);
  // Sentences still end at a period followed by white space.
  const two = parseMembership(
    "Review with Sol. Coordinate with Fable.",
    "m6",
  );
  expect(two.map((r) => r.roleId)).toEqual(["reviewer", "coordinator"]);
});
