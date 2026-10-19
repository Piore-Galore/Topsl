import type { Store } from "../persistence/store";
import { hash, now, safeError, stable } from "../domain/invariants";
import {
  DEFAULT_MEMBER_LIMIT,
  MEMBER_LIMIT_CEILING,
  roleGroupSettingsSchema,
  type CommandReceipt,
  type GroupScope,
  type OrchestrationPolicy,
  type ResolvedMemberAssignment,
  type RoleDefinition,
  type RoleGroupRevision,
  type RoleGroupSettings,
  type RoleRound,
} from "../domain/role-groups";
import { builtInRoleDefinitions } from "./roles";

/** Record kinds the coordinator feature writes to the encrypted store. */
export const kinds = {
  conversation: "orch-conversation",
  message: "orch-message",
  goal: "goal",
  group: "role-group",
  policy: "orch-policy",
  role: "role-definition",
  assignment: "member-assignment",
  round: "role-round",
  contribution: "role-contribution",
  candidate: "decision-candidate",
  endorsement: "decision-endorsement",
  completion: "role-completion",
  findings: "review-findings",
  plan: "coordinator-plan",
  action: "plan-action",
  control: "control-event",
  receipt: "command-receipt",
  memberSession: "member-session",
  dependency: "dependency-bundle",
  integration: "goal-integration",
} as const;

