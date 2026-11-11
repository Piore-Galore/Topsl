import { expect, test } from "vitest";
import { splitGoals } from "../packages/orchestration/loop-engine";

/**
 * A Goal run reads each message for goals. The team instructions the loop
 * supervisor acts on (docs/Recursive_Looping.md) are instructions, and must
 * not also become required goals the run then has to satisfy.
 */
test("team instructions are not goals", () => {
  expect(splitGoals("Use exactly four active roles")).toEqual([]);
  expect(splitGoals("Always keep an accessibility role")).toEqual([]);
  expect(splitGoals("Do not use Fable")).toEqual([]);
  expect(
    splitGoals("Make sync reliable\nAlways keep a security role"),
  ).toEqual(["Make sync reliable"]);
  // Work that merely starts with the same words is still a goal.
  expect(splitGoals("Keep the settings page fast")).toEqual([
    "Keep the settings page fast",
  ]);
});
