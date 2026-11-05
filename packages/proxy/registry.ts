import { createHash, randomUUID } from "node:crypto";
import type { ProxyDatabase } from "./database";
import type { ClientProtocol } from "./canonical";
import {
  CLAUDE_PLAN_RETIREMENT_REASON,
  connectionAuthentication,
  connectionFunding,
  defaultEndpoints,
  isConnectionKind,
  upstreamProtocol,
  type AccountEvidence,
  type CapabilityEvidence,
  type CapabilityName,
  type CapabilityObservation,
  type Connection,
  type ConnectionKind,
  type ConnectionState,
  type ProxyRoute,
  type RemoteRoutePin,
  type RequestReceipt,
  type RetiredConnection,
  type RetiredRoute,
  type ServiceAuthentication,
  type ServiceManifestStatus,
} from "./types";
import {
  capabilityConfiguration,
  documentForRoute,
  mergeEvidence,
} from "./capabilities";

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

function routeRevision(
  route: Omit<ProxyRoute, "revision" | "updatedAt">,
  accountKey: string | null,
) {
  const fields: unknown[] = [
    route.id,
    route.connectionId,
    route.upstreamModel,
    route.alias,
    route.protocol,
    route.adapterRevision,
    route.disabled,
    accountKey,
  ];
  // Appended only when present, so routes without a remote pin keep the
  // revisions their bindings froze.
  if (route.remotePin) fields.push(["remote-pin", route.remotePin]);
  return createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex")
    .slice(0, 32);
}

/** The error every path gives for the retired direct Claude connection. */
export class RetiredConnectionError extends Error {
  constructor(readonly reason: string = CLAUDE_PLAN_RETIREMENT_REASON) {
    super(reason);
    this.name = "RetiredConnectionError";
  }
}

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];

/**
 * Connections, routes and receipts. Each alias resolves to exactly one
 * route, and so to one connection and one funding kind.
 */
export class ProxyRegistry {
  constructor(private database: ProxyDatabase) {}
  private get db() {
    return this.database.db;
  }

  /**
   * Supported connections only. A row of another kind (a retired kind the
   * schema 2 upgrade has not yet moved, or one written by a newer Topsl) is
   * never decoded as a usable connection.
   */
  connections(): Connection[] {
    return this.db
      .prepare("SELECT body FROM connections ORDER BY rowid")
      .all()
      .map((row: { body: string }) => JSON.parse(row.body) as Connection)
      .filter((c: Connection) => isConnectionKind(c.kind));
  }
  connection(id: string): Connection | null {
    const row = this.db
      .prepare("SELECT body FROM connections WHERE id=?")
      .get(id) as { body: string } | undefined;
    const connection = row ? (JSON.parse(row.body) as Connection) : null;
    return connection && isConnectionKind(connection.kind) ? connection : null;
  }
  requireConnection(id: string): Connection {
    const connection = this.connection(id);
    if (connection) return connection;
    const retired = this.retiredConnection(id);
    if (retired) throw new RetiredConnectionError(retired.reason);
    throw new Error("The connection does not exist.");
  }

  /** History-only records of retired connections, for old receipts and bindings. */
  retiredConnections(): RetiredConnection[] {
    return this.db
      .prepare("SELECT body FROM retired_connections ORDER BY rowid")
      .all()
      .map((row: { body: string }) => JSON.parse(row.body) as RetiredConnection);
  }
  retiredConnection(id: string): RetiredConnection | null {
    const row = this.db
      .prepare("SELECT body FROM retired_connections WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as RetiredConnection) : null;
  }
  retiredRoutes(): RetiredRoute[] {
    return this.db
      .prepare("SELECT body FROM retired_routes ORDER BY rowid")
      .all()
      .map((row: { body: string }) => JSON.parse(row.body) as RetiredRoute);
  }
  retiredRouteByAlias(alias: string): RetiredRoute | null {
    const row = this.db
      .prepare("SELECT body FROM retired_routes WHERE alias=?")
      .get(alias) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as RetiredRoute) : null;
  }

