import { useEffect, useState } from "react";
import type {
  AppState,
  Installation,
  LifecyclePlan,
} from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import type { ProviderModel } from "../../../../packages/providers/contract";
import { ActionButton } from "../components/action-button";
import { Badge } from "../components/atlas";
import { ProviderUsage } from "../components/allowance";
import { useRuntimeRefresh } from "../coordinator/shared";
import { suggestedClaudeModels } from "../../../../packages/domain/claude-route";

type Props = {
  state: AppState;
  act: (command: Command) => Promise<any>;
  connect: (installation: Installation) => Promise<void>;
  preview: (
    installation: Installation | null,
    appId: string,
    action: "download" | "install" | "update",
  ) => Promise<void>;
  setPlan: (plan: LifecyclePlan | null) => void;
};

/** What Topsl can do with an executable now, in the owner's words (W3-20). */
const compatibilityText: Record<Installation["compatibility"], string> = {
  compatible: "Protocol connected",
  unverified: "Not connected yet",
  "native-only": "Terminal only",
  incompatible: "Cannot connect",
};

/** Who keeps an executable up to date, as the owner reads it. */
const ownerText: Record<Installation["owner"], string> = {
  homebrew: "Homebrew",
  npm: "npm",
  external: "Inside an application bundle; that application updates it",
  system: "System",
  unknown: "Unknown",
};

/**
 * Providers (docs/UX_Cleanup_Plan.md §2): the Codex and Claude Code CLIs
 * only, with discovery, version checks, trust, sign-in, qualification,
 * installation and updates. Desktop applications are not managed.
 */
