/**
 * The agent-job tools' definitions (docs/Subscription_Runtime_Architecture_Plan.md
 * Phase 6), shared by Topsl's MCP server for Claude Code and the native
 * harness's core tools. The orchestration's AgentJobService answers them.
 */
export const agentJobTools = [
  {
    name: "start_agent_job",
    description:
      "Ask Topsl to run a bounded child task for this goal on whichever model its role resolves to (Claude through Claude Code, GPT through Topsl, or Codex). Topsl records it now and starts it once the coordinators' plan is committed; it is reviewed and integrated with the goal. Returns a job_id. Repeating a call with the same idempotency_key returns the same job.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200 },
        brief: { type: "string", maxLength: 20_000 },
        kind: { type: "string", enum: ["implementation", "information"] },
        role: { type: "string", maxLength: 64 },
        permitted_outputs: {
          type: "array",
          items: { type: "string" },
          maxItems: 200,
        },
        acceptance_criteria: {
          type: "array",
          items: { type: "string" },
          maxItems: 50,
        },
        idempotency_key: { type: "string", maxLength: 200 },
      },
      required: ["title", "brief", "kind"],
      additionalProperties: false,
    },
  },
  {
    name: "get_agent_job",
    description:
      "Read an agent job's status (queued, running, stopping, completed, blocked or cancelled) and its concise result.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", maxLength: 64 } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_agent_job",
    description:
      "Cancel an agent job that has not started. Running work stops only with its goal.",
    inputSchema: {
      type: "object",
      properties: { job_id: { type: "string", maxLength: 64 } },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
] as const;
