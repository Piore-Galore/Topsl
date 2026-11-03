import { z } from "zod";
import { hash, now, stable, uid } from "../domain/invariants";
import type { ConfigurationEvidence, SyncObservation } from "../domain/sync";
import { Store } from "../persistence/store";

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
