import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AppState,
  Approval,
  ConfigurationPlan,
  ContextSnapshot,
  Installation,
  LifecyclePlan,
  Message,
  Provider,
  Run,
} from "../../../packages/domain/types";
import type { Command } from "../../../packages/domain/commands";
import "./style.css";
import { Projects } from "./projects";
import { Coordination } from "./coordination";
import { ActionButton, ActionContext } from "./components/action-button";
import { Transcript } from "./components/transcript";
import { ApprovalCard } from "./components/approval-card";
import {
  recordTerminalOutput,
  TerminalPanel,
} from "./components/terminal-panel";
import {
  findTerminalMode,
  startingTerminalMode,
  terminalModeText,
  terminalProvider,
  TerminalModeNote,
  TerminalModeSelect,
} from "./components/terminal-mode";
import type { TerminalModeId } from "../../../packages/domain/terminal-modes";
import {
  chatPreset,
  chatPresetFor,
  chatPresetNote,
  chatPresets,
  reportedPermissionsText,
  type ChatPresetId,
} from "../../../packages/domain/chat-presets";
import {
  autoAcceptChatNote,
  autoAcceptOptions,
} from "../../../packages/domain/auto-accept";
import { useScopedRefresh } from "./state/scoped";
import { breadcrumb, useThreadIndex } from "./state/threads";
import { summarizeUsage } from "../../../packages/domain/usage";
import { SettingsScreen } from "./screens/settings";
import { HistoryScreen } from "./screens/history";
import { ProvidersScreen } from "./screens/providers";
import {
  WorkbenchSidebar,
  type GlobalPage,
} from "./components/workbench-sidebar";
import { AtlasIcon, Brand, Badge } from "./components/atlas";
import {
  projectDestinations,
  projectView as validProjectView,
  viewLabel,
  type ProjectView,
} from "../../../packages/domain/navigation";
import "./atlas.css";

