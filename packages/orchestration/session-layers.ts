import type { GoalFunctions, RoleDefinition } from "../domain/role-groups";
import { coordinatorSettings, type TopslSession } from "../domain/sessions";
import type { SettingsLayer } from "./membership";

/**
 * Where a native session's settings sit among a role's layers
 * (docs/Native_Sessions_Plan.md): between project defaults and goal
 * overrides. A session created natively replaces the live project layers
 * with the defaults it captured, so later project edits do not silently
 * change it; a legacy session keeps following the project as it did before.
 * Automatic team choices fill only fields no owner layer set.
 */
export function withSessionLayers(
  layers: SettingsLayer[],
  session: TopslSession,
  roleId: string,
): SettingsLayer[] {
  let out = layers;
  if (session.inherited) {
    const captured: SettingsLayer[] = [
      {
        level: "session-inherited",
        revisionId: `${session.id}:inherited:policy`,
        settings: session.inherited.policyDefaults,
      },
    ];
    const role = session.inherited.roles[roleId];
    if (role)
      captured.push({
        level: "session-inherited",
        revisionId: role.revisionId,
        settings: role.settings,
        authority: role.authority,
      });
    out = [...captured, ...out.filter((l) => !l.level.startsWith("project-"))];
  }
  const user: SettingsLayer[] = [];
  if (session.origin === "native" && roleId === "coordinator")
    user.push({
      level: "session-role",
      revisionId: `${session.id}:coordinators:${session.revision}`,
      settings: coordinatorSettings(session.configuration),
    });
  const owned = session.configuration.roles[roleId]?.settings;
  if (owned && Object.keys(owned).length)
    user.push({
      level: "session-role",
      revisionId: `${session.id}:role:${roleId}:${session.revision}`,
      settings: owned,
    });
  const at = out.filter(
    (l) => l.level.startsWith("project-") || l.level === "session-inherited",
  ).length;
  out = [...out.slice(0, at), ...user, ...out.slice(at)];
  const automatic = session.automatic.roles[roleId];
  if (automatic && Object.keys(automatic.settings).length)
    out.push({
      level: "session-automatic",
      revisionId: `${session.id}:automatic:${session.automatic.revision}`,
      settings: automatic.settings,
      authority: "automatic",
    });
  return out;
}

/**
 * The roles a session's coordinators may delegate to, or null for every
 * visible role. A custom team is its roster; an automatic team is what the
 * coordinators chose plus any role the owner pinned.
 */
export function sessionActiveRoles(session: TopslSession): Set<string> | null {
  if (session.origin !== "native") return null;
  const owner = Object.keys(session.configuration.roles);
  if (session.configuration.team === "custom") return new Set(owner);
  if (!session.automatic.activeRoles) return null;
  return new Set([...session.automatic.activeRoles, ...owner]);
}

const builtIn: GoalFunctions = {
  coordination: "coordinator",
  review: "reviewer",
  implementation: "implementer",
  integration: "implementer",
};

/**
 * Which role serves each obligation of a session goal. A role the team uses
 * is preferred; a custom team that lacks one a code goal needs is a
 * configuration request, never a silent fallback to roles it excluded.
 */
export function sessionFunctions(input: {
  session: TopslSession;
  roles: RoleDefinition[];
  goalKind: "code" | "information";
}): { functions: GoalFunctions } | { missing: string[] } {
  const active = sessionActiveRoles(input.session);
  if (!active) return { functions: builtIn };
  const pick = (purpose: RoleDefinition["purpose"], fallback: string) => {
    const usable = input.roles.filter(
      (r) => r.purpose === purpose && active.has(r.id),
    );
    return usable.find((r) => r.id === fallback)?.id ?? usable[0]?.id ?? null;
  };
  const custom = input.session.configuration.team === "custom";
  const implementation = pick("implementation", "implementer");
  const review = pick("candidate-review", "reviewer");
  const missing: string[] = [];
  if (custom && input.goalKind === "code") {
    if (!implementation) missing.push("an implementation role");
    if (!review) missing.push("a review role");
  }
  if (missing.length) return { missing };
  return {
    functions: {
      coordination: "coordinator",
      review: review ?? builtIn.review,
      implementation: implementation ?? builtIn.implementation,
      integration: implementation ?? builtIn.integration,
    },
  };
}
