/** A committed, project-scoped observation. Sequence numbers are comparable only within an epoch. */
export interface ReadObservation {
  projectId: string;
  epoch: string;
  sequence: number;
  generatedAt: string;
}

export type Observed<T> = T & { observation: ReadObservation };
