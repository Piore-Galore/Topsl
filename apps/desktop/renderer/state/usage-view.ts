import type { UsageSummary } from "../../../../packages/domain/usage";
/** Missing observations never turn into a displayed zero-token measurement. */
export function usageReadout(summary: UsageSummary) {
  if (!summary.coveredRuns)
    return "Input unknown · output unknown · no reported usage";
  return `${summary.knownInput.toLocaleString()} known input · ${summary.knownOutput.toLocaleString()} known output${summary.complete ? "" : " · partial coverage"}`;
}
