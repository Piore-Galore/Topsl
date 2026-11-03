/**
 * Campaign 2026-10-19-comprehensive, packet p2b-config-usage: USAGE-15 wiring.
 *
 * Establishes whether the project's saved reporting thresholds reach
 * `budgetAlerts()` in the renderer. The plan suspected that the UI calls the
 * helper without saved thresholds (apps/desktop/renderer/coordination.tsx
 * calls `budgetAlerts(usage, 0, {})`). This file checks the source wiring and
 * renders the real `UsageBudget` component in the state it holds after its
 * `usage-budget-query` effect has returned saved thresholds. Server rendering
 * runs no effects, so `useState` is wrapped to start the component's budget
 * state from those saved thresholds; nothing else in the component is
 * replaced. This is not an Electron journey (layer E stays NOT RUN).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const saved = vi.hoisted(() => ({
  value: null as null | { tokens: number | null; wallMs: number | null },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const useState = ((initial: unknown) => {
    const isBudgetInitial =
      !!initial &&
      typeof initial === "object" &&
      !Array.isArray(initial) &&
      Object.keys(initial).sort().join() === "tokens,wallMs" &&
      (initial as any).tokens === null &&
      (initial as any).wallMs === null;
    return actual.useState(
      (isBudgetInitial && saved.value ? saved.value : initial) as any,
    );
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

const { UsageBudget } =
  await import("../apps/desktop/renderer/components/reporting");

const summary = (knownInput: number, knownOutput: number, complete = true) => ({
  input: complete ? knownInput : null,
  output: complete ? knownOutput : null,
  cached: null,
  knownInput,
  knownOutput,
  coveredRuns: 1,
  totalRuns: complete ? 1 : 2,
  complete,
  notes: [],
});
const attempts = [
  {
    createdAt: "2026-10-19T10:00:00.000Z",
    finishedAt: "2026-10-19T10:02:00.000Z",
  },
];
const render = (
  budget: typeof saved.value,
  usage = summary(60, 40),
  list: any[] = attempts,
) => {
  saved.value = budget;
  try {
    return renderToStaticMarkup(
      createElement(UsageBudget, {
        projectId: "p",
        summary: usage,
        attempts: list,
      }),
    );
  } finally {
    saved.value = null;
  }
};
const tokenAlert = "Known reported tokens reached the configured threshold.";
const wallAlert =
  "Observed project attempt span reached the configured wall time threshold.";

describe("USAGE-15 saved project thresholds reach budgetAlerts in the renderer", () => {
  test("the Usage reporting thresholds panel passes the queried thresholds and the attempt span to budgetAlerts", () => {
    const source = readFileSync(
      path.resolve("apps/desktop/renderer/components/reporting.tsx"),
      "utf8",
    );
    // The saved values come from usage-budget-query and from the save reply.
    expect(source).toMatch(
      /type: "usage-budget-query", projectId \}\)\s*\.then\(\(value\) => \{\s*if \(live\) \{\s*setBudget\(value\);/,
    );
    expect(source).toMatch(
      /type: "usage-budget-save",[\s\S]*?\.then\(setBudget\)/,
    );
    expect(source).toContain("budgetAlerts(summary, span, budget)");
    // Since 30 October 2026 the panel is in Project settings, mounted with
    // the project's usage and attempts; the retired Overview's call without
    // thresholds is gone from the renderer (docs/UX_Cleanup_Plan.md).
    const settings = readFileSync(
      path.resolve("apps/desktop/renderer/screens/project-settings.tsx"),
      "utf8",
    );
    expect(settings).toMatch(
      /<UsageBudget\s+projectId=\{projectId\}\s+summary=\{usage\}\s+attempts=\{scope\.coordination\.attempts\}/,
    );
    for (const file of [
      "apps/desktop/renderer/coordination.tsx",
      "apps/desktop/renderer/screens/advanced-workflows.tsx",
    ])
      expect(readFileSync(path.resolve(file), "utf8")).not.toContain(
        "budgetAlerts(",
      );
  });

  test("with saved thresholds reached, the panel shows both alerts; just below them it shows none", () => {
    const reached = render({ tokens: 100, wallMs: 120_000 });
    expect(reached).toContain(tokenAlert);
    expect(reached).toContain(wallAlert);
    expect(reached).toContain("2 minutes of observed attempt span");
    // Negative control: one token and one millisecond short.
    const below = render({ tokens: 101, wallMs: 120_001 });
    expect(below).not.toContain(tokenAlert);
    expect(below).not.toContain(wallAlert);
  });

  test("each threshold alerts independently, and a cleared threshold never alerts", () => {
    const tokensOnly = render({ tokens: 50, wallMs: null });
    expect(tokensOnly).toContain(tokenAlert);
    expect(tokensOnly).not.toContain(wallAlert);
    const wallOnly = render({ tokens: null, wallMs: 60_000 });
    expect(wallOnly).not.toContain(tokenAlert);
    expect(wallOnly).toContain(wallAlert);
    const cleared = render({ tokens: null, wallMs: null });
    expect(cleared).not.toContain(tokenAlert);
    expect(cleared).not.toContain(wallAlert);
  });

  test("before the query returns there is no threshold, and incomplete coverage is worded as an upper bound", () => {
    const first = render(null);
    expect(first).not.toContain(tokenAlert);
    expect(first).not.toContain(wallAlert);
    expect(first).toContain(
      "They do not grant spending authority or automatically cancel native work.",
    );
    const incomplete = render(
      { tokens: 1_000, wallMs: null },
      summary(5, 5, false),
      [],
    );
    expect(incomplete).toContain("Attempt wall time has not been recorded.");
    expect(incomplete).toContain(
      "Unknown usage may exceed the visible threshold",
    );
  });
});
