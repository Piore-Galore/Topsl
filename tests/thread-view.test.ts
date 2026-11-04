import { expect, test } from "vitest";
import {
  loopTimeline,
  planTasks,
  threadTimeline,
  type ThreadMessage,
} from "../apps/desktop/renderer/state/thread-view";
import { DraftStore, drafts } from "../apps/desktop/renderer/state/drafts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Composer } from "../apps/desktop/renderer/coordinator/composer";
import { SessionThread } from "../apps/desktop/renderer/coordinator/session-thread";
import {
  breadcrumb,
  changedThreadProjects,
} from "../apps/desktop/renderer/state/threads";

/** View models for coordinator threads (docs/Coordinator_Teams.md). */

const message = (
  id: string,
  sequence: number,
  routing: ThreadMessage["routing"] = null,
  createdAt = `2026-10-28T10:00:0${sequence}.000Z`,
): ThreadMessage => ({
  id,
  role: "user",
  text: id,
  sequence,
  routing,
  createdAt,
});

test("each goal's card follows the latest message about it", () => {
  const goals = [
    { goal: { id: "g1" } },
    { goal: { id: "g2" } },
    { goal: { id: "g0" } },
  ];
  const items = threadTimeline(
    [
      message("steer", 3, { kind: "update-goal", goalId: "g1" }),
      message("start", 1, { kind: "new-goal", goalId: "g1" }),
      message("status", 2, { kind: "status", goalId: "g1" }),
      message("more", 4, { kind: "related-goal", goalId: "g2" }),
    ],
    goals,
  );
  expect(items.map((i) => i.key)).toEqual([
    "start",
    "status",
    "steer",
    "goal:g1",
    "more",
    "goal:g2",
    // A goal recorded before threads has no starting message here.
    "goal:g0",
  ]);
});

test("plan tasks carry their action state", () => {
  expect(
    planTasks({
      plan: {
        tasks: [
          { key: "a", title: "Change it", roleId: "implementer" },
          { key: "b", title: "Check it", roleId: "tester" },
        ],
      },
      actions: [{ taskKey: "a", state: "completed", detail: "" }],
    }),
  ).toEqual([
    {
      key: "a",
      title: "Change it",
      roleId: "implementer",
      state: "completed",
      detail: "",
    },
    {
      key: "b",
      title: "Check it",
      roleId: "tester",
      state: "unknown",
      detail: "",
    },
  ]);
  expect(planTasks({ plan: null })).toEqual([]);
});

test("a loop thread interleaves the owner's notes and iterations by time", () => {
  const items = loopTimeline(
    [
      message("asked", 1, null, "2026-10-28T10:00:00.000Z"),
      message("steered", 2, null, "2026-10-28T10:05:00.000Z"),
    ],
    [
      { id: "i2", startedAt: "2026-10-28T10:06:00.000Z" },
      { id: "i1", startedAt: "2026-10-28T10:00:00.000Z" },
    ],
  );
  expect(items.map((i) => i.key)).toEqual(["asked", "i1", "steered", "i2"]);
});

const send = /<button[^>]*>Send<\/button>/;
const disabled = (markup: string, pattern: RegExp) =>
  / disabled=""/.test(markup.match(pattern)![0]);

test("Send waits while the message's target is not read yet; typing does not", () => {
  const composer = (loading: boolean) =>
    renderToStaticMarkup(
      createElement(Composer, {
        value: "Use two reviewers.",
        onChange: () => {},
        onSend: () => {},
        loading,
      }),
    );
  expect(disabled(composer(false), send)).toBe(false);
  expect(disabled(composer(true), send)).toBe(true);
  expect(disabled(composer(true), /<textarea[^>]*>/)).toBe(false);
});

// A session's first render, before its first read lands, does not know its
// current goal or composer mode. A message sent then was aimed at no goal and
// queued as new work instead of steering the goal on screen (the Windows x64
// desktop coordinator journey, 3 and 4 November 2026).
test("a session does not send a typed draft before it has read what the message would steer", () => {
  drafts.set("p:session:s", "Change the reviewers. Use two reviewers.");
  try {
    const markup = renderToStaticMarkup(
      createElement(SessionThread, {
        projectId: "p",
        sessionId: "s",
        onThread: () => {},
      }),
    );
    expect(markup).toContain("Loading session…");
    expect(markup).toContain("Change the reviewers. Use two reviewers.");
    expect(disabled(markup, send)).toBe(true);
  } finally {
    drafts.set("p:session:s", "");
  }
});

test("drafts are kept per thread and cleared when emptied", () => {
  const drafts = new DraftStore();
  drafts.set("p:goal:c1", "half a thought");
  expect(drafts.get("p:goal:c1")).toBe("half a thought");
  expect(drafts.get("p:goal:c2")).toBe("");
  drafts.set("p:goal:c1", "");
  expect(drafts.get("p:goal:c1")).toBe("");
});

test("the thread list re-reads only projects whose threads changed", () => {
  expect(
    changedThreadProjects({
      events: [
        { kind: "goal", projectId: "a" },
        { kind: "orch-message", projectId: "b" },
        { kind: "loop-run", projectId: "c" },
        { kind: "orch-conversation", projectId: "a" },
        { kind: "orch-session", projectId: "d" },
        { kind: "goal", projectId: null },
      ],
    }),
  ).toEqual(["a", "c", "d"]);
});

test("the top bar names the open thread or the project's home", () => {
  const base = {
    page: "project",
    projectName: "Topsl",
    viewLabel: "Coordinator",
  };
  expect(breadcrumb({ ...base, view: "coordinator", threadTitle: null })).toBe(
    "Topsl / New session",
  );
  expect(
    breadcrumb({ ...base, view: "coordinator", threadTitle: "Fix sync" }),
  ).toBe("Topsl / Fix sync");
  expect(breadcrumb({ ...base, view: "tasks", viewLabel: "Tasks" })).toBe(
    "Topsl / Tasks",
  );
  expect(breadcrumb({ ...base, page: "settings", view: "overview" })).toBe(
    "Topsl / Settings",
  );
});
