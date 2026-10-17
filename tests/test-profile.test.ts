import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";
import { testProfileSettings } from "../apps/desktop/test-profile";
import { Service } from "../apps/service/service";
import { fixture } from "./helpers";

const profile = path.join(os.tmpdir(), "topsl-test-profile"),
  outside = path.resolve("node_modules/.cache/topsl-qualify-test");

describe("test profile settings", () => {
  test("a packaged app or a missing test profile ignores both variables", () => {
    expect(
      testProfileSettings(
        { TOPSL_TEST_PROFILE: profile, TOPSL_TEST_QUALIFICATION_DIR: outside },
        true,
      ),
    ).toBeNull();
    expect(
      testProfileSettings({ TOPSL_TEST_QUALIFICATION_DIR: outside }, false),
    ).toBeNull();
  });

  test("a test profile qualifies only in a topsl-qualify-* folder outside the temporary directory", () => {
    expect(testProfileSettings({ TOPSL_TEST_PROFILE: profile }, false)).toEqual(
      { profile, qualificationDirectory: null },
    );
    expect(
      testProfileSettings(
        { TOPSL_TEST_PROFILE: profile, TOPSL_TEST_QUALIFICATION_DIR: outside },
        false,
      ),
    ).toEqual({ profile, qualificationDirectory: outside });
    for (const folder of [
      path.join(os.tmpdir(), "topsl-qualify-test"),
      path.join("/tmp", "topsl-qualify-test"),
      path.resolve("node_modules/.cache/qualify-test"),
    ])
      expect(
        () =>
          testProfileSettings(
            {
              TOPSL_TEST_PROFILE: profile,
              TOPSL_TEST_QUALIFICATION_DIR: folder,
            },
            false,
          ),
        folder,
      ).toThrow("topsl-qualify-*");
    expect(() =>
      testProfileSettings(
        { TOPSL_TEST_PROFILE: path.resolve("topsl-test-profile") },
        false,
      ),
    ).toThrow("topsl-test-*");
  });
});

describe("test profile applications", () => {
  test("a test profile never searches, keeps the runtimes it was given and says so", async () => {
    const f = await fixture(),
      service = new Service(f.directory, f.key, () => {}, true);
    try {
      expect(service.state().testProfile).toBe(true);
      const found = (await service.command({ type: "discover" })) as Array<{
        id: string;
      }>;
      expect(found.map((i) => i.id)).toEqual([f.installation.id]);
    } finally {
      await service.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  test("the usual profile does not call itself a test profile", async () => {
    const f = await fixture(),
      service = new Service(f.directory, f.key, () => {});
    try {
      expect(service.state().testProfile).toBe(false);
    } finally {
      await service.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});

describe("service qualification folder", () => {
  test("a test profile without a qualification folder refuses before qualifying", async () => {
    const f = await fixture(),
      service = new Service(f.directory, f.key, () => {}, true);
    try {
      await expect(
        service.command(
          {
            type: "runtime-qualify",
            id: f.installation.id,
            model: "fixture-model",
          },
          { approved: true },
        ),
      ).rejects.toThrow("TOPSL_TEST_QUALIFICATION_DIR");
    } finally {
      await service.close();
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });

  test("only a test profile accepts a qualification folder", async () => {
    const f = await fixture();
    try {
      expect(
        () =>
          new Service(f.directory, f.key, () => {}, false, undefined, outside),
      ).toThrow("only to isolated test profiles");
    } finally {
      f.store.close();
      await rm(f.directory, { recursive: true, force: true });
    }
  });
});
