import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  AppState,
  Approval,
  ConfigurationPlan,
  ContextSnapshot,
  Installation,
  LifecyclePlan,
  Message,
  Provider,
} from "../../../packages/domain/types";
import type { Command } from "../../../packages/domain/commands";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Projects } from "./projects";
import { Coordination, type ProjectView } from "./coordination";
import { ActionButton, ActionContext } from "./components/action-button";
import { Transcript } from "./components/transcript";
import { ApprovalCard } from "./components/approval-card";
import { useScopedRefresh } from "./state/scoped";
import { summarizeUsage } from "../../../packages/domain/usage";

type Page =
  | "workspace"
  | "projects"
  | "activity"
  | "applications"
  | "history"
  | "settings";
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: React.ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    ref.current?.showModal();
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus();
    };
  }, []);
  return (
    <dialog ref={ref} aria-label={title} onCancel={close}>
      <div className="modal-heading">
        <h2>{title}</h2>
        <ActionButton aria-label="Close dialog" onClick={close}>
          ×
        </ActionButton>
      </div>
      {children}
    </dialog>
  );
}
function TerminalPanel({
  id,
  initial,
  close,
}: {
  id: string;
  initial: string;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: "Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 3000,
      theme: {
        background: "#202421",
        foreground: "#e7e7dd",
        cursor: "#db9b66",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(ref.current!);
    fit.fit();
    terminal.write(initial);
    terminal.parser.registerOscHandler(52, () => true); // Native output cannot write the system clipboard.
    const input = terminal.onData((data) => {
      void window.topsl
        .command({ type: "terminal-input", id, data })
        .catch(() => {});
    });
    const resize = new ResizeObserver(() => {
      fit.fit();
      void window.topsl
        .command({
          type: "terminal-resize",
          id,
          cols: Math.max(20, terminal.cols),
          rows: Math.max(5, terminal.rows),
        })
        .catch(() => {});
    });
    resize.observe(ref.current!);
    const unsubscribe = window.topsl.subscribe((e) => {
      if (e.type === "terminal" && e.data.id === id)
        terminal.write(e.data.data);
    });
    return () => {
      unsubscribe();
      resize.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [id]);
  return (
    <section className="terminal-panel">
      <div className="terminal-heading">
        <span>
          Native session · native permissions and billing · output stays in
          memory
        </span>
        <ActionButton onClick={close}>Close session</ActionButton>
      </div>
      <div
        className="terminal"
        ref={ref}
        role="region"
        aria-label="Native terminal"
      />
    </section>
  );
}
function Badge({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>("applications");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [operationErrors, setOperationErrors] = useState<
    Record<string, string>
  >({});
  const activeAction = useRef<string | null>(null),
    operationTargets = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  const [projectView, setProjectView] = useState<ProjectView>("overview");
  const [navigationReady, setNavigationReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const selectedProject = useRef(projectId);
  selectedProject.current = projectId;
  const selectedConversation = useRef(conversationId);
  selectedConversation.current = conversationId;
  const selectedRuntime = useRef(installationId);
  selectedRuntime.current = installationId;
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<any[]>([]);
  const [mode, setMode] = useState<"review" | "edit">("review");
  const [plan, setPlan] = useState<LifecyclePlan | null>(null);
  const [snapshot, setSnapshot] = useState<ContextSnapshot | null>(null);
  const [attachedSnapshot, setAttachedSnapshot] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Message[] | null>(null);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [scopedData, setScopedData] = useState<any>(null);
  const scopeGeneration = useRef(0);
  useEffect(() => {
    setScopedData(null);
    setSearchResults(null);
    setSearchCursor(null);
  }, [projectId]);
  useEffect(() => {
    scopeGeneration.current++;
    setPrompt("");
    setSnapshot(null);
    setAttachedSnapshot(null);
    setOperationErrors({});
  }, [projectId, conversationId]);
  useScopedRefresh(projectId, (value) => {
    if (value.projectId === selectedProject.current) setScopedData(value);
  });
  const [provider, setProvider] = useState<Provider>("codex");
  const [configuration, setConfiguration] = useState<{
    path: string;
    text: string;
    hash: string;
    ownership: string;
  } | null>(null);
  const [configPlan, setConfigPlan] = useState<ConfigurationPlan | null>(null);
  const [palette, setPalette] = useState(false);
  const [detail, setDetail] = useState<{ title: string; text: string } | null>(
    null,
  );
  const [passphrase, setPassphrase] = useState("");
  const [terminalId, setTerminalId] = useState("");
  const terminalBuffers = useRef(new Map<string, string>());
  async function act(command: Command): Promise<any> {
    const scopeTicket = scopeGeneration.current;
    const scoped = "projectId" in command || "conversationId" in command;
    const inScope = () =>
      (!scoped || scopeTicket === scopeGeneration.current) &&
      (!("projectId" in command) ||
        !command.projectId ||
        command.projectId === selectedProject.current) &&
      (!("conversationId" in command) ||
        command.conversationId === selectedConversation.current) &&
      (!command.type.startsWith("runtime-") ||
        !("id" in command) ||
        command.id === selectedRuntime.current);
    const key = [
      command.type,
      ...["id", "projectId", "conversationId", "installationId"].map(
        (field) => (command as any)[field] ?? "",
      ),
    ].join(":");
    if (inFlight.current.has(key)) return undefined;
    inFlight.current.add(key);
    if (activeAction.current)
      operationTargets.current.set(key, activeAction.current);
    setPending((p) => ({ ...p, [key]: true }));
    setOperationErrors((p) => ({ ...p, [key]: "" }));
    try {
      const result = await window.topsl.command(command);
      if (!inScope()) return undefined;
      return result;
    } catch (error: any) {
      if (inScope())
        setOperationErrors((p) => ({ ...p, [key]: error.message }));
      return undefined;
    } finally {
      inFlight.current.delete(key);
      operationTargets.current.delete(key);
      setPending((p) => ({ ...p, [key]: false }));
    }
  }
  useEffect(() => {
    if (!state || state.locked || navigationReady) return;
    void window.topsl
      .command({ type: "navigation-query" })
      .then((saved) => {
        if (saved.projectId) setProjectId(saved.projectId);
        if (saved.projectView) setProjectView(saved.projectView);
        setNavigationReady(true);
      })
      .catch(() => setNavigationReady(true));
  }, [state?.locked]);
  useEffect(() => {
    if (navigationReady)
      void window.topsl
        .command({
          type: "navigation-save",
          projectId: projectId || null,
          workflowId: null,
          projectView,
        })
        .catch(() => {});
  }, [navigationReady, projectId, projectView]);
  useEffect(() => {
    void window.topsl
      .command({ type: "state" })
      .then(setState)
      .catch((e) => setNotice(e.message));
    return window.topsl.subscribe((event) => {
      if (event.type === "state") setState(event.data);
      if (event.type === "error") setNotice(event.data);
      if (event.type === "terminal") {
        const { id, data } = event.data;
        terminalBuffers.current.set(
          id,
          ((terminalBuffers.current.get(id) ?? "") + data).slice(-262144),
        );
      }
    });
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.theme = state.theme;
    if (
      navigationReady &&
      (!projectId || !state.projects.some((p) => p.id === projectId)) &&
      state.projects[0]
    )
      setProjectId(state.projects[0].id);
  }, [state, navigationReady]);
  const project = state?.projects.find((p) => p.id === projectId);
  const conversations =
    scopedData?.conversations ??
    state?.conversations.filter((c) => c.projectId === projectId) ??
    [];
  const conversation = conversations.find((c: any) => c.id === conversationId);
  const installation = state?.installations.find(
    (i) => i.id === installationId,
  );
  const messages =
    state?.messages
      .filter((m) => m.conversationId === conversationId)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)) ?? [];
  const runs = (scopedData?.runs ?? state?.runs ?? []).filter(
    (r: any) => r.conversationId === conversationId,
  );
  const active = runs.find((r: any) =>
    ["starting", "running", "awaiting-approval"].includes(r.status),
  );
  const usage =
    (scopedData?.usage ?? state?.usage ?? []).filter((u: any) =>
      runs.some((r: any) => r.id === u.runId),
    ) ?? [];
  const updateCount =
    state?.checks.filter((c) => c.status === "available").length ?? 0;
  async function addProject() {
    const origin = selectedProject.current;
    const result = await act({ type: "project-add" });
    if (result && selectedProject.current === origin) {
      setProjectId(result.id);
      setConversationId("");
      setPage("workspace");
    }
  }
  async function newConversation() {
    if (!projectId) return;
    const result = await act({
      type: "conversation-add",
      projectId,
      title: `Chat ${conversations.length + 1}`,
    });
    if (result) {
      setConversationId(result.id);
      setAttachedSnapshot(null);
    }
  }
  async function openTerminal(login = false) {
    if (!projectId || !installationId) return;
    const id = await act({
      type: "terminal-open",
      projectId,
      installationId,
      login,
    });
    if (id) setTerminalId(id);
  }
  async function connect(i: Installation) {
    const result = await act({ type: "runtime-connect", id: i.id });
    if (result) {
      if (selectedRuntime.current === i.id) setModels(result.models);
      // Discovery preserves the requested model and selected native session.
      setModel((current) => current);
      setDetail({
        title: "Native connection",
        text: JSON.stringify(result, null, 2),
      });
    }
  }
  async function preview(
    i: Installation | null,
    appId: string,
    action: "download" | "install" | "update",
  ) {
    const result = await act({
      type: "lifecycle-preview",
      appId,
      installationId: i?.id ?? null,
      action,
    });
    if (result) setPlan(result);
  }
  if (!state) return <main className="loading">Opening Topsl…</main>;
  if (state.locked)
    return (
      <main className="lock-screen">
        <div className="brand large">
          t<span>Topsl</span>
        </div>
        <h1>Your work stays local.</h1>
        <p>{state.lockReason}</p>
        <p className="muted">
          History and search use an encrypted database. A secure OS credential
          store unlocks it when available, or you can use a passphrase.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act({ type: "unlock", passphrase }).then((value) => {
              if (value) {
                setState(value);
                setPassphrase("");
              }
            });
          }}
        >
          <label>
            Vault passphrase
            <input
              type="password"
              minLength={12}
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
              placeholder="At least 12 characters"
            />
          </label>
          <ActionButton className="primary">Unlock / create vault</ActionButton>
        </form>
        {notice && <p role="alert">{notice}</p>}
      </main>
    );
  return (
    <ActionContext.Provider
      value={{
        active: activeAction,
        pending: new Set(
          Object.keys(pending)
            .filter((key) => pending[key])
            .map((key) => operationTargets.current.get(key) ?? ""),
        ),
      }}
    >
      <div className="app-shell">
        <aside
          className={`sidebar ${navOpen ? "navigation-open" : ""}`}
          aria-label="Workbench navigation"
          id="workbench-sidebar"
        >
          <div className="brand">
            t
            <span>
              Topsl<small>LOCAL WORKBENCH</small>
            </span>
          </div>
          <nav aria-label="Main navigation">
            {(
              ["projects", "activity", "applications", "settings"] as Page[]
            ).map((p, index) => (
              <ActionButton
                key={p}
                aria-label={p[0].toUpperCase() + p.slice(1)}
                className={page === p ? "nav selected" : "nav"}
                aria-current={page === p ? "page" : undefined}
                onClick={() => {
                  setPage(p);
                  setNavOpen(false);
                }}
              >
                <span className="nav-icon">{["⌁", "▤", "⊞", "⚙"][index]}</span>
                <span>{p[0].toUpperCase() + p.slice(1)}</span>
                {p === "applications" && updateCount > 0 && (
                  <b className="count">{updateCount}</b>
                )}
              </ActionButton>
            ))}
          </nav>
          <div className="sidebar-projects">
            <div className="eyebrow">
              PROJECTS{" "}
              <ActionButton
                aria-label="Add project"

                onClick={addProject}
              >
                +
              </ActionButton>
            </div>
            {state.projects.map((p) => (
              <ActionButton
                key={p.id}
                className={
                  "project-link " + (projectId === p.id ? "active" : "")
                }
                onClick={() => {
                  setProjectId(p.id);
                  setConversationId("");
                  setAttachedSnapshot(null);
                  setPage("activity");
                  setProjectView("overview");
                  setNavOpen(false);
                }}
              >
                <span>{p.trusted ? "⌁" : "○"}</span>
                {p.name}
              </ActionButton>
            ))}
            <nav
              className="project-shortcuts"
              aria-label="Native project routes"
            >
              <ActionButton
                onClick={() => {
                  setPage("workspace");
                  setNavOpen(false);
                }}
              >
                Workspace
              </ActionButton>
              <ActionButton
                onClick={() => {
                  setPage("history");
                  setNavOpen(false);
                }}
              >
                History
              </ActionButton>
            </nav>
            {!state.projects.length && (
              <p className="muted tiny">
                Add a folder when you’re ready to work.
              </p>
            )}
          </div>
          <div className="sidebar-bottom">
            <ActionButton
              className="palette-key"
              onClick={() => setPalette(true)}
            >
              Command palette <kbd>⌘ K</kbd>
            </ActionButton>
            <span className="status-dot" /> Local vault unlocked
            <small>Personal pilot · {state.version}</small>
          </div>
        </aside>
        <div className="main-column">
          <header className="topbar">
            <ActionButton
              className="navigation-toggle"
              aria-expanded={navOpen}
              aria-controls="workbench-sidebar"
              onClick={() => setNavOpen((value) => !value)}
            >
              Navigation
            </ActionButton>
            <span>
              {page === "applications"
                ? "Settings / Connections / Applications"
                : `Topsl / ${page[0].toUpperCase() + page.slice(1)}`}
            </span>
            <span>
              {state.platform}
              <span className="header-divider">/</span>
              <span className="status-dot" /> On this computer
            </span>
          </header>
          {state.serviceError && (
            <div className="error-banner" role="alert">
              {state.serviceError}
            </div>
          )}
          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <ActionButton
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                ×
              </ActionButton>
            </div>
          )}
          <main className="content">
            {Object.entries(operationErrors)
              .filter(([, message]) => message)
              .map(([key, message]) => (
                <p key={key} role="alert">
                  {message}{" "}
                  <ActionButton
                    aria-label={`Dismiss ${key} error`}
                    onClick={() =>
                      setOperationErrors((p) => ({ ...p, [key]: "" }))
                    }
                  >
                    Dismiss
                  </ActionButton>
                </p>
              ))}
            {Object.entries(pending)
              .filter(([, active]) => active)
              .map(([key]) => (
                <p key={key} role="status">
                  {key.split(":")[0].replaceAll("-", " ")}…
                </p>
              ))}
            {page === "applications" && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">YOUR TOOLBOX</div>
                    <h1>Applications</h1>
                    <p>Native tools. One place to keep them ready.</p>
                  </div>
                  <div className="actions">
                    <ActionButton
                      onClick={() => void act({ type: "select-runtime" })}
                    >
                      Locate a runtime
                    </ActionButton>
                    <ActionButton
                      onClick={() => void act({ type: "discover" })}
                    >
                      ↻ Discover
                    </ActionButton>
                  </div>
                </div>
                <div className="info-strip">
                  <span className="status-dot" />
                  <div>
                    <strong>You approve every Topsl update.</strong>
                    <span>
                      {" "}
                      Metadata checks run at most daily. Native automatic
                      updates keep their existing settings.
                    </span>
                  </div>
                </div>
                <div className="application-grid">
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
                            <span className="muted tiny">
                              {app.kind === "cli"
                                ? "CLI RUNTIME"
                                : "DESKTOP APPLICATION"}
                            </span>
                          </div>
                          <Badge tone={installations.length ? "good" : ""}>
                            {installations.length
                              ? "Installed"
                              : supported
                                ? "Not found"
                                : "Native app unavailable"}
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
                                  <strong>
                                    {i.version ?? "Version not verified"}
                                  </strong>
                                  <Badge
                                    tone={
                                      check?.status === "available"
                                        ? "warm"
                                        : ""
                                    }
                                  >
                                    {check?.status === "available"
                                      ? `${check.release?.version} available`
                                      : i.compatibility === "compatible"
                                        ? "Protocol connected"
                                        : i.compatibility}
                                  </Badge>
                                </div>
                                <dl>
                                  <div>
                                    <dt>Owner / channel</dt>
                                    <dd>
                                      {i.owner} / {i.channel}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>Native auto-updates</dt>
                                    <dd>
                                      {i.nativeAutoUpdates === "unknown"
                                        ? "Unknown · owner controlled"
                                        : i.nativeAutoUpdates}
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
                                    <ActionButton
                                      onClick={() =>
                                        void act({
                                          type: "trust-installation",
                                          id: i.id,
                                        })
                                      }
                                    >
                                      Trust executable
                                    </ActionButton>
                                  )}
                                  {app.id === "openai.codex-cli" &&
                                    i.trusted && (
                                      <ActionButton onClick={() => connect(i)}>
                                        Connect / test
                                      </ActionButton>
                                    )}
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
                                  {app.kind === "desktop" && (
                                    <ActionButton
                                      onClick={() =>
                                        void act({
                                          type: "open-application",
                                          id: i.id,
                                        })
                                      }
                                    >
                                      Open
                                    </ActionButton>
                                  )}
                                </div>
                                {check && (
                                  <p className="check-detail">
                                    {check.detail}
                                    <br />
                                    Checked{" "}
                                    {new Date(
                                      check.checkedAt,
                                    ).toLocaleString()}{" "}
                                    · next{" "}
                                    {new Date(
                                      check.nextCheckAt,
                                    ).toLocaleString()}
                                  </p>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <div className="not-installed">
                            <span>Ready when you are.</span>
                            <small>
                              Installer availability depends on your OS and
                              architecture.
                            </small>
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
                          Official download / native installer ↗
                        </ActionButton>
                      </article>
                    );
                  })}
                </div>
                <section className="jobs">
                  <div className="section-heading">
                    <h2>Operations</h2>
                    <span className="muted tiny">DURABLE LOCAL JOURNAL</span>
                  </div>
                  {!state.jobs.length ? (
                    <div className="empty-row">
                      No downloads or updates yet. Approved operations will
                      appear here.
                    </div>
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
                                {j.total
                                  ? ` / ${(j.total / 1e6).toFixed(1)} MB`
                                  : ""}
                              </small>
                            </>
                          )}
                          {j.actualVersion && (
                            <small>
                              Installed {j.actualVersion} · compatibility
                              evaluated separately
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
                          {[
                            "queued",
                            "waiting-for-idle",
                            "downloading",
                          ].includes(j.state) && (
                            <ActionButton
                              onClick={() =>
                                void act({ type: "lifecycle-cancel", id: j.id })
                              }
                            >
                              Cancel
                            </ActionButton>
                          )}
                          {["failed", "cancelled", "unchanged"].includes(
                            j.state,
                          ) && (
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
                          {[
                            "uncertain",
                            "awaiting-native",
                            "waiting-for-idle",
                          ].includes(j.state) && (
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
            )}
            {page === "activity" && (
              <Coordination
                key={projectId}
                projectId={projectId}
                view={projectView}
                onView={setProjectView}
              />
            )}
            {page === "projects" && (
              <Projects
                state={state}
                busy={false}
                act={act}
                addProject={addProject}
                selectProject={(id) => {
                  setProjectId(id);
                  setConversationId("");
                  setAttachedSnapshot(null);
                  setPage("workspace");
                }}
                openTerminal={(id, terminal) => {
                  setProjectId(id);
                  setConversationId("");
                  setAttachedSnapshot(null);
                  setTerminalId(terminal);
                  setPage("workspace");
                }}
              />
            )}
            {page === "workspace" && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">A PLACE FOR THE WORK</div>
                    <h1>{project?.name ?? "Your workspace"}</h1>
                    <p>
                      {project?.path ??
                        "Bring a trusted folder and your native coding tools."}
                    </p>
                  </div>
                  <ActionButton
                    className="primary"

                    onClick={addProject}
                  >
                    + Add project
                  </ActionButton>
                </div>
                <div className="actions wrap">
                  <ActionButton onClick={() => setPage("projects")}>
                    Manage shared projects
                  </ActionButton>
                  {project &&
                    (!project.trusted ||
                      (project.availability &&
                        project.availability !== "available")) && (
                      <span className="tiny">
                        {project.availability === "missing" ||
                        project.availability === "changed"
                          ? "Relink this folder in Projects before starting a session."
                          : "Trust this discovered folder in Projects before starting a session."}
                      </span>
                    )}
                </div>
                {!project ? (
                  <div className="onboarding">
                    <span className="large-glyph">⌁</span>
                    <h2>Start with a project.</h2>
                    <p>
                      Choose a folder, review your runtime, then open a native
                      session. Your history and handoffs stay in the local
                      vault.
                    </p>
                    <div className="onboarding-steps">
                      <span>01 · Connect a tool</span>
                      <span>02 · Trust a folder</span>
                      <span>03 · Start a session</span>
                    </div>
                    <ActionButton onClick={() => setPage("applications")}>
                      Manage applications
                    </ActionButton>
                  </div>
                ) : (
                  <>
                    <div className="runtime-bar">
                      <label>
                        Runtime
                        <select
                          value={installationId}
                          onChange={(e) => {
                            setInstallationId(e.target.value);
                            setModels([]);
                          }}
                        >
                          <option value="">Select a native runtime</option>
                          {state.installations
                            .filter((i) => i.appId.endsWith("cli"))
                            .map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.appId.includes("claude")
                                  ? "Claude Code"
                                  : "Codex"}{" "}
                                · {i.version ?? "unverified"} · {i.owner}
                              </option>
                            ))}
                          {!state.installations.some((i) =>
                            i.appId.endsWith("cli"),
                          ) && <option value="">No runtime found</option>}
                        </select>
                      </label>
                      <div className="actions wrap">
                        <ActionButton
                          disabled={!installation}
                          onClick={() => openTerminal()}
                        >
                          Native terminal
                        </ActionButton>
                        <ActionButton
                          disabled={!installation}
                          onClick={() => openTerminal(true)}
                        >
                          Native login
                        </ActionButton>
                        {installation?.appId === "openai.codex-cli" && (
                          <ActionButton
                            disabled={!installation.trusted}
                            onClick={() => connect(installation)}
                          >
                            Models & account
                          </ActionButton>
                        )}
                      </div>
                    </div>
                    <div className="chat-tabs">
                      <select
                        aria-label="Conversation"
                        value={conversationId}
                        onChange={(e) => {
                          setConversationId(e.target.value);
                          setAttachedSnapshot(null);
                        }}
                      >
                        <option value="">Choose a conversation</option>
                        {conversations.map((c: any) => (
                          <option key={c.id} value={c.id}>
                            {c.title}
                          </option>
                        ))}
                      </select>
                      <ActionButton onClick={newConversation}>
                        + New chat
                      </ActionButton>
                      {scopedData?.conversationCursor && (
                        <ActionButton
                          disabled={pending["history-conversations"]}
                          onClick={async () => {
                            const result = await act({
                              type: "history-conversations",
                              projectId,
                              cursor: scopedData.conversationCursor,
                              limit: 200,
                            });
                            if (result)
                              setScopedData((current: any) => ({
                                ...current,
                                conversations: [
                                  ...current.conversations,
                                  ...result.items,
                                ],
                                conversationCursor: result.nextCursor,
                              }));
                          }}
                        >
                          Load older chats
                        </ActionButton>
                      )}
                      {conversation && (
                        <ActionButton
                          onClick={async () => {
                            const value = await act({
                              type: "handoff-preview",
                              conversationId,
                              provider: installation?.appId.includes("claude")
                                ? "claude"
                                : "codex",
                              objective:
                                prompt ||
                                "Continue this work with the selected provider.",
                            });
                            if (value) setSnapshot(value);
                          }}
                        >
                          Prepare handoff
                        </ActionButton>
                      )}
                    </div>
                    {terminalId && (
                      <TerminalPanel
                        key={terminalId}
                        id={terminalId}
                        initial={terminalBuffers.current.get(terminalId) ?? ""}
                        close={() => {
                          void act({ type: "terminal-close", id: terminalId });
                          setTerminalId("");
                        }}
                      />
                    )}{" "}
                    {!terminalId &&
                      (scopedData?.terminals ?? state.terminals)
                        .filter((t: any) => t.projectId === projectId)
                        .map((t: any) => (
                          <ActionButton
                            key={t.id}
                            onClick={() => setTerminalId(t.id)}
                          >
                            Show active native terminal
                          </ActionButton>
                        ))}
                    <div className="conversation">
                      <div className="conversation-heading">
                        <span>{conversation?.title ?? "Shared history"}</span>
                        <span className="muted tiny">
                          PROVIDER ATTRIBUTION PRESERVED
                        </span>
                      </div>
                      <Transcript
                        key={`${projectId}:${conversationId}`}
                        projectId={projectId}
                        conversationId={conversationId}
                      />
                    </div>
                    {runs.map((r: any) => (
                      <div className="run-status" key={r.id}>
                        <span>
                          <Badge tone={r.status === "completed" ? "good" : ""}>
                            {r.status}
                          </Badge>{" "}
                          {r.provider} · {r.runtimeVersion ?? "unknown version"}{" "}
                          · {r.model}
                          <small>
                            Run {r.id.slice(0, 8)} · installation revision{" "}
                            {r.installationRevisionId.slice(0, 10)}
                          </small>
                          {r.error && <p>{r.error}</p>}
                        </span>
                        {r.status === "uncertain" && (
                          <ActionButton
                            onClick={() =>
                              void act({ type: "run-reconcile", id: r.id })
                            }
                          >
                            Inspect & reconcile
                          </ActionButton>
                        )}
                        {r.id === active?.id && (
                          <ActionButton
                            onClick={() =>
                              void act({ type: "run-interrupt", id: r.id })
                            }
                          >
                            Interrupt
                          </ActionButton>
                        )}
                      </div>
                    ))}
                    {(scopedData?.approvals ?? state.approvals)
                      .filter((a: any) =>
                        runs.some((r: any) => r.id === a.runId),
                      )
                      .map((a: Approval) => (
                        <ApprovalCard
                          key={a.id}
                          approval={a}
                          decide={(allow) =>
                            act({ type: "approval-decide", id: a.id, allow })
                          }
                        />
                      ))}
                    <form
                      className="composer"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!conversation || !installation) return;
                        const value = await act({
                          type: "run-start",
                          conversationId,
                          installationId,
                          prompt,
                          model,
                          mode,
                          snapshotId: attachedSnapshot,
                        });
                        if (value) {
                          setPrompt("");
                          setAttachedSnapshot(null);
                        }
                      }}
                    >
                      <textarea
                        aria-label="Message"
                        placeholder="What would you like to work on?"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={3}
                      />
                      {attachedSnapshot && (
                        <span className="tiny">
                          Reviewed handoff attached{" "}
                          <ActionButton
                            type="button"
                            className="text-button"
                            onClick={() => setAttachedSnapshot(null)}
                          >
                            Remove
                          </ActionButton>
                        </span>
                      )}
                      <div className="composer-controls">
                        <label>
                          Model
                          <select
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                          >
                            <option value="">Select a requested model</option>
                            {model &&
                              !models.some((m) => m.model === model) && (
                                <option value={model}>
                                  {model} · unconfirmed
                                </option>
                              )}
                            {models.map((m) => (
                              <option key={m.id} value={m.model}>
                                {m.name ?? m.model}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Permissions
                          <select
                            value={mode}
                            onChange={(e) =>
                              setMode(e.target.value as "review" | "edit")
                            }
                          >
                            <option value="review">Read-only review</option>
                            <option value="edit">Workspace edits · ask</option>
                          </select>
                        </label>
                        <ActionButton
                          className="primary"
                          disabled={
                            !!active ||
                            !conversation ||
                            !prompt.trim() ||
                            !model ||
                            installation?.compatibility !== "compatible" ||
                            installation?.appId !== "openai.codex-cli"
                          }
                        >
                          Send to Codex ↑
                        </ActionButton>
                      </div>
                      <p className="tiny muted">
                        Codex uses an experimental local stdio adapter. Claude
                        and provider-specific features use the native terminal.
                        Native terminal history can be imported explicitly.
                      </p>
                    </form>
                    <div className="usage-line">
                      Native-reported usage:{" "}
                      {summarizeUsage(
                        usage,
                        runs.map((run: any) => run.id),
                      ).knownInput.toLocaleString()}{" "}
                      known input ·{" "}
                      {summarizeUsage(
                        usage,
                        runs.map((run: any) => run.id),
                      ).knownOutput.toLocaleString()}{" "}
                      known output ·{" "}
                      {summarizeUsage(
                        usage,
                        runs.map((run: any) => run.id),
                      ).complete
                        ? "complete recorded coverage"
                        : "incomplete coverage; missing usage is unknown"}
                      . Native allowance is unknown until reported; provider
                      billing remains authoritative.
                    </div>
                  </>
                )}
              </>
            )}
            {page === "history" && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">LOCAL, SEARCHABLE, ATTRIBUTED</div>
                    <h1>History</h1>
                    <p>Pick up the thread without losing where it came from.</p>
                  </div>
                </div>
                <div className="runtime-bar">
                  <label>
                    Project
                    <select
                      value={projectId}
                      onChange={(e) => {
                        setProjectId(e.target.value);
                        setSearchResults(null);
                      }}
                    >
                      {state.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="actions">
                    <ActionButton
                      disabled={!projectId}
                      onClick={() =>
                        void act({
                          type: "history-import",
                          projectId,
                          provider: "codex",
                        })
                      }
                    >
                      Import Codex JSONL
                    </ActionButton>
                    <ActionButton
                      disabled={!projectId}
                      onClick={() =>
                        void act({
                          type: "history-import",
                          projectId,
                          provider: "claude",
                        })
                      }
                    >
                      Import Claude JSONL
                    </ActionButton>
                  </div>
                </div>
                <form
                  className="search"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const result = await act({
                      type: "history-page",
                      projectId,
                      query,
                      limit: 80,
                    });
                    if (result) {
                      setSearchResults(result.items);
                      setSearchCursor(result.nextCursor);
                    }
                  }}
                >
                  <input
                    aria-label="Search project history"
                    placeholder="Search this project’s history…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <ActionButton className="primary" disabled={!projectId}>
                    Search
                  </ActionButton>
                </form>
                {searchResults ? (
                  <>
                    <p className="muted">
                      {searchResults.length} matching messages{" "}
                      <ActionButton
                        className="text-button"
                        onClick={() => setSearchResults(null)}
                      >
                        Clear
                      </ActionButton>
                    </p>
                    {searchCursor && (
                      <ActionButton
                        disabled={pending["history-page"]}
                        onClick={async () => {
                          const result = await act({
                            type: "history-page",
                            projectId,
                            query,
                            cursor: searchCursor,
                            limit: 80,
                          });
                          if (result) {
                            setSearchResults((current) => [
                              ...(current ?? []),
                              ...result.items,
                            ]);
                            setSearchCursor(result.nextCursor);
                          }
                        }}
                      >
                        Load more search matches
                      </ActionButton>
                    )}
                    {searchResults.map((m) => (
                      <article key={m.id} className="history-result">
                        <div className="message-meta">
                          {m.provider} / {m.role}
                          <ActionButton
                            onClick={() => {
                              setConversationId(m.conversationId);
                              setPage("workspace");
                            }}
                          >
                            Open conversation →
                          </ActionButton>
                        </div>
                        <pre>{m.text}</pre>
                      </article>
                    ))}
                  </>
                ) : conversations.length ? (
                  conversations.map((c: any) => (
                    <div className="history-row" key={c.id}>
                      <ActionButton
                        className="text-button"
                        onClick={() => {
                          setConversationId(c.id);
                          setPage("workspace");
                        }}
                      >
                        {c.title} →
                      </ActionButton>
                      <span>{new Date(c.createdAt).toLocaleDateString()}</span>
                      <ActionButton
                        onClick={() =>
                          void act({ type: "history-delete", id: c.id })
                        }
                      >
                        Delete locally
                      </ActionButton>
                    </div>
                  ))
                ) : (
                  <div className="onboarding">
                    <h2>A clear record of your work.</h2>
                    <p>
                      Structured sessions appear here. Import native transcripts
                      when you want them included in search and handoffs.
                    </p>
                  </div>
                )}
              </>
            )}
            {page === "settings" && (
              <>
                <div className="page-heading">
                  <div>
                    <div className="eyebrow">SETTINGS / CONNECTIONS</div>
                    <h1>Make it your workspace.</h1>
                    <p>
                      Native configuration stays native. Every write has a
                      preview.
                    </p>
                  </div>
                </div>
                <section className="settings-card">
                  <h2>Appearance</h2>
                  <div className="actions">
                    {(["paper", "night", "system"] as const).map((theme) => (
                      <ActionButton
                        key={theme}
                        className={state.theme === theme ? "primary" : ""}
                        onClick={() => void act({ type: "theme", theme })}
                      >
                        {theme[0].toUpperCase() + theme.slice(1)}
                      </ActionButton>
                    ))}
                  </div>
                </section>
                <section className="settings-card">
                  <div className="section-heading">
                    <h2>Native capabilities</h2>
                    <ActionButton onClick={() => setPage("applications")}>
                      Applications →
                    </ActionButton>
                  </div>
                  <div className="capabilities">
                    {state.capabilities.map((c) => (
                      <div key={c.id}>
                        <strong>{c.name}</strong>
                        <Badge>{c.route}</Badge>
                        <p>{c.description}</p>
                      </div>
                    ))}
                  </div>
                </section>
                <section className="settings-card">
                  <h2>Configuration & instructions</h2>
                  <div className="runtime-bar">
                    <label>
                      Provider
                      <select
                        value={provider}
                        onChange={(e) => {
                          setProvider(e.target.value as Provider);
                          setConfiguration(null);
                        }}
                      >
                        <option value="codex">Codex</option>
                        <option value="claude">Claude Code</option>
                      </select>
                    </label>
                    <div className="actions wrap">
                      <ActionButton
                        onClick={async () => {
                          const result = await act({
                            type: "configuration-read",
                            provider,
                            projectId: null,
                            kind: "native",
                          });
                          if (result) setConfiguration(result);
                        }}
                      >
                        Global settings
                      </ActionButton>
                      <ActionButton
                        disabled={!projectId}
                        onClick={async () => {
                          const result = await act({
                            type: "configuration-read",
                            provider,
                            projectId,
                            kind: "native",
                          });
                          if (result) setConfiguration(result);
                        }}
                      >
                        Project settings
                      </ActionButton>
                      <ActionButton
                        disabled={!projectId}
                        onClick={async () => {
                          const result = await act({
                            type: "configuration-read",
                            provider,
                            projectId,
                            kind: "instructions",
                          });
                          if (result) setConfiguration(result);
                        }}
                      >
                        Project instructions
                      </ActionButton>
                    </div>
                  </div>
                  {configuration && (
                    <>
                      <p className="path">{configuration.path}</p>
                      <p className="muted tiny">{configuration.ownership}</p>
                      <textarea
                        className="config-editor"
                        aria-label="Native configuration text"
                        value={configuration.text}
                        onChange={(e) =>
                          setConfiguration({
                            ...configuration,
                            text: e.target.value,
                          })
                        }
                      />
                      <ActionButton
                        onClick={async () => {
                          const result = await act({
                            type: "configuration-preview",
                            path: configuration.path,
                            expectedHash: configuration.hash,
                            text: configuration.text,
                          });
                          if (result) setConfigPlan(result);
                        }}
                      >
                        Preview changes
                      </ActionButton>
                    </>
                  )}
                </section>
                <section className="settings-card">
                  <h2>Recent configuration writes</h2>
                  {state.configurationWrites.length ? (
                    state.configurationWrites.map((write) => (
                      <div className="history-row" key={write.id}>
                        <code className="path">{write.path}</code>
                        <Badge>{write.state}</Badge>
                      </div>
                    ))
                  ) : (
                    <p>No native files have been changed through Topsl.</p>
                  )}
                </section>
                <section className="settings-card">
                  <h2>Project context connection</h2>
                  <p>
                    Allow a native MCP client to search one project’s Topsl
                    history. The connection has no administrative authority and
                    expires when Topsl closes.
                  </p>
                  <ActionButton
                    disabled={!projectId}
                    onClick={async () => {
                      const result = await act({
                        type: "context-enable",
                        projectId,
                      });
                      if (result)
                        setDetail({
                          title: "Read-only project context",
                          text: `Grant file: ${result.file}\n\n${result.expires}\n\nRun the companion with a Node.js installation:\nnode ${JSON.stringify(result.companionPath)} mcp ${JSON.stringify(result.file)}\n\nUse this executable and argument list in your native MCP configuration. Keep the grant file private.`,
                        });
                    }}
                  >
                    Create grant for {project?.name ?? "a project"}
                  </ActionButton>
                </section>
              </>
            )}
          </main>
          <footer className="statusbar">
            <span>
              {Object.values(pending).some(Boolean)
                ? "Operations pending"
                : "Ready"}{" "}
              <span className="muted">/ Protected local history</span>
            </span>
            <span>Native credentials stay with their provider</span>
          </footer>
        </div>
        {plan && (
          <Modal title={`Review ${plan.action}`} close={() => setPlan(null)}>
            <Badge>
              {plan.route === "native"
                ? "Complete in native installer / store"
                : plan.route}
            </Badge>
            <ul className="review-list">
              {plan.effects.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            {plan.release && (
              <pre className="technical">
                {plan.release.url}\nSHA-256:{" "}
                {plan.release.sha256 ?? "Unavailable"}\nArtifact:{" "}
                {plan.release.artifactName}
              </pre>
            )}
            {plan.command && (
              <pre className="technical">
                {plan.command.executable} {plan.command.args.join(" ")}
              </pre>
            )}
            <p className="muted tiny">
              Approval expires {new Date(plan.expiresAt).toLocaleTimeString()}.
              Applying requires confirmation in a native Topsl dialog.
            </p>
            <div className="modal-actions">
              <ActionButton onClick={() => setPlan(null)}>Cancel</ActionButton>
              <ActionButton
                className="primary"

                onClick={async () => {
                  const result = await act({
                    type: "lifecycle-apply",
                    id: plan.id,
                  });
                  if (result) setPlan(null);
                }}
              >
                {plan.action === "download"
                  ? "Download only…"
                  : "Approve operation…"}
              </ActionButton>
            </div>
          </Modal>
        )}
        {snapshot && (
          <Modal
            title={`Handoff to ${snapshot.provider}`}
            close={() => setSnapshot(null)}
          >
            <p>
              Review the exact context below. This is a new input to the
              destination provider, with its own native session and billing.
            </p>
            <pre className="snapshot">{snapshot.text}</pre>
            <p className="tiny muted">Snapshot SHA-256: {snapshot.hash}</p>
            <div className="modal-actions">
              <ActionButton
                onClick={() =>
                  void act({ type: "handoff-export", id: snapshot.id })
                }
              >
                Export Markdown…
              </ActionButton>
              {snapshot.provider === "codex" && (
                <ActionButton
                  className="primary"
                  onClick={() => {
                    setAttachedSnapshot(snapshot.id);
                    setSnapshot(null);
                  }}
                >
                  Attach to next Codex message
                </ActionButton>
              )}
            </div>
          </Modal>
        )}
        {configPlan && (
          <Modal
            title="Review configuration change"
            close={() => setConfigPlan(null)}
          >
            <code className="path">{configPlan.path}</code>
            <div className="config-diff">
              <section>
                <h3>Current</h3>
                <pre>{configPlan.before || "(empty)"}</pre>
              </section>
              <section>
                <h3>Proposed</h3>
                <pre>{configPlan.after || "(empty)"}</pre>
              </section>
            </div>
            <div className="modal-actions">
              <ActionButton onClick={() => setConfigPlan(null)}>
                Cancel
              </ActionButton>
              <ActionButton
                className="primary"

                onClick={async () => {
                  try {
                    const result = await act({
                      type: "configuration-apply",
                      id: configPlan.id,
                    });
                    if (result?.applied) {
                      setNotice(
                        "Reviewed configuration written. Native reload remains unverified.",
                      );
                      setConfigPlan(null);
                      setConfiguration(null);
                    }
                  } catch (e: any) {
                    setNotice(e.message);
                  }
                }}
              >
                Apply reviewed file…
              </ActionButton>
            </div>
          </Modal>
        )}
        {detail && (
          <Modal title={detail.title} close={() => setDetail(null)}>
            <pre className="snapshot">{detail.text}</pre>
          </Modal>
        )}
        {palette && (
          <Modal title="Command palette" close={() => setPalette(false)}>
            <div className="palette">
              {(
                [
                  "workspace",
                  "projects",
                  "applications",
                  "history",
                  "settings",
                ] as Page[]
              ).map((p) => (
                <ActionButton
                  key={p}
                  onClick={() => {
                    setPage(p);
                    setPalette(false);
                  }}
                >
                  {p[0].toUpperCase() + p.slice(1)} →
                </ActionButton>
              ))}
              <ActionButton
                onClick={() => {
                  setPalette(false);
                  void addProject();
                }}
              >
                Add trusted project →
              </ActionButton>
              <ActionButton
                onClick={() => {
                  setPalette(false);
                  void act({ type: "discover" });
                }}
              >
                Discover applications →
              </ActionButton>
            </div>
          </Modal>
        )}
      </div>
    </ActionContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
