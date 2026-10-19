/**
 * Campaign 2026-10-19 packet p5a-build-review-candidates (plan §5.16).
 *
 * Candidate capture limits at exactly -1/at/+1 (CA-04), binary, mode-only,
 * no-op and paginated diffs (CA-09), and binary manual attestation bound to
 * exact bytes (CA-13), against the real encrypted store and, for CA-09/CA-13,
 * also through Service.command.
 */
import path from "node:path";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import { fixture } from "./helpers";
import { Service } from "../apps/service/service";
import { commandSchema } from "../packages/domain/commands";
import { now, uid } from "../packages/domain/invariants";
import type { Store } from "../packages/persistence/store";
import { ProtectedBlobs } from "../packages/persistence/blobs";
import {
  assertCandidateCoverage,
  captureCandidate,
  candidateFileBytes,
  recordCandidateBinaryReview,
  type CandidateSnapshot,
} from "../packages/workflows/candidates";
import { candidateDiff } from "../packages/workflows/candidate-diff";
import {
  applyCandidateReview,
  candidateBinaryPreview,
  previewCandidateReview,
} from "../packages/workflows/candidate-reviews";

const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
const services: Array<{ service: Service; directory: string }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.store.close();
    await rm(f.directory, { recursive: true, force: true });
  }
  for (const s of services.splice(0)) {
    await s.service.close();
    await rm(s.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture();
  fixtures.push(f);
  const root = path.join(f.directory, "source");
  await mkdir(root);
  return { ...f, root };
}
const select = (root: string, selectedPaths: string[]) => ({
  root,
  projectId: "p",
  workflowId: "w",
  selectedPaths,
  gitExecutable: "missing-git-fixture",
});
const count = (store: Store, table: string): number =>
  store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

describe("CA-04 capture budgets at their exact boundaries", () => {
  test("CA-04: file, project, count and vault limits accept at and above the limit, reject one below it, and a rejected capture publishes nothing", async () => {
    const f = await setup();
    for (const name of ["a", "b", "c", "d", "e", "x", "y"])
      await writeFile(path.join(f.root, `${name}.txt`), name.repeat(10));
    const blobs = new ProtectedBlobs(f.store);
    const published: CandidateSnapshot[] = [];
    const ok = async (paths: string[], limits: Record<string, number>) => {
      const candidate = await captureCandidate(f.store, {
        ...select(f.root, paths),
        limits,
      });
      published.push(candidate);
      return candidate;
    };
    const refused = async (
      paths: string[],
      limits: Record<string, number>,
      message: string,
    ) => {
      const candidates = [...f.store.iterate("candidate")].length,
        refs = count(f.store, "protected_blob_refs"),
        captures = new Set(
          [...f.store.iterate<{ id: string }>("candidate-capture")].map(
            (c) => c.id,
          ),
        );
      await expect(
        captureCandidate(f.store, { ...select(f.root, paths), limits }),
      ).rejects.toThrow(message);
      // No partial manifest, staging or scoped reference survives the refusal.
      expect([...f.store.iterate("candidate")]).toHaveLength(candidates);
      expect(count(f.store, "protected_blob_staging")).toBe(0);
      expect(count(f.store, "protected_blob_refs")).toBe(refs);
      // A capture that started is recorded as failed; a count refusal stops before one starts.
      expect(
        [...f.store.iterate<{ id: string; state: string }>("candidate-capture")]
          .filter((c) => !captures.has(c.id))
          .map((c) => c.state),
      ).toEqual(message === "file count exceeds" ? [] : ["failed"]);
    };
    // Per-file bytes: a 10-byte file.
    await refused(["a.txt"], { fileBytes: 9 }, "exceeds the capture limit");
    await ok(["a.txt"], { fileBytes: 10 });
    await ok(["a.txt"], { fileBytes: 11 });
    // Project bytes: two 10-byte files.
    await refused(["a.txt", "b.txt"], { projectBytes: 19 }, "capture limit");
    await ok(["a.txt", "b.txt"], { projectBytes: 20 });
    await ok(["a.txt", "b.txt"], { projectBytes: 21 });
    // File count: three files.
    await refused(
      ["a.txt", "b.txt", "c.txt"],
      { fileCount: 2 },
      "file count exceeds",
    );
    await ok(["a.txt", "b.txt", "c.txt"], { fileCount: 3 });
    await ok(["a.txt", "b.txt", "c.txt"], { fileCount: 4 });
    // Vault bytes, relative to the measured vault usage before each capture.
    await refused(["d.txt"], { vaultBytes: blobs.usage() + 9 }, "disk budget");
    await ok(["d.txt"], { vaultBytes: blobs.usage() + 10 });
    await ok(["e.txt"], { vaultBytes: blobs.usage() + 11 });
    // Invalid limit values are refused before any capture starts.
    const captures = [...f.store.iterate("candidate-capture")].length;
    for (const limits of [
      { fileBytes: 0 },
      { projectBytes: -1 },
      { fileCount: 100_001 },
      { vaultBytes: 1.5 },
    ])
      await expect(
        captureCandidate(f.store, { ...select(f.root, ["a.txt"]), limits }),
      ).rejects.toThrow("capture limit");
    expect([...f.store.iterate("candidate-capture")]).toHaveLength(captures);
    await ok(["a.txt"], { fileCount: 100_000 });
    // Every published candidate still reads its exact bytes.
    for (const candidate of published)
      for (const file of candidate.files)
        expect(
          candidateFileBytes(candidate, file.path, f.store)?.toString(),
        ).toBe(file.path[0].repeat(10));
  });

  test("CA-04: a project-limit refusal leaves only an unreferenced blob that maintenance reclaims, while deduplicated bytes of a published candidate stay readable", async () => {
    const f = await setup();
    await writeFile(path.join(f.root, "kept.txt"), "k".repeat(10));
    await writeFile(path.join(f.root, "x.txt"), "x".repeat(10));
    await writeFile(path.join(f.root, "y.txt"), "y".repeat(10));
    const kept = await captureCandidate(f.store, select(f.root, ["kept.txt"]));
    expect(count(f.store, "protected_blobs")).toBe(1);
    // kept.txt deduplicates; x.txt is published, then y.txt exceeds the remaining budget.
    await expect(
      captureCandidate(f.store, {
        ...select(f.root, ["kept.txt", "x.txt", "y.txt"]),
        limits: { projectBytes: 29 },
      }),
    ).rejects.toThrow("capture limit");
    expect([...f.store.iterate("candidate")]).toHaveLength(1);
    expect(count(f.store, "protected_blob_staging")).toBe(0);
    const unreferenced = f.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM protected_blobs WHERE hash NOT IN (SELECT hash FROM protected_blob_refs)",
      )
      .get().n;
    expect(unreferenced).toBe(1);
    expect(new ProtectedBlobs(f.store).collectUnreferenced()).toBe(1);
    expect(count(f.store, "protected_blobs")).toBe(1);
    expect(candidateFileBytes(kept, "kept.txt", f.store)?.toString()).toBe(
      "k".repeat(10),
    );
  });
});