export function ProvidersScreen({
  state,
  act,
  connect,
  preview,
  setPlan,
}: Props) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Providers</h1>
        </div>
        <div className="actions">
          <ActionButton onClick={() => void act({ type: "select-runtime" })}>
            Locate a runtime
          </ActionButton>
          <ActionButton
            disabled={state.testProfile}
            onClick={() => void act({ type: "discover" })}
          >
            ↻ Discover
          </ActionButton>
        </div>
      </div>
      {state.testProfile && (
        <div className="info-strip">
          <span className="status-dot notice" />
          <div>
            <strong>This is a test profile.</strong>
            <span>
              {" "}
              Topsl doesn't search for providers here, so it lists only the ones
              the test set up. Your usual profile still finds what's installed.
            </span>
          </div>
        </div>
      )}
      <ProviderUsage state={state} />
      <div className="application-grid application-catalog">
        {state.applications.map((app) => {
          const installations = state.installations.filter(
            (i) => i.appId === app.id,
          );
          const supported = app.platforms.includes(
            state.platform.split("/")[0],
          );
          return (
            <article className="application-card" key={app.id}>
              <div className="card-title">
                <div className={"app-icon " + app.provider}>
                  {app.provider === "codex" ? "◎" : "✳"}
                </div>
                <div>
                  <h2>{app.name}</h2>
                  <span className="muted tiny">CLI</span>
                </div>
                <Badge tone={installations.length ? "good" : ""}>
                  {installations.length
                    ? "Installed"
                    : !supported
                      ? "Unavailable on this system"
                      : state.testProfile
                        ? "Not searched"
                        : "Not found"}
                </Badge>
              </div>
              <p className="description">{app.description}</p>
              {installations.length ? (
                installations.map((i) => {
                  const check = state.checks.find(
                    (c) => c.installationId === i.id,
                  );
                  return (
                    <div className="installation" key={i.id}>
                      <div className="installation-heading">
                        <strong>{i.version ?? "Version not verified"}</strong>
                        <Badge
                          tone={check?.status === "available" ? "warm" : ""}
                        >
                          {check?.status === "available"
                            ? `${check.release?.version} available`
                            : compatibilityText[i.compatibility]}
                        </Badge>
                      </div>
                      <dl>
                        <div>
                          <dt>Updated by</dt>
                          <dd>
                            {ownerText[i.owner] ?? i.owner}
                            {i.owner === "homebrew" ? ` · ${i.channel}` : ""}
                          </dd>
                        </div>
                        <div>
                          <dt>Running state</dt>
                          <dd>
                            {i.runningPids == null
                              ? "Unknown"
                              : i.runningPids.length
                                ? `${i.runningPids.length} process(es)`
                                : "Not observed running"}
                          </dd>
                        </div>
                        <div>
                          <dt>Topsl trust</dt>
                          <dd>
                            {i.trusted
                              ? "Approved executable"
                              : "Review before execution"}
                          </dd>
                        </div>
                      </dl>
                      <code className="path" title={i.realPath}>
                        {i.path}
                      </code>
                      <div className="actions wrap">
                        {!i.trusted && (
                          <>
                            <p className="muted">
                              Next: trust this executable, after checking its
                              path, so Topsl can connect and qualify it.
                            </p>
                            <ActionButton
                              className="primary"
                              onClick={() =>
                                void act({
                                  type: "trust-installation",
                                  id: i.id,
                                })
                              }
                            >
                              Trust executable
                            </ActionButton>
                          </>
                        )}
                        {(app.id === "openai.codex-cli" ||
                          (app.id === "anthropic.claude-code-cli" &&
                            state.claudeStructuredRoute?.enabled)) &&
                          i.trusted && (
                            <ActionButton onClick={() => connect(i)}>
                              Connect / test
                            </ActionButton>
                          )}
                        {i.owner !== "external" && (
                          <>
                            <ActionButton
                              onClick={() =>
                                void act({
                                  type: "check-updates",
                                  id: i.id,
                                })
                              }
                            >
                              Check for updates
                            </ActionButton>
                            <ActionButton
                              onClick={() => preview(i, app.id, "update")}
                            >
                              Update…
                            </ActionButton>
                          </>
                        )}
                      </div>
                      {i.trusted && (
                        <RuntimeQualification
                          installation={i}
                          routeEnabled={!!state.claudeStructuredRoute?.enabled}
                          act={act}
                        />
                      )}
                      {check && (
                        <p className="check-detail">
                          {check.detail}
                          <br />
                          Checked {new Date(check.checkedAt).toLocaleString()} ·
                          next {new Date(check.nextCheckAt).toLocaleString()}
                        </p>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="not-installed">
                  <span>Not installed.</span>
                </div>
              )}
              <div className="card-footer">
                <div className="actions">
                  <ActionButton
                    className={!installations.length ? "primary" : ""}
                    disabled={!supported}
                    onClick={() => preview(null, app.id, "download")}
                  >
                    Download
                  </ActionButton>
                  {!installations.length && (
                    <ActionButton
                      disabled={!supported}
                      onClick={() => preview(null, app.id, "install")}
                    >
                      Install…
                    </ActionButton>
                  )}
                </div>
                <ActionButton
                  className="text-button"
                  onClick={() =>
                    void act({
                      type: "open-docs",
                      appId: app.id,
                      kind: "releaseNotes",
                    })
                  }
                >
                  Release notes ↗
                </ActionButton>
              </div>
              <ActionButton
                className="text-button download-link"
                onClick={() =>
                  void act({
                    type: "open-docs",
                    appId: app.id,
                    kind: "website",
                  })
                }
              >
                Official installation guide ↗
              </ActionButton>
            </article>
          );
        })}
      </div>
      <section className="jobs">
        <div className="section-heading">
          <h2>Operations</h2>
        </div>
        {!state.jobs.length ? (
          <div className="empty-row">No downloads or updates yet.</div>
        ) : (
          state.jobs.map((j) => (
            <div key={j.id} className="job">
              <div>
                <strong>Operation {j.id.slice(0, 8)}</strong>{" "}
                <Badge>{j.state}</Badge>
                <p>{j.detail}</p>
                {j.bytes > 0 && (
                  <>
                    <progress
                      value={j.bytes}
                      max={j.total ?? Math.max(j.bytes * 1.1, 1)}
                    />
                    <small>
                      {" "}
                      {(j.bytes / 1e6).toFixed(1)} MB
                      {j.total ? ` / ${(j.total / 1e6).toFixed(1)} MB` : ""}
                    </small>
                  </>
                )}
                {j.actualVersion && (
                  <small>
                    Installed {j.actualVersion} · compatibility evaluated
                    separately
                  </small>
                )}
              </div>
              <div className="actions">
                {j.acquiredPath && (
                  <ActionButton
                    onClick={() =>
                      void act({ type: "show-download", id: j.id })
                    }
                  >
                    Show download
                  </ActionButton>
                )}
                {["queued", "waiting-for-idle", "downloading"].includes(
                  j.state,
                ) && (
                  <ActionButton
                    onClick={() =>
                      void act({ type: "lifecycle-cancel", id: j.id })
                    }
                  >
                    Cancel
                  </ActionButton>
                )}
                {["failed", "cancelled", "unchanged"].includes(j.state) && (
                  <ActionButton
                    onClick={async () => {
                      const value = await act({
                        type: "lifecycle-retry-preview",
                        id: j.id,
                      });
                      if (value) setPlan(value);
                    }}
                  >
                    Review retry…
                  </ActionButton>
                )}
                {["uncertain", "awaiting-native", "waiting-for-idle"].includes(
                  j.state,
                ) && (
                  <ActionButton
                    onClick={() =>
                      void act({
                        type: "lifecycle-reconcile",
                        id: j.id,
                      })
                    }
                  >
                    Reconcile
                  </ActionButton>
                )}
              </div>
            </div>
          ))
        )}
      </section>
    </>
  );
}

interface QualificationStatus {
  state: "current" | "missing" | "stale";
  running: boolean;
  models: ProviderModel[];
  /** For a stale qualification, what differs from the last one recorded. */
  staleBecause?: string[];
  reports: Array<{
    acceptanceId: string | null;
    expiresAt: string;
    createdAt: string;
    report: {
      model: string;
      error: string | null;
      observations: Array<{ capability: string; passed: boolean }>;
    };
  }>;
}

/** Model ids typed into the "other models" field: split on commas and spaces. */
function typedModels(text: string): string[] {
  return text.split(/[\s,]+/).filter(Boolean);
}

/** What one qualification run passed and missed, in a sentence or two. */
function qualificationSummary(result: any): string {
  const observations: any[] = result.report?.observations ?? [];
  const names = (passed: boolean) =>
    observations
      .filter((o) => !!o.passed === passed)
      .map((o) => o.capability)
      .join(", ") || "none";
  return [
    result.acceptanceId
      ? `Recorded until ${new Date(result.expiresAt).toLocaleString()}.`
      : "Nothing was recorded.",
    `Passed: ${names(true)}.`,
    `Not passed: ${names(false)}.`,
    result.report?.reportedModel !== undefined
      ? `Claude Code reported model ${result.report.reportedModel ?? "none"}.`
      : "",
    ...(result.report?.modelChecks ?? []).map((check: any) =>
      check.passed
        ? `Added ${check.model}.`
        : `Did not add ${check.model}: ${check.detail}`,
    ),
    result.report?.error ? `Stopped: ${result.report.error}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Qualifies a trusted runtime for coordinators and teams, and says whether
 * its current qualification still holds, what voided it, and which checks it
 * missed. A qualification covers the runtime, not one model: Codex lists its
 * models after Connect / test and one run covers them all. Claude Code has no
 * model list, so the owner picks the models to add, and one run checks them
 * all. Topsl's own dialog lists the live turns before any start.
 */
function RuntimeQualification({
  installation,
  routeEnabled,
  act,
}: {
  installation: Installation;
  routeEnabled: boolean;
  act: (command: Command) => Promise<any>;
}) {
  const claude = installation.appId === "anthropic.claude-code-cli";
  const name = claude ? "Claude" : "Codex";
  const [status, setStatus] = useState<QualificationStatus | null>(null);
  const [model, setModel] = useState("");
  // Claude: the suggested models picked, or null for the default (each one
  // not yet qualified), and any other ids typed.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [otherModels, setOtherModels] = useState("");
  const [effort, setEffort] = useState("");
  const [summary, setSummary] = useState("");
  // A failed read keeps the last status it had and says so (W3-4).
  const [readError, setReadError] = useState("");
  async function load() {
    try {
      setStatus(
        await window.topsl.command({
          type: "runtime-qualification-query",
          id: installation.id,
        }),
      );
      setReadError("");
    } catch (error: any) {
      setReadError(error?.message ?? String(error));
    }
  }
  useEffect(() => {
    void load();
  }, [
    installation.id,
    installation.revisionId,
    installation.compatibility,
    routeEnabled,
  ]);
  useRuntimeRefresh(load);
  const models = status?.models ?? [];
  // Codex: the chosen model, else the one the runtime reports as default.
  const codexModel =
    models.find((m) => m.model === model) ??
    models.find((m) => m.isDefault) ??
    models[0];
  const efforts = codexModel?.supportedReasoningEfforts ?? [];
  const qualifiedIds = models.map((m) => m.model);
  const chosenSuggestions =
    picked ??
    suggestedClaudeModels
      .map((m) => m.model)
      .filter((m) => !qualifiedIds.includes(m));
  const claudeModels = [
    ...new Set([...chosenSuggestions, ...typedModels(otherModels)]),
  ];
  const recorded = status?.reports.find(
    (r) => r.acceptanceId && Date.parse(r.expiresAt) > Date.now(),
  );
  const last = status?.reports[0];
  const missed =
    status?.state === "current" && recorded
      ? recorded.report.observations
          .filter((o) => !o.passed)
          .map((o) => o.capability)
      : [];
  const blocked =
    claude && !routeEnabled
      ? "route"
      : installation.compatibility !== "compatible"
        ? "connect"
        : !status
          ? "unread"
          : !claude && !models.length
            ? "models"
            : null;
  async function qualify() {
    const chosen = claude ? claudeModels[0] : (codexModel?.model ?? "");
    if (!chosen) return;
    const result = await act({
      type: "runtime-qualify",
      id: installation.id,
      model: chosen,
      ...(claude && claudeModels.length > 1
        ? { additionalModels: claudeModels.slice(1, 9) }
        : {}),
      ...(!claude && effort && efforts.includes(effort) ? { effort } : {}),
    });
    if (result) setSummary(qualificationSummary(result));
    await load();
  }
  return (
    <section
      className="runtime-qualification"
      aria-label={`${name} qualification`}
    >
      <div className="installation-heading">
        <strong>Qualification</strong>
        <Badge
          tone={
            status?.state === "current"
              ? "good"
              : status?.state === "stale"
                ? "warm"
                : ""
          }
        >
          {!status
            ? readError
              ? "Not read"
              : "Reading…"
            : status.running
              ? "Running…"
              : status.state === "current"
                ? "Qualified"
                : status.state === "stale"
                  ? "Needs qualifying again"
                  : "Not qualified"}
        </Badge>
      </div>
      <p className="muted">
        {status?.state === "current"
          ? `Coordinators and teams can use this runtime${
              recorded
                ? `. Last recorded with ${recorded.report.model} until ${new Date(recorded.expiresAt).toLocaleString()}`
                : ""
            }. Next: start work with + New session.`
          : status?.state === "stale"
            ? `The last qualification no longer applies${
                status.staleBecause?.length
                  ? `: ${status.staleBecause.join(", ")}`
                  : ""
              }. Coordinators and teams can use this runtime again after a new one passes.`
            : "Coordinators and teams can use this runtime only after a qualification passes: a few live turns that check its permissions, recorded for 30 days."}
        {claude
          ? models.length > 0
            ? ` Qualified Claude models: ${models.map((m) => m.model).join(", ")}.`
            : ""
          : " One qualification covers every model Codex lists, at every effort."}
      </p>
      {missed.length > 0 && (
        <p className="muted">
          The last run did not pass {missed.join(", ")}. Work that needs{" "}
          {missed.length === 1 ? "it" : "them"} stays unavailable until a run
          passes {missed.length === 1 ? "it" : "them"}; other work can start.
        </p>
      )}
      {readError && (
        <div className="actions wrap" role="alert">
          <p>
            Topsl could not read this runtime's qualification: {readError}
            {status ? " The state shown is the last one read." : ""}
          </p>
          <ActionButton onClick={() => void load()}>
            Read qualification again
          </ActionButton>
        </div>
      )}
      {last && !last.acceptanceId && !summary && (
        <p className="muted">
          The last attempt ({new Date(last.createdAt).toLocaleString()})
          recorded nothing
          {last.report.error ? `: ${last.report.error}` : "."}
        </p>
      )}
      {blocked === "route" ? (
        <div className="actions wrap">
          <p>
            Claude Code's structured route is off. Turn it on to let Topsl run
            Claude Code under your login for coordinators and teams, then
            connect and qualify a model.
          </p>
          <ActionButton
            onClick={() =>
              void act({ type: "claude-structured-route-set", enabled: true })
            }
          >
            Turn on structured route…
          </ActionButton>
        </div>
      ) : blocked === "connect" ? (
        <p>
          Choose Connect / test first; qualifying needs a connected runtime.
        </p>
      ) : blocked === "unread" ? null : blocked === "models" ? (
        <p>
          Codex reported no models. Choose Connect / test to read them again.
        </p>
      ) : (
        <div className="qualification-form">
          {claude ? (
            <fieldset className="qualification-models">
              <legend>Claude models to qualify</legend>
              {suggestedClaudeModels.map((m) => (
                <label key={m.model} className="checkbox">
                  <input
                    type="checkbox"
                    checked={chosenSuggestions.includes(m.model)}
                    onChange={(event) =>
                      setPicked(
                        event.target.checked
                          ? [...chosenSuggestions, m.model]
                          : chosenSuggestions.filter((c) => c !== m.model),
                      )
                    }
                  />
                  {m.name} <code>{m.model}</code>
                  {qualifiedIds.includes(m.model) ? " (qualified)" : ""}
                </label>
              ))}
              <label>
                Other model ids
                <input
                  value={otherModels}
                  placeholder="Optional, separated by commas"
                  onChange={(event) => setOtherModels(event.target.value)}
                />
              </label>
            </fieldset>
          ) : (
            <>
              <label>
                Codex model for the check turns
                <select
                  value={codexModel?.model ?? ""}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setEffort("");
                  }}
                >
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {m.name || m.model}
                      {m.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {efforts.length > 0 && (
                <label>
                  Effort
                  <select
                    value={effort}
                    onChange={(event) => setEffort(event.target.value)}
                  >
                    <option value="">Runtime default</option>
                    {efforts.map((e) => (
                      <option key={e} value={e}>
                        {e}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </>
          )}
          <ActionButton
            className="primary"
            disabled={
              (claude
                ? !claudeModels.length || claudeModels.length > 9
                : !codexModel) || !!status?.running
            }
            title={
              claude
                ? claudeModels.length > 9
                  ? "One run qualifies at most 9 Claude models"
                  : `Runs ${3 + Math.max(claudeModels.length, 1)} live Claude Code turns after you review them`
                : "Runs up to 3 live model turns after you review them"
            }
            onClick={() => void qualify()}
          >
            {!claude
              ? "Qualify Codex runtime"
              : claudeModels.length === 1
                ? "Qualify 1 Claude model"
                : claudeModels.length
                  ? `Qualify ${claudeModels.length} Claude models`
                  : "Qualify Claude models"}
          </ActionButton>
        </div>
      )}
      {summary && <p role="status">{summary}</p>}
    </section>
  );
}
