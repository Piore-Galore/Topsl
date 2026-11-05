/**
 * Native resource reservations (docs/Native_Harness_Plan.md §3, "Teams and
 * extensions"). Inference capacity, contained-process capacity and
 * workspace mutation are separate: an attempt holds an inference
 * reservation only while a model request is in flight, so a parent waiting
 * for its children holds none, and a writer keeps its workspace until its
 * effects settle.
 */

class Semaphore {
  private held = 0;
  private queue: Array<{
    resolve: () => void;
    reject: (e: Error) => void;
    holder: string;
  }> = [];
  constructor(readonly capacity: number) {}
  get inUse() {
    return this.held;
  }
  get waiting() {
    return this.queue.length;
  }
  acquire(holder: string, signal?: AbortSignal): Promise<() => void> {
    const release = () => {
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const next = this.queue.shift();
        if (next) next.resolve();
        else this.held--;
      };
    };
    if (this.held < this.capacity) {
      this.held++;
      return Promise.resolve(release());
    }
    return new Promise((resolve, reject) => {
      const entry = {
        holder,
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(release());
        },
        reject,
      };
      const onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error("Cancelled while waiting for capacity."));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(entry);
    });
  }
}

export interface QuotaWait {
  owner: string;
  since: string;
  detail: string;
}

export class ResourceLedger {
  private readonly inference: Semaphore;
  private readonly processes: Semaphore;
  private readonly workspaces = new Map<string, Promise<unknown>>();
  private readonly quota = new Map<string, QuotaWait>();
  private readonly listeners = new Set<(owner: string) => void>();

  constructor(options: { inference?: number; processes?: number } = {}) {
    // The default global concurrency of two applies to model requests.
    this.inference = new Semaphore(options.inference ?? 2);
    this.processes = new Semaphore(options.processes ?? 2);
  }

  acquireInference(holder: string, signal?: AbortSignal) {
    return this.inference.acquire(holder, signal);
  }
  acquireProcess(holder: string, signal?: AbortSignal) {
    return this.processes.acquire(holder, signal);
  }

  /** Runs `fn` while holding the workspace's single mutation slot. */
  async exclusive<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.workspaces.get(workspace) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => gate);
    this.workspaces.set(workspace, chained);
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.workspaces.get(workspace) === chained)
        this.workspaces.delete(workspace);
    }
  }

  /**
   * Records that an allowance reported its limit. Every attempt funded by the
   * same owner waits; none restarts on its own, and no reset time is inferred.
   */
  pauseQuota(owner: string, detail: string): void {
    if (!this.quota.has(owner))
      this.quota.set(owner, { owner, since: new Date().toISOString(), detail });
  }
  quotaWait(owner: string | null): QuotaWait | null {
    return owner ? (this.quota.get(owner) ?? null) : null;
  }
  /** The owner chose to try the allowance again. */
  resumeQuota(owner: string): void {
    if (this.quota.delete(owner))
      for (const listener of this.listeners) listener(owner);
  }
  onQuotaResumed(listener: (owner: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return {
      inference: {
        capacity: this.inference.capacity,
        inUse: this.inference.inUse,
        waiting: this.inference.waiting,
      },
      processes: {
        capacity: this.processes.capacity,
        inUse: this.processes.inUse,
        waiting: this.processes.waiting,
      },
      quotaWaits: [...this.quota.values()],
    };
  }
}
