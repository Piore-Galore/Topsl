import { useEffect, useState } from "react";
import type {
  AppState,
  Installation,
  Project,
  Provider,
} from "../../../../packages/domain/types";
import {
  ALLOWANCE_STALE_AFTER_MS,
  allowanceWindows,
  budgetPeriods,
  type AllowanceSnapshot,
  type BudgetPeriod,
  type ProviderBudgetStatus,
} from "../../../../packages/domain/allowance";
import {
  allowanceStatus,
  budgetReadout,
  creditsReadout,
  windowReadout,
} from "../state/allowance-view";

const names: Record<Provider, string> = { codex: "Codex", claude: "Claude" };

/** Usage left per provider: what each runtime reported, and the owner's own budgets. */
export function ProviderUsage({ state }: { state: AppState }) {
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="provider-usage" aria-label="Usage remaining">
      <div className="eyebrow">USAGE REMAINING</div>
      <p className="muted tiny">
        Each runtime's own report of its plan limits, with when Topsl observed
        it. Topsl never estimates a provider's allowance from token counts; a
        value a runtime does not report stays unknown. Values older than{" "}
        {ALLOWANCE_STALE_AFTER_MS / 60_000} minutes are marked stale, and none
        of them authorizes or blocks work.
      </p>
      <div className="usage-grid">
        {(["codex", "claude"] as Provider[]).map((provider) => (
          <ProviderCard
            key={provider}
            provider={provider}
            clock={clock}
            projects={state.projects.filter(
              (p) =>
                p.trusted &&
                p.availability !== "missing" &&
                p.availability !== "changed",
            )}
            snapshots={(state.allowances ?? []).filter(
              (snapshot) => snapshot.provider === provider,
            )}
            installations={state.installations.filter((installation) =>
              provider === "codex"
                ? installation.appId === "openai.codex-cli"
                : installation.appId === "anthropic.claude-code-cli",
            )}
            budget={(state.providerBudgets ?? []).find(
              (budget) => budget.provider === provider,
            )}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  clock,
  snapshots,
  installations,
  projects,
  budget,
}: {
  provider: Provider;
  clock: number;
  snapshots: AllowanceSnapshot[];
  installations: Installation[];
  projects: Project[];
  budget: ProviderBudgetStatus | undefined;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [projectId, setProjectId] = useState("");
  const readProject =
    projects.find((project) => project.id === projectId) ?? projects[0];
  const connected = installations.find((installation) =>
    provider === "claude"
      ? installation.trusted && installation.version !== null
      : installation.compatibility === "compatible",
  );
  const status = allowanceStatus(provider, snapshots, clock);
  return (
    <article
      className="usage-card"
      aria-label={`${names[provider]} usage remaining`}
    >
      <div className="card-title">
        <div className={"app-icon " + provider}>
          {provider === "codex" ? "◎" : "✳"}
        </div>
        <div>
          <h2>{names[provider]}</h2>
          <span className="muted tiny">SUBSCRIPTION ALLOWANCE</span>
        </div>
        <span className={"badge " + status.tone}>{status.label}</span>
      </div>
      {!snapshots.length ? (
        <p className="description">
          Remaining: unknown. {names[provider]} has not reported its allowance
          to Topsl yet.
        </p>
      ) : (
        snapshots.map((snapshot) => (
          <AccountAllowance
            key={snapshot.id}
            snapshot={snapshot}
            clock={clock}
            several={snapshots.length > 1}
          />
        ))
      )}
      {provider === "claude" && (
        <>
          <p className="muted tiny">
            Refresh reads Claude Code's <code>/usage</code> display in a trusted
            Topsl project. If sign-in or folder trust is needed, open Claude
            Code there first. Reset labels are shown as Claude reported them.
          </p>
          {readProject ? (
            <label>
              Project for Claude usage
              <select
                aria-label="Project for Claude usage"
                value={readProject.id}
                disabled={pending}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="muted tiny">
              Add and trust a project to read Claude usage.
            </p>
          )}
        </>
      )}
      <div className="actions wrap">
        <button
          disabled={
            !connected || pending || (provider === "claude" && !readProject)
          }
          onClick={() => {
            if (!connected) return;
            setPending(true);
            setError("");
            void window.topsl
              .command({
                type: "provider-allowance-refresh",
                id: connected.id,
                ...(provider === "claude" && readProject
                  ? { projectId: readProject.id }
                  : {}),
              })
              .catch((reason: Error) => setError(reason.message))
              .finally(() => setPending(false));
          }}
        >
          {pending ? "Reading…" : `Refresh from ${names[provider]}`}
        </button>
        {!connected && (
          <span className="muted tiny">
            {provider === "claude"
              ? "Trust a Claude Code runtime below to read its allowance."
              : "Connect a Codex runtime below to read its allowance."}
          </span>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <OwnerBudget provider={provider} budget={budget} />
    </article>
  );
}

function AccountAllowance({
  snapshot,
  clock,
  several,
}: {
  snapshot: AllowanceSnapshot;
  clock: number;
  several: boolean;
}) {
  const buckets = allowanceWindows(snapshot, clock);
  const plan = snapshot.buckets.find((bucket) => bucket.planType)?.planType;
  return (
    <div className="usage-account">
      <p className="tiny muted">
        {several
          ? `Account ${snapshot.accountKey.slice(0, 8)} (identifier hidden)`
          : "Observed account (identifier hidden)"}
        {plan ? ` · plan ${plan}` : ""} · from {snapshot.interface}
        {snapshot.runtimeVersion ? ` ${snapshot.runtimeVersion}` : ""}
      </p>
      {snapshot.ordinaryUsageAllowed === false && (
        <p role="status">
          {names[snapshot.provider]} reports that ordinary included usage is not
          allowed now.
        </p>
      )}
      {!buckets.some((bucket) => bucket.windows.length) && (
        <p>
          Remaining: unknown. {names[snapshot.provider]} reported no usage
          window.
        </p>
      )}
      {buckets.map(({ bucket, windows }) => (
        <div key={bucket.id}>
          {buckets.length > 1 && <strong>{bucket.name ?? bucket.id}</strong>}
          {bucket.limitReached && (
            <p role="status">
              {names[snapshot.provider]} reports{" "}
              {bucket.limitReached.replaceAll("_", " ")}.
            </p>
          )}
          <dl>
            {windows.map((window) => (
              <div key={window.label}>
                <dt>{window.label}</dt>
                <dd>
                  {window.freshness === "reset-since" ? (
                    "Unknown · this window reset after Topsl observed it"
                  ) : (
                    <>
                      <meter
                        min={0}
                        max={100}
                        value={window.remainingPercent}
                        aria-label={`${window.label} left`}
                      />{" "}
                      {windowReadout(window)}
                    </>
                  )}
                  <br />
                  <small
                    title={`resetsAt ${window.resetsAtSeconds ?? "not reported"} (Unix seconds)`}
                  >
                    {window.resetsAt
                      ? `Resets ${new Date(window.resetsAt).toLocaleString()}`
                      : (window.resetDescription ??
                        "Reset time not reported")}{" "}
                    · observed {new Date(window.observedAt).toLocaleString()}
                    {window.source === "update" ? " (rolling update)" : ""}
                    {window.freshness === "stale" ? " · stale" : ""}
                  </small>
                </dd>
              </div>
            ))}
            {bucket.credits && (
              <div>
                <dt>Credits</dt>
                <dd>{creditsReadout(bucket.credits)}</dd>
              </div>
            )}
          </dl>
        </div>
      ))}
      {snapshot.lastError && (
        <p role="alert">
          The last read failed at{" "}
          {new Date(snapshot.lastError.at).toLocaleString()}:{" "}
          {snapshot.lastError.detail}
          {snapshot.buckets.length ? " Older values are shown." : ""}
        </p>
      )}
    </div>
  );
}

function OwnerBudget({
  provider,
  budget,
}: {
  provider: Provider;
  budget: ProviderBudgetStatus | undefined;
}) {
  const [tokens, setTokens] = useState(budget?.tokens.toString() ?? ""),
    [period, setPeriod] = useState<BudgetPeriod>(budget?.period ?? "week"),
    [pending, setPending] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setTokens(budget?.tokens.toString() ?? "");
    setPeriod(budget?.period ?? "week");
  }, [budget?.tokens, budget?.period]);
  const save = (value: number | null) => {
    setPending(true);
    setError("");
    void window.topsl
      .command({
        type: "provider-budget-save",
        provider,
        tokens: value,
        period,
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setPending(false));
  };
  return (
    <>
      <p role="status" aria-label={`${names[provider]} owner-set budget`}>
        {budget ? budgetReadout(budget) : "No owner-set budget."}
      </p>
      <details>
        <summary>
          {budget ? "Change" : "Set"} your own budget for {names[provider]}
        </summary>
        <p className="muted tiny">
          Owner-set, not a provider limit. It counts the known input and output
          tokens of work Topsl ran or opened this period; native sessions
          started outside Topsl are not counted
          {provider === "claude"
            ? ", and Claude Code terminal sessions report no usage to Topsl"
            : ""}
          .
        </p>
        <form
          className="workflow-form"
          onSubmit={(event) => {
            event.preventDefault();
            save(Number(tokens));
          }}
        >
          <label>
            Tokens per period
            <input
              type="number"
              min="1"
              step="1"
              required
              value={tokens}
              onChange={(event) => setTokens(event.target.value)}
              placeholder="No budget"
            />
          </label>
          <label>
            Period
            <select
              value={period}
              onChange={(event) =>
                setPeriod(event.target.value as BudgetPeriod)
              }
            >
              {budgetPeriods.map((value) => (
                <option key={value} value={value}>
                  {value === "day"
                    ? "Each day"
                    : value === "week"
                      ? "Each week (from Monday)"
                      : "Each month"}
                </option>
              ))}
            </select>
          </label>
          <div className="actions wrap">
            <button disabled={pending || !tokens}>
              {pending ? "Saving…" : "Save budget"}
            </button>
            {budget && (
              <button
                type="button"
                disabled={pending}
                onClick={() => save(null)}
              >
                Remove budget
              </button>
            )}
          </div>
        </form>
        {error && <p role="alert">{error}</p>}
      </details>
    </>
  );
}
