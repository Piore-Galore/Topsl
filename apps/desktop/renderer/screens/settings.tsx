import type { Dispatch, SetStateAction } from "react";
import type {
  AppState,
  Provider,
  ConfigurationPlan,
} from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import { autoAcceptOptions } from "../../../../packages/domain/auto-accept";
import { claudeTranscriptOptions } from "../../../../packages/domain/claude-steps";
import { claudeRouteOptions } from "../../../../packages/domain/claude-route";
import { ActionButton } from "../components/action-button";
import { Badge } from "../components/atlas";
import type { GlobalPage } from "../components/workbench-sidebar";
type Configuration = {
  path: string;
  text: string;
  hash: string;
  ownership: string;
};
type Props = {
  state: AppState;
  act: (command: Command) => Promise<any>;
  provider: Provider;
  setProvider: Dispatch<SetStateAction<Provider>>;
  configuration: Configuration | null;
  setConfiguration: Dispatch<SetStateAction<Configuration | null>>;
  projectId: string;
  project: AppState["projects"][number] | undefined;
  setConfigPlan: (plan: ConfigurationPlan | null) => void;
  setDetail: (detail: { title: string; text: string } | null) => void;
  setPage: (page: GlobalPage) => void;
};
export function SettingsScreen({
  state,
  act,
  provider,
  setProvider,
  configuration,
  setConfiguration,
  projectId,
  project,
  setConfigPlan,
  setDetail,
  setPage,
}: Props) {
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">APPLICATION SETTINGS</div>
          <h1>Make it your workspace.</h1>
          <p>Native configuration stays native. Every write has a preview.</p>
        </div>
      </div>
      <nav className="settings-index" aria-label="Settings sections">
        <a href="#appearance">Appearance</a>
        <a href="#agent-behavior">Agent behavior</a>
        <a href="#configuration">Configuration</a>
        <a href="#context-connection">Context</a>
      </nav>
      <section className="settings-card" id="appearance">
        <h2>Appearance</h2>
        <p>System follows the computer’s light or dark appearance.</p>
        <div className="actions theme-choices">
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
      <h2 className="settings-group-title" id="agent-behavior">
        Agent behavior
      </h2>
      <section className="settings-card" aria-label="Auto-accept">
        <h2>Auto-accept</h2>
        <p>
          Who answers when Codex or Claude Code would ask for permission in a
          session Topsl starts for editing. Reviews stay read-only, and managed
          settings can override either provider.
        </p>
        <div className="actions">
          {autoAcceptOptions.map((option) => (
            <ActionButton
              key={option.level}
              className={state.autoAccept === option.level ? "primary" : ""}
              aria-pressed={state.autoAccept === option.level}
              onClick={() =>
                void act({
                  type: "auto-accept-set",
                  level: option.level,
                })
              }
            >
              {option.label}
            </ActionButton>
          ))}
        </div>
        <p className="tiny" role="note">
          {
            autoAcceptOptions.find(
              (option) => option.level === state.autoAccept,
            )!.effect
          }
        </p>
      </section>
      <section className="settings-card" aria-label="Claude Code transcripts">
        <h2>Claude Code transcripts</h2>
        <p>
          Whether Topsl may take Claude's final reply from a workflow step's
          session transcript, which Claude Code keeps in its own folder, instead
          of your paste.
        </p>
        <div className="actions">
          {claudeTranscriptOptions.map((option) => (
            <ActionButton
              key={option.label}
              className={
                state.claudeTranscriptRead === option.enabled ? "primary" : ""
              }
              aria-pressed={state.claudeTranscriptRead === option.enabled}
              onClick={() =>
                void act({
                  type: "claude-transcript-read-set",
                  enabled: option.enabled,
                })
              }
            >
              {option.label}
            </ActionButton>
          ))}
        </div>
        <p className="tiny" role="note">
          {
            claudeTranscriptOptions.find(
              (option) => option.enabled === state.claudeTranscriptRead,
            )!.effect
          }
        </p>
      </section>
      <section
        className="settings-card"
        aria-label="Claude Code structured route"
      >
        <h2>Claude Code structured route</h2>
        <p>
          Whether Topsl may start Claude Code itself, with no terminal open, for
          coordinator, loop and review work. It runs under your Claude Code
          login and usage. Claude Code's permission lists are not
          operating-system filesystem isolation.
        </p>
        <div className="actions">
          {claudeRouteOptions.map((option) => (
            <ActionButton
              key={option.label}
              className={
                state.claudeStructuredRoute?.enabled === option.enabled
                  ? "primary"
                  : ""
              }
              aria-pressed={
                state.claudeStructuredRoute?.enabled === option.enabled
              }
              onClick={() =>
                void act({
                  type: "claude-structured-route-set",
                  enabled: option.enabled,
                })
              }
            >
              {option.label}
            </ActionButton>
          ))}
        </div>
        <p className="tiny" role="note">
          {
            claudeRouteOptions.find(
              (option) =>
                option.enabled === !!state.claudeStructuredRoute?.enabled,
            )!.effect
          }
          {state.claudeStructuredRoute?.decidedAt
            ? ` Last changed ${new Date(state.claudeStructuredRoute.decidedAt).toLocaleString()}.`
            : ""}
        </p>
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
        <h2 id="configuration">Configuration & instructions</h2>
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
        <h2 id="context-connection">Project context connection</h2>
        <p>
          Allow a native MCP client to search one project’s Topsl history. The
          connection has no administrative authority and expires when Topsl
          closes.
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
  );
}
