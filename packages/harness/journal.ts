import { hash, now, stable } from "../domain/invariants";
import type { Store } from "../persistence/store";
import { emptyUsage } from "../proxy/canonical";
import type {
  JournalBodies,
  JournalEvent,
  JournalKind,
  NativeAttemptView,
} from "./types";
import { terminalStates } from "./types";

/**
 * The attempt-scoped execution journal (docs/Native_Harness_Plan.md §3,
 * "Durable execution"). Events are append-only and hash-chained; each append
 * advances the attempt's projection in the same transaction, so a reader
 * never sees events the projection does not reflect, or the reverse.
 *
 * Writers present the attempt's current generation. Recovery claims a new
 * generation, after which a writer still holding the old one (a kernel from
 * before a restart, say) is refused instead of interleaving with the new one.
 */

const GENESIS = "0".repeat(64);

export class StaleGeneration extends Error {
  constructor() {
    super(
      "This attempt was claimed by a newer writer; the stale writer stopped.",
    );
    this.name = "StaleGeneration";
  }
}

export interface JournalPage {
  events: JournalEvent[];
  throughSequence: number;
  hasMore: boolean;
}

type Draft = {
  [K in JournalKind]: { kind: K; body: JournalBodies[K] };
}[JournalKind];

export class NativeJournal {
  constructor(private store: Store) {}
  private get db() {
    return this.store.db;
  }

  view(attemptId: string): NativeAttemptView | null {
    const row = this.db
      .prepare("SELECT body FROM native_projections WHERE attempt_id=?")
      .get(attemptId);
    return row ? (JSON.parse(row.body) as NativeAttemptView) : null;
  }
  require(attemptId: string): NativeAttemptView {
    const view = this.view(attemptId);
    if (!view) throw new Error("The native attempt does not exist.");
    return view;
  }

