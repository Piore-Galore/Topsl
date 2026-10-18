import type { ProviderModel } from "../providers/contract";
import type {
  EffectiveRoleGroup,
  ExecutionPurpose,
  MemberIntent,
  MemberPin,
  ResolvedMemberAssignment,
  RoleDefinition,
} from "../domain/role-groups";
import { autoCount } from "./membership";

/**
 * One authorized runtime route a member could run on, with its observed
 * model catalog and per-purpose readiness. The service derives these from
 * installations, runtime qualification and the catalog cache; tests supply
 * them directly. Nothing in selection prefers a provider for a role.
 */
export interface RouteCandidate {
  provider: "codex" | "claude";
  installationId: string;
  installationRevision: string;
  executableIdentity: string;
  route: "managed-structured" | "assisted-terminal";
  nativeAccountKey: string | null;
  nativeProfileId: string | null;
  billingRoute: "native-subscription" | "api-key" | "cloud-provider" | null;
  /** A label that tells two sign-ins apart, when needed. */
  accountLabel: string | null;
  catalog: {
    models: ProviderModel[];
    observedAt: string | null;
    fresh: boolean;
  };
  purposes: Partial<
    Record<ExecutionPurpose, { ready: boolean; blockers: string[] }>
  >;
  /** Whether native sub-agent fan-out is enforced off, bounded, or unknown. */
  fanout: "disabled" | "bounded" | "unknown";
}

export interface SelectionResult {
  assignments: Array<
    Omit<ResolvedMemberAssignment, "id" | "revision" | "createdAt">
  >;
  conflicts: string[];
  targetCount: number;
}

interface Option {
  route: RouteCandidate;
  model: ProviderModel;
}

const words = (v: string) => v.toLowerCase();
function labelMatches(model: ProviderModel, label: string): boolean {
  const l = words(label).trim();
  if (!l) return false;
  return [model.id, model.model, model.name].some((v) => {
    const value = words(v);
    return (
      value === l ||
      new RegExp(
        `(^|[^a-z0-9])${l.replace(/[^a-z0-9]/g, "\\$&")}([^a-z0-9]|$)`,
      ).test(value)
    );
  });
}

function optionsFor(pin: MemberPin, pool: RouteCandidate[]): Option[] {
  const out: Option[] = [];
  for (const route of pool) {
    if (pin.provider && route.provider !== pin.provider) continue;
    if (pin.installationId && route.installationId !== pin.installationId)
      continue;
    for (const model of route.catalog.models) {
      if (pin.model) {
        if (model.model === pin.model || model.id === pin.model)
          out.push({ route, model });
      } else if (pin.label && labelMatches(model, pin.label))
        out.push({ route, model });
    }
  }
  return out;
}

function describePin(pin: MemberPin): string {
  return pin.model ?? pin.label ?? "the selected model";
}

/** Why an option cannot run this purpose now, or null when it can. */
function blocker(
  option: Option,
  purpose: ExecutionPurpose,
  effort?: string,
): string | null {
  const { route, model } = option;
  if (route.route !== "managed-structured")
    return "This route is assisted participation, which cannot run an automated exact-model member.";
  if (!route.catalog.fresh)
    return "The model catalog for this runtime, account and installation is stale. Inspect the runtime again.";
  const readiness = route.purposes[purpose];
  if (!readiness?.ready)
    return `The route is not qualified for ${purpose}: ${readiness?.blockers.join(" ") || "no readiness was recorded."}`;
  if (effort && !model.supportedReasoningEfforts?.includes(effort))
    return `Effort ${effort} is not in the observed catalog for ${model.model}.`;
  return null;
}

function assignment(
  role: RoleDefinition,
  group: EffectiveRoleGroup,
  member: MemberIntent,
  status: ResolvedMemberAssignment["status"],
  selection: ResolvedMemberAssignment["selection"],
  option: Option | null,
  reason: string,
  effort: string | null,
): Omit<ResolvedMemberAssignment, "id" | "revision" | "createdAt"> {
  return {
    projectId: group.projectId,
    goalId: group.goalId,
    roleId: group.roleId,
    memberId: member.memberId,
    groupRevisionIds: group.sources
      .map((s) => s.revisionId)
      .filter((v): v is string => !!v),
    status,
    selection,
    primaryPin: member.pin,
    provider: option?.route.provider ?? member.pin?.provider ?? null,
    route:
      option?.route.route ??
      (member.pin?.route === "assisted" ? "assisted-terminal" : null),
    installationId:
      option?.route.installationId ?? member.pin?.installationId ?? null,
    installationRevision: option?.route.installationRevision ?? null,
    executableIdentity: option?.route.executableIdentity ?? null,
    nativeAccountKey: option?.route.nativeAccountKey ?? null,
    nativeProfileId: option?.route.nativeProfileId ?? null,
    billingRoute: option?.route.billingRoute ?? null,
    model: option?.model.model ?? member.pin?.model ?? null,
    modelLabel: option?.model.name ?? member.pin?.label ?? null,
    effort,
    roleDefinitionRevision: role.revision,
    catalog: option
      ? {
          observedAt: option.route.catalog.observedAt,
          fresh: option.route.catalog.fresh,
        }
      : null,
    fanout: option?.route.fanout ?? "unknown",
    modelEvidencePolicy: group.modelEvidence,
    reason,
  };
}

