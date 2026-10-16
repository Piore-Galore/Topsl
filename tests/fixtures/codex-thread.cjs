// What Codex CLI 0.163.0 answers to `thread/start` and `thread/resume`, as its
// generated schema describes it: the thread, and the approval policy,
// approvals reviewer and sandbox policy it adopted. The stand-ins adopt what
// they are asked for. To act as managed requirements could make Codex act,
// FIXTURE_REPORTED_APPROVAL, FIXTURE_REPORTED_REVIEWER and
// FIXTURE_REPORTED_SANDBOX report another value instead: an approval policy
// (`granular` reports a granular policy), a reviewer, or a sandbox by its
// command-line name. `omit` leaves the field out.
const sandboxes = {
  "read-only": () => ({ type: "readOnly", networkAccess: false }),
  "workspace-write": (cwd) => ({
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  }),
  "danger-full-access": () => ({ type: "dangerFullAccess" }),
};
const granular = {
  granular: { mcp_elicitations: true, rules: true, sandbox_approval: true },
};
/** The answer to a thread/start or thread/resume with these params. `extra`
 * replaces fields, such as a model other than the one asked for. */
function threadResponse(params, id, extra = {}) {
  const cwd = params.cwd ?? process.cwd(),
    seconds = Math.floor(Date.now() / 1000),
    approval =
      process.env.FIXTURE_REPORTED_APPROVAL ??
      params.approvalPolicy ??
      "on-request",
    reviewer =
      process.env.FIXTURE_REPORTED_REVIEWER ??
      params.approvalsReviewer ??
      "user",
    sandbox =
      process.env.FIXTURE_REPORTED_SANDBOX ?? params.sandbox ?? "read-only";
  const response = {
    thread: {
      id,
      sessionId: id,
      cliVersion: "0.163.0",
      createdAt: seconds,
      updatedAt: seconds,
      cwd,
      ephemeral: false,
      modelProvider: "openai",
      preview: "",
      projectId: null,
      source: "appServer",
      status: { type: "idle" },
      turns: [],
    },
    approvalPolicy: approval === "granular" ? granular : approval,
    approvalsReviewer: reviewer,
    cwd,
    model: params.model ?? "fixture-model",
    modelProvider: "openai",
    sandbox: sandboxes[sandbox]?.(cwd) ?? { type: sandbox },
    ...extra,
  };
  if (approval === "omit") delete response.approvalPolicy;
  if (reviewer === "omit") delete response.approvalsReviewer;
  if (sandbox === "omit") delete response.sandbox;
  return response;
}
module.exports = { threadResponse };
