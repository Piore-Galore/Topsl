import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { hash, now, safeError, stable } from "../domain/invariants";
import type { Project } from "../domain/types";
import { ProtectedBlobs } from "../persistence/blobs";
import type { Store } from "../persistence/store";
import {
  assertCandidateCurrent,
  captureCandidate,
  gitWorkingTreeChanges,
  materializeCandidate,
  type CandidateSnapshot,
} from "../workflows/candidates";
import { candidateChanges } from "../workflows/parallel-specialists";
import { writeManagedSnapshot } from "../workspace/managed";
import type { Connection, ProxyRoute } from "../proxy/types";
import type { CanonicalOutputFormat } from "../proxy/canonical";
import { memberCapabilityBlockers } from "../proxy/capabilities";
import {
  relaxSchemaForMessages,
  strictCompatible,
} from "../proxy/protocols/shared";
import { canonicalWorkspaceIdentity } from "../workspace/ownership";
import { NativeJournal } from "./journal";
import { NativeKernel, type AttemptSpec } from "./kernel";
import {
  ProxyModelClient,
  type ModelClient,
  type ProxyEndpoint,
} from "./model-client";
import { ResourceLedger } from "./resources";
import { nativeProcessIdentity } from "./process-identity";
import { transcript } from "./context";
import {
  admitTools,
  mcpTool,
  sha256,
  toolchainFolders,
  type NativeTool,
  type SkillEntry,
  type ToolOutcome,
  type DelegationRequest,
} from "./tools";
import {
  McpClient,
  admittedMcpTools,
  mcpToolName,
  schemaHash,
  type McpServerDefinition,
} from "./mcp";
import { containmentStatus, runContained } from "./sandbox";
import {
  defaultLimits,
  delegationLimits,
  terminalStates,
  type ExecutionBinding,
  type NativeAttemptView,
  type NativeMemberContext,
  type ToolGrants,
  type JournalBodies,
} from "./types";

/**
 * The control service's native harness (docs/Native_Harness_Plan.md §3).
 * It prepares each attempt's own workspace copy from a captured baseline,
 * freezes the binding and grants, runs the kernel, turns a finished edit
 * attempt into an ordinary candidate, and keeps acceptance and application
 * to the original folder as separate, owner-approved steps.
 */

export interface RouteInfo {
  route: ProxyRoute;
  connection: Connection;
}

export interface NativeStartInput {
  projectId: string;
  prompt: string;
  title?: string;
  routeAlias: string;
  mode: "investigate" | "edit";
  processes: boolean;
  networkDomains: string[];
  checks: Array<{ name: string; argv: string[]; timeoutMs: number }>;
  delegation: boolean;
  mcpServerIds: string[];
  reasoningEffort: string | null;
  contextWindowTokens: number | null;
  maxRequests: number | null;
}

/**
 * A coordinator, session or loop member turn on Topsl's native harness
 * (docs/Native_Harness_Plan.md §3, "Teams and extensions"). The
 * orchestration driver prepares the member's own copy and captures its
 * candidate; the harness runs the turn there under a frozen binding.
 */
export interface NativeMemberStartInput {
  /** Chosen by the caller when it records the launch before starting it. */
  attemptId?: string;
  projectId: string;
  routeAlias: string;
  title: string;
  prompt: string;
  workspace: {
    root: string;
    writable: boolean;
    /** The snapshot the copy was made from, when there is one. */
    baselineCandidateId: string | null;
  };
  /** The JSON Schema the final answer must follow, or null for free text. */
  outputSchema: { name: string; schema: Record<string, unknown> } | null;
  member: NativeMemberContext;
  reasoningEffort: string | null;
  /** The episode's request budget; null keeps the default. */
  maxRequests: number | null;
  /** Whether the turn may request agent jobs (the driver recorded its authority). */
  agentJobs?: boolean;
  /**
   * The goal's owner-configured checks an implementation member may run
   * inside the sandbox before it submits (plan Phase 7). Ignored for a
   * read-only member and where containment is unavailable.
   */
  checks?: Array<{ name: string; argv: string[]; timeoutMs: number }>;
}

export interface NativeHookDefinition {
  id: string;
  projectId: string;
  event: "before-tool" | "after-tool";
  argv: string[];
  timeoutMs: number;
  admittedAt: string;
}

export interface NativeMemory {
  id: string;
  projectId: string;
  text: string;
  state: "proposed" | "accepted" | "declined";
  attemptId: string;
  createdAt: string;
  decidedAt: string | null;
}

export interface NativeHarnessOptions {
  store: Store;
  profileDirectory: string;
  endpoint: () => ProxyEndpoint | null;
  route: (alias: string) => RouteInfo | null;
  /**
   * Why a bound route can no longer be used, when it was retired; null when
   * it was not. Retired bindings stay readable and are never dispatched.
   */
  retired?: (binding: { routeId: string; connectionId: string }) => string | null;
  gitExecutable: string;
  model?: ModelClient;
  resources?: ResourceLedger;
  onChange?: (view: NativeAttemptView) => void;
  onProvisional?: (attemptId: string, text: string | null) => void;
}

/** Context windows used when a route has no observed value. */
const defaultWindows: Record<string, number> = {
  "chatgpt-plan": 200_000,
  "openai-api": 200_000,
  "anthropic-api": 200_000,
  "openai-compatible": 32_000,
  ollama: 8_192,
};

const MAX_INSTRUCTION_BYTES = 32 * 1024;
const MAX_SKILLS = 50;

async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else if (entry.isFile())
      await chmod(target, (await stat(target)).mode | 0o200);
  }
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== ".git") out.push(...(await listFiles(root, rel)));
    } else if (entry.isFile() && !entry.name.startsWith(".topsl-write-"))
      out.push(rel);
  }
  return out;
}

/**
 * A task's model route was retired. Its history stays readable; it cannot
 * continue, and Topsl never moves it to another route, account or engine.
 */
export class RouteRetiredError extends Error {
  readonly code = "route-retired";
  constructor(readonly reason: string) {
    super(
      `This task's model route was retired, so it cannot continue. ${reason} Its history stays here; start a new task on a supported route.`,
    );
    this.name = "RouteRetiredError";
  }
}

export class NativeHarness {
  /**
   * Answers a member's agent-job tools; set by the control service once its
   * orchestrator exists. Null: the tools answer that jobs are unavailable.
   */
  agentJobs:
    | ((
        attemptId: string,
        callId: string,
        tool: string,
        args: unknown,
      ) => { ok: boolean; text: string })
    | null = null;
  readonly journal: NativeJournal;
  readonly kernel: NativeKernel;
  readonly resources: ResourceLedger;
  readonly blobs: ProtectedBlobs;
  private readonly mcp = new Map<
    string,
    Map<string, { client: McpClient; tool: string }>
  >();
  private readonly baselines = new Map<string, Map<string, string | null>>();
  private readonly mcpClients = new Map<string, Set<McpClient>>();

