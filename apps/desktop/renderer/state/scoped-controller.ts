import {
  advanceSequence,
  type ChangePage,
} from "../../../../packages/domain/events";
import type { ReadObservation as Observation } from "../../../../packages/domain/read-model";
export type { ReadObservation as Observation } from "../../../../packages/domain/read-model";
export type Freshness =
  | "refreshing"
  | "current"
  | "stale"
  | "disconnected"
  | "resynchronizing"
  | "failed";
export interface ScopedState {
  projectId: string;
  status: Freshness;
  snapshot: any | null;
  observation: Observation | null;
  lastSuccessAt: string | null;
  error: string | null;
  source: string;
}
export function observationOf(value: any): Observation | null {
  const observation = value?.observation ?? value;
  return observation &&
    typeof observation.projectId === "string" &&
    typeof observation.epoch === "string" &&
    observation.epoch.length > 0 &&
    Number.isSafeInteger(observation.sequence) &&
    observation.sequence >= 0
    ? { ...observation, generatedAt: observation.generatedAt ?? "" }
    : null;
}

/** Domain revisions win within an epoch; request order fences incomparable epochs. */
export class ScopedReadFence {
  private generation = 0;
  private request = 0;
  private acceptedRequest = 0;
  private accepted: Observation | null = null;
  private retiredEpochs = new Set<string>();
  constructor(private scope = "") {}
  reset(scope: string) {
    this.scope = scope;
    this.generation++;
    this.acceptedRequest = 0;
    this.accepted = null;
    this.retiredEpochs.clear();
  }
  begin() {
    return {
      scope: this.scope,
      generation: this.generation,
      request: ++this.request,
    };
  }
  current(ticket: ReturnType<ScopedReadFence["begin"]>) {
    return ticket.scope === this.scope && ticket.generation === this.generation;
  }
  accept(ticket: ReturnType<ScopedReadFence["begin"]>, value?: any) {
    if (!this.current(ticket)) return false;
    const next = observationOf(value);
    if (next && next.projectId !== this.scope) return false;
    if (!next) {
      if (ticket.request < this.acceptedRequest) return false;
    } else if (this.retiredEpochs.has(next.epoch)) return false;
    else if (this.accepted?.epoch === next.epoch) {
      if (
        next.sequence < this.accepted.sequence ||
        (next.sequence === this.accepted.sequence &&
          ticket.request < this.acceptedRequest)
      )
        return false;
    } else if (this.accepted) {
      if (ticket.request < this.acceptedRequest) return false;
      this.retiredEpochs.add(this.accepted.epoch);
    }
    if (next) this.accepted = next;
    this.acceptedRequest = Math.max(this.acceptedRequest, ticket.request);
    return true;
  }
}

