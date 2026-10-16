import type { ReportedPermissions } from "./types";

/**
 * The Codex chat presets from the provider permissions plan. Each pairs one of
 * Topsl's two sandboxes with an approval policy that Codex's app-server
 * accepts. Topsl sends only these values, and before it sends a prompt it
 * checks that Codex reports having adopted them.
 */
export const codexApprovalPolicies = [
  "untrusted",
  "on-request",
  "never",
] as const;
export type CodexApprovalPolicy = (typeof codexApprovalPolicies)[number];

export const chatPresetIds = [
  "review",
  "edit",
  "edit-on-request",
  "edit-never",
] as const;
export type ChatPresetId = (typeof chatPresetIds)[number];

export interface ChatPreset {
  id: ChatPresetId;
  label: string;
  /** The sandbox: read-only for a review; otherwise the workspace alone, without network. */
  mode: "review" | "edit";
  approvalPolicy: CodexApprovalPolicy;
  /** Who decides when Codex asks for approval, as the composer says it. */
  decides: string;
  /** Offered only on a runtime whose current qualification passed workspace-write. */
  needsQualifiedSandbox?: true;
}

export const chatPresets: readonly ChatPreset[] = [
  {
    id: "review",
    label: "Read-only review",
    mode: "review",
    approvalPolicy: "untrusted",
    decides: "Topsl declines every request Codex makes.",
  },
  {
    id: "edit",
    label: "Workspace edits · ask",
    mode: "edit",
    approvalPolicy: "untrusted",
    decides: "You decide, before any command outside Codex's known-safe list.",
  },
  {
    id: "edit-on-request",
    label: "Workspace edits · ask when needed",
    mode: "edit",
    approvalPolicy: "on-request",
    decides: "You decide, when the model asks for more access.",
  },
  {
    id: "edit-never",
    label: "Workspace edits · no asking",
    mode: "edit",
    approvalPolicy: "never",
    decides:
      "Nobody is asked. Codex's sandbox has the last word, and a command it blocks fails.",
    needsQualifiedSandbox: true,
  },
];

/** What a preset lets commands do, and who decides when Codex asks. */
export const chatPresetNote = (preset: ChatPreset) =>
  `${
    preset.mode === "review"
      ? "Commands cannot write."
      : "Commands write only in the workspace, without network."
  } ${preset.decides}`;

/** The preset with this id, or an error for one Topsl does not offer. */
export function chatPreset(id: string): ChatPreset {
  const preset = chatPresets.find((p) => p.id === id);
  if (!preset)
    throw new Error(`Topsl has no Codex chat preset ${JSON.stringify(id)}.`);
  return preset;
}

/** The preset a run used. A run recorded before the presets asked for `untrusted`. */
export const chatPresetFor = (
  mode: string,
  approvalPolicy: string = "untrusted",
): ChatPreset | undefined =>
  chatPresets.find(
    (p) => p.mode === mode && p.approvalPolicy === approvalPolicy,
  );

/** A chat preset a runtime cannot use now, and why. */
export interface ChatPresetBlock {
  installationId: string;
  preset: ChatPresetId;
  reason: string;
}

/** Why No asking is unavailable, by the state of the runtime's qualification. */
export const noAskingBlocked = {
  missing:
    "Qualify this runtime first, from Create a workflow on the Activity page. No asking needs a qualification that saw Codex's sandbox block a write outside the workspace.",
  stale:
    "Its qualification has expired, or its executable, account or policy has changed since. Qualify it again, from Create a workflow on the Activity page.",
  failed:
    "Its current qualification did not pass workspace-write, so Topsl has not seen its sandbox block a write outside the workspace.",
} as const;

/** Codex's sandbox policy types, by the names its command line uses. */
const sandboxNames: Record<string, string> = {
  readOnly: "read-only",
  workspaceWrite: "workspace-write",
  dangerFullAccess: "danger-full-access",
  externalSandbox: "external-sandbox",
};
/** A sandbox policy type as Codex's command line names it, or as reported. */
export const sandboxName = (type: string) => sandboxNames[type] ?? type;

/** What Codex reported when a chat's thread started or resumed, in words. */
export function reportedPermissionsText(reported: ReportedPermissions): string {
  const named = (what: string, value: string | null) =>
    value === null ? `no ${what}` : `${what} ${value}`;
  return `Codex reported ${[
    named("approval policy", reported.approvalPolicy),
    named(
      "sandbox",
      reported.sandbox === null ? null : sandboxName(reported.sandbox),
    ),
    named("approvals reviewer", reported.approvalsReviewer),
  ].join(", ")}.`;
}
