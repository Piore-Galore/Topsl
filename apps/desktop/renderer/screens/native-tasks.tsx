import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState } from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import type {
  JournalEvent,
  NativeAttemptView,
} from "../../../../packages/harness/types";
import { ActionButton } from "../components/action-button";
import { Badge } from "../components/atlas";

type Act = (command: Command) => Promise<any>;

interface NativeState {
  proxyRunning: boolean;
  attempts: NativeAttemptView[];
  memories: Array<{ id: string; text: string; state: string }>;
  mcpServers: Array<{
    id: string;
    name: string;
    argv: string[];
    networkDomains: string[];
    admittedTools: Record<string, string>;
  }>;
  hooks: Array<{ id: string; event: string; argv: string[] }>;
  resources: {
    quotaWaits: Array<{ owner: string; since: string; detail: string }>;
  };
  containment: {
    available: boolean;
    reason: string | null;
    runtimeVersion: string;
  };
}

const stateText: Record<NativeAttemptView["state"], string> = {
  starting: "Starting",
  running: "Running",
  "waiting-model": "Waiting for the model",
  "running-tools": "Running tools",
  "waiting-children": "Waiting for child agents",
  "waiting-quota": "Waiting for allowance",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  uncertain: "Needs reconciliation",
};
const finished = new Set(["completed", "failed", "cancelled"]);
const fundingWords = {
  subscription: "plan allowance",
  "api-billing": "API billing",
  gateway: "gateway billing",
  local: "local model",
} as const;

