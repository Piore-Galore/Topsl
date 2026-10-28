import type {
  EffectiveRoleGroup,
  ExecutionPurpose,
  MemberIntent,
  RoleDefinition,
  RoleGroupSettings,
} from "../domain/role-groups";
import type { SessionModelRef, SessionTeamProposal } from "../domain/sessions";
import type { RouteCandidate } from "./selection";

/**
 * Team organization shared by Recursive Looping and native sessions
 * (docs/Native_Sessions_Plan.md). Automatic choices fill only fields the
 * owner left open; a proposal is accepted or refused with reasons, never
 * silently rewritten. Model references keep their provider.
 */

/** Observed, qualified models for a purpose on managed structured routes. */
export function eligibleModels(
  routes: RouteCandidate[],
  purpose: ExecutionPurpose | string,
): SessionModelRef[] {
  return routes
    .filter(
      (r) =>
        r.route === "managed-structured" &&
        r.catalog.fresh &&
        r.purposes[purpose as ExecutionPurpose]?.ready,
    )
    .flatMap((r) =>
      r.catalog.models.map((m) => ({ provider: r.provider, model: m.model })),
    );
}

/** The owner's locks on one role: fields they set, pins and an exact roster. */
export function roleLocks(group: EffectiveRoleGroup) {
  const released = group.form === "auto" && !group.members.length;
  const fields = new Set(
    (group.userFields ?? []).filter(
      (f) => !(released && (f === "form" || f === "members")),
    ),
  );
  return {
    fields,
    pinned: group.members.some((m) => m.pin),
    exact: group.form === "exact" && fields.has("members"),
  };
}

/** Why an automatic member change cannot apply to a role, or null. */
export function memberChangeProblem(input: {
  roleId: string;
  locks: ReturnType<typeof roleLocks>;
  count: number | null;
  limit: number;
  purpose: string;
  models: Array<string | SessionModelRef>;
  eligible: SessionModelRef[];
}): string | null {
  if (input.locks.exact)
    return `Role ${input.roleId} has your exact roster; its membership cannot change automatically.`;
  if (input.count !== null && input.locks.fields.has("count"))
    return `Role ${input.roleId}'s member count is fixed by your settings.`;
  if (input.count !== null && input.count > input.limit)
    return `${input.count} members exceed the configured limit of ${input.limit} for one role.`;
  const unknown = input.models
    .filter((m) =>
      typeof m === "string"
        ? !input.eligible.some((e) => e.model === m)
        : !input.eligible.some(
            (e) => e.model === m.model && e.provider === m.provider,
          ),
    )
    .map((m) => (typeof m === "string" ? m : `${m.provider}:${m.model}`));
  if (unknown.length)
    return `${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not an observed, qualified model for ${input.purpose} on an allowed route.`;
  return null;
}

/** A role definition for a role automation or a session defines. */
export function roleDefinitionFor(input: {
  projectId: string;
  roleId: string;
  title: string;
  instructions: string;
  purpose: ExecutionPurpose;
  /** The session that owns it; absent for a project role. */
  ownerConversationId?: string | null;
}): RoleDefinition & { roleId: string; ownerConversationId?: string | null } {
  const p = input.purpose;
  return {
    id: `${input.projectId}:${input.roleId}`,
    roleId: input.roleId,
    projectId: input.projectId,
    revision: 1,
    title: input.title,
    instructions: input.instructions,
    purpose: p,
    requiredCapabilities: [],
    permittedOperations:
      p === "implementation" ? ["write-permitted-outputs"] : ["read-inputs"],
    outputContract:
      p === "implementation"
        ? "code-candidate"
        : p === "candidate-review"
          ? "candidate-review"
          : p === "coordinator-contribution"
            ? "coordinator-proposal"
            : "information",
    defaultCollaboration:
      p === "implementation"
        ? "parallel-partitioned"
        : p === "coordinator-contribution"
          ? "peer-collaboration"
          : "parallel-independent",
    ...(input.ownerConversationId
      ? { ownerConversationId: input.ownerConversationId }
      : {}),
  };
}

