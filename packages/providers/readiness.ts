import type { Installation, Provider } from "../domain/types";
import type { ProviderCapability, ProviderModel } from "./contract";
export type RuntimeRole = "implementer" | "reviewer" | "independent-reviewer";
export interface RuntimeSelection {
  installationId: string;
  provider: Provider;
  model: string;
  effort?: string;
}
export interface RoleReadiness {
  role: RuntimeRole;
  mode: "coordinated";
  ready: boolean;
  blockers: Array<{ code: string; detail: string; action: string }>;
  warnings: string[];
  capabilitiesUsed: string[];
  freshness: {
    state: "current" | "missing" | "stale";
    bindingId: string | null;
  };
  nextActions: string[];
  models: ProviderModel[];
}
const observableContracts = new Set([
  "structured-turn",
  "native-subscription",
  "fresh-session",
  "process-lifecycle",
  "candidate-reader",
  "interrupt",
]);
export function capabilitySatisfies(
  capability: ProviderCapability,
  name: string,
): boolean {
  return (
    capability.name === name &&
    capability.route === "structured" &&
    capability.evidence.level !== "none" &&
    (capability.support === "enforceable" ||
      (observableContracts.has(name) &&
        capability.support === "observable-only" &&
        capability.evidence.source.startsWith("runtime-validation:")))
  );
}
export function roleRequirements(role: RuntimeRole): string[] {
  const common = [
    "structured-turn",
    "native-subscription",
    "process-lifecycle",
  ];
  return role === "implementer"
    ? [...common, "workspace-write"]
    : [
        ...common,
        "fresh-session",
        "candidate-reader",
        "read-only",
        ...(role === "independent-reviewer" ? ["independent-isolation"] : []),
      ];
}
export function evaluateRoleReadiness(input: {
  role: RuntimeRole;
  selection: RuntimeSelection;
  installation: Installation;
  capabilities: ProviderCapability[];
  models?: ProviderModel[];
  freshness?: RoleReadiness["freshness"];
  additionalRequirements?: string[];
}): RoleReadiness {
  const capabilitiesUsed = [
      ...new Set([
        ...roleRequirements(input.role),
        ...(input.additionalRequirements ?? []),
      ]),
    ],
    blockers: RoleReadiness["blockers"] = [],
    freshness = input.freshness ?? { state: "missing", bindingId: null },
    models = input.models ?? [];
  if (!input.installation.trusted)
    blockers.push({
      code: "executable-untrusted",
      detail: "Review the selected executable before use.",
      action: "review-executable",
    });
  if (
    (input.selection.provider === "codex") !==
    input.installation.appId.startsWith("openai.codex")
  )
    blockers.push({
      code: "provider-binding-changed",
      detail: "The selected provider and installation differ.",
      action: "select-runtime",
    });
  for (const name of capabilitiesUsed)
    if (!input.capabilities.some((c) => capabilitySatisfies(c, name)))
      blockers.push({
        code:
          name === "native-subscription"
            ? "authentication-required"
            : name === "candidate-reader"
              ? "candidate-reader-unavailable"
              : name === "process-lifecycle"
                ? "process-lifecycle-unverified"
                : "permission-profile-unverified",
        detail: `${name} is not qualified for this runtime, account, policy and host.`,
        action: "validate-runtime",
      });
  const model = models.find((m) => m.model === input.selection.model);
  if (
    !input.selection.model.trim() ||
    !model ||
    (input.selection.effort &&
      !model.supportedReasoningEfforts?.includes(input.selection.effort))
  )
    blockers.push({
      code: "unsupported-model-setting",
      detail:
        "Select a model and effort observed in this runtime catalog; unknown settings cannot be substituted.",
      action: "inspect-runtime",
    });
  return {
    role: input.role,
    mode: "coordinated",
    ready: blockers.length === 0,
    blockers,
    warnings: [
      "Native sign-in stays in the provider application. No API billing fallback is enabled.",
    ],
    capabilitiesUsed,
    freshness,
    nextActions: [
      ...new Set([
        ...blockers.map((b) => b.action),
        "prepare-assisted-handoff",
      ]),
    ],
    models,
  };
}