export interface ScopeTransport {
  snapshot(): Promise<any>;
  replay(afterSequence: number): Promise<ChangePage>;
  subscribe(callback: (page: ChangePage) => void): () => void;
  now?(): string;
}
/** One read-only owner per project. Subscribe first, then snapshot and durable replay. */
export class ScopedRefreshController {
  state: ScopedState;
  private listeners = new Set<(state: ScopedState) => void>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> | null = null;
  private again = false;
  private stopped = true;
  private cursor = 0;
  private retries = 0;
  private resyncAttempts = 0;
  private buffered: ChangePage[] = [];
  private fence: ScopedReadFence;
  constructor(
    readonly projectId: string,
    private transport: ScopeTransport,
  ) {
    this.fence = new ScopedReadFence(projectId);
    this.state = {
      projectId,
      status: "refreshing",
      snapshot: null,
      observation: null,
      lastSuccessAt: null,
      error: null,
      source: "Project snapshot",
    };
  }
  get active() {
    return this.listeners.size > 0;
  }
  private publish(change: Partial<ScopedState>) {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener(this.state);
  }
  subscribe(listener: (state: ScopedState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    if (this.stopped) {
      this.stopped = false;
      this.unsubscribe = this.transport.subscribe((page) => this.receive(page));
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }
  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fence.reset(this.projectId);
    this.buffered = [];
  }
  disconnected() {
    this.publish({
      status: "disconnected",
      error: "Connection unavailable. Showing last-known project state.",
    });
  }
  private schedule(delay = 80) {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }
  private relevant(page: ChangePage) {
    return page.events.some(
      (event) =>
        (event.projectId === this.projectId ||
          (event.projectId === null &&
            [
              "installation",
              "approval",
              "run",
              "conversation",
              "usage",
            ].includes(event.kind))) &&
        !event.kind.endsWith("-revision"),
    );
  }
  private receive(page: ChangePage) {
    if (this.stopped) return;
    if (this.busy || !this.state.observation) {
      if (this.buffered.length < 32) this.buffered.push(page);
      else this.again = true;
      return;
    }
    if (page.epoch !== this.state.observation.epoch) {
      this.publish({ status: "resynchronizing" });
      this.schedule();
      return;
    }
    const next = advanceSequence(this.cursor, page);
    if (next.resync) {
      this.publish({ status: "resynchronizing" });
      this.schedule();
      return;
    }
    this.cursor = next.sequence;
    // The service publishes its change log in order, a bounded page at a
    // time. Behind a backlog, such as a large import, this project's newer
    // changes wait until other projects' records drain, so a head past this
    // view's cursor refreshes from a snapshot instead.
    if (this.relevant(page) || page.headSequence > this.cursor) this.schedule();
  }
  refresh = (resynchronizing = false): Promise<void> => {
    if (this.stopped) return Promise.resolve();
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ticket = this.fence.begin();
    this.publish({
      status: resynchronizing ? "resynchronizing" : "refreshing",
    });
    this.busy = (async () => {
      try {
        const snapshot = await this.transport.snapshot();
        const observation = observationOf(snapshot);
        if (!observation || observation.projectId !== this.projectId)
          throw new Error(
            "Project snapshot did not include a valid scoped revision.",
          );
        let cursor = observation.sequence,
          needsAnother = false,
          epochChanged = false;
        for (let pages = 0; pages < 10; pages++) {
          const page = await this.transport.replay(cursor);
          if (page.epoch !== observation.epoch) {
            epochChanged = true;
            break;
          }
          const next = advanceSequence(cursor, page);
          if (next.resync) {
            epochChanged = true;
            break;
          }
          needsAnother ||= this.relevant(page);
          cursor = next.sequence;
          if (!page.hasMore) break;
          if (pages === 9) needsAnother = true;
        }
        if (this.stopped || !this.fence.current(ticket)) return;
        for (const page of this.buffered) {
          if (page.epoch !== observation.epoch) epochChanged = true;
          else if (
            (page.throughSequence > observation.sequence &&
              this.relevant(page)) ||
            page.headSequence > cursor
          )
            needsAnother = true;
        }
        this.buffered = [];
        if (epochChanged) {
          if (++this.resyncAttempts > 3)
            throw new Error(
              "Scoped revision kept changing during recovery. Retry project reads.",
            );
          this.again = true;
          this.publish({ status: "resynchronizing" });
          return;
        }
        if (!this.fence.accept(ticket, observation)) return;
        this.cursor = cursor;
        this.retries = 0;
        this.resyncAttempts = 0;
        this.again ||= needsAnother;
        this.publish({
          snapshot,
          observation,
          error: null,
          lastSuccessAt: this.transport.now?.() ?? new Date().toISOString(),
          status: this.again ? "resynchronizing" : "current",
        });
      } catch (error) {
        if (this.stopped || !this.fence.current(ticket)) return;
        this.publish({
          status: this.state.snapshot ? "stale" : "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.retries < 3) this.schedule([250, 1000, 4000][this.retries++]);
      } finally {
        this.busy = null;
        if (!this.stopped && this.again) {
          this.again = false;
          this.schedule();
        }
      }
    })();
    return this.busy;
  };
}
