import { createHmac, randomBytes } from "node:crypto";
import type { Installation, Provider } from "../domain/types";
import { hash, now, stable, uid } from "../domain/invariants";
import type { Store } from "../persistence/store";
import type { ProviderCapability } from "./contract";
export const acceptanceSchemaVersion = 1;
export const adapterProtocols = {
  codex: "codex-app-server/r2-2/v1",
  claude: "claude-print-stream-json/r2-2/v2",
} as const;
export interface RuntimeBinding {
  schemaVersion: 1;
  provider: Provider;
  installationId: string;
  executableIdentity: string;
  runtimeRevision: string;
  runtimeVersion: string | null;
  adapterProtocol: string;
  profileId: string;
  accountKey: string;
  authenticationRoute: "native-subscription";
  policyHash: string;
  sandboxHash: string;
  hostId: string;
  platform: string;
  arch: string;
}
export interface RuntimeProbeObservation {
  capability: string;
  meaning:
    | "protocol-supported"
    | "behavior-observed"
    | "policy-enforced"
    | "unsupported"
    | "unknown";
  source:
    "trusted-runtime-validation" | "fixture" | "import" | "model-statement";
  operationId: string;
  observedAt: string;
  passed: boolean;
  negativeControl: {
    operationAttempted: boolean;
    trustedStateChecked: boolean;
    denied: boolean;
  } | null;
  detail: string;
}
export interface RuntimeAcceptance {
  id: string;
  bindingId: string;
  binding: RuntimeBinding;
  observations: RuntimeProbeObservation[];
  createdAt: string;
  expiresAt: string;
  signature: string;
}
export const runtimeBindingId = (binding: RuntimeBinding) =>
  hash(stable(binding));
/** Service internal authority. No renderer command, record import, trust toggle or fixture can write a qualification. */
export class RuntimeAcceptanceRegistry {
  #key: string;
  constructor(private store: Store) {
    const saved = store.get<{ id: string; value: string }>(
      "runtime-acceptance-authority",
      "local",
    );
    this.#key = saved?.value ?? randomBytes(32).toString("hex");
    if (!saved)
      store.immutable("runtime-acceptance-authority", {
        id: "local",
        value: this.#key,
      });
  }
  private sign(value: Omit<RuntimeAcceptance, "signature">) {
    return createHmac("sha256", this.#key).update(stable(value)).digest("hex");
  }
  /** Called only by a trusted service validation suite after consent and actual bounded operations. Never accepts renderer payloads. */
  recordTrustedValidation(
    binding: RuntimeBinding,
    observations: RuntimeProbeObservation[],
    expiresAt: string,
  ): RuntimeAcceptance {
    if (
      binding.schemaVersion !== acceptanceSchemaVersion ||
      !binding.profileId ||
      !binding.accountKey ||
      !observations.length ||
      new Set(observations.map((o) => o.capability)).size !==
        observations.length ||
      observations.some(
        (o) =>
          o.source !== "trusted-runtime-validation" ||
          !o.operationId ||
          !Number.isFinite(Date.parse(o.observedAt)),
      ) ||
      !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= Date.now()
    )
      throw new Error(
        "Only current trusted runtime operations can qualify a runtime; fixture/import/model records are rejected.",
      );
    for (const o of observations)
      if (
        o.meaning === "policy-enforced" &&
        o.passed &&
        (!o.negativeControl?.operationAttempted ||
          !o.negativeControl.trustedStateChecked ||
          !o.negativeControl.denied)
      )
        throw new Error(
          "Policy enforcement requires an attempted negative control and a trusted filesystem/state check.",
        );
    const body = {
        id: uid(),
        bindingId: runtimeBindingId(binding),
        binding,
        observations: structuredClone(observations),
        createdAt: now(),
        expiresAt,
      },
      record = { ...body, signature: this.sign(body) };
    this.store.immutable("runtime-acceptance", record);
    return record;
  }
  invalidate(bindingId: string, reason: string) {
    this.store.immutable("runtime-acceptance-invalidation", {
      id: uid(),
      bindingId,
      acceptanceIds: [
        ...this.store.iterate<RuntimeAcceptance>("runtime-acceptance"),
      ]
        .filter((r) => r.bindingId === bindingId)
        .map((r) => r.id),
      reason,
      observedAt: now(),
    });
  }
  history(installationId: string) {
    return [
      ...this.store.iterate<RuntimeAcceptance>("runtime-acceptance"),
    ].filter((r) => r.binding.installationId === installationId);
  }
  resolve(
    binding: RuntimeBinding | null,
    installation: Installation,
  ): {
    capabilities: ProviderCapability[];
    freshness: {
      state: "current" | "missing" | "stale";
      bindingId: string | null;
    };
  } {
    const history = this.history(installation.id),
      bindingId = binding ? runtimeBindingId(binding) : null,
      invalid = new Set(
        [
          ...this.store.iterate<{ acceptanceIds: string[] }>(
            "runtime-acceptance-invalidation",
          ),
        ].flatMap((i) => i.acceptanceIds),
      ),
      record = history
        .filter((r) => {
          const { signature, ...body } = r;
          return (
            r.bindingId === bindingId &&
            signature === this.sign(body) &&
            !invalid.has(r.id) &&
            Date.parse(r.expiresAt) > Date.now()
          );
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return {
      freshness: {
        state: record ? "current" : history.length ? "stale" : "missing",
        bindingId,
      },
      capabilities: record
        ? record.observations
            .filter((o) => o.passed)
            .map((o) => ({
              name: o.capability,
              route: "structured",
              support:
                o.meaning === "policy-enforced"
                  ? "enforceable"
                  : o.meaning === "behavior-observed"
                    ? "observable-only"
                    : o.meaning === "unsupported"
                      ? "unsupported"
                      : "unknown",
              versions: record.binding.runtimeVersion
                ? [record.binding.runtimeVersion]
                : [],
              testedPlatforms: [record.binding.platform],
              restrictions: [
                "Finite qualification applies only to this exact executable, account/profile, policy, sandbox and host.",
              ],
              evidence: {
                level: "source-observation",
                source: `runtime-validation:${record.id}:${o.operationId}`,
                observedAt: o.observedAt,
                detail: o.detail,
              },
            }))
        : [],
    };
  }
}
