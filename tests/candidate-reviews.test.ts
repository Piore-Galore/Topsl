import { afterEach, expect, test } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixture } from "./helpers";
import {
  assertCandidateCoverage,
  assertCandidateOutputCoverage,
  captureCandidate,
} from "../packages/workflows/candidates";
import {
  applyCandidateReview,
  candidateBinaryPreview,
  previewCandidateReview,
} from "../packages/workflows/candidate-reviews";

const opened: Awaited<ReturnType<typeof fixture>>[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture();
  opened.push(f);
  await writeFile(
    path.join(f.directory, "main.ts"),
    "export const value = 1;\n",
  );
  await writeFile(
    path.join(f.directory, "image.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]),
  );
  const selection = {
    root: f.directory,
    projectId: "p",
    workflowId: "w",
    selectedPaths: ["main.ts", "image.png"],
  };
  const baseline = await captureCandidate(f.store, selection);
  await writeFile(
    path.join(f.directory, "new.ts"),
    "export const added = true;\n",
  );
  await writeFile(
    path.join(f.directory, "image.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 2]),
  );
  const candidate = await captureCandidate(f.store, {
    ...selection,
    approvedUntracked: ["new.ts"],
    baseCandidateId: baseline.id,
    authorAttemptId: "fixture-attempt",
  });
  const file = candidate.files.find((entry) => entry.path === "new.ts")!;
  return {
    ...f,
    candidate,
    outputs: [
      { path: file.path, hash: file.hash!, decision: "approved" as const },
    ],
    binaries: [
      {
        path: "image.png",
        detail: "Fixture verifier inspected the captured byte change.",
      },
    ],
  };
}

test("R2-AT-18/23: artifact approval binds exact bytes, is single-use, and later rejection revokes approval", async () => {
  const f = await setup();
  expect(() => assertCandidateOutputCoverage(f.candidate, f.store)).toThrow(
    "output",
  );
  const plan = await previewCandidateReview(f.store, {
    projectId: "p",
    candidateId: f.candidate.id,
    outputs: f.outputs,
    binaries: f.binaries,
  });
  const preview = candidateBinaryPreview(
    f.store,
    "p",
    f.candidate.id,
    "image.png",
  );
  expect(preview).toMatchObject({
    mime: "image/png",
    candidateRevision: f.candidate.revision,
  });
  await expect(
    applyCandidateReview(f.store, "p", plan.id, "wrong"),
  ).rejects.toThrow("approval");
  await expect(
    applyCandidateReview(f.store, "other", plan.id, plan.digest),
  ).rejects.toThrow("approval");
  expect(f.store.get("candidate-review-consumed", plan.id)).toBeUndefined();
  await applyCandidateReview(f.store, "p", plan.id, plan.digest);
  expect(() => assertCandidateCoverage(f.candidate, f.store)).not.toThrow();
  expect(
    f.candidate.outputs?.find((entry) => entry.path === "new.ts")?.status,
  ).toBe("pending");
  await expect(
    applyCandidateReview(f.store, "p", plan.id, plan.digest),
  ).rejects.toThrow("consumed");
  const rejection = await previewCandidateReview(f.store, {
    projectId: "p",
    candidateId: f.candidate.id,
    outputs: [{ ...f.outputs[0], decision: "rejected" }],
    binaries: [],
  });
  await applyCandidateReview(f.store, "p", rejection.id, rejection.digest);
  expect(() => assertCandidateOutputCoverage(f.candidate, f.store)).toThrow(
    "rejected",
  );
});

test("R2-AT-20/23: source drift and mismatched hashes cannot grant output approval", async () => {
  const f = await setup();
  await expect(
    previewCandidateReview(f.store, {
      projectId: "p",
      candidateId: f.candidate.id,
      outputs: [{ ...f.outputs[0], hash: "0".repeat(64) }],
      binaries: [],
    }),
  ).rejects.toThrow("manifest");
  const plan = await previewCandidateReview(f.store, {
    projectId: "p",
    candidateId: f.candidate.id,
    outputs: f.outputs,
    binaries: [],
  });
  await writeFile(path.join(f.directory, "new.ts"), "external source change");
  await expect(
    applyCandidateReview(f.store, "p", plan.id, plan.digest),
  ).rejects.toThrow("changed");
  expect(f.store.get("candidate-review-consumed", plan.id)).toBeUndefined();
  expect(() =>
    candidateBinaryPreview(f.store, "other", f.candidate.id, "image.png"),
  ).toThrow("another project");
});
