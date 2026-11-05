import { useState } from "react";
import type { AppState } from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import type {
  Connection,
  ConnectionKind,
  ProxyRoute,
  RequestReceipt,
} from "../../../../packages/proxy/types";
import { ActionButton } from "../components/action-button";
import { Badge } from "../components/atlas";

type Props = {
  state: AppState;
  act: (command: Command) => Promise<any>;
};

const kindText: Record<ConnectionKind, string> = {
  "chatgpt-plan": "ChatGPT plan",
  "openai-api": "OpenAI API key",
  "anthropic-api": "Anthropic API key",
  "openai-compatible": "Gateway (OpenAI-compatible)",
  ollama: "Ollama on this computer",
};
const fundingText: Record<Connection["funding"], string> = {
  subscription: "Plan allowance",
  "api-billing": "API billing",
  gateway: "Gateway billing",
  local: "Local",
};
const stateText: Record<Connection["state"], string> = {
  "signed-out": "Not connected",
  ready: "Ready",
  "plan-use-disabled": "Plan usage not granted",
  "reauthorization-required": "Sign in again",
  "paused-usage-limit": "Usage limit reported",
  unavailable: "Unavailable",
  disconnected: "Disconnected",
};
const aliasPrefix: Record<ConnectionKind, string> = {
  "chatgpt-plan": "chatgpt",
  "openai-api": "openai",
  "anthropic-api": "anthropic",
  "openai-compatible": "gateway",
  ollama: "ollama",
};

/**
 * Connections (docs/Native_Harness_Plan.md §2): the model accounts Topsl's
 * native harness can use, each with its funding kept separate. Credentials
 * never pass through this page: ChatGPT sign-in completes in the browser and
 * an API key is read from the clipboard by Topsl itself.
 */
