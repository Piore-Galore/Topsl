export interface DemoFixture {
  root: string;
  gitExecutable: string;
  baseCommit: string;
  paths: string[];
  manifest: {
    version: number;
    evidenceClass: string;
    seed: string;
    stress: boolean;
    sourceFiles: Array<{ path: string; bytes: number; sha256: string }>;
    logicalBytes: number;
    sourceIdentity: string;
    dependency: { path: string; sha256: string; origin: string };
    live?: true;
    feature:
      | { newPath: string; expectedTotalCents: number }
      | { path: string; expectedTotalCents: number };
  };
}
export function fixtureCommand(
  executable: string,
  args: string[],
  cwd: string,
): Promise<string>;
export function createDemoFixture(options?: {
  root?: string;
  seed?: string;
  stress?: boolean;
  gitExecutable?: string;
  live?: boolean;
}): Promise<DemoFixture>;
export function discountSource(defective?: boolean): string;
export const featureOrderSource: string;