describe.skipIf(process.platform === "win32")(
  "CA-09 binary, mode-only, no-op and paginated diffs",
  () => {
    async function diffFixture() {
      const f = await setup();
      const write = (name: string, value: string | Buffer) =>
        writeFile(path.join(f.root, name), value);
      await write("text.ts", "one\ntwo\nthree\n");
      await write("deleted.ts", "gone soon\n");
      await write("same.ts", "unchanged\n");
      await write("mode.sh", "echo mode\n");
      await chmod(path.join(f.root, "mode.sh"), 0o644);
      await write("image.bin", Buffer.from("BINARY_CANARY_ONE\0\x01\x02"));
      await write(
        "many.txt",
        Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n"),
      );
      const paths = [
        "text.ts",
        "deleted.ts",
        "same.ts",
        "mode.sh",
        "image.bin",
        "added.ts",
        "many.txt",
      ];
      const baseline = await captureCandidate(f.store, select(f.root, paths));
      await write("text.ts", "one\nTWO\nthree\n");
      await rm(path.join(f.root, "deleted.ts"));
      await write("added.ts", "new file\n");
      await chmod(path.join(f.root, "mode.sh"), 0o755);
      await write("image.bin", Buffer.from("BINARY_CANARY_TWO\0\x03\x04"));
      await write(
        "many.txt",
        Array.from({ length: 2000 }, (_, i) => `changed ${i}`).join("\n"),
      );
      const candidate = await captureCandidate(f.store, {
        ...select(f.root, paths),
        baseCandidateId: baseline.id,
      });
      return { ...f, baseline, candidate };
    }

    test("CA-09: each operation carries exact pre/post hashes, binary text is never decoded, unchanged files are absent, and pagination is bounded and deterministic", async () => {
      const f = await diffFixture();
      const hashOf = (snapshot: CandidateSnapshot, name: string) =>
        snapshot.files.find((file) => file.path === name)?.hash ?? null;
      const diff = candidateDiff(f.store, f.baseline, f.candidate, {
        limit: 50,
      });
      expect(diff.changedFiles).toBe(6);
      expect(diff.files.map((file) => [file.path, file.kind])).toEqual([
        ["added.ts", "added"],
        ["deleted.ts", "deleted"],
        ["image.bin", "modified"],
        ["many.txt", "modified"],
        ["mode.sh", "mode-changed"],
        ["text.ts", "modified"],
      ]);
      for (const file of diff.files) {
        expect(file.beforeHash, file.path).toBe(hashOf(f.baseline, file.path));
        expect(file.afterHash, file.path).toBe(hashOf(f.candidate, file.path));
      }
      const byPath = new Map(diff.files.map((file) => [file.path, file]));
      expect(byPath.get("added.ts")!.beforeHash).toBeNull();
      expect(byPath.get("deleted.ts")!.afterHash).toBeNull();
      // Mode-only: identical bytes, distinct executable bit, distinct candidate identity.
      const mode = byPath.get("mode.sh")!;
      expect(mode.beforeHash).toBe(mode.afterHash);
      expect(f.baseline.revision).not.toBe(f.candidate.revision);
      // Binary: no decoded text and no plaintext of its bytes anywhere in the result.
      expect(byPath.get("image.bin")).toMatchObject({
        binary: true,
        before: [],
        after: [],
      });
      expect(byPath.get("image.bin")!.detail).toContain("Text was not decoded");
      expect(JSON.stringify(diff)).not.toContain("BINARY_CANARY");
      // Text change keeps line identities.
      expect(byPath.get("text.ts")!.before).toContainEqual({
        line: 2,
        text: "two",
      });
      expect(byPath.get("text.ts")!.after).toContainEqual({
        line: 2,
        text: "TWO",
      });
      // A long changed file is bounded with explicit omissions.
      const many = byPath.get("many.txt")!;
      expect(many.before.length).toBeLessThanOrEqual(150);
      expect(many.after.length).toBeLessThanOrEqual(150);
      expect(many.omittedBeforeLines).toBeGreaterThan(0);
      expect(many.omittedAfterLines).toBeGreaterThan(0);
      expect(many.detail).toContain("truncated");
      expect(
        diff.files.find((file) => file.path === "same.ts"),
      ).toBeUndefined();
      // Pages of two walk the same ordered list and stop.
      const pages = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = candidateDiff(f.store, f.baseline, f.candidate, {
          offset,
          limit: 2,
        });
        pages.push(page.files.map((file) => file.path));
        offset = page.nextOffset;
      }
      expect(pages).toEqual([
        ["added.ts", "deleted.ts"],
        ["image.bin", "many.txt"],
        ["mode.sh", "text.ts"],
      ]);
      expect(
        candidateDiff(f.store, f.baseline, f.candidate, { limit: 50 }),
      ).toEqual(diff);
      // A no-op comparison has no changes.
      const noop = candidateDiff(f.store, f.candidate, f.candidate);
      expect(noop).toMatchObject({
        changedFiles: 0,
        files: [],
        nextOffset: null,
      });
      for (const page of [
        { limit: 0 },
        { limit: 51 },
        { offset: -1 },
        { offset: 1.5 },
      ])
        expect(() =>
          candidateDiff(f.store, f.baseline, f.candidate, page),
        ).toThrow("Invalid candidate diff page");
    });

    test("CA-09: the service diff query returns the same bounded result and refuses another workflow's baseline", async () => {
      const f = await setup();
      f.store.close();
      fixtures.splice(fixtures.indexOf(f as never), 1);
      const service = new Service(f.directory, f.key, () => {}, true);
      services.push({ service, directory: f.directory });
      service.store.put("project", {
        id: "p",
        name: "diff fixture",
        path: f.root,
        realPath: f.root,
        trusted: true,
        createdAt: now(),
      });
      await service.start();
      await writeFile(
        path.join(f.root, "image.bin"),
        Buffer.from("BINARY_CANARY_A\0"),
      );
      await writeFile(path.join(f.root, "mode.sh"), "echo\n");
      await chmod(path.join(f.root, "mode.sh"), 0o644);
      const baseline = await captureCandidate(
        service.store,
        select(f.root, ["image.bin", "mode.sh"]),
      );
      await writeFile(
        path.join(f.root, "image.bin"),
        Buffer.from("BINARY_CANARY_B\0"),
      );
      await chmod(path.join(f.root, "mode.sh"), 0o755);
      const candidate = await captureCandidate(service.store, {
        ...select(f.root, ["image.bin", "mode.sh"]),
        baseCandidateId: baseline.id,
      });
      const other = await captureCandidate(service.store, {
        ...select(f.root, ["image.bin", "mode.sh"]),
        workflowId: "other-workflow",
      });
      const result = await service.command(
        commandSchema.parse({
          type: "candidate-diff-query",
          projectId: "p",
          workflowId: "w",
          baseCandidateId: baseline.id,
          candidateId: candidate.id,
        }),
      );
      expect(
        result.files.map((file: any) => [file.path, file.kind, file.binary]),
      ).toEqual([
        ["image.bin", "modified", true],
        ["mode.sh", "mode-changed", false],
      ]);
      expect(JSON.stringify(result)).not.toContain("BINARY_CANARY");
      await expect(
        service.command(
          commandSchema.parse({
            type: "candidate-diff-query",
            projectId: "p",
            workflowId: "w",
            baseCandidateId: other.id,
            candidateId: candidate.id,
          }),
        ),
      ).rejects.toThrow("another project or workflow");
    });
  },
);