export class OrchestrationRepository {
  constructor(readonly store: Store) {}
  get<T>(kind: string, id: string): T | undefined {
    return this.store.get<T>(kind, id);
  }
  require<T>(kind: string, id: string): T {
    const value = this.store.get<T>(kind, id);
    if (!value)
      throw new Error(
        `The selected ${kind.replaceAll("-", " ")} does not exist.`,
      );
    return value;
  }
  all<T>(kind: string, projectId?: string): T[] {
    return [...this.store.iterate<T>(kind, projectId ? { projectId } : {})];
  }
  /** Saves a mutable record and an immutable copy of this revision. */
  saveRevisioned<T extends { id: string; revision: number }>(
    kind: string,
    value: T,
  ): T {
    this.store.transaction(() => {
      this.store.save(kind, value, `${kind}.changed`);
      this.store.immutable(`${kind}-revision`, {
        ...value,
        id: `${value.id}:${value.revision}`,
        entityId: value.id,
      });
    });
    return value;
  }
  immutable<T extends { id: string }>(kind: string, value: T): T {
    this.store.immutable(kind, value);
    return value;
  }
  expect(record: { revision: number }, expected: number | undefined): void {
    if (expected !== undefined && record.revision !== expected)
      throw new Error("This record changed. Refresh and try again.");
  }
  /** Commands still running, by command ID, so a concurrent repeat joins them. */
  private inflight = new Map<
    string,
    { projectId: string; type: string; promise: Promise<unknown> }
  >();
  /**
   * Runs a command once per command ID. A repeated request returns the first
   * result, or repeats its refusal, without running the transition again. A
   * repeat that arrives while the first is still running waits for it and
   * shares its outcome.
   */
  async receipt<T>(
    commandId: string,
    projectId: string,
    type: string,
    run: () => T | Promise<T>,
  ): Promise<T> {
    const pending = this.inflight.get(commandId);
    const prior = this.store.get<CommandReceipt>(kinds.receipt, commandId);
    const used = pending ?? prior;
    if (used && (used.projectId !== projectId || used.type !== type))
      throw new Error("This command ID was already used for another request.");
    if (pending) return pending.promise as Promise<T>;
    if (prior) {
      if (!prior.accepted)
        throw new Error(prior.error ?? "This command was refused.");
      return prior.result as T;
    }
    const promise = this.record(commandId, projectId, type, run);
    this.inflight.set(commandId, { projectId, type, promise });
    try {
      return await promise;
    } finally {
      this.inflight.delete(commandId);
    }
  }
  private async record<T>(
    commandId: string,
    projectId: string,
    type: string,
    run: () => T | Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      this.store.immutable(kinds.receipt, {
        id: commandId,
        projectId,
        type,
        accepted: true,
        result: JSON.parse(JSON.stringify(result ?? null)),
        error: null,
        at: now(),
      } satisfies CommandReceipt);
      return result;
    } catch (error) {
      this.store.immutable(kinds.receipt, {
        id: commandId,
        projectId,
        type,
        accepted: false,
        result: null,
        error: safeError(error),
        at: now(),
      } satisfies CommandReceipt);
      throw error;
    }
  }
  policy(projectId: string): OrchestrationPolicy {
    return (
      this.store.get<OrchestrationPolicy>(kinds.policy, projectId) ?? {
        id: projectId,
        projectId,
        revision: 0,
        maxMembersPerRole: DEFAULT_MEMBER_LIMIT,
        defaults: {},
        updatedAt: now(),
      }
    );
  }
  setPolicy(input: {
    projectId: string;
    expectedRevision: number;
    maxMembersPerRole: number;
    defaults: RoleGroupSettings;
  }): OrchestrationPolicy {
    if (
      !Number.isInteger(input.maxMembersPerRole) ||
      input.maxMembersPerRole < 1 ||
      input.maxMembersPerRole > MEMBER_LIMIT_CEILING
    )
      throw new Error(
        `The member limit must be between 1 and ${MEMBER_LIMIT_CEILING}.`,
      );
    return this.store.transaction(() => {
      const old = this.policy(input.projectId);
      this.expect(old, input.expectedRevision);
      return this.saveRevisioned(kinds.policy, {
        ...old,
        revision: old.revision + 1,
        maxMembersPerRole: input.maxMembersPerRole,
        defaults: roleGroupSettingsSchema.parse(input.defaults),
        updatedAt: now(),
      });
    });
  }
  roles(projectId: string): RoleDefinition[] {
    const custom = this.all<RoleDefinition & { roleId: string }>(
      kinds.role,
      projectId,
    ).map(({ roleId, ...role }) => ({ ...role, id: roleId }));
    return [...Object.values(builtInRoleDefinitions), ...custom];
  }
  role(projectId: string, roleId: string): RoleDefinition {
    const role = this.roles(projectId).find((r) => r.id === roleId);
    if (!role)
      throw new Error(`Role ${roleId} is not defined for this project.`);
    return role;
  }
  groupRevisions(projectId: string): RoleGroupRevision[] {
    return this.all<RoleGroupRevision>(kinds.group, projectId);
  }
  addGroupRevision(input: {
    scope: GroupScope;
    roleId: string;
    settings: RoleGroupSettings;
    actor: string;
    commandId: string;
    messageId: string | null;
    /** merge: change only the fields given. replace: these are the scope's whole settings. */
    mode?: "merge" | "replace";
  }): RoleGroupRevision {
    const given = roleGroupSettingsSchema.parse(input.settings);
    const groupId = hash(
      stable([
        input.scope.projectId,
        input.scope.level,
        input.scope.goalId,
        input.scope.taskKey,
        input.roleId,
      ]),
    ).slice(0, 24);
    const prior = this.groupRevisions(input.scope.projectId)
      .filter((r) => r.groupId === groupId)
      .sort((a, b) => b.revision - a.revision)[0];
    let settings = given;
    if (prior && input.mode !== "replace") {
      settings = { ...prior.settings, ...given };
      if (prior.settings.completion || given.completion)
        settings.completion = {
          ...prior.settings.completion,
          ...given.completion,
        };
      // An exact roster derives its count; a broader count no longer applies.
      if (given.form === "exact" && given.members) {
        delete settings.count;
        delete settings.minCount;
        delete settings.maxCount;
      }
      settings = roleGroupSettingsSchema.parse(settings);
    }
    const revision: RoleGroupRevision = {
      id: `${groupId}:${(prior?.revision ?? 0) + 1}`,
      groupId,
      revision: (prior?.revision ?? 0) + 1,
      projectId: input.scope.projectId,
      goalId: input.scope.goalId,
      scope: input.scope,
      roleId: input.roleId,
      settings,
      source: {
        actor: input.actor,
        commandId: input.commandId,
        messageId: input.messageId,
      },
      supersedes: prior?.revision ?? null,
      createdAt: now(),
    };
    return this.immutable(kinds.group, revision);
  }
  /**
   * Records a member's resolved assignment. The same tuple keeps its revision;
   * any change of route, model, account or settings is a new revision, so a
   * stable member ID never lets an old model's evidence count for a new one.
   */
  upsertAssignment(
    value: Omit<ResolvedMemberAssignment, "id" | "revision" | "createdAt">,
  ): ResolvedMemberAssignment {
    const id = hash(
      stable([value.projectId, value.goalId, value.roleId, value.memberId]),
    ).slice(0, 24);
    const old = this.store.get<ResolvedMemberAssignment>(kinds.assignment, id);
    const identity = (
      a: Omit<ResolvedMemberAssignment, "id" | "revision" | "createdAt">,
    ) =>
      stable([
        a.status,
        a.selection,
        a.provider,
        a.route,
        a.installationId,
        a.installationRevision,
        a.executableIdentity,
        a.nativeAccountKey,
        a.nativeProfileId,
        a.billingRoute,
        a.model,
        a.effort,
        a.roleDefinitionRevision,
        a.modelEvidencePolicy,
        a.primaryPin,
      ]);
    if (old && identity(old) === identity(value)) {
      if (
        old.reason !== value.reason ||
        stable(old.catalog) !== stable(value.catalog)
      ) {
        const refreshed = {
          ...old,
          reason: value.reason,
          catalog: value.catalog,
        };
        this.store.put(kinds.assignment, refreshed);
        return refreshed;
      }
      return old;
    }
    return this.saveRevisioned(kinds.assignment, {
      ...value,
      id,
      revision: (old?.revision ?? 0) + 1,
      createdAt: now(),
    });
  }
  assignmentRevision(
    id: string,
    revision: number,
  ): ResolvedMemberAssignment | undefined {
    return this.store.get<ResolvedMemberAssignment>(
      `${kinds.assignment}-revision`,
      `${id}:${revision}`,
    );
  }
  saveRound(round: RoleRound, next: Partial<RoleRound>): RoleRound {
    return this.saveRevisioned(kinds.round, {
      ...round,
      ...next,
      revision: round.revision + 1,
      updatedAt: now(),
    });
  }
}
