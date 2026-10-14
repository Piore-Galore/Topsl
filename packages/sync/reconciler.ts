import { z } from "zod";
import { hash, now, stable, uid } from "../domain/invariants";
import type { Project } from "../domain/types";
import type { Evidence, Workspace } from "../domain/workflow";
import type {
  ConfigurationEvidence,
  FieldValue,
  NativeProjectLink,
  SyncField,
  SyncObservation,
} from "../domain/sync";
import { Store } from "../persistence/store";

const fieldValue = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);
const evidenceSchema = z.object({
  level: z.enum([
    "topsl-transaction",
    "provider-ack",
    "provider-readback",
    "source-observation",
    "user-confirmation",
    "none",
  ]),
  source: z.string(),
  observedAt: z.string().datetime().nullable(),
  detail: z.string(),
});
const observationSchema = z.object({
  projectId: z.string().min(1),
  targetId: z.string().min(1),
  dimension: z.enum([
    "identity",
    "code",
    "context",
    "history",
    "configuration",
    "native-presentation",
  ]),
  state: z.enum([
    "current",
    "pending",
    "stale",
    "conflict",
    "unsupported",
    "unverified",
    "paused",
    "error",
  ]),
  evidence: evidenceSchema,
  expectedRevision: z.string().nullable(),
  observedRevision: z.string().nullable(),
  detail: z.string(),
  suggestedAction: z.string().nullable(),
});
const equal = (a: FieldValue, b: FieldValue) => stable(a) === stable(b);
export const syncObservationId = (
  projectId: string,
  dimension: SyncObservation["dimension"],
  targetId: string,
) => hash(stable([projectId, dimension, targetId]));
export class SyncRepository {
  constructor(readonly store: Store) {}
  observations(projectId: string): SyncObservation[] {
    return [
      ...this.store.iterate<SyncObservation>("sync-observation", { projectId }),
    ];
  }
  fields(projectId: string): SyncField[] {
    return [...this.store.iterate<SyncField>("sync-field", { projectId })];
  }
  links(projectId: string): NativeProjectLink[] {
    return [
      ...this.store.iterate<NativeProjectLink>("native-project-link", {
        projectId,
      }),
    ];
  }
  observe(
    input: Omit<
      SyncObservation,
      "id" | "lastCheckedAt" | "lastSuccessfulObservationAt"
    >,
  ): SyncObservation {
    const valid = observationSchema.parse(input);
    if (valid.state === "current" && valid.evidence.level === "none")
      throw new Error("Current synchronization requires recorded evidence.");
    return this.store.transaction(() => {
      const id = syncObservationId(
          valid.projectId,
          valid.dimension,
          valid.targetId,
        ),
        old = this.store.get<SyncObservation>("sync-observation", id),
        at = now();
      const observation: SyncObservation = {
        ...valid,
        id,
        lastCheckedAt: at,
        lastSuccessfulObservationAt:
          valid.state === "current"
            ? at
            : (old?.lastSuccessfulObservationAt ?? null),
      };
      this.store.save("sync-observation", observation);
      this.store.immutable("sync-observation-evidence", {
        ...observation,
        id: uid(),
        observationId: id,
      });
      return observation;
    });
  }
  reconcileField(input: {
    projectId: string;
    targetId: string;
    field: string;
    local: FieldValue;
    remote: FieldValue;
    authority?: SyncField["authority"];
    expectedRevision: number;
    initialBase?: FieldValue;
    evidence: Evidence;
  }): SyncField {
    fieldValue.parse(input.local);
    fieldValue.parse(input.remote);
    evidenceSchema.parse(input.evidence);
    return this.store.transaction(() => {
      const id = hash(stable([input.projectId, input.targetId, input.field])),
        old = this.store.get<SyncField>("sync-field", id);
      if ((old?.revision ?? 0) !== input.expectedRevision)
        throw new Error(
          "Synchronization field changed; refresh before deciding.",
        );
      const authority = input.authority ?? old?.authority ?? "topsl",
        base = old
          ? old.base
          : input.initialBase !== undefined
            ? input.initialBase
            : input.remote;
      const localChanged = !equal(input.local, base),
        remoteChanged = !equal(input.remote, base);
      const state: SyncField["state"] = equal(input.local, input.remote)
        ? "current"
        : localChanged && remoteChanged
          ? "conflict"
          : authority === "provider" || authority === "follow-native"
            ? "pull-required"
            : localChanged
              ? "push-required"
              : "pull-required";
      const value: SyncField = {
        id,
        projectId: input.projectId,
        targetId: input.targetId,
        field: input.field,
        authority,
        base: state === "current" ? input.local : base,
        local: input.local,
        remote: input.remote,
        state,
        revision: input.expectedRevision + 1,
        evidence: input.evidence,
        updatedAt: now(),
      };
      this.store.save("sync-field", value);
      this.observe({
        projectId: value.projectId,
        dimension: ["name", "order", "position"].includes(value.field)
          ? "native-presentation"
          : "configuration",
        targetId: `field:${value.id}`,
        state:
          value.state === "conflict"
            ? "conflict"
            : value.state === "current"
              ? value.evidence.level === "none"
                ? "unverified"
                : "current"
              : "pending",
        evidence: value.evidence,
        expectedRevision: hash(stable(value.local)),
        observedRevision: hash(stable(value.remote)),
        detail:
          value.state === "conflict"
            ? "Local intent and native observation both changed from their last common field value."
            : `Field reconciliation requires ${value.state}.`,
        suggestedAction:
          value.state === "current"
            ? null
            : "Choose an explicit reconciliation direction; provider writes require supported readback.",
      });
      return value;
    });
  }
  resolveField(
    id: string,
    expectedRevision: number,
    direction: "follow-native" | "keep-topsl",
  ): SyncField {
    return this.store.transaction(() => {
      const value = this.store.get<SyncField>("sync-field", id);
      if (!value || value.revision !== expectedRevision)
        throw new Error(
          "Synchronization decision is stale; refresh the field.",
        );
      if (direction === "keep-topsl" && value.authority === "provider")
        throw new Error("Provider-owned facts cannot be overwritten by Topsl.");
      const at = now(),
        result: SyncField = {
          ...value,
          revision: value.revision + 1,
          base: value.remote,
          local: direction === "follow-native" ? value.remote : value.local,
          state:
            direction === "follow-native" || equal(value.local, value.remote)
              ? "current"
              : "push-required",
          updatedAt: at,
          evidence: {
            level: "topsl-transaction",
            source: "explicit-field-resolution",
            observedAt: at,
            detail:
              direction === "follow-native"
                ? "User explicitly accepted the observed native field."
                : "User selected local intent; native write/readback remains pending.",
          },
        };
      this.store.save("sync-field", result);
      this.observe({
        projectId: result.projectId,
        dimension: ["name", "order", "position"].includes(result.field)
          ? "native-presentation"
          : "configuration",
        targetId: `field:${result.id}`,
        state: result.state === "current" ? "current" : "pending",
        evidence: result.evidence,
        expectedRevision: hash(stable(result.local)),
        observedRevision: hash(stable(result.remote)),
        detail: result.evidence.detail,
        suggestedAction:
          result.state === "current"
            ? null
            : "Push the chosen intent through a supported native route and verify readback.",
      });
      this.store.immutable("sync-field-decision", {
        ...result,
        id: uid(),
        fieldId: result.id,
        direction,
      });
      return result;
    });
  }
  observeNativeGroup(input: {
    projectId: string;
    provider: NativeProjectLink["provider"];
    profileId: string;
    nativeGroupId: string;
    name: string;
    position: number;
    sourceRevision: string;
    roots: string[];
    evidence: Evidence;
  }): NativeProjectLink {
    if (
      !input.roots.length ||
      input.roots.length > 2000 ||
      new Set(input.roots).size !== input.roots.length
    )
      throw new Error("Native group roots must be distinct and bounded.");
    evidenceSchema.parse(input.evidence);
    return this.store.transaction(() => {
      const id = hash(
          stable([
            input.projectId,
            input.provider,
            input.profileId,
            input.nativeGroupId,
          ]),
        ),
        old = this.store.get<NativeProjectLink>("native-project-link", id),
        at = now();
      const roots = input.roots.map(
        (nativeRoot) =>
          old?.roots.find((root) => root.nativeRoot === nativeRoot) ?? {
            nativeRoot,
            workspaceId: null,
            canonicalRoot: null,
            trustRevision: null,
          },
      );
      const link: NativeProjectLink = {
        ...input,
        id,
        roots,
        revision: (old?.revision ?? 0) + 1,
        state: old?.state === "unlinked" ? "unlinked" : "linked",
        createdAt: old?.createdAt ?? at,
        updatedAt: at,
      };
      this.store.save("native-project-link", link);
      return link;
    });
  }
  mapNativeRoot(
    id: string,
    expectedRevision: number,
    nativeRoot: string,
    workspaceId: string,
  ): NativeProjectLink {
    return this.store.transaction(() => {
      const link = this.requireLink(id, expectedRevision),
        workspace = this.store.get<Workspace>("workspace", workspaceId);
      if (
        !workspace ||
        workspace.projectId !== link.projectId ||
        !workspace.trustRevision ||
        workspace.availability !== "available"
      )
        throw new Error(
          "Approve this project's workspace before mapping a native root.",
        );
      if (!link.roots.some((root) => root.nativeRoot === nativeRoot))
        throw new Error("Native root is not part of this group.");
      // Require exact canonical identity; one trusted root never grants access to its siblings.
      if (workspace.canonicalRoot !== nativeRoot)
        throw new Error(
          "Relink the native root to its approved canonical workspace first.",
        );
      const result = {
        ...link,
        revision: link.revision + 1,
        roots: link.roots.map((root) =>
          root.nativeRoot === nativeRoot
            ? {
                ...root,
                workspaceId,
                canonicalRoot: workspace.canonicalRoot,
                trustRevision: workspace.trustRevision,
              }
            : root,
        ),
        updatedAt: now(),
      };
      this.store.save("native-project-link", result);
      return result;
    });
  }
  setLinkState(
    id: string,
    expectedRevision: number,
    state: "removed" | "unlinked" | "linked",
  ): NativeProjectLink {
    return this.store.transaction(() => {
      const link = this.requireLink(id, expectedRevision),
        result = {
          ...link,
          revision: link.revision + 1,
          state,
          updatedAt: now(),
        };
      this.store.save("native-project-link", result);
      if (state !== "linked")
        this.store.immutable("native-link-removal", {
          id: `${id}:${result.revision}`,
          projectId: link.projectId,
          linkId: id,
          state,
          at: result.updatedAt,
        });
      return result;
    });
  }
  private requireLink(id: string, revision: number): NativeProjectLink {
    const link = this.store.get<NativeProjectLink>("native-project-link", id);
    if (!link || link.revision !== revision)
      throw new Error(
        "Native project link changed; refresh before mapping or unlinking.",
      );
    return link;
  }
  projectNativeCatalog(input: {
    provider: NativeProjectLink["provider"];
    profileId: string;
    groups: Array<{
      id: string;
      name: string;
      roots: string[];
      position: number;
      revision: string;
    }>;
    evidence: Evidence;
  }): void {
    this.store.transaction(() => {
      const projects = [...this.store.iterate<Project>("project")];
      const oldLinks = [
        ...this.store.iterate<NativeProjectLink>("native-project-link"),
      ].filter(
        (link) =>
          link.provider === input.provider &&
          link.profileId === input.profileId,
      );
      for (const group of input.groups) {
        const matched = projects.filter(
          (project) =>
            group.roots.includes(project.realPath) ||
            oldLinks.some(
              (link) =>
                link.projectId === project.id &&
                link.nativeGroupId === group.id,
            ),
        );
        for (const project of matched) {
          const link = this.observeNativeGroup({
            projectId: project.id,
            provider: input.provider,
            profileId: input.profileId,
            nativeGroupId: group.id,
            name: group.name,
            position: group.position,
            sourceRevision: group.revision,
            roots: group.roots,
            evidence: input.evidence,
          });
          if (
            !this.fields(project.id).some(
              (field) => field.targetId === link.id && field.field === "name",
            )
          )
            this.reconcileField({
              projectId: project.id,
              targetId: link.id,
              field: "name",
              local: project.name,
              remote: group.name,
              expectedRevision: 0,
              authority: project.nameSource ? "follow-native" : "topsl",
              evidence: input.evidence,
            });
          this.observe({
            projectId: project.id,
            dimension: "native-presentation",
            targetId: `${input.provider}:${input.profileId}:registry:${group.id}`,
            state: "current",
            evidence: input.evidence,
            expectedRevision: null,
            observedRevision: group.revision,
            detail:
              "Native project registry observed; group membership does not grant access to additional roots.",
            suggestedAction: null,
          });
          const sidebarId = syncObservationId(
            project.id,
            "native-presentation",
            `${input.provider}:${input.profileId}:sidebar:${group.id}`,
          );
          if (!this.store.get("sync-observation", sidebarId))
            this.observe({
              projectId: project.id,
              dimension: "native-presentation",
              targetId: `${input.provider}:${input.profileId}:sidebar:${group.id}`,
              state: "unverified",
              evidence: {
                level: "none",
                source: "native-sidebar",
                observedAt: null,
                detail:
                  "Registry readback does not establish visible desktop state.",
              },
              expectedRevision: group.revision,
              observedRevision: null,
              detail: "Desktop sidebar presentation remains unverified.",
              suggestedAction:
                "Open the native application and confirm its visible entry.",
            });
        }
      }
      for (const link of oldLinks)
        if (
          link.state === "linked" &&
          !input.groups.some((group) => group.id === link.nativeGroupId)
        ) {
          this.setLinkState(link.id, link.revision, "removed");
          this.observe({
            projectId: link.projectId,
            dimension: "identity",
            targetId: link.id,
            state: "stale",
            evidence: input.evidence,
            expectedRevision: link.sourceRevision,
            observedRevision: null,
            detail:
              "Native membership was removed. Topsl history and trust remain separate; no recreation is scheduled.",
            suggestedAction:
              "Explicitly relink only if native membership should be restored.",
          });
        }
    });
  }
  recordConfiguration(
    input: Omit<ConfigurationEvidence, "id" | "createdAt">,
  ): ConfigurationEvidence {
    evidenceSchema.parse(input.evidence);
    if (
      input.stage === "effective" &&
      !["provider-readback", "user-confirmation"].includes(input.evidence.level)
    )
      throw new Error(
        "Disk writes or file presence cannot prove effective runtime configuration.",
      );
    if (
      input.stage === "effective" &&
      ["unsupported", "unknown"].includes(input.classification)
    )
      throw new Error(
        "Unsupported or unknown capabilities cannot be reported effective.",
      );
    const value = { ...input, id: uid(), createdAt: now() };
    this.store.immutable("configuration-evidence", value);
    return value;
  }
  configuration(
    projectId: string,
    sessionId?: string,
  ): ConfigurationEvidence[] {
    return [
      ...this.store.iterate<ConfigurationEvidence>("configuration-evidence", {
        projectId,
      }),
    ].filter((value) => !sessionId || value.sessionId === sessionId);
  }
  requireEffectiveCapabilities(
    projectId: string,
    sessionId: string,
    required: string[],
  ): void {
    const values = this.configuration(projectId, sessionId);
    for (const capability of required) {
      const latest = values
        .filter((value) => value.capability === capability)
        .at(-1);
      if (
        !latest ||
        latest.stage !== "effective" ||
        latest.classification !== "enforceable"
      )
        throw new Error(
          `Required capability ${capability} is not evidenced as effective and enforceable.`,
        );
    }
  }
}
