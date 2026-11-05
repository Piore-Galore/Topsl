import { useState } from "react";
import type { AppState } from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import type {
  CapabilityName,
  Connection,
  ConnectionKind,
  EffectiveCapability,
  ProxyRoute,
  RequestReceipt,
  RetiredConnection,
  RetiredRoute,
  ServiceAuthentication,
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
  "openai-compatible": "External model service",
  ollama: "Ollama on this computer",
};
const fundingText: Record<Connection["funding"], string> = {
  subscription: "Plan allowance",
  "api-billing": "API billing",
  gateway: "Managed by external service",
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
  "openai-compatible": "external",
  ollama: "ollama",
};
const protocolText = {
  chat: "Chat Completions",
  responses: "Responses",
  messages: "Anthropic Messages",
} as const;
const authText: Record<ServiceAuthentication, string> = {
  bearer: "Key as a Bearer token",
  "x-api-key": "Key in the x-api-key header",
  none: "No key (this computer only)",
};
const capabilityText: Partial<Record<CapabilityName, string>> = {
  streaming: "Streaming",
  tools: "Tool calls",
  structuredOutput: "Structured output",
};

function evidenceText(capability: EffectiveCapability | undefined): string {
  if (!capability || capability.evidence === "unknown") return "unknown";
  if (capability.evidence === "stale")
    return "unknown (earlier configuration)";
  const when = capability.observation
    ? ` ${new Date(capability.observation.observedAt).toLocaleDateString()}`
    : "";
  return `${capability.value}, ${capability.evidence === "probed" ? `tested by Topsl${when}` : "declared by the service"}`;
}

function documentText(connection: Connection): string {
  const m = connection.manifest;
  if (!m) return "Not read";
  if (m.state === "read")
    return `Version 1, ${m.gatewayId} revision ${m.revision} (${m.routes.length} route${m.routes.length === 1 ? "" : "s"})`;
  if (m.state === "absent") return "Not published; capabilities stay unknown";
  return `${m.state === "unrecognized" ? "Not recognized" : "Unavailable"}: ${m.detail ?? ""}`;
}

/**
 * Connections (docs/Native_Harness_Plan.md §2): the model accounts and
 * services Topsl's native harness can use, each with its funding kept
 * separate. Credentials never pass through this page: ChatGPT sign-in
 * completes in the browser and a key is read from the clipboard by Topsl
 * itself.
 */
