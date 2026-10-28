import { useEffect, useState, useRef } from "react";
import type { UsageSummary } from "../../../../packages/domain/usage";
import { budgetAlerts } from "../../../../packages/domain/usage";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Freshness } from "./freshness";
export function UsageBudget({
  projectId,
  summary,
  attempts,
}: {
  projectId: string;
  summary: UsageSummary;
  attempts: any[];
}) {
  const [budget, setBudget] = useState<{
      tokens: number | null;
      wallMs: number | null;
    }>({ tokens: null, wallMs: null }),
    [tokens, setTokens] = useState(""),
    [minutes, setMinutes] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [clock, setClock] = useState(Date.now());
  useEffect(() => {
    let live = true;
    void window.topsl
      .command({ type: "usage-budget-query", projectId })
      .then((value) => {
        if (live) {
          setBudget(value);
          setTokens(value.tokens?.toString() ?? "");
          setMinutes(value.wallMs == null ? "" : String(value.wallMs / 60000));
        }
      });
    return () => {
      live = false;
    };
  }, [projectId]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 10000);
    return () => clearInterval(timer);
  }, []);
  const span = attempts.length
    ? Math.max(
        ...attempts.map((attempt) =>
          Date.parse(attempt.finishedAt ?? new Date(clock).toISOString()),
        ),
      ) - Math.min(...attempts.map((attempt) => Date.parse(attempt.createdAt)))
    : 0;
  const alerts = budgetAlerts(summary, span, budget);
  return (
    <details>
      <summary>Usage reporting thresholds</summary>
      <p>
        Approximate alerts only. They do not grant spending authority or
        automatically cancel native work. Missing usage and provider allowances
        remain unknown.
      </p>
      <form
        className="workflow-form"
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          void window.topsl
            .command({
              type: "usage-budget-save",
              projectId,
              tokens: tokens ? Number(tokens) : null,
              wallMs: minutes ? Math.round(Number(minutes) * 60000) : null,
            })
            .then(setBudget)
            .catch((error) => setError(error.message))
            .finally(() => setPending(false));
        }}
      >
        <label>
          Reported token threshold
          <input
            type="number"
            min="1"
            step="1"
            value={tokens}
            onChange={(event) => setTokens(event.target.value)}
            placeholder="No threshold"
          />
        </label>
        <label>
          Observed wall time · minutes
          <input
            type="number"
            min="1"
            step="1"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
            placeholder="No threshold"
          />
        </label>
        <button disabled={pending}>
          {pending ? "Saving…" : "Save reporting thresholds"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {alerts.tokenAlert && (
        <p role="status">
          Known reported tokens reached the configured threshold.
        </p>
      )}
      {alerts.wallAlert && (
        <p role="status">
          Observed project attempt span reached the configured wall time
          threshold.
        </p>
      )}
      <p>
        {attempts.length
          ? `${Math.round(span / 60000)} minutes of observed attempt span (includes waiting).`
          : "Attempt wall time has not been recorded."}{" "}
        {alerts.detail}
      </p>
    </details>
  );
}
export function OptionalCoordination({ projectId }: { projectId: string }) {
  const [advanced, setAdvanced] = useState<any>(null),
    [replication, setReplication] = useState<any>(null),
    [pending, setPending] = useState<Record<string, boolean>>({}),
    [error, setError] = useState("");
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId));
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    setAdvanced(null);
    setReplication(null);
    setError("");
    setPending({});
    return () => {
      generation.current++;
    };
  }, [projectId]);
  async function refresh() {
    const ticket = reads.current.begin();
    const values = await Promise.all([
      window.topsl.command({ type: "advanced-query", projectId }),
      window.topsl.command({ type: "replication-query", projectId }),
    ]);
    if (reads.current.accept(ticket)) {
      setAdvanced(values[0]);
      setReplication(values[1]);
    }
  }
  const freshness = useScopedRefresh(projectId, refresh);
  async function toggle(
    feature: "advanced" | "multi-device",
    enabled: boolean,
  ) {
    const ticket = generation.current;
    setPending((p) => ({ ...p, [feature]: true }));
    setError("");
    try {
      await window.topsl.command({
        type: "optional-feature-set",
        requestId: crypto.randomUUID(),
        feature,
        enabled,
      });
      if (ticket === generation.current) await refresh();
    } catch (error: any) {
      if (ticket === generation.current) setError(error.message);
    } finally {
      if (ticket === generation.current)
        setPending((p) => ({ ...p, [feature]: false }));
    }
  }
  return (
    <section className="optional-coordination">
      <h2>Optional coordination</h2>
      <Freshness state={freshness} retry={freshness.retry} quiet />
      {error && <p role="alert">{error}</p>}
      <details>
        <summary>
          Advanced collaboration ·{" "}
          {advanced?.enabled ? "enabled with capability gates" : "disabled"}
        </summary>
        <p>
          Each selected native route must enforce the template's declared
          independence and verification requirements. Enabling the flag cannot
          weaken those requirements.
        </p>
        <button
          disabled={pending.advanced || !advanced}
          onClick={() => void toggle("advanced", !advanced.enabled)}
        >
          {advanced?.enabled
            ? "Disable advanced templates"
            : "Enable advanced template gate"}
        </button>
        {advanced?.templates.map((template: any) => (
          <article className="workflow-card" key={template.id}>
            <h3>{template.name ?? template.id.replaceAll("-", " ")}</h3>
            <p>
              {template.available
                ? "Required capabilities are advertised; each role is checked at dispatch"
                : "Gated until a selected runtime proves every required capability"}
            </p>
            <p>{template.detail}</p>
            <p>Required controls: {template.gates.join(", ")}</p>
          </article>
        ))}
        <p>
          Measured role presets: {advanced?.presets.length ?? 0}. Accepted-task
          rate, escaped defects, repairs, wall time and usage coverage determine
          routing evidence.
        </p>
      </details>
      <details>
        <summary>
          Portable encrypted metadata ·{" "}
          {replication?.enabled ? "enabled" : "disabled"}
        </summary>
        <p>
          Explicit local import/export transport. Remote native control is
          unsupported. Repository code uses separately approved snapshots; live
          databases, credentials and local trust grants are not replicated.
        </p>
        <button
          disabled={pending["multi-device"] || !replication}
          onClick={() => void toggle("multi-device", !replication.enabled)}
        >
          {replication?.enabled
            ? "Disable portable metadata"
            : "Enable portable metadata gate"}
        </button>
        <p>
          {replication?.devices.length ?? 0} approved peers ·{" "}
          {replication?.records.length ?? 0} portable records ·{" "}
          {replication?.conflicts.length ?? 0} unresolved conflicts
        </p>
        <p>
          Connectivity: {replication?.networkConnectivity ?? "Not observed"}.
          Authoritative owner:{" "}
          {replication?.owner ? "Explicitly designated host" : "Not designated"}
          .
        </p>
        <p>
          Native folder mappings always need local approval. Integration pauses
          when peer connectivity is not verified; exclusive ownership does not
          transfer automatically.
        </p>
        <details>
          <summary>Public device identity</summary>
          <pre>{JSON.stringify(replication?.identity ?? {}, null, 2)}</pre>
        </details>
      </details>
    </section>
  );
}