  /** Creates the attempt and its first event. */
  begin(
    attemptId: string,
    projectId: string,
    started: JournalBodies["attempt-started"],
  ): NativeAttemptView {
    return this.store.transaction(() => {
      if (this.view(attemptId))
        throw new Error("The native attempt already exists.");
      const at = now();
      const view: NativeAttemptView = {
        attemptId,
        projectId,
        rootAttemptId: started.rootAttemptId,
        parentAttemptId: started.parentAttemptId,
        depth: started.depth,
        title: started.title,
        state: "starting",
        stateDetail: null,
        generation: 1,
        throughSequence: 0,
        binding: started.binding,
        writable: started.workspace.writable,
        requests: 0,
        toolCalls: 0,
        compactions: 0,
        usage: { ...emptyUsage(), unknownRequests: 0 },
        lastText: "",
        candidateId: null,
        summary: null,
        children: [],
        pendingSteering: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.writeView(view);
      return this.appendWithin(attemptId, 1, [
        { kind: "attempt-started", body: started },
      ]);
    });
  }

  /** Appends events under `generation` and advances the projection with them. */
  append(
    attemptId: string,
    generation: number,
    events: Draft[],
  ): NativeAttemptView {
    return this.store.transaction(() =>
      this.appendWithin(attemptId, generation, events),
    );
  }

  private appendWithin(
    attemptId: string,
    generation: number,
    events: Draft[],
  ): NativeAttemptView {
    let view = this.require(attemptId);
    if (view.generation !== generation) throw new StaleGeneration();
    const last = this.db
      .prepare(
        "SELECT sequence,hash FROM native_journal WHERE attempt_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(attemptId) as { sequence: number; hash: string } | undefined;
    let sequence = last?.sequence ?? 0;
    let previous = last?.hash ?? GENESIS;
    const insert = this.db.prepare(
      "INSERT INTO native_journal(attempt_id,sequence,generation,kind,body,hash,previous_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    const at = now();
    for (const draft of events) {
      sequence++;
      const text = JSON.stringify(draft.body);
      const digest = hash(
        previous +
          stable({ sequence, generation, kind: draft.kind, body: draft.body }),
      );
      insert.run(
        attemptId,
        sequence,
        generation,
        draft.kind,
        text,
        digest,
        previous,
        at,
      );
      previous = digest;
      view = reduce(view, {
        attemptId,
        sequence,
        generation,
        kind: draft.kind,
        body: draft.body,
        hash: digest,
        createdAt: at,
      } as JournalEvent);
    }
    view = { ...view, throughSequence: sequence, updatedAt: at };
    this.writeView(view);
    return view;
  }

  /**
   * Claims the attempt for a new writer (recovery, resume). Every later
   * append must present the returned generation.
   */
  claim(attemptId: string): { generation: number; view: NativeAttemptView } {
    return this.store.transaction(() => {
      const current = this.require(attemptId);
      const generation = current.generation + 1;
      this.writeView({ ...current, generation });
      const view = this.appendWithin(attemptId, generation, [
        { kind: "resumed", body: { generation } },
      ]);
      return { generation, view };
    });
  }

  private writeView(view: NativeAttemptView): void {
    this.db
      .prepare(
        "INSERT INTO native_projections(attempt_id,project_id,root_attempt_id,through_sequence,state,body,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET through_sequence=excluded.through_sequence,state=excluded.state,body=excluded.body,updated_at=excluded.updated_at",
      )
      .run(
        view.attemptId,
        view.projectId,
        view.rootAttemptId,
        view.throughSequence,
        view.state,
        JSON.stringify(view),
        view.updatedAt,
      );
  }

  /** One page of an attempt's events after `afterSequence`. */
  events(attemptId: string, afterSequence = 0, limit = 200): JournalPage {
    if (
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 1000
    )
      throw new Error("Invalid journal cursor or limit.");
    const rows = this.db
      .prepare(
        "SELECT attempt_id,sequence,generation,kind,body,hash,created_at FROM native_journal WHERE attempt_id=? AND sequence>? ORDER BY sequence LIMIT ?",
      )
      .all(attemptId, afterSequence, limit + 1) as Array<{
      attempt_id: string;
      sequence: number;
      generation: number;
      kind: JournalKind;
      body: string;
      hash: string;
      created_at: string;
    }>;
    const included = rows.slice(0, limit);
    return {
      events: included.map((row) => ({
        attemptId: row.attempt_id,
        sequence: row.sequence,
        generation: row.generation,
        kind: row.kind,
        body: JSON.parse(row.body),
        hash: row.hash,
        createdAt: row.created_at,
      })) as JournalEvent[],
      throughSequence: included.at(-1)?.sequence ?? afterSequence,
      hasMore: rows.length > limit,
    };
  }

  /** Every event of an attempt, read in bounded pages. */
  *all(attemptId: string): Generator<JournalEvent> {
    let after = 0;
    while (true) {
      const page = this.events(attemptId, after, 500);
      yield* page.events;
      if (!page.hasMore) return;
      after = page.throughSequence;
    }
  }

  /** Recomputes the hash chain; a mismatch means the journal was altered. */
  verify(attemptId: string): { ok: boolean; brokenAt: number | null } {
    let previous = GENESIS;
    let after = 0;
    const page = this.db.prepare(
      "SELECT sequence,generation,kind,body,hash,previous_hash FROM native_journal WHERE attempt_id=? AND sequence>? ORDER BY sequence LIMIT 500",
    );
    while (true) {
      const rows = page.all(attemptId, after) as Array<{
        sequence: number;
        generation: number;
        kind: string;
        body: string;
        hash: string;
        previous_hash: string;
      }>;
      if (!rows.length) return { ok: true, brokenAt: null };
      for (const row of rows) {
        const expected = hash(
          previous +
            stable({
              sequence: row.sequence,
              generation: row.generation,
              kind: row.kind,
              body: JSON.parse(row.body),
            }),
        );
        if (row.previous_hash !== previous || row.hash !== expected)
          return { ok: false, brokenAt: row.sequence };
        previous = row.hash;
        after = row.sequence;
      }
    }
  }

  /** A project's attempts, newest first, one page at a time. */
  list(
    projectId: string,
    options: {
      limit?: number;
      before?: string | null;
      rootsOnly?: boolean;
    } = {},
  ): { items: NativeAttemptView[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const rows = this.db
      .prepare(
        `SELECT body,updated_at FROM native_projections WHERE project_id=? ${options.rootsOnly ? "AND root_attempt_id=attempt_id" : ""} AND updated_at<? ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(projectId, options.before ?? "￿", limit + 1) as Array<{
      body: string;
      updated_at: string;
    }>;
    const included = rows.slice(0, limit);
    return {
      items: included.map((row) => JSON.parse(row.body)),
      nextCursor: rows.length > limit ? included.at(-1)!.updated_at : null,
    };
  }

  /** Attempts that are not finished, for recovery. */
  unfinished(): NativeAttemptView[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM native_projections WHERE state NOT IN ('completed','failed','cancelled')",
        )
        .all() as Array<{ body: string }>
    ).map((row) => JSON.parse(row.body));
  }

  /** The attempts under one root (the root included). */
  tree(rootAttemptId: string): NativeAttemptView[] {
    return (
      this.db
        .prepare("SELECT body FROM native_projections WHERE root_attempt_id=?")
        .all(rootAttemptId) as Array<{ body: string }>
    ).map((row) => JSON.parse(row.body));
  }
}

/** Advances a projection by one event. */
export function reduce(
  view: NativeAttemptView,
  event: JournalEvent,
): NativeAttemptView {
  const next = { ...view };
  const finished = terminalStates.has(view.state);
  switch (event.kind) {
    case "attempt-started":
      next.state = "running";
      break;
    case "input-claimed": {
      const body = event.body as JournalBodies["input-claimed"];
      const claimed = body.inputIds.filter((id) =>
        id.startsWith("steer:"),
      ).length;
      next.pendingSteering = Math.max(0, view.pendingSteering - claimed);
      break;
    }
    case "steering":
      next.pendingSteering = view.pendingSteering + 1;
      break;
    case "request-frozen":
      next.requests = view.requests + 1;
      if (!finished) next.state = "waiting-model";
      break;
    case "response-settled": {
      const body = event.body as JournalBodies["response-settled"];
      const known = body.usage.input !== null || body.usage.output !== null;
      next.usage = {
        input: add(view.usage.input, body.usage.input),
        output: add(view.usage.output, body.usage.output),
        cachedInput: add(view.usage.cachedInput, body.usage.cachedInput),
        reasoning: add(view.usage.reasoning, body.usage.reasoning),
        unknownRequests: view.usage.unknownRequests + (known ? 0 : 1),
      };
      const text = body.output
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      if (text) next.lastText = text.slice(-4000);
      if (!finished) next.state = "running";
      break;
    }
    case "tool-intended":
      next.toolCalls = view.toolCalls + 1;
      if (!finished) next.state = "running-tools";
      break;
    case "tool-result":
      if (!finished && view.state !== "uncertain") next.state = "running";
      break;
    case "tool-uncertain":
      next.state = "uncertain";
      next.stateDetail = (event.body as JournalBodies["tool-uncertain"]).reason;
      break;
    case "reconciled":
      break;
    case "compaction":
      next.compactions = view.compactions + 1;
      break;
    case "checkpoint": {
      const body = event.body as JournalBodies["checkpoint"];
      if (body.candidateId) next.candidateId = body.candidateId;
      break;
    }
    case "paused": {
      const body = event.body as JournalBodies["paused"];
      next.state =
        body.kind === "quota"
          ? "waiting-quota"
          : body.kind === "uncertain"
            ? "uncertain"
            : "paused";
      next.stateDetail = body.reason;
      break;
    }
    case "resumed":
      next.generation = (event.body as JournalBodies["resumed"]).generation;
      if (!finished && view.state !== "uncertain") {
        next.state = "running";
        next.stateDetail = null;
      }
      break;
    case "child-started":
      next.children = [
        ...view.children,
        (event.body as JournalBodies["child-started"]).childAttemptId,
      ];
      next.state = "waiting-children";
      break;
    case "child-finished":
      if (!finished) next.state = "running";
      break;
    case "submitted": {
      const body = event.body as JournalBodies["submitted"];
      next.summary = body.summary;
      if (body.candidateId) next.candidateId = body.candidateId;
      break;
    }
    case "finished": {
      const body = event.body as JournalBodies["finished"];
      next.state = body.state;
      next.stateDetail = body.detail;
      break;
    }
  }
  return next;
}

function add(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