export function ConnectionsScreen({ state, act }: Props) {
  const proxy = state.proxy ?? null;
  const [service, setService] = useState("");
  const [serviceProtocol, setServiceProtocol] = useState<
    "chat" | "responses" | "messages"
  >("chat");
  const [serviceAuth, setServiceAuth] =
    useState<ServiceAuthentication>("bearer");
  const retired = proxy?.retired ?? { connections: [], routes: [] };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Connections</h1>
          <p className="muted">
            Model accounts and services for Topsl's own native agent. Each
            request stays on the connection and funding you chose; Topsl never
            moves work to another account or to API billing. For Claude-plan
            work, use Claude Code under Providers.
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
            <h3>External model service</h3>
            <p className="muted tiny">
              A separately operated service that speaks a standard inference
              protocol, on this computer or at an https address. Topsl sends
              requests only to the URL you enter, in the protocol you choose;
              the service runs its own upstream accounts, terms and billing.
            </p>
            <div className="actions wrap">
              <label>
                Inference base URL{" "}
                <input
                  aria-label="Inference base URL"
                  placeholder="https://service.example/v1"
                  value={service}
                  onChange={(e) => setService(e.target.value)}
                />
              </label>
              <label>
                Protocol{" "}
                <select
                  aria-label="Protocol"
                  value={serviceProtocol}
                  onChange={(e) =>
                    setServiceProtocol(e.target.value as typeof serviceProtocol)
                  }
                >
                  <option value="chat">{protocolText.chat}</option>
                  <option value="responses">{protocolText.responses}</option>
                  <option value="messages">{protocolText.messages}</option>
                </select>
              </label>
              <label>
                Authentication{" "}
                <select
                  aria-label="Authentication"
                  value={serviceAuth}
                  onChange={(e) =>
                    setServiceAuth(e.target.value as ServiceAuthentication)
                  }
                >
                  <option value="bearer">{authText.bearer}</option>
                  <option value="x-api-key">{authText["x-api-key"]}</option>
                  <option value="none">{authText.none}</option>
                </select>
              </label>
              <ActionButton
                disabled={!service.trim()}
                onClick={async () => {
                  const created = await act({
                    type: "connection-create",
                    kind: "openai-compatible",
                    label: "External service",
                    endpoint: service.trim(),
                    protocol: serviceProtocol,
                    serviceAuth,
                  });
                  if (created) setService("");
                }}
              >
                Add external service
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
                capabilities={proxy.capabilities ?? {}}
                signingIn={
                  proxy.signIns.find((s) => s.connectionId === connection.id)
                    ?.id ?? null
                }
                act={act}
              />
            ))}
          </div>
          {retired.connections.length > 0 && (
            <section aria-label="Retired connections">
              <h2>Retired connections</h2>
              <p className="muted">
                Kept so earlier requests and tasks still read. They cannot sign
                in, be renewed or send requests, and their credentials were
                deleted from Topsl.
              </p>
              <div className="application-grid">
                {retired.connections.map((connection) => (
                  <RetiredCard
                    key={connection.id}
                    connection={connection}
                    routes={retired.routes.filter(
                      (r) => r.connectionId === connection.id,
                    )}
                    act={act}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}

function Receipts({ receipts }: { receipts: RequestReceipt[] }) {
  return (
    <>
      <h3>Recent requests</h3>
      {receipts.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <ul className="tiny">
          {receipts.map((r) => (
            <li key={r.id}>
              {new Date(r.startedAt).toLocaleString()} · {r.requestedModel} ·{" "}
              {r.outcome}
              {r.correlationId?.startsWith("connection-test:")
                ? " · connection test"
                : ""}
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
  );
}

function RetiredCard({
  connection,
  routes,
  act,
}: {
  connection: RetiredConnection;
  routes: RetiredRoute[];
  act: Props["act"];
}) {
  const [receipts, setReceipts] = useState<RequestReceipt[] | null>(null);
  return (
    <article
      className="application-card"
      aria-label={`Retired connection ${connection.label}`}
    >
      <div className="card-title">
        <div>
          <h2>{connection.label}</h2>
          <span className="muted tiny">Claude plan (direct sign-in)</span>
        </div>
        <Badge>Retired</Badge>
      </div>
      <p>{connection.reason}</p>
      <dl>
        <div>
          <dt>Funding</dt>
          <dd>{fundingText[connection.funding] ?? connection.funding}</dd>
        </div>
        <div>
          <dt>Retired</dt>
          <dd>{new Date(connection.retiredAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Routes</dt>
          <dd>
            {routes.length
              ? routes.map((r) => r.alias).join(", ")
              : "None"}
          </dd>
        </div>
      </dl>
      <div className="actions wrap">
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
      </div>
      {receipts && <Receipts receipts={receipts} />}
    </article>
  );
}

function ConnectionCard({
  connection,
  routes,
  capabilities,
  signingIn,
  act,
}: {
  connection: Connection;
  routes: ProxyRoute[];
  capabilities: Record<string, Record<CapabilityName, EffectiveCapability>>;
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
  const [notice, setNotice] = useState<string | null>(null);
  const external = connection.kind === "openai-compatible";
  const suggested = model ? `${aliasPrefix[connection.kind]}/${model}` : "";
  const usable =
    connection.state === "ready" || connection.state === "paused-usage-limit";
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
        {external && (
          <>
            <div>
              <dt>Protocol</dt>
              <dd>{protocolText[connection.protocol ?? "chat"]}</dd>
            </div>
            <div>
              <dt>Authentication</dt>
              <dd>{authText[connection.serviceAuth ?? "bearer"]}</dd>
            </div>
            <div>
              <dt>Capability document</dt>
              <dd>{documentText(connection)}</dd>
            </div>
          </>
        )}
      </dl>
      {connection.stateDetail && (
        <p className="muted">{connection.stateDetail}</p>
      )}
      {notice && (
        <p className="muted" role="status">
          {notice}
        </p>
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
          disabled={!usable}
          onClick={async () => {
            const listed = await act({
              type: "connection-models",
              connectionId: connection.id,
            }).catch(() => null);
            if (Array.isArray(listed)) setModels(listed);
            else if (external)
              setNotice(
                "The service did not list its models. Enter a model ID below.",
              );
          }}
        >
          List models
        </ActionButton>
        {external && (
          <ActionButton
            disabled={!usable}
            title="Reads the service's optional capability document. This is not a model request."
            onClick={async () => {
              const read = await act({
                type: "connection-capabilities",
                connectionId: connection.id,
              });
              if (read?.document)
                setNotice(
                  read.changedRoutes?.length
                    ? `Route revisions changed for ${read.changedRoutes.join(", ")}. Tasks bound to them must start again.`
                    : null,
                );
            }}
          >
            Read service capabilities
          </ActionButton>
        )}
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
            {routes.flatMap((route) => [
              <tr key={route.id}>
                <td>
                  <code>{route.alias}</code>
                  {route.disabled ? " (off)" : ""}
                </td>
                <td>
                  {route.upstreamModel}
                  {route.remotePin ? (
                    <span className="muted tiny">
                      {" "}
                      · pinned to service revision{" "}
                      <code>{route.remotePin.routeRevision}</code>
                    </span>
                  ) : null}
                </td>
                <td>{protocolText[route.protocol]}</td>
                <td>
                  <ActionButton
                    disabled={!usable || route.disabled}
                    title="Sends three small, billable requests and records what they show for this configuration."
                    onClick={() =>
                      void act({ type: "connection-test", routeId: route.id })
                    }
                  >
                    Test route
                  </ActionButton>
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
              </tr>,
              <tr key={`${route.id}-capabilities`}>
                <td colSpan={4}>
                  <p
                    className="muted tiny"
                    aria-label={`Capabilities of ${route.alias}`}
                  >
                    {(Object.keys(capabilityText) as CapabilityName[])
                      .map(
                        (name) =>
                          `${capabilityText[name]}: ${evidenceText(capabilities[route.id]?.[name])}`,
                      )
                      .join(" · ")}
                  </p>
                </td>
              </tr>,
            ])}
          </tbody>
        </table>
      )}
      <div className="actions wrap">
        {models && models.length ? (
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
      {receipts && <Receipts receipts={receipts} />}
    </article>
  );
}