/** Splits a command line on spaces, keeping quoted parts together. */
function argvOf(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((part) =>
    part.replace(/^(["'])(.*)\1$/, "$2"),
  );
}

/**
 * Native tasks (docs/Native_Harness_Plan.md §3): Topsl's own agent loop on a
 * private copy of the project, through a connection route. Changes come back
 * as a candidate; applying them to the folder is a separate, confirmed step.
 */
export function NativeTasks({
  projectId,
  state,
  act,
}: {
  projectId: string;
  state: AppState;
  act: Act;
}) {
  const [native, setNative] = useState<NativeState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [provisional, setProvisional] = useState<Record<string, string | null>>(
    {},
  );
  const refresh = useCallback(async () => {
    const value = await act({ type: "native-state", projectId });
    if (value) setNative(value);
  }, [act, projectId]);
  useEffect(() => {
    void refresh();
    return window.topsl.subscribe((event) => {
      if (
        event.type === "native" &&
        event.data.attempts.some(
          (a: NativeAttemptView) => a.projectId === projectId,
        )
      )
        void refresh();
      if (event.type === "native-provisional")
        setProvisional((current) => ({ ...current, ...event.data.outputs }));
    });
  }, [projectId, refresh]);
  const routes = (state.proxy?.routes ?? []).filter((r) => !r.disabled);
  const current =
    native?.attempts.find((a) => a.attemptId === selected) ?? null;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Native tasks</h1>
          <p className="muted">
            Topsl's own agent works on a private copy of this project through a
            connection you choose. Nothing reaches your folder until you review
            and apply it.
          </p>
        </div>
      </div>
      {native && !native.containment.available && (
        <div className="info-strip">
          <span className="status-dot notice" />
          <div>
            <strong>Commands are unavailable:</strong>{" "}
            <span>{native.containment.reason}</span>
          </div>
        </div>
      )}
      {native?.resources.quotaWaits.map((wait) => (
        <div className="info-strip" key={wait.owner}>
          <span className="status-dot notice" />
          <div>
            <strong>Waiting for allowance.</strong> <span>{wait.detail}</span>{" "}
            <ActionButton
              onClick={() =>
                void act({
                  type: "native-quota-resume",
                  owner: wait.owner,
                }).then(refresh)
              }
            >
              Try the allowance again
            </ActionButton>
          </div>
        </div>
      ))}
      <StartForm
        projectId={projectId}
        routes={routes}
        native={native}
        act={act}
        onStarted={(id) => {
          setSelected(id);
          void refresh();
        }}
      />
      <section aria-label="Native task list">
        <h2>Tasks</h2>
        {!native?.attempts.length ? (
          <p className="muted">No native tasks yet.</p>
        ) : (
          <ul className="thread-list">
            {native.attempts.map((a) => (
              <li key={a.attemptId}>
                <ActionButton
                  className={`nav ${a.attemptId === selected ? "selected" : ""}`}
                  onClick={() => setSelected(a.attemptId)}
                >
                  <span>{a.title}</span>{" "}
                  <Badge
                    tone={
                      a.state === "completed"
                        ? "good"
                        : a.state === "failed" || a.state === "uncertain"
                          ? "warm"
                          : ""
                    }
                  >
                    {stateText[a.state]}
                  </Badge>
                  <span className="muted tiny">
                    {" "}
                    {a.binding.native?.routeAlias} · {a.requests} request
                    {a.requests === 1 ? "" : "s"}
                  </span>
                </ActionButton>
              </li>
            ))}
          </ul>
        )}
      </section>
      {current && (
        <AttemptDetail
          key={current.attemptId}
          view={current}
          provisional={provisional[current.attemptId] ?? null}
          act={act}
          refresh={refresh}
        />
      )}
      {native && (
        <Extensions
          projectId={projectId}
          native={native}
          act={act}
          refresh={refresh}
        />
      )}
    </>
  );
}

function StartForm({
  projectId,
  routes,
  native,
  act,
  onStarted,
}: {
  projectId: string;
  routes: NonNullable<AppState["proxy"]>["routes"];
  native: NativeState | null;
  act: Act;
  onStarted: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [route, setRoute] = useState("");
  const [mode, setMode] = useState<"investigate" | "edit">("investigate");
  const [processes, setProcesses] = useState(false);
  const [network, setNetwork] = useState("");
  const [checks, setChecks] = useState("");
  const [delegation, setDelegation] = useState(false);
  const [servers, setServers] = useState<string[]>([]);
  const [maxRequests, setMaxRequests] = useState(50);
  const alias = route || routes[0]?.alias || "";
  return (
    <section className="application-card" aria-label="Start a native task">
      <h2>Start a native task</h2>
      {!routes.length ? (
        <p className="muted">
          Add a connection and a route under Connections first.
        </p>
      ) : (
        <>
          <label>
            Route{" "}
            <select
              aria-label="Route"
              value={alias}
              onChange={(e) => setRoute(e.target.value)}
            >
              {routes.map((r) => (
                <option key={r.id} value={r.alias}>
                  {r.alias} ({r.upstreamModel})
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Mode{" "}
            <select
              aria-label="Mode"
              value={mode}
              onChange={(e) =>
                setMode(e.target.value as "investigate" | "edit")
              }
            >
              <option value="investigate">Investigate (read-only)</option>
              <option value="edit">Edit a private copy</option>
            </select>
          </label>
          <textarea
            aria-label="Task"
            rows={4}
            placeholder="What should the native agent do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
          <div className="actions wrap">
            <label>
              <input
                type="checkbox"
                checked={processes}
                disabled={!native?.containment.available}
                onChange={(e) => setProcesses(e.target.checked)}
              />{" "}
              Allow commands in Topsl's sandbox
            </label>
            {processes && (
              <input
                aria-label="Network destinations"
                placeholder="Network: none (e.g. registry.npmjs.org)"
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
              />
            )}
            <label>
              <input
                type="checkbox"
                checked={delegation}
                onChange={(e) => setDelegation(e.target.checked)}
              />{" "}
              Allow child agents
            </label>
            <label>
              Model requests{" "}
              <input
                aria-label="Model requests"
                type="number"
                min={1}
                max={500}
                value={maxRequests}
                onChange={(e) => setMaxRequests(Number(e.target.value) || 50)}
              />
            </label>
          </div>
          {processes && (
            <>
              <textarea
                aria-label="Checks"
                rows={2}
                placeholder={
                  "Checks required before applying, one per line as name: command — e.g. test: npm test"
                }
                value={checks}
                onChange={(e) => setChecks(e.target.value)}
              />
              <p className="muted">
                Each listed check must pass after the final edit before you can
                apply the candidate.
              </p>
            </>
          )}
          {!!native?.mcpServers.length && (
            <div className="actions wrap">
              {native.mcpServers.map((s) => (
                <label key={s.id}>
                  <input
                    type="checkbox"
                    checked={servers.includes(s.id)}
                    onChange={(e) =>
                      setServers((list) =>
                        e.target.checked
                          ? [...list, s.id]
                          : list.filter((x) => x !== s.id),
                      )
                    }
                  />{" "}
                  MCP {s.name}
                </label>
              ))}
            </div>
          )}
          <ActionButton
            className="primary"
            disabled={!prompt.trim() || !alias}
            onClick={async () => {
              const parsedChecks = checks
                .split("\n")
                .map((line) => /^([^:]+):\s*(.+)$/.exec(line.trim()))
                .filter((m): m is RegExpExecArray => !!m)
                .map((m) => ({
                  name: m[1].trim(),
                  argv: ["/bin/sh", "-c", m[2]],
                  timeoutMs: 600_000,
                }));
              const view = await act({
                type: "native-start",
                projectId,
                prompt,
                routeAlias: alias,
                mode,
                processes,
                networkDomains: processes
                  ? network.split(/[\s,]+/).filter(Boolean)
                  : [],
                checks: processes ? parsedChecks : [],
                delegation,
                mcpServerIds: servers,
                reasoningEffort: null,
                contextWindowTokens: null,
                maxRequests,
              });
              if (view?.attemptId) {
                setPrompt("");
                onStarted(view.attemptId);
              }
            }}
          >
            Start task
          </ActionButton>
        </>
      )}
    </section>
  );
}

function describe(event: JournalEvent): string | null {
  const body = event.body as any;
  switch (event.kind) {
    case "input-claimed":
      return body.texts
        .map((t: string) =>
          t.startsWith("Steering from the owner:") ? t : `Task: ${t}`,
        )
        .join("\n");
    case "response-settled": {
      if (body.error)
        return `Model request ${body.requestNumber} failed: ${body.error.code ?? body.error.kind} — ${body.error.message}`;
      const parts: string[] = [];
      for (const p of body.output) {
        if (p.type === "text" && p.text.trim()) parts.push(p.text);
        if (p.type === "tool-call")
          parts.push(`→ ${p.name} ${p.arguments.slice(0, 200)}`);
      }
      return parts.join("\n") || null;
    }
    case "tool-result":
      return `${body.ok ? "✓" : "✗"} ${body.output.slice(0, 600)}${body.output.length > 600 ? "…" : ""}`;
    case "tool-uncertain":
      return `? ${body.reason}`;
    case "compaction":
      return `History compacted through event ${body.throughSequence}; the owner's messages were kept verbatim.`;
    case "paused":
      return `Paused: ${body.reason}`;
    case "resumed":
      return "Resumed.";
    case "child-started":
      return `Child agent started (${body.mode}): ${body.task.slice(0, 200)}`;
    case "child-finished":
      return `Child agent ${body.state}: ${body.summary.slice(0, 300)}`;
    case "submitted":
      return body.candidateId ? "Submitted a candidate for review." : null;
    case "finished":
      return `${body.state === "completed" ? "Finished" : body.state === "cancelled" ? "Stopped" : "Failed"}: ${body.detail}`;
    default:
      return null;
  }
}

function AttemptDetail({
  view,
  provisional,
  act,
  refresh,
}: {
  view: NativeAttemptView;
  provisional: string | null;
  act: Act;
  refresh: () => Promise<void>;
}) {
  const [events, setEvents] = useState<JournalEvent[]>([]);
  const [steer, setSteer] = useState("");
  const [preview, setPreview] = useState<{
    files: Array<{ path: string; change: string }>;
    problems: string[];
  } | null>(null);
  const through = events.at(-1)?.sequence ?? 0;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let after = through;
      while (!cancelled) {
        const result = await act({
          type: "native-events",
          attemptId: view.attemptId,
          after,
          limit: 200,
        });
        if (!result?.page?.events?.length) break;
        const page = result.page.events as JournalEvent[];
        setEvents((current) => [
          ...current,
          ...page.filter((e) => e.sequence > (current.at(-1)?.sequence ?? 0)),
        ]);
        after = result.page.throughSequence;
        if (!result.page.hasMore) break;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view.throughSequence]);
  const uncertain = useMemo(
    () =>
      events
        .filter((e) => e.kind === "tool-uncertain")
        .map((e) => (e.body as any).callId as string),
    [events],
  );
  const native = view.binding.native;
  return (
    <section
      className="application-card"
      aria-label={`Native task ${view.title}`}
    >
      <div className="card-title">
        <div>
          <h2>{view.title}</h2>
          <span className="muted tiny">
            {native?.routeAlias} → {native?.upstreamModel} ·{" "}
            {native?.connectionLabel} ·{" "}
            {native ? fundingWords[native.funding] : ""} ·{" "}
            {view.writable ? "edits a private copy" : "read-only"}
          </span>
        </div>
        <Badge tone={view.state === "completed" ? "good" : ""}>
          {stateText[view.state]}
        </Badge>
      </div>
      <p className="muted tiny">
        {view.requests} model request{view.requests === 1 ? "" : "s"} ·{" "}
        {view.toolCalls} tool call{view.toolCalls === 1 ? "" : "s"} ·{" "}
        {view.usage.input === null
          ? "usage not reported"
          : `${view.usage.input} in / ${view.usage.output ?? 0} out tokens${view.usage.unknownRequests ? ` (${view.usage.unknownRequests} request(s) reported nothing)` : ""}`}
        {view.compactions ? ` · compacted ${view.compactions}×` : ""}
      </p>
      {view.stateDetail && <p>{view.stateDetail}</p>}
      <ol className="transcript" aria-label="Journal">
        {events.map((event) => {
          const text = describe(event);
          return text ? (
            <li key={event.sequence} className={`journal-${event.kind}`}>
              <pre>{text}</pre>
            </li>
          ) : null;
        })}
        {provisional && (
          <li className="provisional" aria-live="polite">
            <pre>{provisional}</pre>
            <span className="muted tiny">Streaming; not yet settled.</span>
          </li>
        )}
      </ol>
      {!finished.has(view.state) && (
        <div className="actions wrap">
          <input
            aria-label="Steer the task"
            placeholder="Steer the task…"
            value={steer}
            onChange={(e) => setSteer(e.target.value)}
          />
          <ActionButton
            disabled={!steer.trim()}
            onClick={async () => {
              await act({
                type: "native-steer",
                attemptId: view.attemptId,
                text: steer,
              });
              setSteer("");
            }}
          >
            Send steering
          </ActionButton>
          {["paused", "waiting-quota"].includes(view.state) ? (
            <ActionButton
              className="primary"
              onClick={() =>
                void act({
                  type: "native-resume",
                  attemptId: view.attemptId,
                }).then(refresh)
              }
            >
              Resume
            </ActionButton>
          ) : view.state !== "uncertain" ? (
            <ActionButton
              onClick={() =>
                void act({ type: "native-pause", attemptId: view.attemptId })
              }
            >
              Pause
            </ActionButton>
          ) : null}
          <ActionButton
            onClick={() =>
              void act({
                type: "native-cancel",
                attemptId: view.attemptId,
              }).then(refresh)
            }
          >
            Stop
          </ActionButton>
        </div>
      )}
      {view.state === "uncertain" &&
        uncertain.map((callId) => (
          <div className="actions wrap" key={callId}>
            <span>Did call {callId} take effect?</span>
            <ActionButton
              onClick={() =>
                void act({
                  type: "native-reconcile",
                  attemptId: view.attemptId,
                  callId,
                  outcome: "applied",
                  note: "",
                }).then(refresh)
              }
            >
              It did
            </ActionButton>
            <ActionButton
              onClick={() =>
                void act({
                  type: "native-reconcile",
                  attemptId: view.attemptId,
                  callId,
                  outcome: "not-applied",
                  note: "",
                }).then(refresh)
              }
            >
              It did not
            </ActionButton>
          </div>
        ))}
      {view.summary && (
        <>
          <h3>Answer</h3>
          <pre className="answer">{view.summary}</pre>
        </>
      )}
      {view.candidateId && view.state === "completed" && (
        <div className="actions wrap">
          <ActionButton
            onClick={async () =>
              setPreview(
                await act({
                  type: "native-apply-preview",
                  attemptId: view.attemptId,
                }),
              )
            }
          >
            Review changes
          </ActionButton>
          {preview && !preview.problems.length && (
            <ActionButton
              className="primary"
              onClick={() =>
                void act({
                  type: "native-apply",
                  attemptId: view.attemptId,
                }).then(() => setPreview(null))
              }
            >
              Apply to project folder
            </ActionButton>
          )}
          <ActionButton
            onClick={() =>
              void act({ type: "native-discard", attemptId: view.attemptId })
            }
          >
            Remove private copy
          </ActionButton>
        </div>
      )}
      {preview && (
        <div>
          {preview.problems.map((p) => (
            <p key={p} role="alert">
              {p}
            </p>
          ))}
          <ul>
            {preview.files.map((f) => (
              <li key={f.path}>
                {f.change} <code>{f.path}</code>
              </li>
            ))}
            {!preview.files.length && <li className="muted">No changes.</li>}
          </ul>
        </div>
      )}
      {!!view.children.length && (
        <p className="muted tiny">Child agents: {view.children.length}</p>
      )}
    </section>
  );
}

function Extensions({
  projectId,
  native,
  act,
  refresh,
}: {
  projectId: string;
  native: NativeState;
  act: Act;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [line, setLine] = useState("");
  const [network, setNetwork] = useState("");
  const [inspected, setInspected] = useState<Array<{
    name: string;
    description: string;
    schemaHash: string;
  }> | null>(null);
  const [hookLine, setHookLine] = useState("");
  const [hookEvent, setHookEvent] = useState<"before-tool" | "after-tool">(
    "before-tool",
  );
  const proposed = native.memories.filter((m) => m.state === "proposed");
  return (
    <section className="application-card" aria-label="Native extensions">
      <h2>Notes, MCP servers and hooks</h2>
      {proposed.length > 0 && (
        <>
          <h3>Proposed notes</h3>
          {proposed.map((m) => (
            <div className="actions wrap" key={m.id}>
              <span>{m.text}</span>
              <ActionButton
                onClick={() =>
                  void act({
                    type: "native-memory-decide",
                    id: m.id,
                    accept: true,
                  }).then(refresh)
                }
              >
                Accept
              </ActionButton>
              <ActionButton
                onClick={() =>
                  void act({
                    type: "native-memory-decide",
                    id: m.id,
                    accept: false,
                  }).then(refresh)
                }
              >
                Decline
              </ActionButton>
            </div>
          ))}
        </>
      )}
      <p className="muted tiny">
        Accepted notes:{" "}
        {native.memories.filter((m) => m.state === "accepted").length}. Only
        accepted notes reach later tasks.
      </p>
      <h3>MCP servers</h3>
      <ul>
        {native.mcpServers.map((s) => (
          <li key={s.id}>
            <code>{s.name}</code> {s.argv.join(" ")} ·{" "}
            {Object.keys(s.admittedTools).length} tool(s) · network{" "}
            {s.networkDomains.join(", ") || "off"}{" "}
            <ActionButton
              onClick={() =>
                void act({ type: "native-mcp-remove", id: s.id }).then(refresh)
              }
            >
              Remove
            </ActionButton>
          </li>
        ))}
      </ul>
      <div className="actions wrap">
        <input
          aria-label="MCP server name"
          placeholder="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="MCP server command"
          placeholder="command and arguments"
          value={line}
          onChange={(e) => setLine(e.target.value)}
        />
        <input
          aria-label="MCP server network"
          placeholder="network: none"
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
        />
        <ActionButton
          disabled={!name.trim() || !line.trim()}
          onClick={async () => {
            const result = await act({
              type: "native-mcp-inspect",
              projectId,
              name: name.trim(),
              argv: argvOf(line),
              networkDomains: network.split(/[\s,]+/).filter(Boolean),
            });
            if (result?.tools) setInspected(result.tools);
          }}
        >
          Start and list tools
        </ActionButton>
        {inspected && (
          <ActionButton
            className="primary"
            onClick={async () => {
              const saved = await act({
                type: "native-mcp-admit",
                projectId,
                name: name.trim(),
                argv: argvOf(line),
                networkDomains: network.split(/[\s,]+/).filter(Boolean),
                tools: Object.fromEntries(
                  inspected.map((t) => [t.name, t.schemaHash]),
                ),
              });
              if (saved) {
                setInspected(null);
                setName("");
                setLine("");
                void refresh();
              }
            }}
          >
            Admit {inspected.length} tool(s)
          </ActionButton>
        )}
      </div>
      {inspected && (
        <ul className="tiny">
          {inspected.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code> {t.description}
            </li>
          ))}
        </ul>
      )}
      <h3>Hooks</h3>
      <ul>
        {native.hooks.map((h) => (
          <li key={h.id}>
            {h.event}: <code>{h.argv.join(" ")}</code>{" "}
            <ActionButton
              onClick={() =>
                void act({ type: "native-hook-remove", id: h.id }).then(refresh)
              }
            >
              Remove
            </ActionButton>
          </li>
        ))}
      </ul>
      <div className="actions wrap">
        <select
          aria-label="Hook event"
          value={hookEvent}
          onChange={(e) =>
            setHookEvent(e.target.value as "before-tool" | "after-tool")
          }
        >
          <option value="before-tool">
            Before each tool call (exit 2 refuses it)
          </option>
          <option value="after-tool">After each tool call</option>
        </select>
        <input
          aria-label="Hook command"
          placeholder="command and arguments"
          value={hookLine}
          onChange={(e) => setHookLine(e.target.value)}
        />
        <ActionButton
          disabled={!hookLine.trim()}
          onClick={async () => {
            if (
              await act({
                type: "native-hook-admit",
                projectId,
                event: hookEvent,
                argv: argvOf(hookLine),
                timeoutMs: 10_000,
              })
            ) {
              setHookLine("");
              void refresh();
            }
          }}
        >
          Admit hook
        </ActionButton>
      </div>
    </section>
  );
}