/**
 * Resolves every member slot of a group to a concrete route and model, or
 * explains why it cannot. Pins are never replaced by a provider default, an
 * exact roster never shrinks, and Auto never clones a model to satisfy a
 * distinct-model requirement.
 */
export function resolveGroup(input: {
  role: RoleDefinition;
  group: EffectiveRoleGroup;
  pool: RouteCandidate[];
  complexity: "simple" | "complex";
}): SelectionResult {
  const { role, group, pool } = input;
  const conflicts = [...group.conflicts];
  const targetCount =
    group.form === "exact"
      ? group.members.length
      : autoCount(group, input.complexity);
  const results: SelectionResult["assignments"] = [];
  const chosen: Option[] = [];
  if (conflicts.length) {
    for (const member of group.members)
      results.push(
        assignment(
          role,
          group,
          member,
          "unresolved",
          member.pin ? "pinned" : "auto",
          null,
          `Group settings conflict: ${conflicts.join(" ")}`,
          member.pin?.effort ?? null,
        ),
      );
    return { assignments: results, conflicts, targetCount };
  }
  for (const member of group.members) {
    if (!member.pin) continue;
    if (member.pin.route === "assisted") {
      results.push(
        assignment(
          role,
          group,
          member,
          "assisted",
          "pinned",
          null,
          "Assisted participation: an owner-run Claude Code step whose model Claude Code decides. It keeps its hand-back provenance and cannot satisfy a strict managed exact-model member.",
          null,
        ),
      );
      continue;
    }
    const tried: string[] = [];
    let resolved = false;
    for (const [index, pin] of [member.pin, ...member.fallbacks].entries()) {
      const options = optionsFor(pin, pool);
      const distinct = [
        ...new Map(
          options.map((o) => [`${o.route.installationId}:${o.model.model}`, o]),
        ).values(),
      ];
      if (!distinct.length) {
        tried.push(
          pin.model
            ? `${describePin(pin)} is not in any observed catalog for the authorized routes.`
            : `No observed model matches the label "${describePin(pin)}".`,
        );
        continue;
      }
      const usable = distinct.filter(
        (o) => !blocker(o, role.purpose, pin.effort),
      );
      if (!usable.length) {
        tried.push(
          `${describePin(pin)}: ${blocker(distinct[0], role.purpose, pin.effort)}`,
        );
        continue;
      }
      if (usable.length > 1 && !pin.model && !pin.installationId) {
        tried.push(
          `The label "${describePin(pin)}" matches ${usable.length} models (${usable.map((o) => o.model.model).join(", ")}). Choose one exact model.`,
        );
        // An ambiguous label is unresolved, not silently narrowed.
        break;
      }
      const option = usable[0];
      if (
        group.distinctModels === "required" &&
        chosen.some((c) => c.model.model === option.model.model)
      ) {
        tried.push(
          `${option.model.model} is already a member, and distinct models are required.`,
        );
        continue;
      }
      chosen.push(option);
      results.push(
        assignment(
          role,
          group,
          member,
          "resolved",
          index === 0 ? "pinned" : "fallback",
          option,
          index === 0
            ? group.goalId
              ? "Pinned for this goal."
              : "Pinned in the project's role settings."
            : `Primary choice ${describePin(member.pin)} is unavailable (${tried.join(" ")}); using its explicitly authorized fallback.`,
          pin.effort ?? null,
        ),
      );
      resolved = true;
      break;
    }
    if (!resolved)
      results.push(
        assignment(
          role,
          group,
          member,
          tried.some((t) =>
            /matches \d+ models|No observed model matches/.test(t),
          )
            ? "unresolved"
            : "unavailable",
          "pinned",
          null,
          tried.join(" "),
          member.pin.effort ?? null,
        ),
      );
  }
  // Auto slots: explicit open members first, then generated ones up to the count.
  const open = group.members.filter((m) => !m.pin);
  const generated = Math.max(0, targetCount - group.members.length);
  const autoMembers: MemberIntent[] = [
    ...open,
    ...Array.from({ length: generated }, (_, i) => ({
      memberId: `${group.roleId}-auto-${group.members.length + i + 1}`,
      required: true,
      pin: null,
      fallbacks: [],
      preferences: { providers: [], models: [] },
      source: {
        kind: "auto" as const,
        reference: null,
        provenance: "default" as const,
      },
    })),
  ];
  const eligible: Option[] = pool
    .flatMap((route) => route.catalog.models.map((model) => ({ route, model })))
    .filter((o) => !blocker(o, role.purpose));
  for (const member of autoMembers) {
    const preferences = member.preferences;
    const candidates = eligible.filter(
      (o) =>
        !(
          group.distinctModels === "required" &&
          chosen.some((c) => c.model.model === o.model.model)
        ) &&
        !(
          group.distinctProviders === "required" &&
          chosen.some((c) => c.route.provider === o.route.provider)
        ),
    );
    const score = (o: Option) =>
      (preferences.models.includes(o.model.model) ? 0 : 10) +
      (preferences.providers.includes(o.route.provider) ? 0 : 5) +
      (chosen.some((c) => c.model.model === o.model.model) ? 100 : 0) +
      (group.distinctProviders === "preferred" &&
      chosen.some((c) => c.route.provider === o.route.provider)
        ? 20
        : 0) +
      (o.model.isDefault ? 0 : 1);
    const ranked = [...candidates].sort(
      (a, b) =>
        score(a) - score(b) ||
        a.route.provider.localeCompare(b.route.provider) ||
        a.route.installationId.localeCompare(b.route.installationId) ||
        a.model.model.localeCompare(b.model.model),
    );
    const option = ranked[0];
    if (!option) {
      results.push(
        assignment(
          role,
          group,
          member,
          "unresolved",
          "auto",
          null,
          group.distinctModels === "required" && eligible.length
            ? "No further distinct eligible model is available; Auto does not clone a model to satisfy a distinct-model requirement."
            : `No authorized route is qualified for ${role.purpose} with a current model catalog.`,
          null,
        ),
      );
      continue;
    }
    const repeat = chosen.some((c) => c.model.model === option.model.model);
    chosen.push(option);
    results.push(
      assignment(
        role,
        group,
        member,
        "resolved",
        "auto",
        option,
        repeat
          ? `Selected automatically: no other eligible model was available, so this is another session of ${option.model.model}.`
          : `Selected automatically because this qualified ${option.route.provider} route supports ${role.purpose} with a current catalog.`,
        null,
      ),
    );
  }
  const models = results
    .filter((a) => a.status === "resolved")
    .map((a) => a.model);
  if (
    group.distinctModels === "required" &&
    new Set(models).size !== models.length
  )
    conflicts.push(
      "Resolved members share a model, but distinct models are required.",
    );
  return { assignments: results, conflicts, targetCount };
}

