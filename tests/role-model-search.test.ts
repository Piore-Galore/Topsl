import { expect, test } from "vitest";
import {
  filterModelOptions,
  typedModelPin,
  type ModelOption,
} from "../apps/desktop/renderer/coordinator/role-editor";
import { memberPinSchema } from "../packages/domain/role-groups";

const option = (
  provider: ModelOption["provider"],
  model: string,
  name: string,
): ModelOption => ({
  key: `${provider}-install:${model}`,
  provider,
  installationId: `${provider}-install`,
  model,
  name,
  available: true,
  reason: "",
});
const options = [
  option("codex", "gpt-5.5-codex", "GPT-5.5 Codex"),
  option("claude", "claude-opus-5-5", "Opus 5.5"),
];

test("role model search matches every word across provider, name and ID", () => {
  expect(filterModelOptions(options, "").map((o) => o.model)).toEqual([
    "gpt-5.5-codex",
    "claude-opus-5-5",
  ]);
  expect(
    filterModelOptions(options, "  OPUS claude ").map((o) => o.model),
  ).toEqual(["claude-opus-5-5"]);
  expect(filterModelOptions(options, "opus codex")).toEqual([]);
});

test("a typed model ID becomes a pin when no observed option offers it", () => {
  // Claude Code has no model list, so an empty catalog must still allow a pin.
  expect(typedModelPin([], "claude-sonnet-5-5", "claude")).toEqual({
    provider: "claude",
    model: "claude-sonnet-5-5",
  });
  expect(typedModelPin(options, " my-custom-model ", "")).toEqual({
    model: "my-custom-model",
  });
  // The same ID observed for another provider still allows a pin here.
  expect(typedModelPin(options, "claude-opus-5-5", "codex")).toEqual({
    provider: "codex",
    model: "claude-opus-5-5",
  });
  for (const pin of [
    typedModelPin([], "claude-sonnet-5-5", "claude"),
    typedModelPin([], "x", ""),
  ])
    expect(memberPinSchema.safeParse(pin).success).toBe(true);
});

test("no typed pin for an observed exact model, empty text or words", () => {
  expect(typedModelPin(options, "claude-opus-5-5", "")).toBeNull();
  expect(typedModelPin(options, "claude-opus-5-5", "claude")).toBeNull();
  expect(typedModelPin(options, "   ", "")).toBeNull();
  expect(typedModelPin(options, "opus claude", "")).toBeNull();
  expect(typedModelPin(options, "m".repeat(201), "")).toBeNull();
});