describe("CA-13 binary manual attestation binds exact bytes", () => {
  async function binaryFixture(store: Store, root: string) {
    await writeFile(path.join(root, "main.ts"), "export const value = 1;\n");
    await writeFile(
      path.join(root, "image.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1]),
    );
    const selection = { ...select(root, ["main.ts", "image.png"]) };
    const baseline = await captureCandidate(store, selection);
    await writeFile(
      path.join(root, "image.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 2]),
    );
    const reviewed = await captureCandidate(store, {
      ...selection,
      baseCandidateId: baseline.id,
    });
    return { selection, baseline, reviewed };
  }

  test("CA-13: an attestation covers only the candidate and hash it named; a byte change, a byte revert in a new capture, a preview, or a blank detail does not certify the binary", async () => {
    const f = await setup();
    const { selection, baseline, reviewed } = await binaryFixture(
      f.store,
      f.root,
    );
    expect(reviewed.coverage?.manualBinaryPaths).toEqual(["image.png"]);
    // An unchanged binary needs no manual route, and cannot be attested as changed.
    expect(baseline.coverage?.manualBinaryPaths).toEqual([]);
    expect(() =>
      recordCandidateBinaryReview(
        f.store,
        baseline,
        "image.png",
        "looked at it",
      ),
    ).toThrow("changed binary");
    expect(() => assertCandidateCoverage(reviewed, f.store)).toThrow(
      "Changed binary image.png requires explicit manual verification",
    );
    // A pinned preview is not a verification result.
    const preview = candidateBinaryPreview(
      f.store,
      "p",
      reviewed.id,
      "image.png",
    );
    expect(preview).toMatchObject({
      mime: "image/png",
      candidateRevision: reviewed.revision,
      hash: reviewed.files.find((file) => file.path === "image.png")!.hash,
    });
    expect(preview.detail).toContain(
      "manual result still needs explicit confirmation",
    );
    expect(() => assertCandidateCoverage(reviewed, f.store)).toThrow(
      "manual verification",
    );
    expect(() =>
      recordCandidateBinaryReview(f.store, reviewed, "image.png", "   "),
    ).toThrow("observed result");
    const plan = await previewCandidateReview(f.store, {
      projectId: "p",
      candidateId: reviewed.id,
      outputs: [],
      binaries: [
        { path: "image.png", detail: "Owner inspected the pinned image." },
      ],
    });
    expect(plan.binaries[0].hash).toBe(
      reviewed.files.find((file) => file.path === "image.png")!.hash,
    );
    await applyCandidateReview(f.store, "p", plan.id, plan.digest);
    expect(() => assertCandidateCoverage(reviewed, f.store)).not.toThrow();
    const receipts = [
      ...f.store.iterate<any>("candidate-binary-review", { projectId: "p" }),
    ];
    expect(receipts).toEqual([
      expect.objectContaining({
        candidateId: reviewed.id,
        candidateRevision: reviewed.revision,
        path: "image.png",
        hash: plan.binaries[0].hash,
        source: "explicit-user-verification",
        accepted: true,
      }),
    ]);
    // A second, never-applied plan for the same candidate and bytes. It differs
    // from the consumed one only in not being consumed, so a later refusal of it
    // is attributable to the byte change alone.
    const fresh = await previewCandidateReview(f.store, {
      projectId: "p",
      candidateId: reviewed.id,
      outputs: [],
      binaries: [
        {
          path: "image.png",
          detail: "Owner inspected the pinned image again.",
        },
      ],
    });
    expect(fresh.binaries[0].hash).toBe(plan.binaries[0].hash);
    expect(f.store.get("candidate-review-consumed", fresh.id)).toBeUndefined();
    // Changed bytes produce a new candidate that the old attestation does not cover.
    await writeFile(
      path.join(f.root, "image.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 3]),
    );
    const changed = await captureCandidate(f.store, {
      ...selection,
      baseCandidateId: baseline.id,
    });
    expect(
      changed.files.find((file) => file.path === "image.png")!.hash,
    ).not.toBe(plan.binaries[0].hash);
    expect(() => assertCandidateCoverage(changed, f.store)).toThrow(
      "requires explicit manual verification for this candidate",
    );
    // The reviewed candidate's live bytes changed, so even an unconsumed plan for
    // it cannot apply, and the reason is the byte change.
    await expect(
      applyCandidateReview(f.store, "p", fresh.id, fresh.digest),
    ).rejects.toThrow(
      "Candidate bytes changed; review and check evidence is stale.",
    );
    expect(f.store.get("candidate-review-consumed", fresh.id)).toBeUndefined();
    expect([
      ...f.store.iterate("candidate-binary-review", { projectId: "p" }),
    ]).toHaveLength(1);
    // Reverting to the attested bytes in a fresh capture still needs its own attestation.
    await writeFile(
      path.join(f.root, "image.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 2]),
    );
    // With the reviewed bytes back on disk, the consumed plan is refused only
    // because it was consumed...
    await expect(
      applyCandidateReview(f.store, "p", plan.id, plan.digest),
    ).rejects.toThrow("Candidate review was already consumed or expired.");
    // ...and the unconsumed plan refused above now applies, so its refusal was
    // the byte change and nothing else about the plan.
    await expect(
      applyCandidateReview(f.store, "p", fresh.id, fresh.digest),
    ).resolves.toMatchObject({
      candidateId: reviewed.id,
      candidateRevision: reviewed.revision,
      planId: fresh.id,
    });
    expect(
      [...f.store.iterate<any>("candidate-binary-review", { projectId: "p" })]
        .filter((receipt) => receipt.candidateId === reviewed.id)
        .map((receipt) => receipt.hash),
    ).toEqual([plan.binaries[0].hash, plan.binaries[0].hash]);
    const reverted = await captureCandidate(f.store, {
      ...selection,
      baseCandidateId: baseline.id,
    });
    expect(reverted.id).not.toBe(reviewed.id);
    expect(() => assertCandidateCoverage(reverted, f.store)).toThrow(
      "manual verification",
    );
    // A receipt with a forged hash for the current candidate is not accepted.
    f.store.immutable("candidate-binary-review", {
      ...receipts[0],
      id: uid(),
      candidateId: changed.id,
      candidateRevision: changed.revision,
      hash: plan.binaries[0].hash,
    });
    expect(() => assertCandidateCoverage(changed, f.store)).toThrow(
      "manual verification",
    );
  });

  test("CA-13: through the service, binary attestation needs native approval of the exact plan, is single-use, and a plan for changed bytes cannot apply", async () => {
    const f = await setup();
    f.store.close();
    fixtures.splice(fixtures.indexOf(f as never), 1);
    const service = new Service(f.directory, f.key, () => {}, true);
    services.push({ service, directory: f.directory });
    service.store.put("project", {
      id: "p",
      name: "binary fixture",
      path: f.root,
      realPath: f.root,
      trusted: true,
      createdAt: now(),
    });
    await service.start();
    const { reviewed } = await binaryFixture(service.store, f.root);
    const preview = (candidateId: string) =>
      service.command({
        type: "candidate-review-preview",
        projectId: "p",
        candidateId,
        outputs: [],
        binaries: [{ path: "image.png", detail: "Owner inspected it." }],
      });
    const apply = (id: string, digest?: string) =>
      service.command(
        {
          type: "candidate-review-apply",
          requestId: uid(),
          projectId: "p",
          id,
        },
        digest ? { digest } : {},
      );
    const plan = await preview(reviewed.id);
    await expect(apply(plan.id)).rejects.toThrow("Native approval");
    await expect(apply(plan.id, "0".repeat(64))).rejects.toThrow(
      "missing, expired, or stale",
    );
    expect([...service.store.iterate("candidate-binary-review")]).toEqual([]);
    const shown = await service.command({
      type: "candidate-binary-preview",
      projectId: "p",
      candidateId: reviewed.id,
      path: "image.png",
    });
    expect(shown.mime).toBe("image/png");
    expect([...service.store.iterate("candidate-binary-review")]).toEqual([]);
    await apply(plan.id, plan.digest);
    expect(() =>
      assertCandidateCoverage(reviewed, service.store),
    ).not.toThrow();
    await expect(apply(plan.id, plan.digest)).rejects.toThrow("consumed");
    // A second plan prepared, then the bytes change before it is applied.
    const second = await preview(reviewed.id);
    await writeFile(
      path.join(f.root, "image.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 9]),
    );
    await expect(apply(second.id, second.digest)).rejects.toThrow("changed");
    expect([...service.store.iterate("candidate-binary-review")]).toHaveLength(
      1,
    );
  });
});
