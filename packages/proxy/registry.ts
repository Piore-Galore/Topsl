import { createHash, randomUUID } from "node:crypto";
import type { ProxyDatabase } from "./database";
import type { ClientProtocol } from "./canonical";
import {
  connectionAuthentication,
  connectionFunding,
  defaultEndpoints,
  upstreamProtocol,
  type AccountEvidence,
  type CapabilityEvidence,
  type Connection,
  type ConnectionKind,
  type ConnectionState,
  type ProxyRoute,
  type RequestReceipt,
} from "./types";

/**
 * Serializer and stream-reader revisions per connection kind. A route's
 * revision includes its adapter revision, so changing how a kind of
 * connection is converted invalidates every native binding to it.
 */
export const adapterRevisions: Record<ConnectionKind, string> = {
  "chatgpt-plan": "chatgpt-plan-responses-v1",
  "openai-api": "openai-api-responses-v1",
  "anthropic-api": "anthropic-api-messages-v1",
  "openai-compatible": "openai-compatible-chat-v1",
  ollama: "ollama-chat-v1",
};

const now = () => new Date().toISOString();
const aliasPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function routeRevision(route: Omit<ProxyRoute, "revision" | "updatedAt">) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        route.id,
        route.connectionId,
        route.upstreamModel,
        route.alias,
        route.protocol,
        route.adapterRevision,
        route.disabled,
      ]),
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * Connections, routes and receipts. Each alias resolves to exactly one
 * route, and so to one connection and one funding kind.
 */
export class ProxyRegistry {
  constructor(private database: ProxyDatabase) {}
  private get db() {
    return this.database.db;
  }

