import { useEffect, useRef, useState, type ReactNode } from "react";
import { type ProjectView } from "../../../packages/domain/navigation";
export type { ProjectView } from "../../../packages/domain/navigation";
import { AtlasIcon } from "./components/atlas";
import { ProjectOverview } from "./screens/project-overview";
import { ParallelActivity } from "./components/parallel-activity";
import { CoordinatorTeams } from "./components/coordinator-teams";
import { OptionalCoordination, UsageBudget } from "./components/reporting";
import { Workflows } from "./workflows";
import { ScopedReadFence, useScopedRefresh } from "./state/scoped";
import { Freshness } from "./components/freshness";
import { usageReadout } from "./state/usage-view";
import { SynchronizationSummary } from "./components/synchronization-summary";
import type { Task } from "../../../packages/domain/workflow";
import type { Command } from "../../../packages/domain/commands";
import { summarizeUsage, budgetAlerts } from "../../../packages/domain/usage";
const label = (value: string) =>
  value.replaceAll("-", " ").replace(/^./, (c) => c.toUpperCase());
function Identity({ name, value }: { name: string; value?: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <p className="identity-row">
      <span>
        {name}: {value ?? "Unknown"}
      </span>
      {value && (
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(value)
              .then(() => setCopied(true))
              .catch(() => setCopied(false))
          }
        >
          {copied ? "Copied" : `Copy ${name.toLowerCase()}`}
        </button>
      )}
    </p>
  );
}
export function Coordination({
  projectId,
  view = "overview",
  onView,
  projectName,
  projectPath,
  sessionsContent,
  historyContent,
}: {
  projectId: string;
  view?: ProjectView;
  onView?: (view: ProjectView) => void;
  projectName?: string;
  projectPath?: string;
  sessionsContent?: ReactNode;
  historyContent?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<any>(null),
    [sync, setSync] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [inspection, setInspection] = useState<any>(null),
    [pending, setPending] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [drawer, setDrawer] = useState(false);
  const [historyProvider, setHistoryProvider] = useState<"codex" | "claude">(
      "codex",
    ),
    [profile, setProfile] = useState(""),
    [nativeSession, setNativeSession] = useState("");
  const [revisionKind, setRevisionKind] = useState<
      "decision" | "interface" | "specification"
    >("decision"),
    [revisionTitle, setRevisionTitle] = useState(""),
    [revisionContent, setRevisionContent] = useState("");
  const [workspaceWorkflow, setWorkspaceWorkflow] = useState(""),
    [workspaceSource, setWorkspaceSource] = useState(""),
    [workspaceKind, setWorkspaceKind] = useState<"snapshot" | "worktree">(
      "snapshot",
    ),
    [workspacePaths, setWorkspacePaths] = useState("");
  const generation = useRef(0),
    reads = useRef(new ScopedReadFence(projectId)),
    inspectionReads = useRef(new ScopedReadFence(projectId)),
    selectedTask = useRef(""),
    inspectionGeneration = useRef(0),
    pendingInspections = useRef(new Map<string, number>()),
    taskTrigger = useRef<HTMLButtonElement | null>(null),
    dialog = useRef<HTMLDialogElement>(null);
  async function readInspection(taskId: string, background = false) {
    const scopeTicket = generation.current,
      ticket = ++inspectionGeneration.current,
      readTicket = inspectionReads.current.begin(),
      key = `inspect:${taskId}`;
    if (!background) {
      pendingInspections.current.set(key, ticket);
      setPending((current) => ({ ...current, [key]: true }));
    }
    try {
      const value = await window.topsl.command({
        type: "task-inspect",
        projectId,
        id: taskId,
      });
      if (
        scopeTicket === generation.current &&
        ticket === inspectionGeneration.current &&
        selectedTask.current === taskId &&
        inspectionReads.current.accept(readTicket, value)
      )
        setInspection(value);
    } catch (error: any) {
      if (
        scopeTicket === generation.current &&
        ticket === inspectionGeneration.current &&
        selectedTask.current === taskId
      )
        setErrors((current) => ({ ...current, [key]: error.message }));
    } finally {
      if (
        scopeTicket === generation.current &&
        pendingInspections.current.get(key) === ticket
      ) {
        pendingInspections.current.delete(key);
        setPending((current) => ({ ...current, [key]: false }));
      }
    }
  }
  async function refresh(acceptedSnapshot?: any) {
    if (!projectId) return;
    const ticket = reads.current.begin();
    const next =
      acceptedSnapshot ??
      (await window.topsl.command({ type: "scope-snapshot", projectId }));
    if (reads.current.accept(ticket, next)) {
      setSnapshot(next);
      setSync(next.synchronization);
      if (
        selectedTask.current &&
        next.coordination.tasks.some(
          (task: Task) => task.id === selectedTask.current,
        )
      )
        await readInspection(selectedTask.current, true);
    }
  }
  useEffect(() => {
    generation.current++;
    reads.current.reset(projectId);
    inspectionReads.current.reset(projectId);
    inspectionGeneration.current++;
    pendingInspections.current.clear();
    selectedTask.current = "";
    setSnapshot(null);
    setSync(null);
    setSelected("");
    setInspection(null);
    setDrawer(false);
    setErrors({});
    setPending({});
    setProfile("");
    setNativeSession("");
    setRevisionTitle("");
    setRevisionContent("");
    setWorkspaceWorkflow("");
    setWorkspaceSource("");
    setWorkspacePaths("");
    return () => {
      generation.current++;
    };
  }, [projectId]);
  const freshness = useScopedRefresh(projectId, refresh);
  async function run(key: string, command: Command) {
    if (pending[key]) return;
    const ticket = generation.current;
    setPending((p) => ({ ...p, [key]: true }));
    setErrors((p) => ({ ...p, [key]: "" }));
    try {
      const result = await window.topsl.command(command);
      if (ticket !== generation.current) return undefined;
      await refresh();
      return result;
    } catch (error: any) {
      if (ticket === generation.current)
        setErrors((p) => ({ ...p, [key]: error.message }));
    } finally {
      if (ticket === generation.current)
        setPending((p) => ({ ...p, [key]: false }));
    }
  }
  async function inspect(task: Task) {
    selectedTask.current = task.id;
    setSelected(task.id);
    setInspection(null);
    setDrawer(window.matchMedia("(max-width:1199px)").matches);
    await readInspection(task.id);
  }
  useEffect(() => {
    if (drawer && window.matchMedia("(max-width:1199px)").matches)
      dialog.current?.showModal();
  }, [drawer]);
  const coordination = snapshot?.coordination,
    task: Task | undefined = coordination?.tasks.find(
      (t: Task) => t.id === selected,
    ),
    validInspection =
      task && inspection?.task?.id === task.id ? inspection : null,
    attempts = validInspection?.attempts ?? [],
    workspace =
      validInspection?.workspace ??
      coordination?.workspaces.find(
        (workspace: any) => workspace.id === task?.workspaceId,
      );
  const usage = summarizeUsage(
    snapshot?.usage ?? [],
    (snapshot?.runs ?? []).map((run: any) => run.id),
  );
  const alert = budgetAlerts(usage, 0, {});
  const inspector = (
    <>
      <h2>{task?.title ?? "Task inspector"}</h2>
      {!task ? (
        <p>
          Select a task to see responsibility, inputs, blockers and acceptance.
        </p>
      ) : (
        <>
          {inspection?.task?.id !== task.id && (
            <p role="status">Loading recorded task evidence…</p>
          )}
          <dl>
            <dt>Responsible agent</dt>
            <dd>{label(task.role)}</dd>
            <dt>Stage</dt>
            <dd>{label(task.state)}</dd>
            <dt>Next action</dt>
            <dd>
              {task.detail ||
                (task.state === "accepted"
                  ? "Accepted against recorded evidence."
                  : task.state === "ready"
                    ? "Dispatch with an explicitly selected runtime."
                    : "Inspect evidence and resolve the recorded blocker.")}
            </dd>
            <dt>Acceptance</dt>
            <dd>
              {task.state === "accepted"
                ? "Accepted"
                : "Pending recorded review and checks"}
            </dd>
            <dt>Workspace</dt>
            <dd className="path">{workspace?.canonicalRoot ?? "Unknown"}</dd>
            <dt>Writer</dt>
            <dd>
              {inspection?.leases?.find((l: any) => l.state !== "released")
                ?.state ?? "No active writer lease"}
            </dd>
            <dt>Dependency inputs</dt>
            <dd>
              {inspection?.inputStatus?.stale?.length
                ? `${inspection.inputStatus.stale.filter((item: any) => item.blocking).length} blocking and ${inspection.inputStatus.stale.filter((item: any) => !item.blocking).length} advisory input changes available`
                : inspection?.inputStatus?.binding
                  ? "Pinned input references are current"
                  : "Context binding was not recorded"}
            </dd>
          </dl>
          {task.dependencies.length > 0 && (
            <p>
              Depends on:{" "}
              {task.dependencies
                .map(
                  (id) =>
                    coordination.tasks.find((t: Task) => t.id === id)?.title ??
                    "Unavailable dependency",
                )
                .join(", ")}
            </p>
          )}
          <h3>Acceptance criteria</h3>
          {task.acceptanceCriteria.length ? (
            <ul>
              {task.acceptanceCriteria.map((criterion, i) => (
                <li key={i}>{criterion}</li>
              ))}
            </ul>
          ) : (
            <p>Criteria were not captured for this historical task.</p>
          )}
          {attempts.map((attempt: any) => {
            const session = inspection.sessions?.find(
                (s: any) => s.id === attempt.sessionId,
              ),
              run = snapshot.runs?.find(
                (run: any) => run.id === attempt.legacyRunId,
              ),
              reported = summarizeUsage(
                snapshot.usage ?? [],
                attempt.legacyRunId ? [attempt.legacyRunId] : [],
              ),
              metadata = inspection.runtimeMetadata?.find(
                (item: any) =>
                  item.attemptId === attempt.id || item.id === attempt.id,
              ),
              resultMetadata = inspection.runtimeResultMetadata?.find(
                (item: any) =>
                  item.attemptId === attempt.id || item.id === attempt.id,
              );
            return (
              <article key={attempt.id} className="coordination-attempt">
                <h3>
                  {label(attempt.provider)} · {label(attempt.state)}
                </h3>
                <dl>
                  <dt>Requested model</dt>
                  <dd>{attempt.requestedModel ?? "Native controlled"}</dd>
                  <dt>Effective model</dt>
                  <dd>
                    {resultMetadata?.reported.model ??
                      metadata?.reported.model ??
                      attempt.reportedModel ??
                      "Unknown; not reported"}
                  </dd>
                  <dt>Requested effort</dt>
                  <dd>
                    {metadata?.requested.effort ??
                      "Runtime default requested; exact effort unknown"}
                  </dd>
                  <dt>Effective effort</dt>
                  <dd>
                    {resultMetadata?.reported.effort ??
                      metadata?.reported.effort ??
                      "Unknown; not reported"}
                  </dd>
                  <dt>Settings source</dt>
                  <dd>
                    {resultMetadata?.source ??
                      metadata?.source ??
                      "No runtime settings observation"}{" "}
                    ·{" "}
                    {resultMetadata?.observedAt ??
                      metadata?.observedAt ??
                      "freshness unknown"}
                  </dd>
                  <dt>Runtime</dt>
                  <dd>
                    {run?.runtimeVersion
                      ? `${label(attempt.provider)} ${run.runtimeVersion} · bound executable revision`
                      : session?.runtimeRevision
                        ? "Bound executable revision; version unknown"
                        : "Unknown"}
                  </dd>
                  <dt>Account</dt>
                  <dd>
                    {session?.accountKey
                      ? "Bound native account (identifier hidden)"
                      : "Unknown"}
                  </dd>
                  <dt>Billing route</dt>
                  <dd>
                    Native provider account · allowance unknown until reported.
                    API estimates are separate and unavailable here.
                  </dd>
                  <dt>Code basis</dt>
                  <dd>
                    {attempt.inputManifest.baseRevision ?? "Not captured"}
                  </dd>
                  <dt>Context delivery</dt>
                  <dd>
                    {attempt.contextPackageId
                      ? "Captured package; inspect delivery evidence"
                      : "No recorded package"}
                  </dd>
                  <dt>Specification</dt>
                  <dd>
                    {attempt.specificationRevision
                      ? "Pinned specification revision"
                      : "Not captured"}
                  </dd>
                  <dt>Access</dt>
                  <dd>
                    {task.role === "reviewer"
                      ? "Read-only route required; independence not inferred"
                      : "Native permissions; inspect configured capability evidence"}
                  </dd>
                  <dt>Usage</dt>
                  <dd>
                    {usageReadout(reported)} · cached{" "}
                    {reported.cached ?? "unknown"} ·{" "}
                    {reported.complete
                      ? "recorded native report"
                      : "incomplete / unknown coverage"}
                  </dd>
                </dl>
                {attempt.error && <p role="status">{attempt.error}</p>}
                <details>
                  <summary>Source identities</summary>
                  <Identity name="Attempt" value={attempt.id} />
                  <Identity name="Session" value={session?.nativeSessionId} />
                  <Identity
                    name="Native thread"
                    value={metadata?.nativeThreadId}
                  />
                  <Identity
                    name="Provider session"
                    value={metadata?.providerSessionId}
                  />
                  <p>
                    Thread and provider session identities remain distinct;
                    missing identities are unknown.
                  </p>
                  <h4>Reported instruction sources</h4>
                  {metadata?.instructionSources?.length ? (
                    metadata.instructionSources.map((source: any) => (
                      <p className="path" key={source.path}>
                        {source.path} · {source.source} · {source.observedAt} ·
                        content hash {source.contentHash ?? "not reported"}
                      </p>
                    ))
                  ) : (
                    <p>No instruction source paths were reported.</p>
                  )}
                  <Identity
                    name="Runtime revision"
                    value={session?.runtimeRevision}
                  />
                  <Identity
                    name="Context package"
                    value={attempt.contextPackageId}
                  />
                  <Identity
                    name="Specification"
                    value={attempt.specificationRevision}
                  />
                </details>
              </article>
            );
          })}
          <h3>Activity</h3>
          <p>
            Created {new Date(task.createdAt).toLocaleString()} · updated{" "}
            {new Date(task.updatedAt).toLocaleString()}
          </p>
          <details>
            <summary>Input and capability evidence</summary>
            <pre>
              {JSON.stringify(
                {
                  inputs: inspection?.inputStatus,
                  configuration: inspection?.configuration,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </>
  );
  return (
    <section className="coordination-view" aria-label="Project activity">
      <div className="page-heading chart-heading">
        <div>
          <div className="eyebrow">PROJECT COMMAND DESK / {label(view)}</div>
          <h1>
            {view === "overview" ? (projectName ?? "Overview") : label(view)}
          </h1>
          <p className="path">{projectPath ?? "Select a project to begin."}</p>
        </div>
        <AtlasIcon name="overview" />
        <button
          disabled={pending.refresh || !projectId}
          onClick={() =>
            void run("refresh", { type: "coordination-query", projectId })
          }
        >
          Refresh activity
        </button>
      </div>
      {projectId && !["coordinator", "tasks", "changes"].includes(view) && (
        <Freshness state={freshness} retry={freshness.retry} />
      )}
      <div hidden={view !== "sessions"}>{sessionsContent}</div>
      <div hidden={view !== "history"}>{historyContent}</div>
      {Object.entries(errors)
        .filter(([, message]) => message)
        .map(([key, message]) => (
          <p key={key} role="alert">
            {message}
          </p>
        ))}
      {!projectId ? (
        <p>Select a project to inspect its work.</p>
      ) : !snapshot ? (
        <p>Loading project activity…</p>
      ) : (
        <>
          <div hidden={view !== "coordinator"}>
            <CoordinatorTeams projectId={projectId} />
          </div>
          <div hidden={view !== "tasks" && view !== "changes"}>
            <Workflows
              projectId={projectId}
              view={view === "changes" ? "changes" : "tasks"}
              onView={onView}
            />
          </div>
          {view === "overview" && (
            <ProjectOverview
              tasks={coordination.tasks}
              onView={(next) => onView?.(next)}
            >
              <div className="project-overview">
                <article>
                  <h2>Responsibility</h2>
                  <p>
                    {coordination.tasks.length} tasks ·{" "}
                    {coordination.workflows.length} workflows
                  </p>
                  <p>
                    {
                      coordination.tasks.filter(
                        (t: Task) => t.state === "blocked",
                      ).length
                    }{" "}
                    blocked ·{" "}
                    {
                      coordination.tasks.filter(
                        (t: Task) => t.state === "accepted",
                      ).length
                    }{" "}
                    accepted
                  </p>
                </article>
                <article>
                  <h2>Capacity</h2>
                  <p>
                    {coordination.concurrency.visibleAttempts} visible attempts
                    · {coordination.concurrency.reservedCapacity}/
                    {coordination.concurrency.totalLimit} reserved
                  </p>
                  <p>
                    Hidden native concurrency:{" "}
                    {coordination.concurrency.hiddenConcurrency}
                  </p>
                  <p>
                    Maximum including native children:{" "}
                    {coordination.concurrency.maximumIncludingNativeChildren ??
                      "Unknown"}
                  </p>
                </article>
                <article>
                  <h2>Usage and billing</h2>
                  <p>{usageReadout(usage)}</p>
                  <p>
                    {usage.coveredRuns}/{usage.totalRuns} turns report usage ·{" "}
                    {usage.complete
                      ? "Complete recorded coverage"
                      : "Incomplete coverage; missing is unknown"}
                  </p>
                  <p>{alert.detail}</p>
                  <p className="tiny">
                    Provider allowance: Applications → Usage remaining. API
                    estimate: unavailable.
                  </p>
                </article>
              </div>
              <UsageBudget
                projectId={projectId}
                summary={usage}
                attempts={coordination.attempts}
              />
            </ProjectOverview>
          )}
          {view === "tasks" && (
            <>
              <ParallelActivity projectId={projectId} />
              <div className="coordination-layout">
                <section aria-label="Task list">
                  <h2>Tasks</h2>
                  {!coordination.tasks.length && (
                    <p>
                      No recorded tasks yet. Capture a workflow above or start a
                      native session.
                    </p>
                  )}
                  {coordination.tasks.map((item: Task) => (
                    <button
                      key={item.id}
                      className={`coordination-task ${selected === item.id ? "selected" : ""}`}
                      aria-pressed={selected === item.id}
                      disabled={pending[`inspect:${item.id}`]}
                      onClick={(event) => {
                        taskTrigger.current = event.currentTarget;
                        void inspect(item);
                      }}
                    >
                      <strong>{item.title}</strong>
                      <span>
                        {label(item.role)} · {label(item.state)}
                      </span>
                      <span>{item.detail}</span>
                    </button>
                  ))}
                </section>
                <aside
                  className="coordination-inspector"
                  aria-label="Task inspector"
                >
                  {inspector}
                </aside>
              </div>
            </>
          )}
          {view === "changes" && (
            <>
              <p>
                Each candidate requires its own review and check evidence.
                Changing captured files invalidates acceptance for a newer
                candidate.
              </p>
            </>
          )}
          <div hidden={view !== "context"} className="">
            <h2>Shared context</h2>
            <p>
              Published inputs are immutable. Dispatch blocking changes remain
              visible to existing attempts until explicitly restarted.
            </p>
            <form
              className="workflow-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run("publish", {
                  type: "shared-revision-publish",
                  requestId: crypto.randomUUID(),
                  projectId,
                  recordId: crypto.randomUUID(),
                  kind: revisionKind,
                  title: revisionTitle,
                  content: revisionContent,
                  impact:
                    revisionKind === "decision"
                      ? "advisory"
                      : "dispatch-blocking",
                  expectedHeadId: null,
                });
              }}
            >
              <label>
                Context kind
                <select
                  value={revisionKind}
                  onChange={(e) => setRevisionKind(e.target.value as any)}
                >
                  <option value="decision">Decision</option>
                  <option value="interface">Interface</option>
                  <option value="specification">Specification</option>
                </select>
              </label>
              <label>
                Title
                <input
                  value={revisionTitle}
                  onChange={(e) => setRevisionTitle(e.target.value)}
                  required
                />
              </label>
              <label>
                Exact context
                <textarea
                  value={revisionContent}
                  onChange={(e) => setRevisionContent(e.target.value)}
                  required
                />
              </label>
              <button disabled={pending.publish}>
                Publish captured context
              </button>
            </form>
            {sync?.sharedRevisions.map((revision: any) => (
              <article className="workflow-card" key={revision.id}>
                <h3>{revision.title}</h3>
                <p>
                  {label(revision.kind)} · revision {revision.sequence} ·{" "}
                  {label(revision.impact)}
                </p>
                <details>
                  <summary>Captured input</summary>
                  <pre>{revision.content}</pre>
                  <Identity name="Revision" value={revision.id} />
                </details>
              </article>
            ))}
            <h3>Task input freshness</h3>
            {sync?.inputs.map((input: any) => (
              <p key={input.taskId}>
                {coordination.tasks.find((t: Task) => t.id === input.taskId)
                  ?.title ?? "Historical task"}
                : {input.detail ?? JSON.stringify(input.stale ?? [])}
              </p>
            ))}
          </div>
          <div hidden={view !== "history"} className="history-sources">
            <h2>Approved native history sources</h2>
            <p>
              Use project History for paged transcript search and native
              imports. Continuous source observation requires selecting one
              exact file and profile.
            </p>
            <form
              className="workflow-form"
              onSubmit={(e) => {
                e.preventDefault();
                void run("source", {
                  type: "native-history-approve",
                  requestId: crypto.randomUUID(),
                  projectId,
                  provider: historyProvider,
                  profileId: profile,
                  sessionId: nativeSession,
                });
              }}
            >
              <label>
                Provider
                <select
                  value={historyProvider}
                  onChange={(e) => setHistoryProvider(e.target.value as any)}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label>
                Native profile label
                <input
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  required
                />
              </label>
              <label>
                Native session identity
                <input
                  value={nativeSession}
                  onChange={(e) => setNativeSession(e.target.value)}
                  required
                />
              </label>
              <button disabled={pending.source}>
                Select and approve history source…
              </button>
            </form>
            {sync?.historySources.map((source: any) => (
              <article className="workflow-card" key={source.id}>
                <h3>
                  {label(source.provider)} source · {label(source.state)}
                </h3>
                <p className="path">{source.selectedFile}</p>
                <p>
                  {source.detail} · {source.recordCount} records ·{" "}
                  {source.pendingBytes} pending bytes
                </p>
                <p>{source.coverageLosses.length} recorded coverage gaps</p>
                <button
                  disabled={pending[source.id]}
                  onClick={() =>
                    void run(source.id, {
                      ...(source.enabled
                        ? {
                            type: "native-history-pause",
                            requestId: crypto.randomUUID(),
                            projectId,
                            id: source.id,
                            expectedRevision: source.revision,
                          }
                        : {
                            type: "native-history-approve",
                            requestId: crypto.randomUUID(),
                            projectId,
                            provider: source.provider,
                            profileId: source.profileId,
                            sessionId: source.sessionId,
                          }),
                    })
                  }
                >
                  {source.enabled ? "Pause source" : "Review source again…"}
                </button>
                {source.enabled && (
                  <button
                    disabled={pending[source.id]}
                    onClick={() =>
                      void run(source.id, {
                        type: "native-history-reconcile",
                        requestId: crypto.randomUUID(),
                        projectId,
                        id: source.id,
                        expectedRevision: source.revision,
                      })
                    }
                  >
                    Refresh source
                  </button>
                )}
              </article>
            ))}
          </div>
          <div hidden={view !== "synchronization"} className="">
            <SynchronizationSummary synchronization={sync} />
            <h2>Native synchronization</h2>
            {sync?.observations.map((observation: any) => (
              <article key={observation.id} className="workflow-card">
                <h3>
                  {label(observation.dimension)} · {label(observation.state)}
                </h3>
                <p>{observation.detail}</p>
                <p>Next action: {observation.suggestedAction}</p>
                <p>
                  Evidence: {observation.evidence.level} ·{" "}
                  {observation.evidence.detail}
                </p>
                <p>
                  Last successful observation:{" "}
                  {observation.lastSuccessfulObservationAt ?? "Unknown"}
                </p>
              </article>
            ))}
            {!sync?.observations.length && (
              <p>No native readback recorded for this project.</p>
            )}
            {sync?.fields.map((field: any) => (
              <article className="workflow-card" key={field.id}>
                <h3>
                  {label(field.field)} · {label(field.state)}
                </h3>
                <p>
                  Authority: {label(field.authority)} · Topsl{" "}
                  {JSON.stringify(field.local)} · native{" "}
                  {JSON.stringify(field.remote)}
                </p>
                {["conflict", "pull-required"].includes(field.state) && (
                  <button
                    disabled={pending[field.id]}
                    onClick={() =>
                      void run(field.id, {
                        type: "sync-field-resolve",
                        requestId: crypto.randomUUID(),
                        projectId,
                        id: field.id,
                        expectedRevision: field.revision,
                        direction: "follow-native",
                      })
                    }
                  >
                    Follow native value
                  </button>
                )}
                {field.state === "conflict" && (
                  <button
                    disabled={pending[field.id]}
                    onClick={() =>
                      void run(field.id, {
                        type: "sync-field-resolve",
                        requestId: crypto.randomUUID(),
                        projectId,
                        id: field.id,
                        expectedRevision: field.revision,
                        direction: "keep-topsl",
                      })
                    }
                  >
                    Keep Topsl intent
                  </button>
                )}
                {field.state === "push-required" && (
                  <button
                    disabled={pending[field.id]}
                    onClick={() =>
                      void run(field.id, {
                        type: "sync-field-push",
                        requestId: crypto.randomUUID(),
                        projectId,
                        id: field.id,
                        expectedRevision: field.revision,
                      })
                    }
                  >
                    Review native name push…
                  </button>
                )}
              </article>
            ))}
            {sync?.links.map((link: any) => (
              <article className="workflow-card" key={link.id}>
                <h3>
                  {link.name} · {label(link.provider)} · {label(link.state)}
                </h3>
                {link.roots.map((root: any) => (
                  <p className="path" key={root.nativeRoot}>
                    {root.nativeRoot} ·{" "}
                    {root.trustRevision
                      ? "Approved root mapping"
                      : "Unapproved root mapping"}
                  </p>
                ))}
              </article>
            ))}
            <h2>Managed workspaces</h2>
            <p>
              Distinct workspaces share logical project identity. Git worktrees
              share repository metadata; OS isolation is not enforced.
            </p>
            <form
              className="workflow-form"
              onSubmit={(e) => {
                e.preventDefault();
                void (async () => {
                  const plan = await run("workspace", {
                    type: "workspace-create-preview",
                    sourceWorkspaceId: workspaceSource,
                    workflowId: workspaceWorkflow,
                    kind: workspaceKind,
                    dirtyInputPolicy: "reviewed-snapshot",
                    selectedPaths: workspacePaths.trim()
                      ? workspacePaths.split("\n").filter(Boolean)
                      : undefined,
                    approvedUntracked: [],
                  });
                  if (plan)
                    await run("workspace", {
                      type: "workspace-plan-apply",
                      requestId: crypto.randomUUID(),
                      id: plan.id,
                    });
                })();
              }}
            >
              <label>
                Source workspace
                <select
                  value={workspaceSource}
                  onChange={(e) => setWorkspaceSource(e.target.value)}
                  required
                >
                  <option value="">Select approved workspace</option>
                  {coordination.workspaces.map((w: any) => (
                    <option key={w.id} value={w.id}>
                      {w.canonicalRoot}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workflow
                <select
                  value={workspaceWorkflow}
                  onChange={(e) => setWorkspaceWorkflow(e.target.value)}
                  required
                >
                  <option value="">Select workflow</option>
                  {coordination.workflows.map((w: any) => (
                    <option key={w.id} value={w.id}>
                      {w.objective}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Workspace route
                <select
                  value={workspaceKind}
                  onChange={(e) => setWorkspaceKind(e.target.value as any)}
                >
                  <option value="snapshot">Selected file snapshot</option>
                  <option value="worktree">Git worktree</option>
                </select>
              </label>
              <label>
                Selected paths · one per line
                <textarea
                  value={workspacePaths}
                  onChange={(e) => setWorkspacePaths(e.target.value)}
                />
              </label>
              <button disabled={pending.workspace}>
                Review workspace creation…
              </button>
            </form>
            <OptionalCoordination projectId={projectId} />
          </div>
        </>
      )}
      {drawer && view === "tasks" && (
        <dialog
          className="task-drawer"
          ref={dialog}
          aria-label="Task details"
          onCancel={() => {
            setDrawer(false);
            requestAnimationFrame(() => taskTrigger.current?.focus());
          }}
        >
          <button
            onClick={() => {
              dialog.current?.close();
              setDrawer(false);
              requestAnimationFrame(() => taskTrigger.current?.focus());
            }}
          >
            Close task details
          </button>
          {inspector}
        </dialog>
      )}
    </section>
  );
}
