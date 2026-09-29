import { describe, expect, test, vi, afterEach } from "vitest";
import { commandSchema } from "../packages/domain/commands";
import {
  compareVersions,
  planDigest,
  validatePlan,
  checkDue,
  nextCheck,
  normalizeUsage,
  safeError,
} from "../packages/domain/invariants";
import { nativeEnvironment, isWithin } from "../packages/platform/system";
import {
  assertArtifactPublisher,
  assertDownloadUrl,
  brewVariant,
  resolveRelease,
} from "../packages/applications/releases";
import { plan } from "./helpers";
afterEach(() => vi.unstubAllEnvs());
describe("approval and scheduling invariants", () => {
  test("binds action, installation revision, artifact, and privilege effects", () => {
    const original = plan({ expectedRevision: "one" });
    original.digest = planDigest(original);
    expect(() => validatePlan(original, "one")).not.toThrow();
    expect(() => validatePlan(original, "two")).toThrow("changed");
    for (const changed of [
      { ...original, action: "install" },
      { ...original, effects: ["unreviewed privilege"] },
      { ...original, release: { version: "2" } },
    ])
      expect(() => validatePlan(changed as any, "one")).toThrow("integrity");
  });
  test("expired approval cannot execute", () => {
    const p = plan({ expiresAt: new Date(100).toISOString() });
    p.digest = planDigest(p);
    expect(() => validatePlan(p, null, 101)).toThrow("expired");
  });
  test("checks at most daily with bounded failure backoff", () => {
    expect(Date.parse(nextCheck(0, 0))).toBe(86400000);
    expect(Date.parse(nextCheck(2, 0))).toBe(172800000);
    expect(Date.parse(nextCheck(20, 0))).toBe(7 * 86400000);
    expect(
      checkDue({ nextCheckAt: nextCheck(0, 0) } as any, 86400000 - 1),
    ).toBe(false);
  });
  test.each([
    ["2.1.0", "2.0.9", 1],
    ["1.0.0", "2.0.0", -1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.0", "1.0.0-alpha", 1],
    ["1.0.0-beta", "1.0.0-alpha", null],
    ["dev", "1.0.0", null],
  ])("does not guess versions %s vs %s", (a, b, result) =>
    expect(compareVersions(a as string, b as string)).toBe(result),
  );
});
describe("command and network boundary", () => {
  test("a vendor desktop's update eligibility is not inferred from a public installer feed", async () => {
    expect(
      await resolveRelease("openai.desktop", {
        owner: "vendor",
        appId: "openai.desktop",
        channel: "native",
      } as any),
    ).toBeNull();
  });
  test.each(["exec", "approve", "shell", "install-anything"])(
    "rejects untyped command %s",
    (type) =>
      expect(
        commandSchema.safeParse({ type, executable: "/bin/sh" }).success,
      ).toBe(false),
  );
  test("renderer cannot inject trusted approval fields", () =>
    expect(
      commandSchema.parse({
        type: "lifecycle-apply",
        id: "p",
        trusted: { approved: true, digest: "anything" },
      }),
    ).toEqual({ type: "lifecycle-apply", id: "p" }));
  test.each([
    "file:///etc/passwd",
    "http://github.com/a",
    "https://github.com.evil.test/a",
    "https://evil.test/a",
    "https://user:secret@github.com/a",
    "https://github.com:444/a",
  ])("rejects artifact URL %s", (url) =>
    expect(() => assertDownloadUrl(url)).toThrow(),
  );
  test("allows explicit publisher transport", () =>
    expect(() =>
      assertDownloadUrl(
        "https://downloads.claude.ai/claude-code-releases/2.1.0/darwin-arm64/claude",
      ),
    ).not.toThrow());
  test("a trusted transport host does not imply the right publisher", () => {
    expect(() =>
      assertArtifactPublisher(
        "openai.codex-cli",
        "https://github.com/unrelated/repo/releases/download/app.zip",
      ),
    ).toThrow("publisher");
    expect(() =>
      assertArtifactPublisher(
        "anthropic.claude-desktop",
        "https://persistent.oaistatic.com/codex-app-prod/app.zip",
      ),
    ).toThrow("publisher");
  });
  test("selects architecture-specific metadata", () => {
    const m = {
      url: "arm",
      sha256: "a",
      variations: {
        sequoia: { url: "intel", sha256: "b" },
        arm64_linux: { url: "linux", sha256: "c" },
      },
    };
    expect(brewVariant(m, "darwin", "x64").url).toBe("intel");
    expect(brewVariant(m, "linux", "arm64").sha256).toBe("c");
    expect(() => brewVariant(m, "win32", "x64")).toThrow();
    expect(() => brewVariant(m, "darwin", "ia32")).toThrow();
  });
  test("does not inherit API billing secrets into subscription runtimes", () => {
    vi.stubEnv("OPENAI_API_KEY", "private");
    vi.stubEnv("ANTHROPIC_API_KEY", "private");
    const env = nativeEnvironment();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  });
  test("redacts common auth values from errors", () =>
    expect(
      safeError("Bearer abcd access_token=secret sk-abcdefghijklmnop"),
    ).not.toMatch(/abcd|secret|sk-/));
  test("path prefix alone does not grant a sibling access", () => {
    expect(isWithin("/project", "/project-copy/secret")).toBe(false);
    expect(isWithin("/project", "/project/../secret")).toBe(false);
  });
});
describe("usage provenance", () => {
  test("snapshot IDs permit deduplication instead of summing repeats", () => {
    const a = normalizeUsage(
      "codex",
      { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 },
      "r",
      "t",
    );
    expect(a).toMatchObject({
      id: "r:t",
      input: 12,
      cached: 4,
      source: "native-runtime",
    });
  });
  test("unknown fields remain unknown", () => {
    expect(normalizeUsage("codex", {}, "r").input).toBeNull();
    expect(normalizeUsage("claude", { input_tokens: 4 }, "r").input).toBeNull();
  });
  test("Claude cache input is accounted for once", () =>
    expect(
      normalizeUsage(
        "claude",
        {
          input_tokens: 4,
          cache_read_input_tokens: 7,
          cache_creation_input_tokens: 3,
          output_tokens: 2,
        },
        "r",
      ).input,
    ).toBe(14));
});
