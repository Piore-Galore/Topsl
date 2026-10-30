import { useEffect, useRef, useState } from "react";
import {
  advancedSections,
  viewLabel as label,
  type AdvancedSection,
} from "../../../../packages/domain/navigation";
import { ParallelActivity } from "../components/parallel-activity";
import { OptionalCoordination } from "../components/reporting";
import { Workflows } from "../workflows";
import { ScopedReadFence, useScopedRefresh } from "../state/scoped";
import { Freshness } from "../components/freshness";
import { usageReadout } from "../state/usage-view";
import type { Task } from "../../../../packages/domain/workflow";
import type { Command } from "../../../../packages/domain/commands";
import { summarizeUsage } from "../../../../packages/domain/usage";

const sectionTitles: Record<AdvancedSection, string> = {
  workflows: "Builder–reviewer",
  changes: "Candidate review",
  activity: "Activity",
  context: "Context",
  workspaces: "Workspaces",
};
const attentionStates = new Set([
  "blocked",
  "awaiting-approval",
  "awaiting-review",
  "awaiting-acceptance",
  "failed",
  "uncertain",
]);

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

/**
 * Advanced workflows (docs/UX_Cleanup_Plan.md §1): the older
 * builder–reviewer workflows and their candidate review, task activity,
 * shared context and managed workspaces, kept out of the everyday session
 * workspace but fully available.
 */
export function AdvancedWorkflows({
  projectId,
  section,
  onSection,
}: {
  projectId: string;
  section: AdvancedSection;
  onSection: (section: AdvancedSection) => void;
}) {
  const [snapshot, setSnapshot] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [inspection, setInspection] = useState<any>(null),
    [pending, setPending] = useState<Record<string, boolean>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [drawer, setDrawer] = useState(false);
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
    setSelected("");
    setInspection(null);
    setDrawer(false);
    setErrors({});
    setPending({});
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
    sync = snapshot?.synchronization,
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
  const attention = (coordination?.tasks ?? []).filter((t: Task) =>
    attentionStates.has(t.state),
  );
  const inspector = (
    <>
      <h2>{task?.title ?? "Task inspector"}</h2>
      {!task ? (
        <p>Select a task to see its responsibility, inputs and acceptance.</p>
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
    <section className="advanced-workflows" aria-label="Advanced workflows">
      <div className="page-heading">
        <div>
          <h1>Advanced workflows</h1>
        </div>
      </div>
      <div className="segmented sections" role="tablist" aria-label="Section">
        {advancedSections.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={section === s}
            className={section === s ? "selected" : ""}
            onClick={() => onSection(s)}
          >
            {sectionTitles[s]}
            {s === "activity" && attention.length > 0 && (
              <span className="count">{attention.length}</span>
            )}
          </button>
        ))}
      </div>
      <Freshness state={freshness} retry={freshness.retry} />
      {Object.entries(errors)
        .filter(([, message]) => message)
        .map(([key, message]) => (
          <p key={key} role="alert">
            {message}
          </p>
        ))}
      {!snapshot ? (
        <p role="status">Loading project activity…</p>
      ) : (
        <>
          <div hidden={section !== "workflows" && section !== "changes"}>
            <Workflows
              projectId={projectId}
              view={section === "changes" ? "changes" : "tasks"}
              onView={() => onSection("changes")}
            />
          </div>
          {section === "activity" && (
            <>
              <section className="atlas-panel" aria-label="Needs attention">
                <h2>Needs attention</h2>
                {attention.length ? (
                  <ul className="attention-list">
                    {attention.map((t: Task) => (
                      <li key={t.id}>
                        <span>
                          <strong>{t.title}</strong>
                          <br />
                          <small>
                            {t.state.replaceAll("-", " ")} · {t.detail}
                          </small>
                        </span>
                        <button onClick={() => void inspect(t)}>
                          Inspect task
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>Nothing needs attention.</p>
                )}
              </section>
              <p className="muted">
                {coordination.tasks.length} tasks ·{" "}
                {coordination.workflows.length} workflows ·{" "}
                {coordination.concurrency.visibleAttempts} running ·{" "}
                {usageReadout(usage)}
              </p>
              <ParallelActivity projectId={projectId} />
              <div className="coordination-layout">
                <section aria-label="Task list">
                  <h2>Tasks</h2>
                  {!coordination.tasks.length && <p>No recorded tasks yet.</p>}
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
          {section === "context" && (
            <div>
              <h2>Shared context</h2>
              <p className="muted">
                Published inputs are immutable. Dispatch-blocking changes stay
                visible to existing attempts until they are restarted.
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
              {sync?.inputs.length > 0 && (
                <>
                  <h3>Task input freshness</h3>
                  {sync.inputs.map((input: any) => (
                    <p key={input.taskId}>
                      {coordination.tasks.find(
                        (t: Task) => t.id === input.taskId,
                      )?.title ?? "Historical task"}
                      : {input.detail ?? JSON.stringify(input.stale ?? [])}
                    </p>
                  ))}
                </>
              )}
            </div>
          )}
          {section === "workspaces" && (
            <div>
              <h2>Managed workspaces</h2>
              <p className="muted">
                Workspaces share the project's identity. Git worktrees share
                repository metadata; the operating system does not isolate them.
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
          )}
        </>
      )}
      {drawer && section === "activity" && (
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
