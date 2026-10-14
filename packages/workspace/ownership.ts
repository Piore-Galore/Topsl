import { realpathSync, statSync } from "node:fs";
import { hash, now, uid } from "../domain/invariants";
import type {
  CoordinatorOwner,
  Evidence,
  WorkspaceLease,
} from "../domain/workflow";
import { Store } from "../persistence/store";

export function canonicalWorkspaceIdentity(
  root: string,
  hostId = "local",
): { canonicalRoot: string; filesystemIdentity: string } {
  const canonicalRoot = realpathSync(root),
    stat = statSync(canonicalRoot);
  if (!stat.isDirectory())
    throw new Error("Workspace root is not a directory.");
  // Device/inode identity folds symlink and filesystem case aliases without assuming
  // that every filesystem on one OS has the same case behavior.
  const filesystemIdentity = hash(
    JSON.stringify([hostId, stat.dev, stat.ino || canonicalRoot]),
  );
  return { canonicalRoot, filesystemIdentity };
}
const observation = (detail: string): Evidence => ({
  level: "topsl-transaction",
  source: "workspace-ownership",
  observedAt: now(),
  detail,
});
export class WorkspaceOwnership {
  readonly instanceId = uid();
  readonly processBinding = hash(
    JSON.stringify([process.pid, Date.now() - process.uptime() * 1000, uid()]),
  );
  private owner?: CoordinatorOwner;
  constructor(
    private store: Store,
    readonly profileId = "local-profile",
    private ttlMs = 30_000,
  ) {}
  acquireProfile(): CoordinatorOwner {
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare("SELECT body FROM coordinator_owners WHERE profile_id=?")
        .get(this.profileId);
      const existing: CoordinatorOwner | undefined =
        row && JSON.parse(row.body);
      if (existing && existing.instanceId !== this.instanceId) {
        let absent = false;
        try {
          process.kill(existing.pid, 0);
        } catch (error: any) {
          absent = error.code === "ESRCH";
        }
        // A heartbeat timeout or PID reuse never grants ownership. A present or
        // unobservable process requires explicit external resolution.
        if (!absent)
          throw new Error(
            "This Topsl profile already has a coordination owner. Connect to or close that instance first.",
          );
      }
      const at = now();
      this.owner = {
        id: this.profileId,
        instanceId: this.instanceId,
        pid: process.pid,
        processBinding: this.processBinding,
        generation: (existing?.generation ?? 0) + 1,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      };
      this.store.db
        .prepare(
          "INSERT INTO coordinator_owners(profile_id,instance_id,pid,body) VALUES(?,?,?,?) ON CONFLICT(profile_id) DO UPDATE SET instance_id=excluded.instance_id,pid=excluded.pid,body=excluded.body",
        )
        .run(
          this.profileId,
          this.instanceId,
          process.pid,
          JSON.stringify(this.owner),
        );
      this.store.event("coordinator.acquired", {
        instanceId: this.instanceId,
        generation: this.owner.generation,
      });
      return this.owner;
    });
  }
  assertOwner(): CoordinatorOwner {
    const row = this.store.db
      .prepare(
        "SELECT body FROM coordinator_owners WHERE profile_id=? AND instance_id=?",
      )
      .get(this.profileId, this.instanceId);
    if (!row || !this.owner)
      throw new Error("This service no longer owns the Topsl profile.");
    const owner: CoordinatorOwner = JSON.parse(row.body);
    if (owner.generation !== this.owner.generation)
      throw new Error("Coordinator ownership generation changed.");
    return owner;
  }
  heartbeat(): void {
    this.store.transaction(() => {
      const owner = this.assertOwner(),
        at = now();
      this.owner = {
        ...owner,
        heartbeatAt: at,
        expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
      };
      this.store.db
        .prepare(
          "UPDATE coordinator_owners SET body=? WHERE profile_id=? AND instance_id=?",
        )
        .run(JSON.stringify(this.owner), this.profileId, this.instanceId);
      for (const lease of this.list().filter(
        (item) => item.ownerId === this.instanceId && item.state === "held",
      )) {
        lease.heartbeatAt = at;
        lease.expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
        this.write(lease);
      }
    });
  }
  acquire(
    workspace: {
      id: string;
      projectId: string;
      root: string;
      filesystemIdentity: string | null;
    },
    attemptId: string,
  ): WorkspaceLease {
    return this.store.transaction(() => {
      this.assertOwner();
      const identity = canonicalWorkspaceIdentity(workspace.root);
      if (workspace.filesystemIdentity !== identity.filesystemIdentity)
        throw new Error(
          "Workspace identity changed. Revalidate its trust before dispatch.",
        );
      const previous = this.get(identity.filesystemIdentity);
      if (previous && previous.state !== "released") {
        if (
          previous.attemptId === attemptId &&
          previous.ownerId === this.instanceId &&
          previous.state === "held"
        )
          return previous;
        throw new Error(
          "This workspace already has a writer lease or uncertain ownership. Expiry does not prove termination; reconcile before starting another writer.",
        );
      }
      const at = now();
      const lease: WorkspaceLease = {
        id: identity.filesystemIdentity,
        filesystemIdentity: identity.filesystemIdentity,
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        attemptId,
        ownerId: this.instanceId,
        generation: (previous?.generation ?? 0) + 1,
        acquiredAt: at,
        heartbeatAt: at,
        expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
        state: "held",
        execution: { pid: null, binding: null },
        evidence: observation(
          "Exclusive managed writer acquired transactionally.",
        ),
      };
      this.write(lease);
      this.store.event("workspace.lease-acquired", {
        projectId: workspace.projectId,
        attemptId,
        workspaceId: workspace.id,
        generation: lease.generation,
      });
      return lease;
    });
  }
  get(identity: string): WorkspaceLease | undefined {
    const row = this.store.db
      .prepare("SELECT body FROM workspace_leases WHERE filesystem_identity=?")
      .get(identity);
    return row && JSON.parse(row.body);
  }
  forAttempt(attemptId: string): WorkspaceLease | undefined {
    const row = this.store.db
      .prepare(
        "SELECT body FROM workspace_leases WHERE attempt_id=? AND state!='released'",
      )
      .get(attemptId);
    return row && JSON.parse(row.body);
  }
  list(projectId?: string): WorkspaceLease[] {
    return this.store.db
      .prepare("SELECT body FROM workspace_leases ORDER BY filesystem_identity")
      .all()
      .map((row) => JSON.parse(row.body))
      .filter((lease) => !projectId || lease.projectId === projectId);
  }
  private write(lease: WorkspaceLease): void {
    this.store.db
      .prepare(
        "INSERT INTO workspace_leases(filesystem_identity,attempt_id,owner_id,generation,state,body) VALUES(?,?,?,?,?,?) ON CONFLICT(filesystem_identity) DO UPDATE SET attempt_id=excluded.attempt_id,owner_id=excluded.owner_id,generation=excluded.generation,state=excluded.state,body=excluded.body",
      )
      .run(
        lease.filesystemIdentity,
        lease.attemptId,
        lease.ownerId,
        lease.generation,
        lease.state,
        JSON.stringify(lease),
      );
  }
  bindExecution(
    attemptId: string,
    generation: number,
    pid: number,
    binding: string,
  ): void {
    this.store.transaction(() => {
      const lease = this.assertLease(attemptId, generation);
      lease.execution = { pid, binding };
      this.write(lease);
    });
  }
  assertLease(attemptId: string, generation: number): WorkspaceLease {
    this.assertOwner();
    const lease = this.forAttempt(attemptId);
    if (
      !lease ||
      lease.ownerId !== this.instanceId ||
      lease.generation !== generation ||
      lease.state !== "held"
    )
      throw new Error("Workspace lease is stale or uncertain.");
    return lease;
  }
  markUncertain(attemptId: string, detail: string): void {
    this.store.transaction(() => {
      this.assertOwner();
      const lease = this.forAttempt(attemptId);
      if (!lease) return;
      lease.state = "uncertain";
      lease.evidence = observation(detail);
      this.write(lease);
    });
  }
  release(
    attemptId: string,
    generation: number,
    evidence: Evidence,
    expectedOwnerId: string = this.instanceId,
  ): void {
    if (
      ![
        "provider-readback",
        "source-observation",
        "user-confirmation",
        "topsl-transaction",
      ].includes(evidence.level)
    )
      throw new Error(
        "Termination or quarantine evidence is required to release ownership.",
      );
    this.store.transaction(() => {
      this.assertOwner();
      const lease = this.forAttempt(attemptId);
      if (
        !lease ||
        lease.generation !== generation ||
        lease.ownerId !== expectedOwnerId
      )
        throw new Error("Workspace lease owner or generation changed.");
      lease.state = "released";
      lease.evidence = evidence;
      this.write(lease);
      this.store.event("workspace.lease-released", {
        projectId: lease.projectId,
        attemptId,
        generation,
      });
    });
  }
  releaseProfile(): void {
    if (!this.owner) return;
    this.store.db
      .prepare(
        "DELETE FROM coordinator_owners WHERE profile_id=? AND instance_id=?",
      )
      .run(this.profileId, this.instanceId);
    this.owner = undefined;
  }
}
