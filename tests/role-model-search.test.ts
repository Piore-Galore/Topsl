import { expect, test } from "vitest";
import {
  filterModelOptions,
  modelOptions,
  routeBlockers,
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
  routeId: null,
  model,
  name,
  efforts: [],
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

/** A route as the orchestration view reports it, with coordinator blockers. */
const route = (
  provider: "codex" | "claude",
  blockers: string[],
  { fresh = true, models = ["m"] } = {},
) => ({
  provider,
  installationId: `${provider}-install`,
  catalog: { fresh },
  models: models.map((model) => ({ model, name: model, efforts: [] })),
  purposes: {
    "coordinator-contribution": { ready: !blockers.length, blockers },
  },
});
const missing = (capability: string, code = "permission-profile-unverified") =>
  `${code}: ${capability} is not qualified for this runtime, account, policy and host.`;
const unqualified = [
  missing("structured-turn"),
  missing("native-subscription", "authentication-required"),
  missing("process-lifecycle", "process-lifecycle-unverified"),
  missing("fresh-session"),
  missing("read-only"),
];

test("an unqualified runtime is one line, with the runtime's own text behind it", () => {
  const status = routeBlockers(
    route("codex", unqualified),
    "coordinator-contribution",
  );
  expect(status.reasons).toEqual([
    "Not qualified yet. Qualify it under Providers.",
  ]);
  expect(status.details).toEqual(unqualified);
  // Every model of the route carries that one line, not the five blockers.
  expect(
    modelOptions([route("codex", unqualified)], "coordinator-contribution"),
  ).toMatchObject([
    {
      available: false,
      reason: "Not qualified yet. Qualify it under Providers.",
    },
  ]);
});

test("a qualification that missed a capability names it", () => {
  expect(
    routeBlockers(
      route("codex", [missing("read-only")]),
      "coordinator-contribution",
    ).reasons,
  ).toEqual([
    "Its qualification did not pass read-only. Qualify it again under Providers.",
  ]);
});

test("the first fix the owner must make stands alone", () => {
  expect(
    routeBlockers(
      route(
        "claude",
        [
          ...unqualified,
          "authentication-route-unapproved: Claude Code's structured route is off.",
        ],
        { fresh: false, models: [] },
      ),
      "coordinator-contribution",
    ).reasons,
  ).toEqual([
    "Claude Code's structured route is off. Turn it on under Providers, then qualify a model.",
  ]);
  expect(
    routeBlockers(
      route("codex", [
        "executable-untrusted: Review the selected executable before use.",
        ...unqualified,
      ]),
      "coordinator-contribution",
    ).reasons,
  ).toEqual(["Its executable is not trusted. Trust it under Providers."]);
});

test("a stale Codex catalog says so; an empty Claude catalog does not", () => {
  expect(
    routeBlockers(
      route("codex", [], { fresh: false }),
      "coordinator-contribution",
    ).reasons,
  ).toEqual([
    "Its model list is stale or not from the signed-in account. Choose Connect / test under Providers.",
  ]);
  expect(
    routeBlockers(
      route(
        "claude",
        [
          "claude-route-unqualified: Qualify this Claude runtime before Topsl starts Claude Code for a workflow role.",
        ],
        { fresh: false, models: [] },
      ),
      "coordinator-contribution",
    ).reasons,
  ).toEqual(["Not qualified yet. Qualify it under Providers."]);
  expect(routeBlockers(route("codex", []), "coordinator-contribution")).toEqual(
    { reasons: [], details: [] },
  );
});