/**
 * Whether a member's reported effective settings satisfy its assignment. A
 * different reported model never satisfies an exact assignment, and an
 * unreported one satisfies only the clearly labelled requested-only mode.
 */
export function modelEvidence(
  assignment: Pick<
    ResolvedMemberAssignment,
    "model" | "effort" | "modelEvidencePolicy"
  >,
  reported: { model: string | null; effort: string | null },
): {
  satisfies: boolean;
  level: "verified" | "requested-only" | "mismatch" | "unreported";
  detail: string;
} {
  if (reported.model && reported.model !== assignment.model)
    return {
      satisfies: false,
      level: "mismatch",
      detail: `The runtime reported ${reported.model}, not the assigned ${assignment.model}. This contribution cannot satisfy the member.`,
    };
  if (
    assignment.effort &&
    reported.effort &&
    reported.effort !== assignment.effort
  )
    return {
      satisfies: false,
      level: "mismatch",
      detail: `The runtime reported effort ${reported.effort}, not ${assignment.effort}.`,
    };
  if (!reported.model)
    return assignment.modelEvidencePolicy === "requested-only"
      ? {
          satisfies: true,
          level: "requested-only",
          detail:
            "The effective model was not reported; accepted under the requested-only mode.",
        }
      : {
          satisfies: false,
          level: "unreported",
          detail:
            "The effective model was not reported, and this group requires a verified model.",
        };
  return {
    satisfies: true,
    level: "verified",
    detail: "The runtime reported the assigned model.",
  };
}