export function ConnectionsScreen({ state, act }: Props) {
  const proxy = state.proxy ?? null;
  const [gateway, setGateway] = useState("");
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Connections</h1>
          <p className="muted">
            Model accounts for Topsl's own native agent. Each request stays on
            the connection and funding you chose; Topsl never moves work to
            another account or to API billing.
          </p>
        </div>
      </div>
      {!proxy ? (
        <div className="info-strip">
          <span className="status-dot notice" />
          <div>
            <strong>The local proxy is not running.</strong>{" "}
            <span>
              Connections appear once it starts after the vault opens.
            </span>
          </div>
        </div>
      ) : (
        <>
          <div className="info-strip" role="note">
            <span className="status-dot notice" />
            <div>
              <strong>Claude subscription: not offered.</strong>{" "}
              <span>{proxy.claudeSubscription.reason}</span>
            </div>
          </div>
          <section className="application-card" aria-label="Add a connection">
            <h2>Add a connection</h2>
            <div className="actions wrap">
              <ActionButton
                className="primary"
                onClick={async () => {
                  const connection = await act({
                    type: "connection-create",
                    kind: "chatgpt-plan",
                    label: "ChatGPT",
                  });
                  if (connection?.id)
                    await act({
                      type: "connection-sign-in",
                      connectionId: connection.id,
                    });
                }}
              >
                Continue with ChatGPT
              </ActionButton>
              <ActionButton
                onClick={() =>
                  void act({
                    type: "connection-create",
                    kind: "openai-api",
                    label: "OpenAI API",
                  })
                }
              >
                OpenAI API key
              </ActionButton>
              <ActionButton
                onClick={() =>
                  void act({
                    type: "connection-create",
                    kind: "anthropic-api",
                    label: "Anthropic API",
                  })
                }
              >
                Anthropic API key
              </ActionButton>
              <ActionButton
                onClick={() =>
                  void act({
                    type: "connection-create",
                    kind: "ollama",
                    label: "Ollama",
                  })
                }
              >
                Ollama
              </ActionButton>
            </div>
            <div className="actions wrap">
              <label>
                Gateway base URL{" "}
                <input
                  aria-label="Gateway base URL"
                  placeholder="https://gateway.example/v1"
                  value={gateway}
                  onChange={(e) => setGateway(e.target.value)}
                />
              </label>
              <ActionButton
                disabled={!gateway.trim()}
                onClick={async () => {
                  const created = await act({
                    type: "connection-create",
                    kind: "openai-compatible",
                    label: "Gateway",
                    endpoint: gateway.trim(),
                  });
                  if (created) setGateway("");
                }}
              >
                Add gateway
              </ActionButton>
            </div>
          </section>
          {proxy.connections.length === 0 && (
            <p className="muted">No connections yet.</p>
          )}
          <div className="application-grid">
            {proxy.connections.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                routes={proxy.routes.filter(
                  (r) => r.connectionId === connection.id,
                )}
                signingIn={
                  proxy.signIns.find((s) => s.connectionId === connection.id)
                    ?.id ?? null
                }
                act={act}
              />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function ConnectionCard({
  connection,
  routes,
  signingIn,
  act,
}: {
  connection: Connection;
  routes: ProxyRoute[];
  signingIn: string | null;
  act: Props["act"];
}) {
  const [models, setModels] = useState<Array<{
    id: string;
    name: string;
  }> | null>(null);
  const [model, setModel] = useState("");
  const [alias, setAlias] = useState("");
  const [receipts, setReceipts] = useState<RequestReceipt[] | null>(null);
  const suggested = model ? `${aliasPrefix[connection.kind]}/${model}` : "";
  return (
    <article
      className="application-card"
      aria-label={`Connection ${connection.label}`}
    >
      <div className="card-title">
        <div>
          <h2>{connection.label}</h2>
          <span className="muted tiny">{kindText[connection.kind]}</span>
        </div>
        <Badge
          tone={
            connection.state === "ready"
              ? "good"
              : connection.state === "paused-usage-limit"
                ? "warm"
                : ""
          }
        >
          {stateText[connection.state]}
        </Badge>
      </div>
      <dl>
        <div>
          <dt>Funding</dt>
          <dd>{fundingText[connection.funding]}</dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>
            {connection.account.email ??
              (connection.account.source === "api-key-fingerprint"
                ? `Key ${connection.account.accountKey?.split(":").slice(1).join(":")}`
                : "Not established")}
          </dd>
        </div>
        <div>
          <dt>Endpoint</dt>
          <dd>
            <code>{connection.endpoint}</code>
          </dd>
        </div>
      </dl>
      {connection.stateDetail && (
        <p className="muted">{connection.stateDetail}</p>
      )}
      <div className="actions wrap">
        {connection.kind === "chatgpt-plan" &&
          (signingIn ? (
            <ActionButton
              onClick={() =>
                void act({
                  type: "connection-sign-in-cancel",
                  attemptId: signingIn,
                })
              }
            >
              Cancel sign-in
            </ActionButton>
          ) : (
            <ActionButton
              className={connection.hasCredential ? "" : "primary"}
              onClick={() =>
                void act({
                  type: "connection-sign-in",
                  connectionId: connection.id,
                })
              }
            >
              {connection.hasCredential
                ? "Sign in again"
                : "Continue with ChatGPT"}
            </ActionButton>
          ))}
        {connection.authentication === "api-key" && (
          <ActionButton
            className={connection.hasCredential ? "" : "primary"}
            title="Copy the key, then choose this; Topsl reads it from the clipboard and clears it."
            onClick={() =>
              void act({
                type: "connection-key-paste",
                connectionId: connection.id,
              })
            }
          >
            {connection.hasCredential
              ? "Replace key from clipboard"
              : "Paste key from clipboard"}
          </ActionButton>
        )}
        <ActionButton
          disabled={
            connection.state !== "ready" &&
            connection.state !== "paused-usage-limit"
          }
          onClick={async () => {
            const listed = await act({
              type: "connection-models",
              connectionId: connection.id,
            });
            if (Array.isArray(listed)) setModels(listed);
          }}
        >
          List models
        </ActionButton>
        <ActionButton
          onClick={async () => {
            const listed = await act({
              type: "connection-receipts",
              connectionId: connection.id,
              limit: 20,
            });
            if (Array.isArray(listed)) setReceipts(listed);
          }}
        >
          Recent requests
        </ActionButton>
        {connection.hasCredential && (
          <ActionButton
            onClick={() =>
              void act({
                type: "connection-disconnect",
                connectionId: connection.id,
              })
            }
          >
            Disconnect
          </ActionButton>
        )}
        <ActionButton
          onClick={() =>
            void act({ type: "connection-remove", connectionId: connection.id })
          }
        >
          Remove
        </ActionButton>
      </div>
      <h3>Routes</h3>
      {routes.length === 0 ? (
        <p className="muted">
          No routes. A route gives one of this connection's models a name native
          tasks can use.
        </p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Model</th>
              <th>Protocol</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {routes.map((route) => (
              <tr key={route.id}>
                <td>
                  <code>{route.alias}</code>
                  {route.disabled ? " (off)" : ""}
                </td>
                <td>{route.upstreamModel}</td>
                <td>{route.protocol}</td>
                <td>
                  <ActionButton
                    onClick={() =>
                      void act({
                        type: "route-save",
                        id: route.id,
                        connectionId: connection.id,
                        upstreamModel: route.upstreamModel,
                        alias: route.alias,
                        disabled: !route.disabled,
                      })
                    }
                  >
                    {route.disabled ? "Turn on" : "Turn off"}
                  </ActionButton>
                  <ActionButton
                    aria-label={`Remove route ${route.alias}`}
                    onClick={() =>
                      void act({ type: "route-remove", routeId: route.id })
                    }
                  >
                    Remove
                  </ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="actions wrap">
        {models ? (
          <select
            aria-label="Model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Choose a model</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name === m.id ? m.id : `${m.name} (${m.id})`}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Model"
            placeholder="Model ID"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        )}
        <input
          aria-label="Route name"
          placeholder={suggested || "Route name"}
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
        />
        <ActionButton
          disabled={!model.trim()}
          onClick={async () => {
            const saved = await act({
              type: "route-save",
              connectionId: connection.id,
              upstreamModel: model.trim(),
              alias: (alias.trim() || suggested).replace(/\s+/g, "-"),
            });
            if (saved) {
              setAlias("");
              setModel("");
            }
          }}
        >
          Add route
        </ActionButton>
      </div>
      {receipts && (
        <>
          <h3>Recent requests</h3>
          {receipts.length === 0 ? (
            <p className="muted">None yet.</p>
          ) : (
            <ul className="tiny">
              {receipts.map((r) => (
                <li key={r.id}>
                  {new Date(r.startedAt).toLocaleString()} · {r.requestedModel}{" "}
                  · {r.outcome}
                  {r.usage.input !== null
                    ? ` · ${r.usage.input} in / ${r.usage.output ?? "?"} out`
                    : " · usage unknown"}
                  {r.error
                    ? ` · ${r.error.code ?? r.error.kind}: ${r.error.message}`
                    : ""}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </article>
  );
}