/** Auto members preferring the chosen models, one slot per model. */
export function automaticMembers(
  roleId: string,
  models: Array<string | SessionModelRef>,
  reference: string,
): MemberIntent[] {
  return models.map((m, i) => ({
    memberId: `${roleId}-auto-${i + 1}`,
    required: true,
    pin: null,
    fallbacks: [],
    preferences:
      typeof m === "string"
        ? { providers: [], models: [m] }
        : { providers: [m.provider], models: [m.model] },
    source: { kind: "auto", reference, provenance: "default" },
  }));
}

/**
 * Validates a session team proposal against the owner's locks, the member
 * limit, model readiness and the team mode. Returns the automatic settings
 * to record, the session roles to define, and refusals with reasons.
 */
export function organizeSessionTeam(input: {
  proposal: SessionTeamProposal;
  teamMode: "automatic" | "custom";
  /** Roles in the session's catalog, with their purpose. */
  catalog: Array<{ id: string; purpose: ExecutionPurpose }>;
  /** Roles in a custom roster; ignored for an automatic team. */
  roster: string[];
  group: (roleId: string) => EffectiveRoleGroup | null;
  routes: RouteCandidate[];
  limit: number;
  reference: string;
}): {
  roles: Record<string, { settings: RoleGroupSettings; reason: string }>;
  created: Array<{
    roleId: string;
    title: string;
    instructions: string;
    purpose: ExecutionPurpose;
  }>;
  activeRoles: string[];
  rejections: string[];
} {
  const roles: Record<string, { settings: RoleGroupSettings; reason: string }> =
    {};
  const created: Array<{
    roleId: string;
    title: string;
    instructions: string;
    purpose: ExecutionPurpose;
  }> = [];
  const rejections: string[] = [];
  const active: string[] = [];
  for (const r of input.proposal) {
    let purpose = input.catalog.find((c) => c.id === r.roleId)?.purpose;
    if (purpose === "coordinator-contribution") {
      rejections.push(
        `Coordinators are the ones you selected; ${r.roleId} cannot be organized automatically.`,
      );
      continue;
    }
    if (!purpose) {
      if (input.teamMode === "custom") {
        rejections.push(
          `Role ${r.roleId} is not in your custom roster; coordinators work within it.`,
        );
        continue;
      }
      if (!r.title || !r.instructions || !r.purpose) {
        rejections.push(
          `Role ${r.roleId} does not exist; creating it needs a title, instructions and a purpose.`,
        );
        continue;
      }
      purpose = r.purpose;
      created.push({
        roleId: r.roleId,
        title: r.title,
        instructions: r.instructions,
        purpose,
      });
    } else if (
      input.teamMode === "custom" &&
      !input.roster.includes(r.roleId)
    ) {
      rejections.push(
        `Role ${r.roleId} is not in your custom roster; coordinators work within it.`,
      );
      continue;
    }
    const group = input.group(r.roleId);
    const locks = group
      ? roleLocks(group)
      : { fields: new Set<string>(), pinned: false, exact: false };
    const settings: RoleGroupSettings = {};
    if (r.count !== null || r.models.length) {
      const problem = memberChangeProblem({
        roleId: r.roleId,
        locks,
        count: r.count,
        limit: input.limit,
        purpose,
        models: r.models,
        eligible: eligibleModels(input.routes, purpose),
      });
      if (problem) {
        rejections.push(problem);
        // The role is still used; only the member change is refused.
      } else {
        if (r.count !== null) settings.count = r.count;
        if (r.models.length)
          settings.members = automaticMembers(
            r.roleId,
            r.models,
            input.reference,
          );
      }
    }
    roles[r.roleId] = { settings, reason: r.reason };
    active.push(r.roleId);
  }
  return { roles, created, activeRoles: [...new Set(active)], rejections };
}