  connections(): Connection[] {
    return this.db
      .prepare("SELECT body FROM connections ORDER BY rowid")
      .all()
      .map((row: { body: string }) => JSON.parse(row.body) as Connection);
  }
  connection(id: string): Connection | null {
    const row = this.db
      .prepare("SELECT body FROM connections WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Connection) : null;
  }
  requireConnection(id: string): Connection {
    const connection = this.connection(id);
    if (!connection) throw new Error("The connection does not exist.");
    return connection;
  }

  createConnection(input: {
    kind: ConnectionKind;
    label: string;
    endpoint?: string | null;
    state?: ConnectionState;
  }): Connection {
    const endpoint = normalizeEndpoint(
      input.kind,
      input.endpoint ?? defaultEndpoints[input.kind],
    );
    const at = now();
    const connection: Connection = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label.trim().slice(0, 200) || input.kind,
      endpoint,
      authentication: connectionAuthentication[input.kind],
      funding: connectionFunding[input.kind],
      state: input.state ?? "signed-out",
      stateDetail: null,
      account: {
        accountKey: null,
        email: null,
        source: "none",
        quotaOwner: null,
        observedAt: null,
      },
      hasCredential: false,
      revocation:
        input.kind === "chatgpt-plan"
          ? "supported"
          : input.kind === "ollama"
            ? "not-applicable"
            : "not-supported",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare("INSERT INTO connections(id,body) VALUES(?,?)")
      .run(connection.id, JSON.stringify(connection));
    return connection;
  }

  /** Updates a connection; `expectedRevision` guards against lost updates. */
  updateConnection(
    id: string,
    change: Partial<
      Pick<
        Connection,
        "label" | "state" | "stateDetail" | "account" | "hasCredential"
      >
    >,
    expectedRevision?: number,
  ): Connection {
    return this.database.transaction(() => {
      const current = this.requireConnection(id);
      if (
        expectedRevision !== undefined &&
        current.revision !== expectedRevision
      )
        throw new Error("The connection changed. Refresh and try again.");
      const next: Connection = {
        ...current,
        ...change,
        revision: current.revision + 1,
        updatedAt: now(),
      };
      this.db
        .prepare("UPDATE connections SET body=? WHERE id=?")
        .run(JSON.stringify(next), id);
      return next;
    });
  }

  setAccount(id: string, account: AccountEvidence): Connection {
    return this.updateConnection(id, { account });
  }

  removeConnection(id: string): void {
    this.database.transaction(() => {
      this.db.prepare("DELETE FROM routes WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM connections WHERE id=?").run(id);
    });
  }

  routes(): ProxyRoute[] {
    return this.db
      .prepare("SELECT body FROM routes ORDER BY rowid")
      .all()
      .map((row: { body: string }) => JSON.parse(row.body) as ProxyRoute);
  }
  route(id: string): ProxyRoute | null {
    const row = this.db
      .prepare("SELECT body FROM routes WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ProxyRoute) : null;
  }
  routeByAlias(alias: string): ProxyRoute | null {
    const row = this.db
      .prepare("SELECT body FROM routes WHERE alias=?")
      .get(alias) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as ProxyRoute) : null;
  }

  /**
   * Creates or changes a route. Changing anything that affects dispatch gives
   * the route a new revision, so native requests frozen on the old one are
   * rejected before they reach the upstream.
   */
  saveRoute(input: {
    id?: string;
    connectionId: string;
    upstreamModel: string;
    alias: string;
    capabilities?: Partial<CapabilityEvidence>;
    disabled?: boolean;
  }): ProxyRoute {
    if (!aliasPattern.test(input.alias))
      throw new Error(
        "A model alias uses letters, digits and . _ : / - (at most 128).",
      );
    if (!input.upstreamModel.trim() || input.upstreamModel.length > 200)
      throw new Error("Name the upstream model.");
    return this.database.transaction(() => {
      const connection = this.requireConnection(input.connectionId);
      const existing = input.id ? this.route(input.id) : null;
      if (input.id && !existing) throw new Error("The route does not exist.");
      const clash = this.routeByAlias(input.alias);
      if (clash && clash.id !== input.id)
        throw new Error(
          `The alias ${input.alias} already names another route. Each alias resolves to one connection.`,
        );
      const at = now();
      const protocol: ClientProtocol = upstreamProtocol[connection.kind];
      const base = {
        id: existing?.id ?? randomUUID(),
        connectionId: connection.id,
        upstreamModel: input.upstreamModel.trim(),
        alias: input.alias,
        protocol,
        adapterRevision: adapterRevisions[connection.kind],
        capabilities: {
          tools: "unknown",
          images: "unknown",
          reasoning: "unknown",
          outputCap:
            connection.kind === "chatgpt-plan" ? "unsupported" : "unknown",
          structuredOutput: "unknown",
          source: "not observed",
          observedAt: null,
          ...existing?.capabilities,
          ...input.capabilities,
        } as CapabilityEvidence,
        disabled: input.disabled ?? existing?.disabled ?? false,
        createdAt: existing?.createdAt ?? at,
      };
      const route: ProxyRoute = {
        ...base,
        revision: routeRevision(base),
        updatedAt: at,
      };
      this.db
        .prepare(
          "INSERT INTO routes(id,alias,connection_id,body) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,connection_id=excluded.connection_id,body=excluded.body",
        )
        .run(route.id, route.alias, route.connectionId, JSON.stringify(route));
      return route;
    });
  }

  removeRoute(id: string): void {
    this.db.prepare("DELETE FROM routes WHERE id=?").run(id);
  }

  recordReceipt(receipt: RequestReceipt): void {
    this.db
      .prepare(
        "INSERT INTO receipts(id,attempt_id,connection_id,started_at,body) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(
        receipt.id,
        receipt.attemptId,
        receipt.connectionId,
        receipt.startedAt,
        JSON.stringify(receipt),
      );
  }
  receipts(filter: {
    attemptId?: string;
    connectionId?: string;
    limit?: number;
  }): RequestReceipt[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 1000);
    const rows = filter.attemptId
      ? this.db
          .prepare(
            "SELECT body FROM receipts WHERE attempt_id=? ORDER BY started_at DESC LIMIT ?",
          )
          .all(filter.attemptId, limit)
      : filter.connectionId
        ? this.db
            .prepare(
              "SELECT body FROM receipts WHERE connection_id=? ORDER BY started_at DESC LIMIT ?",
            )
            .all(filter.connectionId, limit)
        : this.db
            .prepare(
              "SELECT body FROM receipts ORDER BY started_at DESC LIMIT ?",
            )
            .all(limit);
    return rows.map(
      (row: { body: string }) => JSON.parse(row.body) as RequestReceipt,
    );
  }
}

/**
 * Validates an upstream endpoint. Official kinds keep their documented
 * endpoint; gateways need https unless they are on this computer; Ollama must
 * be on loopback.
 */
export function normalizeEndpoint(
  kind: ConnectionKind,
  endpoint: string | null,
): string {
  if (!endpoint) throw new Error("Enter the gateway's base URL.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The endpoint is not a valid URL.");
  }
  if (url.username || url.password)
    throw new Error("Put credentials in the key field, not in the URL.");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (kind === "chatgpt-plan" || kind === "openai-api") {
    if (url.origin !== "https://api.openai.com")
      throw new Error("This connection uses OpenAI's documented endpoint.");
  } else if (kind === "anthropic-api") {
    if (url.origin !== "https://api.anthropic.com")
      throw new Error("This connection uses Anthropic's documented endpoint.");
  } else if (kind === "ollama") {
    if (!loopback || url.protocol !== "http:")
      throw new Error("Ollama is reached over http on this computer only.");
  } else if (url.protocol !== "https:" && !loopback)
    throw new Error(
      "A gateway must use https unless it runs on this computer.",
    );
  return url.toString().replace(/\/+$/, "");
}
