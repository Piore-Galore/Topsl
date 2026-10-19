import {
  DEFAULT_MEMBER_LIMIT,
  MEMBER_LIMIT_CEILING,
  completionPolicySchema,
  memberIntentSchema,
  roleGroupSettingsSchema,
  type CompletionPolicy,
  type EffectiveRoleGroup,
  type MemberIntent,
  type MemberPin,
  type RoleDefinition,
  type RoleGroupRevision,
  type RoleGroupSettings,
} from "../domain/role-groups";
import { claudeStepModel } from "../domain/claude-steps";
import type { WorkflowDraftInput } from "../domain/workflow-drafts";

/**
 * Scope precedence, most specific last: application defaults, project
 * policy, project-role preset, goal-wide policy, goal-role override, task
 * override. A layer overrides only the fields it sets.
 */
export interface SettingsLayer {
  level:
    | "application"
    | "project-policy"
    | "project-role"
    | "goal-policy"
    | "goal-role"
    | "task"
    | "adaptive";
  revisionId: string | null;
  settings: RoleGroupSettings;
  /**
   * Who set it. Automatic settings (a loop's adaptive organization, or any
   * revision not written by the owner) fill only fields that no user layer
   * set at any scope: authority comes before scope.
   */
  authority?: "user" | "automatic";
}

/** Revisions the owner wrote carry user authority; anything else is automatic. */
export const userActors: ReadonlySet<string> = new Set(["local-user"]);

export function applicationDefaults(role: RoleDefinition): RoleGroupSettings {
  return {
    form: "auto",
    minCount: 1,
    maxCount: role.id === "coordinator" || role.id === "reviewer" ? 3 : 4,
    distinctModels: "none",
    distinctProviders: "none",
    collaboration: role.defaultCollaboration,
    scheduling: "capacity-waves",
    executionWidth: null,
    modelEvidence: "verified",
    completion: {},
  };
}

/** The layer settings that a scope actually sets, by field name. */
const setFields = (settings: RoleGroupSettings) =>
  Object.entries(settings)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);

