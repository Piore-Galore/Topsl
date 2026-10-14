import type Database from "better-sqlite3-multiple-ciphers";
import { migrateWithBackup } from "./backup";
import { hash, now } from "../../domain/invariants";
import {
  unknownEvidence,
  type AgentSession,
  type ExecutionAttempt,
  type Task,
  type Workspace,
} from "../../domain/workflow";
import type {
  ContextSnapshot,
  Conversation,
  Project,
  Run,
} from "../../domain/types";

export const COORDINATION_SCHEMA_VERSION = 3;
/** Checkpoint and leave WAL mode before locking/copying. The copy is made while
 * an EXCLUSIVE transaction holds the rollback-journal database; no live WAL is copied. */
export function migrateCoordination(
  db: Database,
  file: string,
  key: string,
): void {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version >= COORDINATION_SCHEMA_VERSION) return;
  if (version !== 2)
    throw new Error("Coordination migration requires schema 2.");
  migrateWithBackup(db, file, key, 2, 3, (backup) => {
    db.exec(`
      CREATE TABLE coordinator_owners(profile_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,pid INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE TABLE workspace_leases(filesystem_identity TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,owner_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);
      CREATE INDEX workspace_leases_attempt ON workspace_leases(attempt_id);
      CREATE INDEX coordination_task_project ON documents(kind,json_extract(body,'$.projectId'),json_extract(body,'$.taskId'));
      CREATE INDEX coordination_session_project ON documents(kind,json_extract(body,'$.projectId'),json_extract(body,'$.sessionId'));
      CREATE INDEX coordination_workflow_project ON documents(kind,json_extract(body,'$.projectId'),json_extract(body,'$.workflowId'));
      CREATE INDEX coordination_attempt_state ON documents(kind,json_extract(body,'$.workspaceId'),json_extract(body,'$.state'));
    `);
    const read = <T>(kind: string): T[] =>
      db
        .prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid")
        .all(kind)
        .map((row) => JSON.parse(row.body));
    const put = <T extends { id: string }>(kind: string, value: T) =>
      db
        .prepare(
          "INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO NOTHING",
        )
        .run(kind, value.id, JSON.stringify(value));
    const projects = read<Project>("project"),
      conversations = read<Conversation>("conversation"),
      runs = read<Run>("run");
    const tombstones = new Set(
      read<{ id: string }>("tombstone").map((record) => record.id),
    );
    const at = now(),
      evidence = unknownEvidence(
        "Legacy provenance was not recorded; no trust, delivery, or acceptance is inferred.",
      );
    const workspaceIds = new Map<string, string>();
    for (const project of projects) {
      const workspace: Workspace = {
        id: `legacy-workspace:${project.id}`,
        projectId: project.id,
        hostId: "local",
        root: project.path,
        canonicalRoot: project.realPath,
        filesystemIdentity: null,
        checkoutType: "unknown",
        branch: null,
        trustRevision: project.trusted
          ? hash(JSON.stringify([project.id, project.realPath, "legacy-trust"]))
          : null,
        availability: "unverified",
        provenance: "legacy-mapping",
        revision: 1,
        createdAt: project.createdAt,
        updatedAt: at,
      };
      workspaceIds.set(project.id, workspace.id);
      put("workspace", workspace);
    }
    const sessionFor = (
      conversation: Conversation,
      provider: "codex" | "claude",
      nativeSessionId: string | null,
      role: Task["role"],
      run?: Run,
    ): AgentSession => {
      const session: AgentSession = {
        id: `legacy-session:${hash(JSON.stringify([conversation.id, provider, nativeSessionId, role, run?.nativeAccountKey ?? conversation.nativeAccounts?.[provider] ?? null])).slice(0, 32)}`,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        provider,
        nativeSessionId,
        profileId: null,
        accountKey:
          run?.nativeAccountKey ??
          conversation.nativeAccounts?.[provider] ??
          null,
        runtimeRevision: run?.installationRevisionId ?? null,
        executableIdentity: run?.executableIdentity ?? null,
        workspaceId:
          workspaceIds.get(conversation.projectId) ??
          `legacy-workspace:${conversation.projectId}`,
        role,
        parentSessionId: null,
        forkOfSessionId: null,
        observability: "observed-external",
        resumable: false,
        continuity: "unknown",
        evidence,
        revision: 1,
        createdAt: run?.createdAt ?? conversation.createdAt,
        updatedAt: at,
      };
      put("agent-session", session);
      return session;
    };
    for (const conversation of conversations) {
      if (tombstones.has(conversation.id)) continue;
      for (const provider of ["codex", "claude"] as const)
        if (conversation.nativeSessions[provider])
          sessionFor(
            conversation,
            provider,
            conversation.nativeSessions[provider]!,
            "historical",
          );
    }
    let migratedRuns = 0;
    for (const run of runs) {
      if (tombstones.has(run.conversationId)) continue;
      const conversation = conversations.find(
        (item) => item.id === run.conversationId,
      ) ?? {
        id: run.conversationId,
        projectId: run.projectId,
        title: "Historical session",
        nativeSessions: {},
        createdAt: run.createdAt,
      };
      const session = sessionFor(
        conversation,
        run.provider,
        run.nativeSessionId,
        run.mode === "native"
          ? "native"
          : run.mode === "review"
            ? "reviewer"
            : "implementer",
        run,
      );
      const state = [
        "starting",
        "running",
        "awaiting-approval",
        "uncertain",
      ].includes(run.status)
        ? "uncertain"
        : run.status;
      const task: Task = {
        id: `legacy-task:${run.id}`,
        projectId: run.projectId,
        workflowId: null,
        conversationId: run.conversationId,
        title: `Historical ${run.mode} execution`,
        role: "historical",
        workspaceId: session.workspaceId,
        dependencies: [],
        inputRefs: [],
        permittedOutputs: [],
        acceptanceCriteria: [],
        requiredCapabilities: [],
        state: state === "completed" ? "submitted" : "blocked",
        attemptIds: [`legacy-attempt:${run.id}`],
        candidateId: null,
        detail:
          "Legacy execution outcome only; code basis and acceptance were not recorded.",
        revision: 1,
        createdAt: run.createdAt,
        updatedAt: at,
      };
      const attempt: ExecutionAttempt = {
        id: `legacy-attempt:${run.id}`,
        projectId: run.projectId,
        taskId: task.id,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        conversationId: run.conversationId,
        legacyRunId: run.id,
        provider: run.provider,
        requestedModel: run.model,
        reportedModel: null,
        modelEvidence: evidence,
        contextPackageId: null,
        specificationRevision: null,
        inputManifest: {
          workspaceIdentity: null,
          baseRevision: null,
          contentManifestId: null,
          dirtyInputPolicy: "unknown",
          instructionHashes: [],
        },
        state: state as ExecutionAttempt["state"],
        dispatchId: `legacy-dispatch:${run.id}`,
        operationIntentId: null,
        retryOfAttemptId: null,
        leaseGeneration: null,
        error: run.error,
        usageEvidence: evidence,
        finishedAt: null,
        revision: 1,
        createdAt: run.createdAt,
        updatedAt: at,
      };
      put("task", task);
      put("attempt", attempt);
      migratedRuns++;
    }
    const snapshots = read<ContextSnapshot>("snapshot");
    for (const snapshot of snapshots) {
      if (tombstones.has(snapshot.conversationId)) continue;
      put("context-package", {
        ...snapshot,
        specificationRevision: null,
        sourceRefs: snapshot.sourceMessageIds,
        omissions: ["Legacy snapshot completeness and delivery are unknown."],
        visibility: "project",
        completeness: "legacy-unknown",
      });
    }
    put("migration", {
      id: "coordination-v3",
      from: 2,
      to: 3,
      at,
      backup,
      integrity: "ok",
      projects: projects.length,
      runs: migratedRuns,
      tombstones: tombstones.size,
    });
  });
}
