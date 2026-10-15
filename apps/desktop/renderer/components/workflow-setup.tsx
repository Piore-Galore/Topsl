import { useEffect, useRef, useState } from "react";
import {
  workflowDraftInput,
  type WorkflowDraftInput,
} from "../../../../packages/domain/workflow-drafts";
import { ScopedReadFence } from "../state/scoped";
const steps = ["Goal", "Team", "Environment", "Scope", "Review and start"];
const lines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
function qualificationSummary(result: any): string {
  const observations: any[] = result.report?.observations ?? [],
    passed = observations.filter((o) => o.passed).map((o) => o.capability),
    failed = observations.filter((o) => !o.passed).map((o) => o.capability),
    untested = (result.report?.notTested ?? []).map((n: any) => n.capability);
  return [
    result.acceptanceId
      ? `Qualification recorded until ${result.expiresAt}.`
      : "Nothing was recorded.",
    `Passed: ${passed.join(", ") || "none"}.`,
    failed.length ? `Not passed: ${failed.join(", ")}.` : "",
    untested.length ? `Not tested: ${untested.join(", ")}.` : "",
    `Model turns started: ${result.report?.turnsStarted ?? 0}.`,
    result.report?.error ? `Stopped: ${result.report.error}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
export function WorkflowSetup({
  projectId,
  runtimes,
  checkRuntime,
  afterCreate,
}: {
  projectId: string;
  runtimes: any[];
  checkRuntime: string;
  afterCreate: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() => workflowDraftInput.parse({})),
    [revision, setRevision] = useState(0),
    [savedAt, setSavedAt] = useState(""),
    [pending, setPending] = useState(""),
    [error, setError] = useState(""),
    [models, setModels] = useState<Record<string, any>>({}),
    [readiness, setReadiness] = useState<any>(null),
    [guidedEnabled, setGuidedEnabled] = useState(false),
    [environment, setEnvironment] = useState<any>(null),
    [qualifications, setQualifications] = useState<Record<string, any>>({}),
    [created, setCreated] = useState("");
  const generation = useRef(0),
    edits = useRef(0),
    heading = useRef<HTMLHeadingElement>(null),
    draftReads = useRef(new ScopedReadFence(projectId)),
    readinessOrder = useRef(0),
    selection = useRef("");
  selection.current = JSON.stringify([
    draft.builder,
    draft.builderRuntime,
    draft.reviewerRuntime,
    draft.builderModel,
    draft.reviewerModel,
    draft.builderEffort,
    draft.reviewerEffort,
  ]);
  function update(change: Partial<WorkflowDraftInput>) {
    edits.current++;
    setDraft((current) => ({ ...current, ...change }));
  }
  async function loadDraft() {
    const ticket = generation.current,
      before = edits.current,
      readTicket = draftReads.current.begin();
    const value = await window.topsl.command({
      type: "workflow-draft-query",
      projectId,
      workflowId: null,
    });
    if (
      ticket !== generation.current ||
      !draftReads.current.accept(readTicket, value)
    )
      return;
    setRevision(value.draft?.revision ?? 0);
    setSavedAt(value.draft?.updatedAt ?? "");
    if (before === edits.current && value.draft) setDraft(value.draft.draft);
  }
  useEffect(() => {
    generation.current++;
    draftReads.current.reset(projectId);
    readinessOrder.current++;
    setDraft(workflowDraftInput.parse({}));
    setRevision(0);
    setSavedAt("");
    setPending("");
    setError("");
    setModels({});
    setQualifications({});
    setGuidedEnabled(false);
    setEnvironment(null);
    setCreated("");
    edits.current = 0;
    const ticket = generation.current;
    void window.topsl
      .command({ type: "round-2-features-query", projectId })
      .then((value) => {
        if (ticket === generation.current)
          setGuidedEnabled(
            value.features.find(
              (feature: any) => feature.id === "guided-workflows",
            )?.enabled === true,
          );
      })
      .catch((error) => {
        if (ticket === generation.current) {
          setGuidedEnabled(false);
          setError(error.message);
        }
      });
    void loadDraft().catch((error) => {
      if (ticket === generation.current) setError(error.message);
    });
    void detectEnvironment().catch((error) => {
      if (ticket === generation.current) setError(error.message);
    });
    return () => {
      generation.current++;
    };
  }, [projectId]);
  const builderProvider = draft.builder,
    reviewerProvider = draft.builder === "codex" ? "claude" : "codex";
  const choices = (provider: string) =>
    runtimes.filter(
      (runtime) =>
        runtime.installation.trusted &&
        runtime.installation.appId ===
          (provider === "codex"
            ? "openai.codex-cli"
            : "anthropic.claude-code-cli"),
    );
  const builder = choices(builderProvider).find(
      (runtime) => runtime.installation.id === draft.builderRuntime,
    ),
    reviewer = choices(reviewerProvider).find(
      (runtime) => runtime.installation.id === draft.reviewerRuntime,
    );
  const selectedEnvironment = environment?.suggestions.find(
    (suggestion: any) => suggestion.id === draft.environmentRecipeId,
  );
  const blockers = [
    ...(!guidedEnabled
      ? [
          "Guided workflow execution is disabled by the service rollout gate. Drafts and historical evidence remain available.",
        ]
      : []),
    ...(!builder ? ["Select a trusted builder runtime."] : []),
    ...(!reviewer ? ["Select a trusted reviewer runtime."] : []),
    ...(["builder", "reviewer"] as const).flatMap(
      (role) =>
        readiness?.roles?.[role]?.blockers?.map(
          (blocker: any) => `${role}: ${blocker.detail}`,
        ) ?? [],
    ),
    ...(!readiness
      ? ["Route readiness has not been observed for the selected team."]
      : []),
    ...(!selectedEnvironment
      ? ["Select a detected preparation and check recipe."]
      : selectedEnvironment.blockers),
  ];
  function readinessCommand() {
    return {
      type: "workflow-readiness-query" as const,
      projectId,
      builder:
        draft.builderRuntime && draft.builderModel
          ? {
              provider: builderProvider,
              installationId: draft.builderRuntime,
              model: draft.builderModel,
              ...(draft.builderEffort ? { effort: draft.builderEffort } : {}),
            }
          : undefined,
      reviewer:
        draft.reviewerRuntime && draft.reviewerModel
          ? {
              provider: reviewerProvider as "codex" | "claude",
              installationId: draft.reviewerRuntime,
              model: draft.reviewerModel,
              ...(draft.reviewerEffort ? { effort: draft.reviewerEffort } : {}),
            }
          : undefined,
    };
  }
  useEffect(() => {
    let alive = true;
    const ticket = ++readinessOrder.current;
    setReadiness(null);
    const timer = setTimeout(() => {
      void window.topsl
        .command(readinessCommand())
        .then((value) => {
          if (alive && ticket === readinessOrder.current) setReadiness(value);
        })
        .catch((error) => {
          if (alive && ticket === readinessOrder.current)
            setError(error.message);
        });
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [
    projectId,
    draft.builder,
    draft.builderRuntime,
    draft.reviewerRuntime,
    draft.builderModel,
    draft.reviewerModel,
    draft.builderEffort,
    draft.reviewerEffort,
  ]);
  async function perform(key: string, operation: () => Promise<unknown>) {
    if (pending) return;
    const ticket = generation.current;
    setPending(key);
    setError("");
    try {
      await operation();
    } catch (error: any) {
      if (ticket === generation.current) setError(error.message);
    } finally {
      if (ticket === generation.current) setPending("");
    }
  }
  async function save() {
    const ticket = generation.current,
      readTicket = draftReads.current.begin();
    const value = await window.topsl.command({
      type: "workflow-draft-save",
      requestId: crypto.randomUUID(),
      projectId,
      workflowId: null,
      expectedRevision: revision,
      draft,
    });
    if (
      ticket === generation.current &&
      draftReads.current.accept(readTicket, value)
    ) {
      setRevision(value.draft.revision);
      setSavedAt(value.draft.updatedAt);
    }
  }
  const capturable = !!(
    builder &&
    reviewer &&
    draft.objective.trim() &&
    lines(draft.criteria).length &&
    draft.builderModel &&
    draft.reviewerModel &&
    draft.checkExecutable &&
    selectedEnvironment &&
    !selectedEnvironment.blockers.length
  );
  async function capture(mode: "assisted" | "coordinated") {
    if (!capturable)
      throw new Error(
        "Complete the goal, team, exact check and environment selection before capture.",
      );
    const ticket = generation.current;
    if (mode === "coordinated") {
      const latest = await window.topsl.command(readinessCommand());
      if (!guidedEnabled || !latest.runnable)
        throw new Error(
          "The selected coordinated route is blocked. Save a draft or capture an assisted handoff.",
        );
    }
    const result = await window.topsl.command({
      type: "builder-reviewer-create",
      requestId: crypto.randomUUID(),
      projectId,
      objective: draft.objective,
      acceptanceCriteria: lines(draft.criteria),
      interfaces: lines(draft.interfaces),
      builder: {
        provider: builderProvider,
        installationId: draft.builderRuntime,
        model: draft.builderModel,
        ...(draft.builderEffort ? { effort: draft.builderEffort } : {}),
      },
      reviewer: {
        provider: reviewerProvider as "codex" | "claude",
        installationId: draft.reviewerRuntime,
        model: draft.reviewerModel,
        ...(draft.reviewerEffort ? { effort: draft.reviewerEffort } : {}),
      },
      selectedPaths: draft.selectedPaths.trim()
        ? lines(draft.selectedPaths)
        : undefined,
      approvedUntracked: lines(draft.approvedUntracked),
      maxRepairs: 2,
      requireIndependence: false,
      checks: [
        {
          id: "required-check",
          label: "Required project check",
          executable: draft.checkExecutable,
          args: draft.checkArguments,
          timeoutMs: 120000,
          environmentRecipeId: draft.environmentRecipeId,
        },
      ],
    });
    if (ticket === generation.current) {
      if (result == null) {
        setError(
          "Workflow capture was cancelled. The editable draft is retained.",
        );
        return;
      }
      setCreated(result.id);
      await afterCreate();
    }
  }
  async function discover(installationId: string) {
    const ticket = generation.current;
    const result = await window.topsl.command({
      type: "runtime-models",
      id: installationId,
    });
    if (ticket === generation.current)
      setModels((current) => ({ ...current, [installationId]: result }));
  }
  async function detectEnvironment() {
    const ticket = generation.current;
    const value = await window.topsl.command({
      type: "environment-detect",
      projectId,
    });
    if (ticket === generation.current) setEnvironment(value);
  }
  function selectEnvironment(id: string) {
    const suggestion = environment?.suggestions.find(
      (item: any) => item.id === id,
    );
    if (!suggestion) {
      update({ environmentRecipeId: id });
      return;
    }
    const script =
      suggestion.scripts.find((item: any) => item.name === "test") ??
      suggestion.scripts[0];
    update({
      environmentRecipeId: id,
      checkExecutable: suggestion.nodeExecutable,
      checkArguments:
        suggestion.kind === "locked-node" && script && suggestion.npmCli
          ? [suggestion.npmCli, "run", script.name]
          : ["--test"],
    });
  }
  const modelList = (runtimeId: string): any[] =>
    models[runtimeId]?.models ??
    (Array.isArray(models[runtimeId])
      ? models[runtimeId]
      : runtimeId === draft.builderRuntime
        ? (readiness?.roles?.builder?.models ?? [])
        : (readiness?.roles?.reviewer?.models ?? []));
  function roleFields(
    role: "builder" | "reviewer",
    provider: string,
    selected: any,
  ) {
    const runtimeKey =
        role === "builder" ? "builderRuntime" : "reviewerRuntime",
      modelKey = role === "builder" ? "builderModel" : "reviewerModel";
    const effortKey = role === "builder" ? "builderEffort" : "reviewerEffort",
      model = modelList(draft[runtimeKey]).find(
        (item) => (item.model ?? item.id) === draft[modelKey],
      );
    return (
      <fieldset>
        <legend>
          {role === "builder" ? "Builder" : "Reviewer"} · {provider}
        </legend>
        <label>
          Selected {role} runtime
          <select
            value={draft[runtimeKey]}
            onChange={(event) => update({ [runtimeKey]: event.target.value })}
          >
            <option value="">Choose a trusted runtime</option>
            {choices(provider).map((runtime) => (
              <option
                key={runtime.installation.id}
                value={runtime.installation.id}
              >
                {runtime.installation.version ?? "Version unknown"} ·{" "}
                {runtime.installation.realPath}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!selected || !!pending}
          onClick={() =>
            void perform(`models-${role}`, () => discover(draft[runtimeKey]))
          }
        >
          Discover {role} models
        </button>
        <button
          type="button"
          disabled={!selected || !!pending}
          onClick={() =>
            void perform(`validate-${role}`, async () => {
              const ticket = generation.current,
                requested = selection.current,
                order = ++readinessOrder.current;
              await window.topsl.command({
                type: "runtime-connect",
                id: draft[runtimeKey],
              });
              if (
                requested !== selection.current ||
                ticket !== generation.current
              )
                return;
              const value = await window.topsl.command(readinessCommand());
              if (
                ticket === generation.current &&
                requested === selection.current &&
                order === readinessOrder.current
              )
                setReadiness(value);
            })
          }
        >
          Validate {role} runtime
        </button>
        {selected?.installation.appId === "openai.codex-cli" && (
          <button
            type="button"
            disabled={!draft[modelKey] || !!pending}
            title="Runs up to 4 live model turns after you review them"
            onClick={() =>
              void perform(`qualify-${role}`, async () => {
                const ticket = generation.current,
                  requested = selection.current,
                  installationId = draft[runtimeKey];
                const result = await window.topsl.command({
                  type: "runtime-qualify",
                  id: installationId,
                  model: draft[modelKey],
                  ...(draft[effortKey] ? { effort: draft[effortKey] } : {}),
                });
                if (result == null || ticket !== generation.current) return;
                setQualifications((current) => ({
                  ...current,
                  [installationId]: result,
                }));
                const order = ++readinessOrder.current,
                  value = await window.topsl.command(readinessCommand());
                if (
                  ticket === generation.current &&
                  requested === selection.current &&
                  order === readinessOrder.current
                )
                  setReadiness(value);
              })
            }
          >
            Qualify {role} runtime
          </button>
        )}
        {qualifications[draft[runtimeKey]] && (
          <p role="status">
            {qualificationSummary(qualifications[draft[runtimeKey]])}
          </p>
        )}
        <label>
          Requested {role} model
          <select
            value={draft[modelKey]}
            onChange={(event) => update({ [modelKey]: event.target.value })}
          >
            <option value="">Select a model reported by this runtime</option>
            {draft[modelKey] &&
              !modelList(draft[runtimeKey]).some(
                (model) => (model.model ?? model.id) === draft[modelKey],
              ) && (
                <option value={draft[modelKey]}>
                  {draft[modelKey]} · saved intent, availability unverified
                </option>
              )}
            {modelList(draft[runtimeKey]).map((model) => (
              <option
                key={model.model ?? model.id}
                value={model.model ?? model.id}
              >
                {model.name ?? model.model ?? model.id}
              </option>
            ))}
          </select>
        </label>
        {(model?.supportedReasoningEfforts?.length > 0 || draft[effortKey]) && (
          <label>
            Requested {role} effort
            <select
              value={draft[effortKey]}
              onChange={(event) => update({ [effortKey]: event.target.value })}
            >
              <option value="">Use reported runtime default</option>
              {draft[effortKey] &&
                !model?.supportedReasoningEfforts?.includes(
                  draft[effortKey],
                ) && (
                  <option value={draft[effortKey]}>
                    {draft[effortKey]} · saved intent, unsupported or unknown
                  </option>
                )}
              {(model?.supportedReasoningEfforts ?? []).map(
                (effort: string) => (
                  <option key={effort}>{effort}</option>
                ),
              )}
            </select>
          </label>
        )}
        {model && (
          <p>
            Model metadata: {model.metadataSource ?? "unknown"} · observed{" "}
            {model.observedAt ?? "unknown"} · input{" "}
            {model.inputModalities?.join(", ") || "unknown"} · default effort{" "}
            {model.defaultReasoningEffort ?? "unknown"}.
          </p>
        )}
        {readiness?.roles?.[role] && (
          <p>
            {readiness.roles[role].ready
              ? "Role requirements currently satisfied"
              : "Role blocked"}{" "}
            · acceptance binding {readiness.roles[role].freshness.state}.
          </p>
        )}
        <p>
          Effective model and effort: unknown until the runtime reports them.
          Model discovery is an observation, not live route qualification.
        </p>
        <details>
          <summary>Runtime and capability evidence</summary>
          <p className="path">
            {selected?.installation.realPath ?? "No runtime selected"}
          </p>
          {selected?.capabilities.map((capability: any) => (
            <p key={capability.name}>
              {capability.name}: {capability.support} ·{" "}
              {capability.evidence.detail}
            </p>
          ))}
        </details>
        <details>
          <summary>Explicit assisted model intent</summary>
          <label>
            Unverified {role} native model intent
            <input
              value={draft[modelKey]}
              onChange={(event) => update({ [modelKey]: event.target.value })}
            />
          </label>
          <p>
            This field preserves explicit intent for an assisted capture.
            Unknown or unsupported settings keep coordinated execution blocked.
          </p>
        </details>
      </fieldset>
    );
  }
  function move(step: number) {
    update({ step });
    requestAnimationFrame(() => heading.current?.focus());
  }
  return (
    <details className="guided-workflow" data-project-id={projectId}>
      <summary>Create a workflow</summary>
      <div className="workflow-readiness" role="status">
        <strong>Coordinated workflow readiness</strong>
        <p>{blockers.join(" ")}</p>
        <p>
          Observed {readiness?.observedAt ?? "not yet"}. A trusted binary does
          not establish route qualification. Save a protected draft while
          requirements or runtime support are incomplete.
        </p>
      </div>
      <nav className="workflow-step-nav" aria-label="Workflow setup steps">
        {steps.map((step, index) => (
          <button
            type="button"
            key={step}
            aria-current={draft.step === index ? "step" : undefined}
            onClick={() => move(index)}
          >
            {index + 1}. {step}
          </button>
        ))}
      </nav>
      <h3 ref={heading} tabIndex={-1}>
        {steps[draft.step]}
      </h3>
      {error && <p role="alert">{error}</p>}
      <form
        className="workflow-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.step < 4) move(draft.step + 1);
        }}
      >
        {draft.step === 0 && (
          <>
            <label>
              Objective
              <textarea
                value={draft.objective}
                onChange={(event) => update({ objective: event.target.value })}
                required
              />
            </label>
            <label>
              Acceptance criteria · one per line
              <textarea
                value={draft.criteria}
                onChange={(event) => update({ criteria: event.target.value })}
                required
              />
            </label>
            <details className="full-width">
              <summary>Interfaces and constraints</summary>
              <label>
                Interface requirements · one per line
                <textarea
                  value={draft.interfaces}
                  onChange={(event) =>
                    update({ interfaces: event.target.value })
                  }
                />
              </label>
            </details>
          </>
        )}
        {draft.step === 1 && (
          <>
            <label className="full-width">
              Team preset
              <select
                value={draft.builder}
                onChange={(event) =>
                  update({ builder: event.target.value as any })
                }
              >
                <option value="codex">Codex builds · Claude reviews</option>
                <option value="claude">Claude builds · Codex reviews</option>
              </select>
            </label>
            {roleFields("builder", builderProvider, builder)}
            {roleFields("reviewer", reviewerProvider, reviewer)}
          </>
        )}
        {draft.step === 2 && (
          <>
            <label className="full-width">
              Preparation and check recipe
              <select
                value={draft.environmentRecipeId}
                onChange={(event) => selectEnvironment(event.target.value)}
              >
                <option value="">Select a detected recipe</option>
                {draft.environmentRecipeId && !selectedEnvironment && (
                  <option value={draft.environmentRecipeId}>
                    Saved recipe is no longer available · review again
                  </option>
                )}
                {(environment?.suggestions ?? []).map((suggestion: any) => (
                  <option key={suggestion.id} value={suggestion.id}>
                    {suggestion.label}
                    {suggestion.blockers.length ? " · blocked" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!!pending}
              onClick={() => void perform("environment", detectEnvironment)}
            >
              Detect preparation recipes
            </button>
            <p className="full-width">
              {environment?.disclosure ??
                "Preparation recipes have not been observed. Save a draft while detection is unavailable."}
            </p>
            {selectedEnvironment && (
              <section className="full-width">
                <p>{selectedEnvironment.detail}</p>
                {selectedEnvironment.blockers.map((blocker: string) => (
                  <p role="status" key={blocker}>
                    {blocker}
                  </p>
                ))}
                {selectedEnvironment.kind === "locked-node" &&
                  selectedEnvironment.scripts.length > 0 && (
                    <label>
                      Project check script
                      <select
                        value={
                          draft.checkArguments[1] === "run"
                            ? (draft.checkArguments[2] ?? "")
                            : ""
                        }
                        onChange={(event) =>
                          update({
                            checkExecutable: selectedEnvironment.nodeExecutable,
                            checkArguments: [
                              selectedEnvironment.npmCli,
                              "run",
                              event.target.value,
                            ],
                          })
                        }
                      >
                        <option value="">
                          Custom exact command · inspect advanced details
                        </option>
                        {selectedEnvironment.scripts.map((script: any) => (
                          <option key={script.name} value={script.name}>
                            {script.name} · {script.command}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                <p>
                  Exact check:{" "}
                  <code>
                    {[draft.checkExecutable, ...draft.checkArguments]
                      .map((argument) => JSON.stringify(argument))
                      .join(" ")}
                  </code>
                </p>
                <p>
                  Dependency preparation runs only after review of the exact
                  check recipe. Network, hooks and host isolation follow the
                  disclosed recipe; approval does not create unsupported
                  enforcement.
                </p>
              </section>
            )}
            <details className="full-width">
              <summary>Advanced check definition</summary>
              <label>
                Check executable
                <input
                  value={draft.checkExecutable}
                  onChange={(event) =>
                    update({ checkExecutable: event.target.value })
                  }
                  placeholder={checkRuntime || "Absolute executable path"}
                />
              </label>
              <label>
                Check arguments · one argument per line
                <textarea
                  value={draft.checkArguments.join("\n")}
                  onChange={(event) =>
                    update({ checkArguments: event.target.value.split("\n") })
                  }
                />
              </label>
              <p>
                Saving these fields does not approve execution or prepare an
                environment. Exact commands and permissions require review.
              </p>
            </details>
          </>
        )}
        {draft.step === 3 && (
          <>
            <label>
              Change boundaries · relative paths, one per line
              <textarea
                value={draft.selectedPaths}
                onChange={(event) =>
                  update({ selectedPaths: event.target.value })
                }
                placeholder="Leave empty for the approved tracked candidate scope"
              />
            </label>
            <label>
              Approved new files · relative paths, one per line
              <textarea
                value={draft.approvedUntracked}
                onChange={(event) =>
                  update({ approvedUntracked: event.target.value })
                }
              />
            </label>
            <p className="full-width">
              Candidate coverage and the initial model context are reviewed
              separately. Missing required artifacts block acceptance.
            </p>
          </>
        )}
        {draft.step === 4 && (
          <section className="full-width" aria-label="Workflow plan review">
            <h4>{draft.objective || "Untitled draft"}</h4>
            <p>
              {lines(draft.criteria).length} acceptance criteria ·{" "}
              {builderProvider} builder / {reviewerProvider} reviewer · at most
              two repair rounds.
            </p>
            <dl>
              <dt>Builder requested model</dt>
              <dd>{draft.builderModel || "Unselected"}</dd>
              <dt>Reviewer requested model</dt>
              <dd>{draft.reviewerModel || "Unselected"}</dd>
              <dt>Environment</dt>
              <dd>
                {selectedEnvironment?.label ?? "Not selected"} · preparation
                requires exact check approval
              </dd>
              <dt>New-file policy</dt>
              <dd>
                {lines(draft.approvedUntracked).join(", ") ||
                  "No new files approved"}
              </dd>
            </dl>
            <p>
              No model turn, dependency preparation, native adoption, or
              repository write is authorized by saving a draft.
            </p>
            <div className="workflow-actions">
              <button
                type="button"
                disabled={
                  !!pending ||
                  !guidedEnabled ||
                  !capturable ||
                  !readiness?.runnable
                }
                onClick={() =>
                  void perform("capture", () => capture("coordinated"))
                }
              >
                Capture coordinated workflow
              </button>
              <button
                type="button"
                disabled={!!pending || !capturable}
                onClick={() =>
                  void perform("assisted-capture", () => capture("assisted"))
                }
              >
                Capture for assisted handoff
              </button>
            </div>
            <p>
              Capture records immutable inputs. Coordinated dispatch requires
              the separate Start action and current role qualification; assisted
              opening remains explicit.
            </p>
            <p>
              Assisted handoff remains a separate action and cannot qualify
              automatic execution.
            </p>
          </section>
        )}
        <div className="workflow-actions full-width">
          {draft.step > 0 && (
            <button type="button" onClick={() => move(draft.step - 1)}>
              Back
            </button>
          )}
          {draft.step < 4 && (
            <button type="submit">Continue to {steps[draft.step + 1]}</button>
          )}
          <button
            type="button"
            disabled={!!pending}
            onClick={() => void perform("save", save)}
          >
            {pending === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            type="button"
            disabled={!!pending}
            onClick={() => void perform("reload", loadDraft)}
          >
            Reload saved draft
          </button>
        </div>
      </form>
      <p role="status">
        {savedAt
          ? `Protected draft revision ${revision} saved ${new Date(savedAt).toLocaleString()}.`
          : "Draft has not been saved."}
      </p>
      {created && (
        <p role="status">
          Workflow captured. Use its card below to inspect inputs, prepare an
          assisted handoff or explicitly start a qualified coordinated route.
        </p>
      )}
    </details>
  );
}