type Page = GlobalPage | "project";
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
/** Says what the handoff limits left out of a snapshot, before its text. */
function HandoffOmissions({ snapshot }: { snapshot: ContextSnapshot }) {
  const omissions = snapshot.omissions;
  if (!omissions) return null;
  const dropped = omissions.droppedMessageIds.length,
    clipped = omissions.clippedMessageIds.length;
  const lines = [
    omissions.olderMessages &&
      "Messages older than the newest 30 in this conversation are not included.",
    dropped > 0 &&
      `${dropped === 1 ? "The oldest message considered is" : `The ${dropped} oldest messages considered are`} not included, to keep the handoff within 150,000 characters.`,
    clipped > 0 &&
      `${clipped === 1 ? "1 message is" : `${clipped} messages are`} shortened to the first 12,000 characters; ${clipped === 1 ? "its heading says" : "their headings say"} so.`,
  ].filter((line): line is string => typeof line === "string");
  if (!lines.length) return null;
  return (
    <div className="handoff-omissions" role="note" aria-label="Omitted context">
      <strong>Not the whole conversation.</strong>
      <ul>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>("projects");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [operationErrors, setOperationErrors] = useState<
    Record<string, string>
  >({});
  const activeAction = useRef<string | null>(null),
    operationTargets = useRef(new Map<string, string>());
  const inFlight = useRef(new Set<string>());
  const [projectView, setProjectView] = useState<ProjectView>("coordinator");
  /** The section a destination opens at, such as Advanced workflows' Activity. */
  const [section, setSection] = useState<string | null>(null);
  /** An import the New session page attaches, by project (Settings → Imports). */
  const [attachments, setAttachments] = useState<Record<string, string>>({});
  /** Fences a project's last-viewed lookup against a later project choice. */
  const projectTicket = useRef(0);
  const [navigationReady, setNavigationReady] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  /** The open coordinator thread (`session:<id>` or `loop:<id>`), if any. */
  const [threadId, setThreadId] = useState<string | null>(null);
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
  const [chatPresetId, setChatPresetId] = useState<ChatPresetId>("review");
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
  /** A mode picked for the next terminal; otherwise auto-accept's or the project's remembered one. */
  const [terminalModeChoice, setTerminalModeChoice] =
    useState<TerminalModeId | null>(null);
  useEffect(() => setTerminalModeChoice(null), [projectId, installationId]);
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
        if (state.projects.some((project) => project.id === saved.projectId)) {
          setProjectId(saved.projectId);
          setProjectView(validProjectView(saved.projectView));
          setSection(saved.section ?? null);
          setThreadId(saved.threadId ?? null);
          setPage("project");
        }
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
          threadId,
        })
        .catch(() => {});
  }, [navigationReady, projectId, projectView, threadId]);
  useEffect(() => {
    void window.topsl
      .command({ type: "state" })
      .then(setState)
      .catch((e) => setNotice(e.message));
    return window.topsl.subscribe((event) => {
      if (event.type === "state") setState(event.data);
      if (event.type === "error") setNotice(event.data);
      if (event.type === "terminal")
        recordTerminalOutput(event.data.id, event.data.data);
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
      projectId &&
      !state.projects.some((project) => project.id === projectId)
    ) {
      setProjectId("");
      setProjectView("coordinator");
      setThreadId(null);
      setPage("projects");
    }
  }, [state, navigationReady]);
  function openProjectView(view: ProjectView, next: string | null = null) {
    setProjectView(view);
    setSection(next);
    setPage("project");
    setNavOpen(false);
  }
  /** Switches the selected project, leaving its terminal and chat behind. */
  function switchProject(id: string) {
    projectTicket.current++;
    if (id === projectId) return;
    setProjectId(id);
    setThreadId(null);
    setConversationId("");
    setAttachedSnapshot(null);
    setTerminalId("");
  }
  /**
   * Opens a project where the owner left it: its last viewed session, else
   * its newest one, else New session. A later choice wins over a lookup
   * still in flight, so rapid switching lands on the last project chosen.
   */
  function openProject(id: string) {
    switchProject(id);
    const ticket = projectTicket.current;
    openProjectView("coordinator");
    void window.topsl
      .command({ type: "navigation-query", projectId: id })
      .then((saved) => {
        if (ticket === projectTicket.current) setThreadId(saved.threadId);
      })
      .catch(() => {});
  }
  /** Opens one of a project's destinations from its menu. */
  function selectView(view: ProjectView, id = projectId) {
    switchProject(id);
    openProjectView(view);
  }
  /** Opens one session or loop, or the project's New session page with none. */
  function openThread(next: string | null, inProject = projectId) {
    switchProject(inProject);
    setThreadId(next);
    openProjectView("coordinator");
  }
  /** Settings → Imports: New session in that project with the import attached. */
  function continueImport(id: string, referenceId: string) {
    setAttachments((current) => ({ ...current, [id]: referenceId }));
    openThread(null, id);
  }
  const project = state?.projects.find((p) => p.id === projectId);
  const threadIndex = useThreadIndex(
    state?.locked ? [] : (state?.projects.map((p) => p.id) ?? []),
  );
  const conversations =
    scopedData?.conversations ??
    state?.conversations.filter((c) => c.projectId === projectId) ??
    [];
  const conversation = conversations.find((c: any) => c.id === conversationId);
  const installation = state?.installations.find(
    (i) => i.id === installationId,
  );
  const terminalModeValue: TerminalModeId =
    terminalModeChoice ??
    (installation && state
      ? startingTerminalMode(state, projectId, terminalProvider(installation))
      : "provider-default");
  /** The permission mode Topsl asked for when it opened a terminal, if any. */
  const openedMode = (runtimeId: string, mode: string | null | undefined) => {
    const runtime = state?.installations.find((i) => i.id === runtimeId);
    return runtime && findTerminalMode(terminalProvider(runtime), mode);
  };
  /** A run's requested terminal mode or chat preset, and any auto-accept it
   * ran under, as it reads after the run's model. */
  const requestedMode = (run: Run) => {
    const mode = findTerminalMode(run.provider, run.permissionMode);
    if (mode) return ` · ${terminalModeText(mode)}`;
    const preset =
        run.provider === "codex" && chatPresetFor(run.mode, run.approvalPolicy),
      auto = autoAcceptOptions.find((o) => o.level === run.autoAccept);
    return `${preset ? ` · ${preset.label}` : ""}${
      auto
        ? ` · auto-accept ${auto.label}${
            run.autoAllowed
              ? `, ${run.autoAllowed} ${run.autoAllowed === 1 ? "request" : "requests"} allowed`
              : ""
          }`
        : ""
    }`;
  };
  const selectedPreset = chatPreset(chatPresetId);
  /** Why each chat preset is unavailable on the selected runtime. */
  const presetBlocks = new Map(
    (state?.chatPresetBlocks ?? [])
      .filter((block) => block.installationId === installationId)
      .map((block) => [block.preset, block.reason]),
  );
  const presetBlocked = presetBlocks.get(chatPresetId);
  /** What auto-accept does to the selected preset, if anything. */
  const autoAcceptNote =
    state &&
    autoAcceptChatNote(
      state.autoAccept,
      selectedPreset,
      presetBlocks.get("edit-never"),
    );
  /** An open terminal's mode, as it reads on the button that shows it. */
  const openedLabel = (terminal: AppState["terminals"][number]) => {
    const mode = openedMode(terminal.installationId, terminal.permissionMode);
    return mode ? ` · ${mode.label}` : "";
  };
  const runs = (scopedData?.runs ?? state?.runs ?? []).filter(
    (r: any) => r.conversationId === conversationId,
  );
  const active = runs.find((r: any) =>
    ["starting", "running", "awaiting-approval"].includes(r.status),
  );
  const usage = (scopedData?.usage ?? state?.usage ?? []).filter((u: any) =>
    runs.some((r: any) => r.id === u.runId),
  );
  const sessionUsage = summarizeUsage(
    usage,
    runs.map((run: any) => run.id),
  );
  async function addProject() {
    const origin = selectedProject.current;
    const result = await act({ type: "project-add" });
    if (result && selectedProject.current === origin) openProject(result.id);
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
      permissionMode: login ? "provider-default" : terminalModeValue,
    });
    // The menu returns to the project's remembered mode, which is never a bypass mode.
    setTerminalModeChoice(null);
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
  if (!state)
    return (
      <main className="loading">
        <Brand large />
        <p role="status">Opening your local atlas…</p>
      </main>
    );
  if (state.locked)
    return (
      <main className="lock-screen">
        <Brand large />
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
        <WorkbenchSidebar
          state={state}
          page={page}
          projectId={projectId}
          view={projectView}
          open={navOpen}
          close={() => setNavOpen(false)}
          navigate={setPage}
          openProject={openProject}
          selectView={selectView}
          addProject={addProject}
          palette={() => setPalette(true)}
          threads={threadIndex}
          threadId={threadId}
          openThread={openThread}
        />
        <div className="main-column">
          <header className="topbar">
            <ActionButton
              className="navigation-toggle"
              aria-expanded={navOpen}
              aria-controls="workbench-sidebar"
              onClick={() => setNavOpen((value) => !value)}
            >
              <AtlasIcon name="menu" /> Navigation
            </ActionButton>
            <span>
              {breadcrumb({
                page,
                projectName: project?.name,
                view: projectView,
                viewLabel: viewLabel(projectView),
                threadTitle: threadId
                  ? (threadIndex[projectId]?.threads.find(
                      (t) => t.threadId === threadId,
                    )?.title ?? "Conversation")
                  : null,
              })}
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
            {page === "providers" && (
              <ProvidersScreen
                state={state}
                act={act}
                connect={connect}
                preview={preview}
                setPlan={setPlan}
              />
            )}
            {page === "projects" && (
              <Projects
                state={state}
                busy={false}
                act={act}
                addProject={addProject}
                selectProject={openProject}
                openTerminal={(id, terminal) => {
                  switchProject(id);
                  setTerminalId(terminal);
                  openProjectView("sessions");
                }}
              />
            )}
            <div hidden={page !== "project"}>
              <Coordination
                key={projectId}
                project={project}
                view={projectView}
                section={section}
                onView={openProjectView}
                threadId={threadId}
                onThread={(next) => openThread(next)}
                attachment={attachments[projectId] ?? null}
                onAttachment={(referenceId) =>
                  setAttachments((current) => {
                    const next = { ...current };
                    if (referenceId) next[projectId] = referenceId;
                    else delete next[projectId];
                    return next;
                  })
                }
                sessionsContent={
                  <>
                    {project &&
                      (!project.trusted ||
                        (project.availability &&
                          project.availability !== "available")) && (
                        <span className="tiny">
                          {project.availability === "missing" ||
                          project.availability === "changed"
                            ? "Relink this folder in Projects before starting a session."
                            : "Trust this folder in Projects before starting a session."}
                        </span>
                      )}
                    {!project ? null : (
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
                              ) && (
                                <option value="">
                                  {state.testProfile
                                    ? "No runtime in this test profile"
                                    : "No runtime found"}
                                </option>
                              )}
                            </select>
                          </label>
                          {installation && (
                            <TerminalModeSelect
                              provider={terminalProvider(installation)}
                              value={terminalModeValue}
                              onChange={setTerminalModeChoice}
                            />
                          )}
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
                        {installation && (
                          <TerminalModeNote
                            provider={terminalProvider(installation)}
                            value={terminalModeValue}
                          />
                        )}
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
                                  provider: installation
                                    ? terminalProvider(installation)
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
                            mode={(() => {
                              const open = (
                                scopedData?.terminals ?? state.terminals
                              ).find((t: any) => t.id === terminalId);
                              const mode =
                                open &&
                                openedMode(
                                  open.installationId,
                                  open.permissionMode,
                                );
                              return mode ? terminalModeText(mode) : null;
                            })()}
                            close={() => {
                              void act({
                                type: "terminal-close",
                                id: terminalId,
                              });
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
                                {openedLabel(t)}
                              </ActionButton>
                            ))}
                        <div className="conversation">
                          <div className="conversation-heading">
                            <span>
                              {conversation?.title ?? "Shared history"}
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
                              <Badge
                                tone={r.status === "completed" ? "good" : ""}
                              >
                                {r.status}
                              </Badge>{" "}
                              {r.provider} ·{" "}
                              {r.runtimeVersion ?? "unknown version"} ·{" "}
                              {r.model}
                              {requestedMode(r)}
                              <small>
                                Run {r.id.slice(0, 8)} · installation revision{" "}
                                {r.installationRevisionId.slice(0, 10)}
                              </small>
                              {r.reportedPermissions && (
                                <small>
                                  {reportedPermissionsText(
                                    r.reportedPermissions,
                                  )}
                                </small>
                              )}
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
                                act({
                                  type: "approval-decide",
                                  id: a.id,
                                  allow,
                                })
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
                              mode: selectedPreset.mode,
                              approvalPolicy: selectedPreset.approvalPolicy,
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
                                <option value="">
                                  Select a requested model
                                </option>
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
                                value={chatPresetId}
                                onChange={(e) =>
                                  setChatPresetId(
                                    e.target.value as ChatPresetId,
                                  )
                                }
                              >
                                {chatPresets.map((preset) => (
                                  <option key={preset.id} value={preset.id}>
                                    {presetBlocks.has(preset.id)
                                      ? `${preset.label} (unavailable)`
                                      : preset.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <ActionButton
                              className="primary"
                              disabled={
                                !!active ||
                                !conversation ||
                                !prompt.trim() ||
                                !model ||
                                !!presetBlocked ||
                                installation?.compatibility !== "compatible" ||
                                installation?.appId !== "openai.codex-cli"
                              }
                            >
                              Send to Codex ↑
                            </ActionButton>
                          </div>
                          <p className="tiny chat-preset-note" role="note">
                            {presetBlocked
                              ? `Not available for this runtime. ${presetBlocked}`
                              : (autoAcceptNote ??
                                chatPresetNote(selectedPreset))}
                          </p>
                          <p className="tiny muted">
                            Claude Code runs in the native terminal.
                          </p>
                        </form>
                        {runs.length > 0 && (
                          <div className="usage-line">
                            Reported usage:{" "}
                            {sessionUsage.knownInput.toLocaleString()} input ·{" "}
                            {sessionUsage.knownOutput.toLocaleString()} output
                            {sessionUsage.complete
                              ? ""
                              : " · some turns did not report usage"}
                          </div>
                        )}
                      </>
                    )}
                  </>
                }
                historyContent={
                  <HistoryScreen
                    pending={pending}
                    projectId={projectId}
                    act={act}
                    query={query}
                    setQuery={setQuery}
                    searchResults={searchResults}
                    setSearchResults={setSearchResults}
                    searchCursor={searchCursor}
                    setSearchCursor={setSearchCursor}
                    conversations={conversations}
                    openConversation={(id) => {
                      setConversationId(id);
                      openProjectView("sessions");
                    }}
                  />
                }
              />
            </div>
            {page === "settings" && (
              <SettingsScreen
                state={state}
                act={act}
                provider={provider}
                setProvider={setProvider}
                configuration={configuration}
                setConfiguration={setConfiguration}
                projectId={projectId}
                project={project}
                setConfigPlan={setConfigPlan}
                continueImport={continueImport}
              />
            )}
          </main>
          {Object.values(pending).some(Boolean) && (
            <footer className="statusbar">
              <span role="status">Operations pending</span>
            </footer>
          )}
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
            <HandoffOmissions snapshot={snapshot} />
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
              {(["projects", "providers", "settings"] as GlobalPage[]).map(
                (target) => (
                  <ActionButton
                    key={target}
                    onClick={() => {
                      setPage(target);
                      setPalette(false);
                    }}
                  >
                    {viewLabel(target)} →
                  </ActionButton>
                ),
              )}
              {projectDestinations.map((view) => (
                <ActionButton
                  key={view}
                  disabled={!projectId}
                  onClick={() => {
                    // Sessions open at the project's New session page.
                    if (view === "coordinator") openThread(null);
                    else openProjectView(view);
                    setPalette(false);
                  }}
                >
                  {view === "coordinator" ? "New session" : viewLabel(view)} →
                </ActionButton>
              ))}
              <ActionButton
                onClick={() => {
                  setPalette(false);
                  void addProject();
                }}
              >
                Add project →
              </ActionButton>
              <ActionButton
                disabled={state.testProfile}
                onClick={() => {
                  setPalette(false);
                  void act({ type: "discover" });
                }}
              >
                Discover providers →
              </ActionButton>
            </div>
          </Modal>
        )}
      </div>
    </ActionContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
