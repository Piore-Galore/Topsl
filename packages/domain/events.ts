/** Metadata only: text, credentials and artifact content never travel in control events. */
export interface ControlChange {
  sequence: number;
  kind: string;
  id: string;
  projectId: string | null;
  conversationId: string | null;
  operation: "put" | "remove";
}
export interface ChangePage {
  epoch?: string;
  afterSequence: number;
  throughSequence: number;
  headSequence: number;
  events: ControlChange[];
  hasMore: boolean;
}
/** Scope-filtered sequences may skip unrelated events; the envelope carries the scanned boundary. */
export function advanceSequence(
  current: number,
  page: ChangePage,
): { sequence: number; resync: boolean } {
  const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
  if (
    !integer(current) ||
    !integer(page.afterSequence) ||
    !integer(page.throughSequence) ||
    !integer(page.headSequence) ||
    page.afterSequence > page.throughSequence ||
    page.throughSequence > page.headSequence ||
    page.hasMore !== page.throughSequence < page.headSequence
  )
    return { sequence: current, resync: true };
  let last = page.afterSequence;
  for (const event of page.events) {
    if (
      !integer(event.sequence) ||
      event.sequence <= last ||
      event.sequence > page.throughSequence
    )
      return { sequence: current, resync: true };
    last = event.sequence;
  }
  if (page.throughSequence <= current)
    return { sequence: current, resync: false };
  if (
    page.afterSequence !== current ||
    page.events.some(
      (event) =>
        event.sequence <= current || event.sequence > page.throughSequence,
    )
  )
    return { sequence: current, resync: true };
  return { sequence: page.throughSequence, resync: false };
}
