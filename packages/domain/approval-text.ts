import type { Approval } from "./types";

/** The approval's summary as plain text, or its request's JSON when it has
 * none. A value on several lines starts on its own line, indented, so none
 * of its lines can pass for Topsl's own text. */
export function approvalText(approval: Approval): string {
  const summary = approval.summary;
  if (!summary) return approval.description;
  const details = summary.details
    .map(({ label, value }) =>
      value.includes("\n")
        ? `${label}:\n${value.replace(/^/gm, "    ")}`
        : `${label}: ${value}`,
    )
    .join("\n");
  return [summary.title, details, summary.effects.join("\n")]
    .filter(Boolean)
    .join("\n\n");
}

/** The detail of Topsl's trusted confirmation before it allows an approval,
 * from the approval as the service recorded it. */
export function approvalConfirmation(approval: Approval): string {
  return `${approvalText(approval)}\n\nRun: ${approval.runId}\nRequest: ${approval.requestId}\nDigest: ${approval.digest}`;
}
