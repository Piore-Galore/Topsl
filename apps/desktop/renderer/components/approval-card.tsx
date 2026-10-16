import { Fragment } from "react";
import type { Approval } from "../../../../packages/domain/types";
import { ActionButton } from "./action-button";

/** A native approval request: what allowing does in words, then the request
 * as the runtime sent it. Deny comes first, and allowing still goes through
 * Topsl's trusted confirmation. */
export function ApprovalCard({
  approval,
  decide,
}: {
  approval: Approval;
  decide: (allow: boolean) => unknown;
}) {
  const summary = approval.summary;
  return (
    <div
      className="approval"
      role="group"
      aria-label={summary?.title ?? "Native approval requested"}
    >
      <strong>{summary?.title ?? "Native approval requested"}</strong>
      {summary ? (
        <>
          <dl className="approval-details">
            {summary.details.map((detail, index) => (
              <Fragment key={index}>
                <dt>{detail.label}</dt>
                <dd>
                  <pre>{detail.value}</pre>
                </dd>
              </Fragment>
            ))}
          </dl>
          <ul className="approval-effects">
            {summary.effects.map((effect, index) => (
              <li key={index}>{effect}</li>
            ))}
          </ul>
          <details>
            <summary>Request as sent</summary>
            <pre>{approval.description}</pre>
          </details>
        </>
      ) : (
        <pre>{approval.description}</pre>
      )}
      <div className="actions">
        <ActionButton onClick={() => void decide(false)}>Deny</ActionButton>
        <ActionButton className="primary" onClick={() => void decide(true)}>
          Review & allow once
        </ActionButton>
      </div>
    </div>
  );
}