  constructor(private options: NativeHarnessOptions) {
    this.journal = new NativeJournal(options.store);
    this.blobs = new ProtectedBlobs(options.store);
    this.resources =
      options.resources ?? new ResourceLedger({ store: options.store });
    this.kernel = new NativeKernel({
      journal: this.journal,
      blobs: this.blobs,
      model: options.model ?? new ProxyModelClient(options.endpoint),
      resources: this.resources,
      gitExecutable: options.gitExecutable,
      tools: (spec) => this.tools(spec),
      skills: (spec) => this.storedSpec(spec.attemptId)?.skills ?? [],
      baseline: (spec) => this.baseline(spec),
      submit: (spec, summary) => this.submit(spec, summary),
      delegate: (parent, callId, request, signal) =>
        this.delegate(parent, callId, request, signal),
      integrate: (parent, child) => this.integrate(parent, child),
      proposeMemory: (spec, text) => this.proposeMemory(spec, text),
      callMcp: (spec, tool, args) => this.callMcp(spec, tool, args),
      agentJobs: async (spec, callId, tool, args) => {
        if (!this.agentJobs)
          return { ok: false, output: "Agent jobs are not available here." };
        const answer = this.agentJobs(spec.attemptId, callId, tool, args);
        return { ok: answer.ok, output: answer.text };
      },
      hooks: {
        before: (spec, call) => this.runHooks(spec, "before-tool", call, null),
        after: async (spec, call, outcome) => {
          await this.runHooks(spec, "after-tool", call, outcome);
        },
      },
      recordProcess: (attemptId, callId, pid) => {
        const id = `${attemptId}:${callId}`;
        if (pid === null) this.store.remove("native-process", id);
        else
          this.store.put("native-process", {
            id,
            attemptId,
            callId,
            pid,
            identity: nativeProcessIdentity(pid),
            startedAt: now(),
          });
      },
      onChange: (view) => {
        options.onChange?.(view);
        if (terminalStates.has(view.state)) this.stopMcp(view.attemptId);
      },
      onProvisional: options.onProvisional,
    });
    // A member turn waits with every attempt on its allowance; when the
    // owner tries the allowance again, the waiting members continue.
    this.resources.onQuotaResumed((owner) => this.resumeQuotaMembers(owner));
  }

  private get store() {
    return this.options.store;
  }

  private storedSpec(
    attemptId: string,
  ): (AttemptSpec & { skills: SkillEntry[]; mcpServerIds: string[] }) | null {
    return this.store.get("native-attempt-spec", attemptId) ?? null;
  }

  /** Why the binding's route was retired, or null when it is usable. */
  retiredReason(binding: AttemptSpec["binding"]): string | null {
    const native = binding.native;
    if (!native) return null;
    const reason = this.options.retired?.({
      routeId: native.routeId,
      connectionId: native.connectionId,
    });
    if (reason) return reason;
    return native.connectionKind === "claude-plan"
      ? "Direct Claude subscription sign-in was removed from Topsl."
      : null;
  }

  private baseline(spec: AttemptSpec): Map<string, string | null> {
    let map = this.baselines.get(spec.attemptId);
    if (!map) {
      map = new Map();
      const id = spec.workspace.baselineCandidateId;
      const snapshot = id
        ? this.store.get<CandidateSnapshot>("candidate", id)
        : undefined;
      for (const file of snapshot?.files ?? [])
        if (file.hash) map.set(file.path, file.hash);
      this.baselines.set(spec.attemptId, map);
    }
    return map;
  }