export function effectiveGroup(input: {
  projectId: string;
  goalId: string | null;
  role: RoleDefinition;
  memberLimit: number;
  layers: SettingsLayer[];
}): EffectiveRoleGroup {
  const automatic = input.layers.filter((l) => l.authority === "automatic");
  const ordered: SettingsLayer[] = [
    {
      level: "application" as const,
      revisionId: null,
      settings: applicationDefaults(input.role),
    },
    ...input.layers.filter((l) => l.authority !== "automatic"),
  ];
  let merged: RoleGroupSettings = {};
  let completion: Partial<CompletionPolicy> = {};
  const userFields = new Set<string>();
  const ignored: string[] = [];
  for (const layer of ordered) {
    if (layer.level !== "application")
      for (const field of setFields(layer.settings)) userFields.add(field);
    const settings = roleGroupSettingsSchema.parse(layer.settings);
    // A scope that sets a roster closes membership there: it replaces the
    // broader roster and its count, instead of adding to it.
    if (settings.members !== undefined && settings.form === undefined)
      settings.form = merged.form === "exact" ? "exact" : "required-plus-auto";
    if (settings.form === "exact" && settings.members !== undefined) {
      delete merged.count;
      delete merged.minCount;
      delete merged.maxCount;
    }
    if (settings.form === "auto" && settings.members === undefined)
      merged.members = [];
    merged = { ...merged, ...withoutUndefined(settings) };
    completion = {
      ...completion,
      ...withoutUndefined(settings.completion ?? {}),
    };
  }
  // Adaptive settings fill only what the owner left open. An exact roster is
  // closed; a required-members roster keeps its pins and may gain Auto slots.
  for (const layer of automatic) {
    const settings = roleGroupSettingsSchema.parse(layer.settings);
    for (const [field, value] of Object.entries(withoutUndefined(settings))) {
      if (field === "members") continue;
      if (field === "completion") continue;
      if (userFields.has(field)) {
        ignored.push(field);
        continue;
      }
      (merged as Record<string, unknown>)[field] = value;
    }
    if (settings.members?.length) {
      if (merged.form === "exact" && userFields.has("members"))
        ignored.push("members");
      else {
        const pinned = userFields.has("members") ? (merged.members ?? []) : [];
        const ids = new Set(pinned.map((m) => m.memberId));
        const limit =
          (userFields.has("count") ? merged.count : undefined) ??
          settings.count ??
          pinned.length + settings.members.length;
        const extra = settings.members
          .filter((m) => !m.pin && !ids.has(m.memberId))
          .slice(0, Math.max(0, limit - pinned.length));
        merged.members = [...pinned, ...extra];
        if (!userFields.has("form") && merged.form === "exact")
          merged.form = "required-plus-auto";
      }
    }
    if (
      merged.count !== undefined &&
      !userFields.has("maxCount") &&
      (merged.maxCount ?? 0) < merged.count
    )
      merged.maxCount = merged.count;
  }
  const memberLimit = Math.min(
    MEMBER_LIMIT_CEILING,
    Math.max(1, input.memberLimit || DEFAULT_MEMBER_LIMIT),
  );
  const members = (merged.members ?? []).map((m) =>
    memberIntentSchema.parse(m),
  );
  const form = merged.form ?? "auto";
  const conflicts: string[] = [];
  if (new Set(members.map((m) => m.memberId)).size !== members.length)
    conflicts.push("Member IDs must be unique within a role.");
  if (form === "exact") {
    if (!members.length)
      conflicts.push("An exact roster needs at least one member.");
    for (const member of members)
      if (!member.pin)
        conflicts.push(
          `Exact member ${member.memberId} has no model choice. Use Required members + Auto for open slots.`,
        );
  }
  const count = form === "exact" ? members.length : (merged.count ?? null);
  const minCount = form === "exact" ? members.length : (merged.minCount ?? 1);
  const maxCount =
    form === "exact"
      ? members.length
      : (merged.maxCount ?? Math.max(minCount, members.length, count ?? 0));
  const requestedTotal = Math.max(count ?? 0, members.length, minCount);
  if (requestedTotal > memberLimit)
    conflicts.push(
      `${requestedTotal} members are requested, above the configured limit of ${memberLimit} for one role. The requested roster is kept; raise the limit to run it.`,
    );
  if (count !== null && members.length > count)
    conflicts.push(
      `${members.length} required members do not fit an exact count of ${count}. Change the count or the members; nothing was removed.`,
    );
  if (form !== "exact" && minCount > maxCount)
    conflicts.push(
      `The minimum count ${minCount} exceeds the maximum ${maxCount}.`,
    );
  const pinnedModels = members
    .map((m) => m.pin?.model ?? m.pin?.label)
    .filter((v): v is string => !!v);
  if (
    merged.distinctModels === "required" &&
    new Set(pinnedModels.map((v) => v.toLowerCase())).size !==
      pinnedModels.length
  )
    conflicts.push(
      "Distinct models are required, but two members pin the same model. Another session of one model does not satisfy this.",
    );
  const policy = completionPolicySchema.parse(completion);
  const ids = new Set(members.map((m) => m.memberId));
  for (const [field, values] of [
    ["required contributors", policy.requiredContributorIds ?? []],
    ["electorate", policy.electorateIds ?? []],
    ["required endorsers", policy.requiredEndorserIds],
  ] as const)
    for (const value of values)
      if (form === "exact" && !ids.has(value))
        conflicts.push(`The ${field} name ${value}, which is not a member.`);
  const sources = [...ordered, ...automatic]
    .map((layer) => ({
      level: layer.level,
      revisionId: layer.revisionId,
      fields:
        layer.authority === "automatic"
          ? setFields(layer.settings).filter((f) => !userFields.has(f))
          : setFields(layer.settings),
      ...(layer.authority === "automatic"
        ? { authority: "automatic" as const }
        : {}),
    }))
    .filter((s) => s.fields.length)
    .reverse();
  return {
    projectId: input.projectId,
    goalId: input.goalId,
    roleId: input.role.id,
    form,
    count,
    minCount,
    maxCount,
    members,
    distinctModels: merged.distinctModels ?? "none",
    distinctProviders: merged.distinctProviders ?? "none",
    collaboration: merged.collaboration ?? input.role.defaultCollaboration,
    scheduling: merged.scheduling ?? "capacity-waves",
    executionWidth: merged.executionWidth ?? null,
    completion: policy,
    modelEvidence: merged.modelEvidence ?? "verified",
    memberLimit,
    sources,
    conflicts,
    userFields: [...userFields].sort(),
    ignoredAutomatic: [...new Set(ignored)].sort(),
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

const authorityOf = (r: RoleGroupRevision): "user" | "automatic" =>
  userActors.has(r.source.actor) ? "user" : "automatic";

/** Layers for a role, from stored revisions, most specific last. */
export function layersFor(
  revisions: RoleGroupRevision[],
  policyDefaults: RoleGroupSettings | null,
  roleId: string,
  goalId: string | null,
  taskKey: string | null,
): SettingsLayer[] {
  const latest = (pick: (r: RoleGroupRevision) => boolean) =>
    revisions
      .filter(pick)
      .sort((a, b) => b.revision - a.revision)
      .at(0);
  const layers: SettingsLayer[] = [];
  if (policyDefaults)
    layers.push({
      level: "project-policy",
      revisionId: null,
      settings: policyDefaults,
    });
  const projectRole = latest(
    (r) => r.scope.level === "project-role" && r.roleId === roleId,
  );
  if (projectRole)
    layers.push({
      level: "project-role",
      revisionId: projectRole.id,
      settings: projectRole.settings,
      authority: authorityOf(projectRole),
    });
  if (goalId) {
    const goalWide = latest(
      (r) =>
        r.scope.level === "goal-role" &&
        r.goalId === goalId &&
        r.roleId === "*",
    );
    if (goalWide)
      layers.push({
        level: "goal-policy",
        revisionId: goalWide.id,
        settings: goalWide.settings,
        authority: authorityOf(goalWide),
      });
    const goalRole = latest(
      (r) =>
        r.scope.level === "goal-role" &&
        r.goalId === goalId &&
        r.roleId === roleId,
    );
    if (goalRole)
      layers.push({
        level: "goal-role",
        revisionId: goalRole.id,
        settings: goalRole.settings,
        authority: authorityOf(goalRole),
      });
    if (taskKey) {
      const task = latest(
        (r) =>
          r.scope.level === "task" &&
          r.goalId === goalId &&
          r.roleId === roleId &&
          r.scope.taskKey === taskKey,
      );
      if (task)
        layers.push({
          level: "task",
          revisionId: task.id,
          settings: task.settings,
          authority: authorityOf(task),
        });
    }
  }
  return layers;
}

/**
 * How many members Auto picks when no count is set: one for a simple goal,
 * more for complex work, always inside the role's bounds. A transparent
 * heuristic, not a ranking of models.
 */
export function autoCount(
  group: EffectiveRoleGroup,
  complexity: "simple" | "complex",
): number {
  if (group.count !== null) return group.count;
  const wanted =
    complexity === "simple" ? 1 : group.roleId === "coordinator" ? 2 : 2;
  return Math.max(
    group.members.length,
    Math.min(group.maxCount, Math.max(group.minCount, wanted)),
  );
}

export function goalComplexity(objective: string): "simple" | "complex" {
  const words = objective.trim().split(/\s+/).length;
  return words > 40 ||
    /\b(architecture|refactor|design|migrat|several|multiple|across|feature|coordinat)/i.test(
      objective,
    )
    ? "complex"
    : "simple";
}

// ---------------------------------------------------------------------------
// Natural-language membership instructions. Each match produces the same
// settings the role editor would save, so the two paths agree.

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  a: 1,
  an: 1,
  single: 1,
};
const roleWords: Array<[RegExp, string]> = [
  [/^coordinat(?:or|ors|e|ion)$/i, "coordinator"],
  [/^review(?:er|ers|s)?$/i, "reviewer"],
  [/^implement(?:er|ers|ation)?$/i, "implementer"],
  [/^planners?$/i, "planner"],
  [/^testers?$/i, "tester"],
  [/^integrators?$/i, "integrator"],
  [/^researchers?$/i, "researcher"],
  [/^(?:documentation|doc|docs|writers?)$/i, "documentation"],
];
const roleAlternation =
  "coordinators?|coordinate|reviewers?|review|implementers?|implementation|planners?|testers?|integrators?|researchers?|documentation";

function roleOf(word: string): string | null {
  for (const [pattern, role] of roleWords) if (pattern.test(word)) return role;
  return null;
}
function countOf(word: string): number | null {
  const lower = word.toLowerCase();
  if (/^\d+$/.test(lower)) return Number(lower);
  return numberWords[lower] ?? null;
}
function labels(list: string): string[] {
  return list
    .split(/\s*(?:,|\+|\band\b|&)\s*/i)
    .map((v) => v.trim().replace(/^the\s+/i, ""))
    .filter((v) => v && !/^(models?|agents?|them)$/i.test(v));
}
const pinned = (
  label: string,
  index: number,
  roleId: string,
  source: string,
): MemberIntent =>
  memberIntentSchema.parse({
    memberId: `${roleId}-${slug(label)}-${index + 1}`,
    required: true,
    pin: { label },
    source: { kind: "message", reference: source, provenance: "explicit" },
  });
const slug = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "member";

export interface MembershipInstruction {
  roleId: string;
  settings: RoleGroupSettings;
  matched: string;
}

/**
 * Reads membership instructions from a message. Text that matches no rule
 * changes nothing; an unknown model label is kept as a label and resolved,
 * or reported unresolved, later.
 */
export function parseMembership(
  text: string,
  sourceMessageId: string,
): MembershipInstruction[] {
  const results: MembershipInstruction[] = [];
  const clauses = text
    .split(
      /(?<=[.;\n])\s*|,\s*(?=(?:and\s+)?(?:review|coordinate|use|include)\s)|\s+(?=then\s+(?:review|coordinate)\s)/i,
    )
    .map((c) => c.replace(/^and\s+/i, ""))
    .map((c) => c.trim())
    .filter(Boolean);
  // A count clause may be followed by an "include" clause for the same role.
  let lastCountRole: { roleId: string; index: number } | null = null;
  for (const raw of clauses) {
    const clause = raw.replace(/[.;]+$/, "").trim();
    let m: RegExpExecArray | null;
    if (
      /\bchoose (?:the )?(?:agents|models|members) automatically\b/i.test(
        clause,
      )
    ) {
      results.push({
        roleId: "*",
        settings: { form: "auto" },
        matched: clause,
      });
      continue;
    }
    // "Use Sol; fall back to Fable if unavailable" arrives as two clauses.
    if (
      (m =
        /^fall ?back to (.+?)(?: if (?:it is |they are )?unavailable)?$/i.exec(
          clause,
        ))
    ) {
      const previous = results.at(-1);
      const member = previous?.settings.members?.at(-1);
      if (previous && member) {
        member.fallbacks = labels(m[1]).map((label) => ({ label }));
        previous.matched += `; ${clause}`;
      }
      continue;
    }
    if (
      (m =
        /^use (?:the )?(.+?) first,? then (.+?)(?: (?:for|as) (\w+))?$/i.exec(
          clause,
        ))
    ) {
      const roleId = (m[3] && roleOf(m[3])) || "reviewer";
      const list = [...labels(m[1]), ...labels(m[2])];
      results.push({
        roleId,
        settings: {
          form: "exact",
          members: list.map((l, i) => pinned(l, i, roleId, sourceMessageId)),
          collaboration: "sequential",
          scheduling: "sequential",
        },
        matched: clause,
      });
      continue;
    }
    if (
      (m = new RegExp(
        `^(?:use )?at most (\\w+) (${roleAlternation})$`,
        "i",
      ).exec(clause))
    ) {
      const roleId = roleOf(m[2]);
      const n = countOf(m[1]);
      if (roleId && n)
        results.push({
          roleId,
          settings: { form: "auto", maxCount: n },
          matched: clause,
        });
      continue;
    }
    if (/\bdifferent models\b/i.test(clause) && !/\bprefer/i.test(clause)) {
      const roleId = lastCountRole?.roleId ?? "*";
      results.push({
        roleId,
        settings: { distinctModels: "required" },
        matched: clause,
      });
      continue;
    }
    if (/\bprefer different providers\b/i.test(clause)) {
      results.push({
        roleId: lastCountRole?.roleId ?? "*",
        settings: { distinctProviders: "preferred" },
        matched: clause,
      });
      continue;
    }
    if (/^pick the models$/i.test(clause)) continue;
    if (
      (m = new RegExp(
        `^include (.+?) as (?:an? )?(${roleAlternation})$`,
        "i",
      ).exec(clause))
    ) {
      const roleId = roleOf(m[2])!;
      results.push({
        roleId,
        settings: {
          form: "required-plus-auto",
          members: labels(m[1]).map((l, i) =>
            pinned(l, i, roleId, sourceMessageId),
          ),
        },
        matched: clause,
      });
      continue;
    }
    // "Include Fable among the reviewers": a required member, the rest Auto.
    if (
      (m = new RegExp(
        `^include (.+?) among (?:the )?(${roleAlternation})$`,
        "i",
      ).exec(clause))
    ) {
      const roleId = roleOf(m[2])!;
      results.push({
        roleId,
        settings: {
          form: "required-plus-auto",
          members: labels(m[1]).map((l, i) =>
            pinned(l, i, roleId, sourceMessageId),
          ),
        },
        matched: clause,
      });
      continue;
    }
    // "Use Opus and Astra as the exact coordinator team": a closed roster.
    if (
      (m = /^use (.+?) as (?:the |an? )?exact (\w+?)s? team$/i.exec(clause)) &&
      roleOf(m[2])
    ) {
      const roleId = roleOf(m[2])!;
      results.push({
        roleId,
        settings: {
          form: "exact",
          members: labels(m[1]).map((l, i) =>
            pinned(l, i, roleId, sourceMessageId),
          ),
        },
        matched: clause,
      });
      continue;
    }
    if ((m = /^include (.+)$/i.exec(clause)) && lastCountRole) {
      const target = results[lastCountRole.index];
      target.settings = {
        ...target.settings,
        form: "required-plus-auto",
        members: labels(m[1]).map((l, i) =>
          pinned(l, i, target.roleId, sourceMessageId),
        ),
      };
      target.matched += `; ${clause}`;
      continue;
    }
    // "Use Opus and Astra as coordinators", "coordinate with Opus and Astra",
    // "review with Fable and Sol".
    if (
      (m = new RegExp(
        `^(?:use )?(.+?) as (?:the )?(${roleAlternation})$`,
        "i",
      ).exec(clause)) &&
      !countOf(m[1].split(/\s+/)[0] ?? "")
    ) {
      const roleId = roleOf(m[2])!;
      const list = labels(m[1].replace(/^use\s+/i, ""));
      results.push({
        roleId,
        settings: {
          form: "exact",
          members: list.map((l, i) => pinned(l, i, roleId, sourceMessageId)),
        },
        matched: clause,
      });
      continue;
    }
    if ((m = /^(?:.*?\b)?(coordinate|review) with (.+)$/i.exec(clause))) {
      const roleId = roleOf(m[1])!;
      const list = labels(m[2]);
      if (list.length) {
        results.push({
          roleId,
          settings: {
            form: "exact",
            members: list.map((l, i) => pinned(l, i, roleId, sourceMessageId)),
          },
          matched: clause,
        });
        continue;
      }
    }
    if ((m = /^use (.+?)$/i.exec(clause))) {
      const counts = [
        ...m[1].matchAll(new RegExp(`(\\w+) (${roleAlternation})`, "gi")),
      ]
        .map((c) => ({ n: countOf(c[1]), roleId: roleOf(c[2]) }))
        .filter((c): c is { n: number; roleId: string } => !!c.n && !!c.roleId);
      if (counts.length) {
        for (const c of counts) {
          results.push({
            roleId: c.roleId,
            settings: { form: "auto", count: c.n, members: [] },
            matched: clause,
          });
          lastCountRole = { roleId: c.roleId, index: results.length - 1 };
        }
        continue;
      }
      // "Use Sol" before a fallback clause: a one-member roster for the role in context.
      const list = labels(m[1]);
      if (list.length === 1 && /^[A-Z]/.test(list[0])) {
        const roleId = lastCountRole?.roleId ?? "reviewer";
        results.push({
          roleId,
          settings: {
            form: "exact",
            members: [pinned(list[0], 0, roleId, sourceMessageId)],
          },
          matched: clause,
        });
      }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Compatibility readers for one-member records written before role groups.

/**
 * A Build and review draft's builder and reviewer as singleton groups. An
 * untouched default is never relabelled as an explicit pin: an empty model
 * stays an unresolved Auto slot, and a filled one keeps unknown provenance
 * until ordinary selection resolves it. A Claude role keeps its native-default
 * meaning: an assisted Claude Code step whose model Claude Code decides.
 */
export function legacyDraftGroups(
  draft: Pick<
    WorkflowDraftInput,
    | "builder"
    | "reviewer"
    | "builderRuntime"
    | "reviewerRuntime"
    | "builderModel"
    | "reviewerModel"
    | "builderEffort"
    | "reviewerEffort"
  >,
  draftId: string,
): Array<{ roleId: "implementer" | "reviewer"; settings: RoleGroupSettings }> {
  const one = (
    roleId: "implementer" | "reviewer",
    provider: "codex" | "claude",
    installationId: string,
    model: string,
    effort: string,
  ) => {
    const pin: MemberPin | null =
      provider === "claude"
        ? {
            provider,
            ...(installationId ? { installationId } : {}),
            model: claudeStepModel,
            route: "assisted",
          }
        : model.trim()
          ? {
              provider,
              ...(installationId ? { installationId } : {}),
              model: model.trim(),
              ...(effort.trim() ? { effort: effort.trim() } : {}),
            }
          : null;
    return {
      roleId,
      settings: {
        form: pin ? ("exact" as const) : ("auto" as const),
        count: 1,
        collaboration: "solo" as const,
        members: [
          memberIntentSchema.parse({
            memberId: `${roleId}-1`,
            required: true,
            pin,
            source: {
              kind: "legacy-migration",
              reference: draftId,
              provenance: "legacy-unknown",
            },
          }),
        ],
      },
    };
  };
  return [
    one(
      "implementer",
      draft.builder,
      draft.builderRuntime,
      draft.builderModel,
      draft.builderEffort,
    ),
    one(
      "reviewer",
      draft.reviewer,
      draft.reviewerRuntime,
      draft.reviewerModel,
      draft.reviewerEffort,
    ),
  ];
}

/** A routing preset's assignments as role groups keyed by member identity. */
export function presetGroups(preset: {
  id: string;
  assignments: Array<{
    role: string;
    memberId?: string;
    provider: "codex" | "claude";
    installationId: string;
    model: string;
  }>;
}): Array<{ roleId: string; settings: RoleGroupSettings }> {
  const byRole = new Map<string, MemberIntent[]>();
  for (const a of preset.assignments) {
    const members = byRole.get(a.role) ?? [];
    members.push(
      memberIntentSchema.parse({
        memberId: a.memberId ?? `${a.role}-${members.length + 1}`,
        required: true,
        pin: {
          provider: a.provider,
          installationId: a.installationId,
          model: a.model,
        },
        source: {
          kind: "preset",
          reference: preset.id,
          provenance: "explicit",
        },
      }),
    );
    byRole.set(a.role, members);
  }
  return [...byRole].map(([roleId, members]) => ({
    roleId,
    settings: { form: "exact" as const, members },
  }));
}