  createConnection(input: {
    kind: ConnectionKind;
    label: string;
    endpoint?: string | null;
    protocol?: ClientProtocol;
    serviceAuth?: ServiceAuthentication;
    state?: ConnectionState;
  }): Connection {
    // Checked at run time too: a stale window or a direct command can still
    // name a kind the type no longer has.
    if ((input.kind as string) === "claude-plan")
      throw new RetiredConnectionError();
    if (!isConnectionKind(input.kind))
      throw new Error("Topsl does not support that kind of connection.");
    const endpoint = normalizeEndpoint(
      input.kind,
      input.endpoint ?? defaultEndpoints[input.kind],
    );
    if (input.serviceAuth && input.kind !== "openai-compatible")
      throw new Error(
        "Only an external model service chooses how its key is sent.",
      );
    const serviceAuth: ServiceAuthentication | undefined =
      input.kind === "openai-compatible"
        ? (input.serviceAuth ?? "bearer")
        : undefined;
    if (
      serviceAuth === "none" &&
      !loopbackHosts.includes(new URL(endpoint).hostname)
    )
      throw new Error(
        "Only a service on this computer can be reached without a key.",
      );
    const at = now();
    if (
      input.protocol &&
      input.kind !== "openai-compatible" &&
      input.protocol !== upstreamProtocol[input.kind]
    )
      throw new Error(
        "Only a gateway can select a different upstream protocol.",
      );
    const connection: Connection = {
      id: randomUUID(),
      kind: input.kind,
      label: input.label.trim().slice(0, 200) || input.kind,
      endpoint,
      protocol: input.protocol ?? upstreamProtocol[input.kind],
      authentication:
        serviceAuth === "none" ? "none" : connectionAuthentication[input.kind],
      ...(serviceAuth ? { serviceAuth } : {}),
      funding: connectionFunding[input.kind],
      state:
        serviceAuth === "none" ? "ready" : (input.state ?? "signed-out"),
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
        | "label"
        | "state"
        | "stateDetail"
        | "account"
        | "hasCredential"
        | "manifest"
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
      if (next.account.accountKey !== current.account.accountKey) {
        for (const route of this.routes().filter(
          (r) => r.connectionId === id,
        )) {
          const updated = {
            ...route,
            revision: routeRevision(route, next.account.accountKey),
            updatedAt: now(),
          };
          this.db
            .prepare("UPDATE routes SET body=? WHERE id=?")
            .run(JSON.stringify(updated), route.id);
        }
      }
      return next;
    });
  }

  setAccount(id: string, account: AccountEvidence): Connection {
    return this.updateConnection(id, { account });
  }

  removeConnection(id: string): void {
    this.requireConnection(id);
    this.database.transaction(() => {
      this.db.prepare("DELETE FROM routes WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM connections WHERE id=?").run(id);
    });
  }

  routes(): ProxyRoute[] {
    return this.db
      .prepare("SELECT body FROM routes ORDER BY rowid")
      .all()
      .map((row: { body: string }) =>
        this.effectiveRoute(JSON.parse(row.body) as ProxyRoute),
      );
  }
  route(id: string): ProxyRoute | null {
    const row = this.db
      .prepare("SELECT body FROM routes WHERE id=?")
      .get(id) as { body: string } | undefined;
    return row ? this.effectiveRoute(JSON.parse(row.body) as ProxyRoute) : null;
  }
  routeByAlias(alias: string): ProxyRoute | null {
    const row = this.db
      .prepare("SELECT body FROM routes WHERE alias=?")
      .get(alias) as { body: string } | undefined;
    return row ? this.effectiveRoute(JSON.parse(row.body) as ProxyRoute) : null;
  }

  /** Code upgrades and account changes invalidate frozen requests as well as edits do. */
  private effectiveRoute(route: ProxyRoute): ProxyRoute {
    const connection = this.connection(route.connectionId);
    if (!connection) return route;
    const current = {
      ...route,
      adapterRevision: adapterRevisions[connection.kind],
      protocol: connection.protocol ?? upstreamProtocol[connection.kind],
    };
    return {
      ...current,
      revision: routeRevision(current, connection.account.accountKey),
    };
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
      if (this.retiredRouteByAlias(input.alias))
        throw new Error(
          `The alias ${input.alias} named a retired route. Choose another name, so tasks bound to it can never reach a different connection.`,
        );
      const at = now();
      const protocol: ClientProtocol =
        connection.protocol ?? upstreamProtocol[connection.kind];
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
        evidence: existing?.evidence ?? {},
        remotePin: existing?.remotePin ?? null,
      };
      // A route saved for a model the service's document lists takes its
      // declarations and, when the service pins, its remote revision.
      const declared =
        !existing && connection.manifest
          ? this.declaredFor(connection, base, connection.manifest)
          : null;
      const withDocument = declared ? { ...base, ...declared } : base;
      const route: ProxyRoute = {
        ...withDocument,
        revision: routeRevision(withDocument, connection.account.accountKey),
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

  /** Declared evidence and the remote pin a document gives one route. */
  private declaredFor(
    connection: Connection,
    route: Omit<ProxyRoute, "revision" | "updatedAt">,
    document: ServiceManifestStatus,
  ): Pick<ProxyRoute, "evidence" | "remotePin"> | null {
    const found = documentForRoute(document, route);
    if (found.kind !== "declared") return null;
    const pinned = { ...route, remotePin: found.pin };
    const configuration = capabilityConfiguration(pinned, connection);
    const observations: Partial<Record<CapabilityName, CapabilityObservation>> =
      {};
    for (const [name, value] of Object.entries(found.capabilities))
      observations[name as CapabilityName] = {
        value: value!,
        evidence: "declared",
        source: `Service capability document ${document.gatewayId} revision ${document.revision}, route ${found.entry.id}`,
        model: route.upstreamModel,
        protocol: route.protocol,
        configuration,
        observedAt: document.checkedAt,
      };
    return {
      evidence: mergeEvidence(route.evidence, observations, configuration),
      remotePin: found.pin,
    };
  }

  /**
   * Records what an external service's capability document said. Only a
   * document that was read changes routes: an absent, unrecognized or
   * unreachable document leaves their pins and evidence as they were, so a
   * metadata outage never silently drops a pin bound attempts rely on.
   */
  applyServiceDocument(
    connectionId: string,
    document: ServiceManifestStatus,
  ): { connection: Connection; changedRoutes: string[] } {
    return this.database.transaction(() => {
      const connection = this.updateConnection(connectionId, {
        manifest: document,
      });
      const changedRoutes: string[] = [];
      if (document.state !== "read") return { connection, changedRoutes };
      for (const stored of this.routes().filter(
        (r) => r.connectionId === connectionId,
      )) {
        const declared = this.declaredFor(connection, stored, document);
        const remotePin: RemoteRoutePin | null = declared?.remotePin ?? null;
        const next = {
          ...stored,
          evidence: declared?.evidence ?? stored.evidence ?? {},
          remotePin,
        };
        const revision = routeRevision(next, connection.account.accountKey);
        if (revision !== stored.revision) changedRoutes.push(stored.alias);
        this.db
          .prepare("UPDATE routes SET body=? WHERE id=?")
          .run(
            JSON.stringify({ ...next, revision, updatedAt: now() }),
            stored.id,
          );
      }
      return { connection, changedRoutes };
    });
  }

  /** Records a connection test's results on the route. */
  recordProbe(
    routeId: string,
    observations: Partial<Record<CapabilityName, CapabilityObservation>>,
  ): ProxyRoute {
    return this.database.transaction(() => {
      const route = this.route(routeId);
      if (!route) throw new Error("The route does not exist.");
      const connection = this.requireConnection(route.connectionId);
      const next = {
        ...route,
        evidence: mergeEvidence(
          route.evidence,
          observations,
          capabilityConfiguration(route, connection),
        ),
      };
      this.db
        .prepare("UPDATE routes SET body=? WHERE id=?")
        .run(JSON.stringify(next), routeId);
      return this.route(routeId)!;
    });
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
  if (!endpoint)
    throw new Error("Enter the external model service's inference base URL.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("The endpoint is not a valid URL.");
  }
  if (url.username || url.password)
    throw new Error("Put credentials in the key field, not in the URL.");
  const loopback = loopbackHosts.includes(url.hostname);
  if (kind === "chatgpt-plan" || kind === "openai-api") {
    if (url.origin !== "https://api.openai.com")
      throw new Error("This connection uses OpenAI's documented endpoint.");
  } else if (kind === "anthropic-api") {
    if (url.origin !== "https://api.anthropic.com")
      throw new Error("This connection uses Anthropic's documented endpoint.");
  } else if (kind === "ollama") {
    if (!loopback || url.protocol !== "http:")
      throw new Error("Ollama is reached over http on this computer only.");
  } else if (
    url.protocol !== "https:" &&
    !(loopback && url.protocol === "http:")
  )
    throw new Error(
      "An external model service must use https unless it runs on this computer.",
    );
  if (url.search || url.hash)
    throw new Error("The endpoint cannot include a query or fragment.");
  if (
    ["chatgpt-plan", "openai-api", "anthropic-api"].includes(kind) &&
    url.pathname.replace(/\/+$/, "") !== "/v1"
  )
    throw new Error("This connection uses the provider's /v1 endpoint.");
  return url.toString().replace(/\/+$/, "");
}