  private tools(spec: AttemptSpec): NativeTool[] {
    const stored = this.storedSpec(spec.attemptId);
    const mcp = [...(this.mcp.get(spec.attemptId)?.entries() ?? [])].map(
      ([name, entry]) =>
        mcpTool({
          name,
          description: `[${entry.client.definition.name}] ${entry.tool}`,
          inputSchema: { type: "object" },
          revision: `mcp-${entry.client.definition.name}-${entry.tool}`,
        }),
    );
    const tools = admitTools(spec.grants, {
      skills: (stored?.skills.length ?? 0) > 0,
      memory: true,
      mcp: stored ? this.mcpDefinitions(spec.attemptId, mcp) : mcp,
      childOf: spec.parentAttemptId,
    });
    return tools.map((tool) =>
      tool.name !== "run_check"
        ? tool
        : {
            ...tool,
            revision: "run_check-candidate-v2",
            execute: async (args, ctx) => {
              const check = spec.grants.checks.find(
                (c) => c.name === args.name,
              );
              if (!check) return tool.execute(args, ctx);
              const before = await this.captureWorkspace(spec, ctx.signal);
              const outcome = await tool.execute(args, ctx);
              const after = await this.captureWorkspace(spec, ctx.signal);
              const unchanged = before.revision === after.revision;
              return {
                ...outcome,
                ok: outcome.ok && unchanged,
                output: unchanged
                  ? outcome.output
                  : `${outcome.output}\n\nThe workspace changed during this check. Run it again on the finished candidate.`,
                evidence: {
                  ...outcome.evidence,
                  checkName: check.name,
                  checkDefinitionHash: hash(stable(check)),
                  checkCandidateId: after.id,
                  checkCandidateRevision: after.revision,
                  checkWorkspaceStable: unchanged,
                },
              };
            },
          },
    );
  }
  private mcpDefinitions(
    attemptId: string,
    fallback: NativeTool[],
  ): NativeTool[] {
    const stored = this.store.get<{
      id: string;
      tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        revision: string;
      }>;
    }>("native-attempt-mcp", attemptId);
    return stored ? stored.tools.map((t) => mcpTool(t)) : fallback;
  }

  // ── Attempts ───────────────────────────────────────────────────────────

  /** Starts a native task in its own workspace copy. */
  async start(input: NativeStartInput): Promise<NativeAttemptView> {
    const project = this.store.get<Project>("project", input.projectId);
    if (!project) throw new Error("The project does not exist.");
    if (!project.trusted)
      throw new Error(
        "Trust the project folder before starting a native task.",
      );
    if (project.availability && project.availability !== "available")
      throw new Error(
        "The project folder is missing or moved. Relink it first.",
      );
    if (!input.prompt.trim())
      throw new Error("Write what the native agent should do.");
    if (input.checks.length && !input.processes)
      throw new Error("Allow contained commands to run the configured checks.");
    if (new Set(input.checks.map((c) => c.name)).size !== input.checks.length)
      throw new Error("Give each configured check a unique name.");
    const info = this.options.route(input.routeAlias);
    if (!info)
      throw new Error(`No connection route is named ${input.routeAlias}.`);
    if (info.route.disabled) throw new Error("That route is turned off.");
    if (!["ready", "paused-usage-limit"].includes(info.connection.state))
      throw new Error(
        `${info.connection.label} is not ready (${info.connection.state}).`,
      );
    const attemptId = randomUUID();
    const edit = input.mode === "edit";
    // The tracked files are the task's starting point, as for loops; a folder
    // without Git has no implied file selection.
    if (!existsSync(path.join(project.realPath, ".git")))
      throw new Error(
        "Native tasks need a Git project folder: Topsl copies its tracked files as the task's starting point.",
      );
    const baseline = await captureCandidate(this.store, {
      root: project.realPath,
      projectId: project.id,
      workflowId: attemptId,
      authorAttemptId: null,
    });
    const copy = await materializeCandidate(baseline, undefined, this.store, {
      readOnlyFolders: !edit,
    });
    if (edit) await makeWritable(copy.root);
    const grants: ToolGrants = {
      write: edit,
      processes: input.processes,
      networkDomains: [
        ...new Set(input.networkDomains.map((d) => d.trim()).filter(Boolean)),
      ],
      checks: input.checks,
      delegation: input.delegation,
      mcpTools: [],
      candidates: [],
    };
    const limits = {
      ...defaultLimits,
      ...(input.maxRequests
        ? { maxRequests: Math.min(Math.max(input.maxRequests, 1), 500) }
        : {}),
    };
    const binding = this.binding(
      info,
      input.reasoningEffort,
      input.contextWindowTokens,
      grants,
      limits,
    );
    const skills = await this.readSkills(project.realPath);
    const spec: AttemptSpec = {
      attemptId,
      projectId: project.id,
      title: (input.title?.trim() || input.prompt.trim().split("\n")[0]).slice(
        0,
        120,
      ),
      prompt: input.prompt,
      instructions: "",
      binding,
      limits,
      grants,
      workspace: {
        root: copy.root,
        identity: baseline.workspaceIdentity,
        writable: edit,
        baselineCandidateId: baseline.id,
      },
      projectRoot: project.realPath,
      tempRoot: await this.tempRoot(attemptId),
      parentAttemptId: null,
      rootAttemptId: attemptId,
      depth: 0,
      delegationMode: null,
    };
    const mcp = await this.startMcp(spec, input.mcpServerIds);
    spec.grants = { ...grants, mcpTools: mcp.map((t) => t.name) };
    spec.binding = this.binding(
      info,
      input.reasoningEffort,
      input.contextWindowTokens,
      spec.grants,
      limits,
    );
    spec.instructions = await this.instructions(project, spec, skills);
    this.store.put("native-attempt-spec", {
      ...spec,
      id: attemptId,
      skills,
      mcpServerIds: input.mcpServerIds,
    });
    return this.kernel.start(spec);
  }

  /**
   * Starts one member turn in the copy the orchestration driver prepared.
   * The turn gets read (and, for implementation, edit) tools only: no
   * commands, network, delegation or MCP, so its effects stay in its copy.
   * A turn that needs a schema is refused on a route recorded as unable to
   * carry one.
   */
  async startMember(input: NativeMemberStartInput): Promise<NativeAttemptView> {
    const project = this.store.get<Project>("project", input.projectId);
    if (!project) throw new Error("The project does not exist.");
    const info = this.options.route(input.routeAlias);
    if (!info)
      throw new Error(`No connection route is named ${input.routeAlias}.`);
    if (info.route.disabled) throw new Error("That route is turned off.");
    if (!["ready", "paused-usage-limit"].includes(info.connection.state))
      throw new Error(
        `${info.connection.label} is not ready (${info.connection.state}).`,
      );
    if (
      input.outputSchema &&
      info.route.capabilities.structuredOutput === "unsupported"
    )
      throw new Error(
        `${info.route.alias} is recorded as unable to enforce a response schema, which this turn needs.`,
      );
    const capabilityBlocker = memberCapabilityBlockers(
      info.route,
      info.connection,
      !!input.outputSchema,
    )[0];
    if (capabilityBlocker)
      throw new Error(capabilityBlocker.slice(capabilityBlocker.indexOf(":") + 2));
    if (!existsSync(input.workspace.root))
      throw new Error("The member's workspace copy does not exist.");
    const attemptId = input.attemptId ?? randomUUID();
    const checks =
      input.workspace.writable && input.checks?.length
        ? (await containmentStatus()).available
          ? input.checks
          : []
        : [];
    const grants: ToolGrants = {
      write: input.workspace.writable,
      processes: false,
      networkDomains: [],
      checks,
      delegation: false,
      mcpTools: [],
      candidates: [],
      ...(input.agentJobs ? { agentJobs: true } : {}),
    };
    const limits = {
      ...defaultLimits,
      ...(input.maxRequests
        ? { maxRequests: Math.min(Math.max(input.maxRequests, 1), 500) }
        : {}),
    };
    const binding = this.binding(
      info,
      input.reasoningEffort,
      null,
      grants,
      limits,
    );
    const outputFormat = memberOutputFormat(
      input.outputSchema,
      info.route.protocol,
    );
    const identity = canonicalWorkspaceIdentity(input.workspace.root);
    const skills = await this.readSkills(input.workspace.root);
    const spec: AttemptSpec = {
      attemptId,
      projectId: project.id,
      title: input.title.slice(0, 120),
      prompt: input.prompt,
      instructions: "",
      binding,
      limits,
      grants,
      workspace: {
        root: identity.canonicalRoot,
        identity: identity.filesystemIdentity,
        writable: input.workspace.writable,
        baselineCandidateId: input.workspace.baselineCandidateId,
      },
      projectRoot: project.realPath,
      tempRoot: await this.tempRoot(attemptId),
      parentAttemptId: null,
      rootAttemptId: attemptId,
      depth: 0,
      delegationMode: null,
      outputFormat,
      member: input.member,
    };
    // Instruction files and skills come from the member's copy: the content
    // the turn was given, not a fresh read of the project folder.
    spec.instructions = await this.instructions(
      { ...project, realPath: identity.canonicalRoot },
      spec,
      skills,
    );
    this.store.put("native-attempt-spec", {
      ...spec,
      id: attemptId,
      skills,
      mcpServerIds: [],
    });
    return this.kernel.start(spec);
  }

  /** Continues every member turn that waited on `owner`'s allowance. */
  private resumeQuotaMembers(owner: string): void {
    for (const view of this.journal.unfinished()) {
      if (view.state !== "waiting-quota") continue;
      if (view.binding.native?.quotaOwner !== owner) continue;
      if (this.kernel.isRunning(view.attemptId)) continue;
      const spec = this.storedSpec(view.attemptId);
      if (!spec?.member) continue;
      if (this.retiredReason(spec.binding)) continue;
      try {
        this.kernel.resume(spec);
      } catch {
        // Finished or claimed meanwhile; nothing to continue.
      }
    }
  }

  private binding(
    info: RouteInfo,
    reasoningEffort: string | null,
    contextWindowTokens: number | null,
    grants: ToolGrants,
    limits: typeof defaultLimits,
  ): ExecutionBinding {
    return {
      id: randomUUID(),
      engine: "native",
      native: {
        routeId: info.route.id,
        routeAlias: info.route.alias,
        routeRevision: info.route.revision,
        connectionId: info.connection.id,
        connectionKind: info.connection.kind,
        connectionLabel: info.connection.label,
        protocol: info.route.protocol,
        upstreamModel: info.route.upstreamModel,
        funding: info.connection.funding,
        accountKey: info.connection.account.accountKey,
        quotaOwner: info.connection.account.quotaOwner,
      },
      vendor: null,
      model: {
        reasoningEffort,
        contextWindowTokens:
          contextWindowTokens ?? defaultWindows[info.connection.kind] ?? 32_000,
      },
      policyRevision: hash(stable({ grants, limits })),
      createdAt: now(),
    };
  }

  private async tempRoot(attemptId: string): Promise<string> {
    const root = path.join(
      this.options.profileDirectory,
      "native",
      attemptId,
      "tmp",
    );
    await mkdir(root, { recursive: true, mode: 0o700 });
    return root;
  }

  /** Project instruction files, skills and accepted memories, frozen into the attempt. */
  private async instructions(
    project: Project,
    spec: AttemptSpec,
    skills: SkillEntry[],
  ): Promise<string> {
    const parts: string[] = [
      `You are Topsl's native coding agent, working in a private copy of the project "${project.name}". Work only through the tools you are given; paths are relative to the workspace root.`,
      spec.grants.write
        ? "You may change files in your copy. Read a file before you edit it: edits and replacements need the sha256 that read_file reported, and are refused if the file changed since. Your changes stay in this copy; the owner reviews them as a candidate before anything reaches their folder."
        : "This attempt is read-only: investigate and report; do not try to change files.",
      spec.grants.processes
        ? `Commands run in Topsl's sandbox: ${spec.grants.networkDomains.length ? `network only to ${spec.grants.networkDomains.join(", ")}` : "no network"}, writes only inside the workspace${spec.grants.write ? "" : " (not even there in this attempt)"} and a private temporary folder.`
        : "You cannot run commands in this attempt.",
      spec.grants.checks.length
        ? `Run every configured check with run_check after your final edit: ${spec.grants.checks.map((c) => c.name).join(", ")}. Each must pass on the unchanged final candidate before the owner can apply it. If a check changes the workspace, run it again after those changes settle.`
        : "",
      spec.grants.delegation
        ? `You may hand bounded sub-tasks to child agents with delegate (at most ${delegationLimits.maxDepth} levels deep and ${delegationLimits.maxActiveDescendants} active at a time). You alone integrate writable children's results.`
        : "",
      spec.outputFormat
        ? "When you are done, answer without calling tools, with only the JSON object your task describes. It must follow the response schema exactly; nothing before or after it."
        : "When you are done, answer with a concise summary of what you found or changed and how you verified it, without calling tools.",
    ].filter(Boolean);
    const files = await this.projectInstructionFiles(project.realPath);
    if (files)
      parts.push(
        `Project instructions (from the project folder, verbatim):\n\n${files}`,
      );
    if (skills.length)
      parts.push(
        `Project skills (load one with load_skill when it applies):\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`,
      );
    const memories = this.memories(project.id).filter(
      (m) => m.state === "accepted",
    );
    if (memories.length)
      parts.push(
        `Accepted project notes:\n${memories.map((m) => `- ${m.text}`).join("\n")}`,
      );
    return parts.join("\n\n");
  }

  private async projectInstructionFiles(root: string): Promise<string> {
    const out: string[] = [];
    let budget = MAX_INSTRUCTION_BYTES;
    const include = async (name: string, depth: number) => {
      const file = path.join(root, name);
      if (budget <= 0 || !existsSync(file)) return;
      const info = await stat(file);
      if (!info.isFile()) return;
      const text = (await readFile(file, "utf8")).slice(0, budget);
      budget -= text.length;
      const lines: string[] = [];
      for (const line of text.split("\n")) {
        const reference = /^@([\w./-]+)$/.exec(line.trim());
        if (reference && depth < 2 && !reference[1].includes(".."))
          await include(reference[1], depth + 1);
        else lines.push(line);
      }
      if (lines.join("").trim())
        out.push(`--- ${name} ---\n${lines.join("\n")}`);
    };
    await include("AGENTS.md", 0);
    await include("CLAUDE.md", 0);
    return out.join("\n\n");
  }

  /** Skills from the trusted project folder, frozen at start (progressive disclosure). */
  async readSkills(root: string): Promise<SkillEntry[]> {
    const skills: SkillEntry[] = [];
    for (const folder of [".agents/skills", ".claude/skills", "skills"]) {
      const base = path.join(root, folder);
      if (!existsSync(base)) continue;
      for (const entry of await readdir(base, { withFileTypes: true })) {
        if (!entry.isDirectory() || skills.length >= MAX_SKILLS) continue;
        const file = path.join(base, entry.name, "SKILL.md");
        if (!existsSync(file)) continue;
        const body = (await readFile(file, "utf8")).slice(0, 64 * 1024);
        const front = /^---\n([\s\S]*?)\n---/.exec(body)?.[1] ?? "";
        const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim() || entry.name;
        const description =
          /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() || "";
        if (!skills.some((s) => s.name === name))
          skills.push({
            name: name.slice(0, 100),
            description: description.slice(0, 500),
            path: `${folder}/${entry.name}/SKILL.md`,
            body,
          });
      }
    }
    return skills;
  }

  view(attemptId: string) {
    return this.journal.view(attemptId);
  }
  list(projectId: string, cursor: string | null, limit = 50) {
    return this.journal.list(projectId, {
      before: cursor,
      limit,
      rootsOnly: true,
    });
  }
  events(attemptId: string, after: number, limit: number) {
    return this.journal.events(attemptId, after, limit);
  }

  steer(attemptId: string, text: string) {
    if (!text.trim()) throw new Error("Write the steering message.");
    return this.kernel.steer(attemptId, text.trim().slice(0, 20_000));
  }
  pause(attemptId: string) {
    this.kernel.pause(attemptId);
    return this.journal.require(attemptId);
  }
  async resume(attemptId: string) {
    const spec = this.storedSpec(attemptId);
    if (!spec)
      throw new Error("The attempt's frozen specification is missing.");
    const current = this.journal.require(attemptId);
    if (terminalStates.has(current.state))
      throw new Error("The attempt has finished.");
    if (current.state === "uncertain")
      throw new Error("Reconcile the uncertain tool call before resuming.");
    if (this.kernel.isRunning(attemptId))
      throw new Error("The attempt is already running.");
    const retired = this.retiredReason(spec.binding);
    if (retired) throw new RouteRetiredError(retired);
    if (
      (!this.mcp.has(attemptId) ||
        [...(this.mcpClients.get(attemptId) ?? [])].some((c) => !c.running)) &&
      spec.mcpServerIds.length
    ) {
      this.stopMcp(attemptId);
      await this.startMcp(spec, spec.mcpServerIds, true);
    }
    const owner = spec.binding.native?.quotaOwner;
    // Resuming a quota wait is the owner deciding to try the allowance again.
    if (owner && this.resources.quotaWait(owner))
      this.resources.resumeQuota(owner);
    return this.kernel.resume(spec);
  }
  /** Clears a quota wait for every attempt funded by `owner`. */
  resumeQuota(owner: string) {
    this.resources.resumeQuota(owner);
  }
  cancel(attemptId: string) {
    return this.kernel.cancel(attemptId);
  }
  reconcile(
    attemptId: string,
    callId: string,
    outcome: "applied" | "not-applied",
    note: string,
  ) {
    return this.kernel.reconcile(attemptId, callId, outcome, note);
  }

  /**
   * After the control service restarts: every unfinished attempt is claimed,
   * reconciled from its journal and left paused for the owner. Nothing that
   * could have an external effect is replayed.
   */
  async recoverAll(): Promise<number> {
    let count = 0;
    for (const view of this.journal.unfinished()) {
      const spec = this.storedSpec(view.attemptId);
      if (!spec) continue;
      const processes = new Map<string, number>();
      const identities = new Map<number, string>();
      for (const record of this.store.list<{
        id: string;
        attemptId: string;
        callId: string;
        pid: number;
        identity?: string | null;
      }>("native-process"))
        if (record.attemptId === view.attemptId) {
          processes.set(record.callId, record.pid);
          if (record.identity) identities.set(record.pid, record.identity);
        }
      const owned = (pid: number) => {
        const recorded = identities.get(pid);
        return !!recorded && nativeProcessIdentity(pid) === recorded;
      };
      await this.kernel.recover(spec, processes, owned, (pid) => {
        if (!owned(pid)) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          if (!owned(pid)) return;
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      });
      for (const callId of processes.keys())
        this.store.remove("native-process", `${view.attemptId}:${callId}`);
      count++;
    }
    return count;
  }

  // ── Submission and application ─────────────────────────────────────────

  private async captureWorkspace(spec: AttemptSpec, signal?: AbortSignal) {
    return captureCandidate(this.store, {
      root: spec.workspace.root,
      owned: true,
      projectId: spec.projectId,
      workflowId: spec.rootAttemptId,
      authorAttemptId: spec.attemptId,
      baseCandidateId: spec.workspace.baselineCandidateId ?? undefined,
      selectedPaths: await listFiles(spec.workspace.root),
      signal,
    });
  }

  private async submit(
    spec: AttemptSpec,
    _summary: string,
  ): Promise<string | null> {
    // A member turn's candidate is captured by the orchestration driver,
    // which checks it against the turn's permitted outputs.
    if (spec.member) return null;
    if (!spec.workspace.writable || !spec.workspace.baselineCandidateId)
      return null;
    const candidate = await this.captureWorkspace(spec);
    return candidate.id;
  }

  /** What applying a finished attempt's candidate to the original folder would change. */
  async applyPreview(attemptId: string) {
    const spec = this.storedSpec(attemptId);
    const view = this.journal.require(attemptId);
    if (!spec || !view.candidateId || !spec.workspace.baselineCandidateId)
      throw new Error("This attempt has no candidate to apply.");
    if (view.state !== "completed")
      throw new Error("Only a completed attempt's candidate can be applied.");
    const project = this.store.get<Project>("project", spec.projectId);
    if (!project) throw new Error("The project does not exist.");
    const baseline = this.store.get<CandidateSnapshot>(
      "candidate",
      spec.workspace.baselineCandidateId,
    )!;
    const candidate = this.store.get<CandidateSnapshot>(
      "candidate",
      view.candidateId,
    )!;
    const problems: string[] = [];
    const checks = new Map<string, JournalBodies["tool-result"]>();
    const checkCalls = new Map<string, string>();
    for (const event of this.journal.all(attemptId)) {
      if (event.kind === "tool-intended") {
        const intent = event.body as JournalBodies["tool-intended"];
        const args = intent.arguments as { name?: unknown } | null;
        if (intent.tool === "run_check" && typeof args?.name === "string")
          checkCalls.set(intent.callId, args.name);
      }
      if (event.kind !== "tool-result") continue;
      const result = event.body as JournalBodies["tool-result"];
      const name = checkCalls.get(result.callId);
      if (typeof name === "string") checks.set(name, result);
    }
    for (const check of spec.grants.checks) {
      const result = checks.get(check.name);
      if (
        !result?.ok ||
        result.evidence?.checkDefinitionHash !== hash(stable(check)) ||
        result.evidence?.checkCandidateRevision !== candidate.revision ||
        result.evidence?.checkWorkspaceStable !== true
      )
        problems.push(
          `Check ${check.name} has no passing result for this exact candidate. Start a new task to complete its checks before applying.`,
        );
    }
    if (!project.trusted) problems.push("The project folder must be trusted.");
    if (baseline.sourceRoot !== project.realPath)
      problems.push(
        "The project was relinked to another folder after this attempt started.",
      );
    if (!baseline.git)
      problems.push(
        "Applying needs a Git checkout, so Topsl can show the folder has no other changes.",
      );
    else
      try {
        const dirty = await gitWorkingTreeChanges(
          project.realPath,
          this.options.gitExecutable,
        );
        if (dirty.length)
          problems.push(
            `The project folder has uncommitted or untracked changes (${dirty.slice(0, 8).join(", ")}${dirty.length > 8 ? ` and ${dirty.length - 8} more` : ""}). Commit, stash or remove them first.`,
          );
      } catch (error) {
        problems.push(
          `Git could not report the folder's state: ${safeError(error)}`,
        );
      }
    try {
      await assertCandidateCurrent(baseline, this.options.gitExecutable);
    } catch (error) {
      problems.push(
        `The project folder changed since this attempt's baseline: ${safeError(error)}`,
      );
    }
    const before = new Set(
      baseline.files.filter((f) => f.hash).map((f) => f.path),
    );
    const files = candidateChanges(baseline, candidate).map((f) => ({
      path: f.path,
      change:
        f.hash === null
          ? ("deleted" as const)
          : before.has(f.path)
            ? ("modified" as const)
            : ("added" as const),
    }));
    const preview = {
      attemptId,
      candidateId: candidate.id,
      root: project.realPath,
      files,
      problems,
    };
    return { ...preview, digest: hash(stable(preview)) };
  }

  /** Writes the reviewed candidate into the original folder; separate from acceptance. */
  async apply(attemptId: string, digest: string) {
    const preview = await this.applyPreview(attemptId);
    if (preview.digest !== digest)
      throw new Error(
        "The folder or candidate changed since the preview. Review it again.",
      );
    if (preview.problems.length) return { refused: preview.problems.join(" ") };
    const spec = this.storedSpec(attemptId)!;
    const baseline = this.store.get<CandidateSnapshot>(
      "candidate",
      spec.workspace.baselineCandidateId!,
    )!;
    const candidate = this.store.get<CandidateSnapshot>(
      "candidate",
      preview.candidateId,
    )!;
    const changed = candidateChanges(baseline, candidate);
    await writeManagedSnapshot(
      { ...candidate, files: changed },
      preview.root,
      this.store,
    );
    for (const file of changed) {
      const target = path.join(preview.root, file.path);
      if (file.hash === null) {
        if (existsSync(target))
          throw new Error(`${file.path} was not removed.`);
        continue;
      }
      if (sha256(await readFile(target)) !== file.hash)
        throw new Error(`${file.path} does not match the candidate.`);
    }
    this.store.put("native-application", {
      id: attemptId,
      attemptId,
      candidateId: candidate.id,
      files: preview.files,
      appliedAt: now(),
    });
    return { applied: preview.files };
  }

  // ── Delegation ─────────────────────────────────────────────────────────

  private async delegate(
    parent: AttemptSpec,
    callId: string,
    request: DelegationRequest,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const root = this.journal.require(parent.rootAttemptId);
    if (terminalStates.has(root.state) || signal.aborted)
      return {
        ok: false,
        output: "The task was stopped; no child was started.",
      };
    if (parent.depth + 1 > delegationLimits.maxDepth)
      return {
        ok: false,
        output: `Delegation is limited to ${delegationLimits.maxDepth} levels.`,
      };
    const tree = this.journal.tree(parent.rootAttemptId);
    const active = tree.filter(
      (v) =>
        v.attemptId !== parent.rootAttemptId && !terminalStates.has(v.state),
    ).length;
    if (active >= delegationLimits.maxActiveDescendants)
      return {
        ok: false,
        output: `At most ${delegationLimits.maxActiveDescendants} child agents may be active under one task.`,
      };
    const rootSpec = this.storedSpec(parent.rootAttemptId);
    const used = tree.reduce((sum, v) => sum + v.requests, 0);
    const remaining =
      (rootSpec?.limits.maxRequests ?? defaultLimits.maxRequests) - used;
    if (remaining < 3)
      return {
        ok: false,
        output:
          "The task's model-request budget is nearly used; no child was started.",
      };
    const childId = randomUUID();
    const writable = request.writable && parent.grants.write;
    let source: CandidateSnapshot;
    if (request.mode === "fresh")
      source = this.store.get<CandidateSnapshot>(
        "candidate",
        parent.workspace.baselineCandidateId!,
      )!;
    else
      source = await captureCandidate(this.store, {
        root: parent.workspace.root,
        owned: true,
        projectId: parent.projectId,
        workflowId: parent.rootAttemptId,
        authorAttemptId: parent.attemptId,
        baseCandidateId: parent.workspace.baselineCandidateId ?? undefined,
        selectedPaths: await listFiles(parent.workspace.root),
      });
    const copy = await materializeCandidate(source, undefined, this.store, {
      readOnlyFolders: !writable,
    });
    if (writable) await makeWritable(copy.root);
    let prompt = request.task;
    if (request.mode === "task-package" && request.contextPaths.length) {
      const pieces: string[] = [];
      for (const rel of request.contextPaths.slice(0, 20)) {
        const file = path.join(copy.root, rel);
        if (existsSync(file))
          pieces.push(
            `--- ${rel} ---\n${(await readFile(file, "utf8")).slice(0, 32 * 1024)}`,
          );
      }
      prompt = `${request.task}\n\nFiles the parent agent shared:\n\n${pieces.join("\n\n")}`;
    } else if (request.mode === "fork") {
      const events = [...this.journal.all(parent.attemptId)];
      prompt = `You are continuing from another agent's visible work. Its conversation so far:\n\n${transcript(events, Number.MAX_SAFE_INTEGER, null, 0, 120_000)}\n\nYour task: ${request.task}`;
    }
    const grants: ToolGrants = {
      ...parent.grants,
      write: writable,
      delegation:
        parent.grants.delegation &&
        parent.depth + 2 <= delegationLimits.maxDepth,
    };
    const limits = {
      ...parent.limits,
      maxRequests: Math.min(defaultLimits.maxRequests, remaining),
    };
    const binding: ExecutionBinding = {
      ...parent.binding,
      id: randomUUID(),
      policyRevision: hash(stable({ grants, limits })),
      createdAt: now(),
    };
    const parentStored = this.storedSpec(parent.attemptId);
    const spec: AttemptSpec = {
      ...parent,
      attemptId: childId,
      title: `Child: ${request.task.split("\n")[0]}`.slice(0, 120),
      prompt,
      binding,
      limits,
      grants,
      workspace: {
        root: copy.root,
        identity: source.workspaceIdentity,
        writable,
        baselineCandidateId: source.id,
      },
      tempRoot: await this.tempRoot(childId),
      parentAttemptId: parent.attemptId,
      rootAttemptId: parent.rootAttemptId,
      depth: parent.depth + 1,
      delegationMode: request.mode,
    };
    const inheritedServers = parentStored?.mcpServerIds ?? [];
    const parentMcp = this.store.get<{ id: string }>(
      "native-attempt-mcp",
      parent.attemptId,
    );
    if (parentMcp)
      this.store.put("native-attempt-mcp", { ...parentMcp, id: childId });
    const inheritedTools = await this.startMcp(
      spec,
      inheritedServers,
      !!parentMcp,
    );
    spec.grants = {
      ...spec.grants,
      mcpTools: inheritedTools.map((t) => t.name),
    };
    spec.binding = {
      ...spec.binding,
      policyRevision: hash(stable({ grants: spec.grants, limits })),
    };
    this.store.put("native-attempt-spec", {
      ...spec,
      id: childId,
      skills: parentStored?.skills ?? [],
      mcpServerIds: inheritedServers,
    });
    const parentView = this.journal.require(parent.attemptId);
    this.journal.append(parent.attemptId, parentView.generation, [
      {
        kind: "child-started",
        body: {
          callId,
          childAttemptId: childId,
          mode: request.mode,
          task: request.task,
        },
      },
    ]);
    this.kernel.start(spec);
    const onAbort = () => void this.kernel.cancel(childId);
    signal.addEventListener("abort", onAbort, { once: true });
    let child: NativeAttemptView;
    try {
      child = await this.kernel.settled(childId);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    const current = this.journal.require(parent.attemptId);
    this.journal.append(parent.attemptId, current.generation, [
      {
        kind: "child-finished",
        body: {
          childAttemptId: childId,
          state: child.state,
          summary: child.summary ?? child.stateDetail ?? "",
          candidateId: child.candidateId,
        },
      },
    ]);
    return {
      ok: child.state === "completed",
      output: `Child ${childId} ${child.state}.${child.summary ? `\nSummary:\n${child.summary}` : child.stateDetail ? `\n${child.stateDetail}` : ""}${child.candidateId ? `\nIts changes are candidate ${child.candidateId}; apply them with integrate_child.` : ""}`,
      evidence: {
        childAttemptId: childId,
        state: child.state,
        candidateId: child.candidateId,
      },
    };
  }

  /** Applies a finished writable child's changes to its parent's copy, refusing any file the parent changed since. */
  private async integrate(
    parent: AttemptSpec,
    childAttemptId: string,
  ): Promise<ToolOutcome> {
    const child = this.journal.view(childAttemptId);
    const childSpec = this.storedSpec(childAttemptId);
    if (!child || !childSpec || child.parentAttemptId !== parent.attemptId)
      return {
        ok: false,
        output: "That is not one of this attempt's children.",
      };
    if (child.state !== "completed" || !child.candidateId)
      return {
        ok: false,
        output: "The child has no completed candidate to integrate.",
      };
    if (this.store.get("native-integration", childAttemptId))
      return { ok: false, output: "That child was already integrated." };
    const base = this.store.get<CandidateSnapshot>(
      "candidate",
      childSpec.workspace.baselineCandidateId!,
    )!;
    const result = this.store.get<CandidateSnapshot>(
      "candidate",
      child.candidateId,
    )!;
    const changes = candidateChanges(base, result);
    const baseHashes = new Map(base.files.map((f) => [f.path, f.hash]));
    const conflicts: string[] = [];
    for (const file of changes) {
      const target = path.join(parent.workspace.root, file.path);
      const current = existsSync(target)
        ? sha256(await readFile(target))
        : null;
      if (current !== (baseHashes.get(file.path) ?? null))
        conflicts.push(file.path);
    }
    if (conflicts.length)
      return {
        ok: false,
        output: `Not integrated: you changed these files since the child started: ${conflicts.join(", ")}. Integrate by hand.`,
      };
    const root = await realpath(parent.workspace.root);
    await writeManagedSnapshot({ ...result, files: changes }, root, this.store);
    this.store.put("native-integration", {
      id: childAttemptId,
      parentAttemptId: parent.attemptId,
      files: changes.map((f) => f.path),
      at: now(),
    });
    return {
      ok: true,
      output: `Integrated ${changes.length} file(s) from child ${childAttemptId}: ${changes.map((f) => f.path).join(", ") || "none"}.`,
      evidence: { files: changes.map((f) => f.path) },
    };
  }

  // ── Memory ─────────────────────────────────────────────────────────────

  private async proposeMemory(
    spec: AttemptSpec,
    text: string,
  ): Promise<ToolOutcome> {
    const memory: NativeMemory = {
      id: randomUUID(),
      projectId: spec.projectId,
      text: text.trim().slice(0, 2000),
      state: "proposed",
      attemptId: spec.attemptId,
      createdAt: now(),
      decidedAt: null,
    };
    this.store.put("native-memory", memory);
    return {
      ok: true,
      output:
        "Proposed. The owner decides whether future tasks see it; it has no effect until accepted.",
    };
  }
  memories(projectId: string): NativeMemory[] {
    return this.store
      .list<NativeMemory>("native-memory")
      .filter((m) => m.projectId === projectId);
  }
  decideMemory(id: string, accept: boolean): NativeMemory {
    const memory = this.store.get<NativeMemory>("native-memory", id);
    if (!memory) throw new Error("The note does not exist.");
    const next = {
      ...memory,
      state: accept ? ("accepted" as const) : ("declined" as const),
      decidedAt: now(),
    };
    this.store.put("native-memory", next);
    return next;
  }

  // ── MCP servers and hooks ──────────────────────────────────────────────

  mcpServers(projectId: string): McpServerDefinition[] {
    return this.store
      .list<McpServerDefinition>("native-mcp-server")
      .filter((s) => s.projectId === projectId);
  }
  /** Starts a server once in a disposable copy to list its tools, for the owner to admit. */
  async mcpInspect(
    projectId: string,
    name: string,
    argv: string[],
    networkDomains: string[],
  ) {
    const project = this.store.get<Project>("project", projectId);
    if (!project?.trusted) throw new Error("Trust the project folder first.");
    const temp = await this.tempRoot(`mcp-inspect-${randomUUID()}`);
    // Listing runs in the trusted project folder, read-only, as tasks later
    // run it in their own copy of that folder.
    const client = new McpClient(
      { name, argv },
      {
        workspaceRoot: project.realPath,
        writable: false,
        tempRoot: temp,
        allowedDomains: networkDomains,
        extraReadable: toolchainFolders,
      },
      project.realPath,
    );
    try {
      const tools = await client.start();
      return {
        tools: tools.map((t) => ({
          ...t,
          schemaHash: schemaHash(t.inputSchema),
        })),
        stderr: client.stderr,
      };
    } finally {
      client.close();
      await rm(path.dirname(temp), { recursive: true, force: true });
    }
  }
  mcpAdmit(input: {
    projectId: string;
    name: string;
    argv: string[];
    networkDomains: string[];
    tools: Record<string, string>;
  }): McpServerDefinition {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(input.name))
      throw new Error(
        "A server name uses letters, digits, _ and - (at most 40).",
      );
    const existing = this.mcpServers(input.projectId).find(
      (s) => s.name === input.name,
    );
    const definition: McpServerDefinition = {
      id: existing?.id ?? randomUUID(),
      projectId: input.projectId,
      name: input.name,
      argv: input.argv,
      networkDomains: input.networkDomains,
      admittedTools: input.tools,
      admittedAt: now(),
    };
    this.store.put("native-mcp-server", definition);
    return definition;
  }
  mcpRemove(id: string) {
    this.store.remove("native-mcp-server", id);
  }

  private async startMcp(
    spec: AttemptSpec,
    serverIds: string[],
    restoring = false,
  ): Promise<NativeTool[]> {
    const previous = this.store.get<{
      id: string;
      tools: NativeTool[];
      servers?: Record<string, string>;
    }>("native-attempt-mcp", spec.attemptId);
    if (restoring && serverIds.length && !previous?.servers)
      throw new Error(
        "This task has no frozen MCP server configuration. Start a new task to use these tools.",
      );
    const servers: Record<string, string> = {};
    const opened = new Set<McpClient>();
    const tools: Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      revision: string;
    }> = [];
    const clients = new Map<string, { client: McpClient; tool: string }>();
    try {
      for (const id of serverIds) {
        const definition = this.store.get<McpServerDefinition>(
          "native-mcp-server",
          id,
        );
        if (!definition || definition.projectId !== spec.projectId)
          throw new Error("An MCP server is not admitted for this project.");
        servers[id] = hash(stable(definition));
        if (
          restoring &&
          previous?.servers &&
          previous.servers[id] !== servers[id]
        )
          throw new Error(
            "The admitted MCP configuration changed. Start a new task to use the new configuration.",
          );
        const client = new McpClient(
          definition,
          {
            workspaceRoot: spec.workspace.root,
            writable: false,
            tempRoot: path.join(spec.tempRoot, `mcp-${definition.name}`),
            allowedDomains: definition.networkDomains,
            extraReadable: toolchainFolders,
          },
          spec.workspace.root,
        );
        opened.add(client);
        await mkdir(path.join(spec.tempRoot, `mcp-${definition.name}`), {
          recursive: true,
          mode: 0o700,
        });
        const listed = await client.start();
        const { admitted, changed } = admittedMcpTools(definition, listed);
        if (changed.length) {
          client.close();
          throw new Error(
            `The MCP server ${definition.name} changed these tools since you admitted them: ${changed.join(", ")}. Inspect and admit it again.`,
          );
        }
        for (const tool of admitted) {
          const name = mcpToolName(definition.name, tool.name);
          if (clients.has(name))
            throw new Error("Two MCP tools have the same normalized name.");
          clients.set(name, { client, tool: tool.name });
          tools.push({
            name,
            description: `[${definition.name}] ${tool.description}`,
            inputSchema: tool.inputSchema,
            revision: `mcp-${definition.id}-${schemaHash(tool.inputSchema).slice(0, 16)}`,
          });
        }
      }
      if (restoring && previous && stable(previous.tools) !== stable(tools))
        throw new Error(
          "The MCP tools changed since this task started. Start a new task after reviewing them.",
        );
      this.mcp.set(spec.attemptId, clients);
      this.mcpClients.set(spec.attemptId, opened);
      this.store.put("native-attempt-mcp", {
        id: spec.attemptId,
        tools,
        servers,
      });
      return tools.map((t) => mcpTool(t));
    } catch (error) {
      for (const client of opened) client.close();
      throw error;
    }
  }
  private async callMcp(
    spec: AttemptSpec,
    tool: string,
    args: unknown,
  ): Promise<ToolOutcome> {
    const entry = this.mcp.get(spec.attemptId)?.get(tool);
    if (!entry)
      return {
        ok: false,
        output:
          "The MCP server is not running for this attempt (Topsl may have restarted).",
      };
    return entry.client.call(entry.tool, args, spec.limits.toolTimeoutMs);
  }
  private stopMcp(attemptId: string) {
    for (const client of this.mcpClients.get(attemptId) ?? []) client.close();
    this.mcpClients.delete(attemptId);
    this.mcp.delete(attemptId);
  }

  hooks(projectId: string): NativeHookDefinition[] {
    return this.store
      .list<NativeHookDefinition>("native-hook")
      .filter((h) => h.projectId === projectId);
  }
  hookAdmit(input: {
    projectId: string;
    event: NativeHookDefinition["event"];
    argv: string[];
    timeoutMs: number;
  }): NativeHookDefinition {
    const hook: NativeHookDefinition = {
      id: randomUUID(),
      ...input,
      timeoutMs: Math.min(Math.max(input.timeoutMs, 1000), 60_000),
      admittedAt: now(),
    };
    this.store.put("native-hook", hook);
    return hook;
  }
  hookRemove(id: string) {
    this.store.remove("native-hook", id);
  }

  /**
   * Runs the project's admitted hooks for one call, contained: read-only
   * workspace, no network. A before-tool hook allows with exit 0 and refuses
   * with exit 2 (its stderr is the reason); anything else refuses.
   */
  private async runHooks(
    spec: AttemptSpec,
    event: NativeHookDefinition["event"],
    call: { tool: string; arguments: unknown },
    outcome: ToolOutcome | null,
  ): Promise<{ allow: boolean; reason: string | null }> {
    for (const hook of this.hooks(spec.projectId).filter(
      (h) => h.event === event,
    )) {
      const temp = path.join(spec.tempRoot, "hooks");
      await mkdir(temp, { recursive: true, mode: 0o700 });
      const result = await runContained(hook.argv, {
        cwd: spec.workspace.root,
        policy: {
          workspaceRoot: spec.workspace.root,
          writable: false,
          tempRoot: temp,
          allowedDomains: [],
          extraReadable: toolchainFolders,
        },
        timeoutMs: hook.timeoutMs,
        stdin: JSON.stringify({
          event,
          attemptId: spec.attemptId,
          tool: call.tool,
          arguments: call.arguments,
          outcome: outcome ? { ok: outcome.ok } : null,
        }),
      });
      if (event === "before-tool" && result.exitCode !== 0)
        return {
          allow: false,
          reason:
            result.exitCode === 2
              ? result.stderr.trim().slice(0, 1000) || null
              : `hook exited with ${result.exitCode ?? result.signal ?? "no status"}`,
        };
    }
    return { allow: true, reason: null };
  }

  /** Removes a finished attempt's workspace copy and temporary folder. */
  async discardWorkspace(attemptId: string): Promise<void> {
    const spec = this.storedSpec(attemptId);
    const view = this.journal.require(attemptId);
    if (!spec || !terminalStates.has(view.state))
      throw new Error("Only a finished attempt's copy can be removed.");
    await makeWritable(spec.workspace.root).catch(() => undefined);
    await rm(spec.workspace.root, { recursive: true, force: true });
    await rm(path.dirname(spec.tempRoot), { recursive: true, force: true });
  }

  close(): void {
    for (const id of [...this.mcp.keys()]) this.stopMcp(id);
  }
}

/**
 * The output format a member turn sends: its schema as given, strict when
 * OpenAI's strict mode can take it, and on a Messages route relaxed to what
 * Anthropic accepts. The engine validates the final text against the full
 * schema in every case.
 */
export function memberOutputFormat(
  schema: NativeMemberStartInput["outputSchema"],
  protocol: ProxyRoute["protocol"],
): CanonicalOutputFormat | null {
  if (!schema) return null;
  const { $schema: _ignored, ...body } = schema.schema;
  if (protocol === "messages")
    return {
      name: schema.name,
      schema: relaxSchemaForMessages(body) as Record<string, unknown>,
      strict: true,
    };
  return { name: schema.name, schema: body, strict: strictCompatible(body) };
}
