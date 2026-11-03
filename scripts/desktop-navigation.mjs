/** Opens the sidebar the owner would use: the aside, or the drawer below 900px. */
async function sidebar(page) {
  // A viewport/zoom change can precede React's media-query reconciliation,
  // and `innerWidth` can lag a zoom reset. Ask the media query the app uses,
  // then wait until React shows the matching sidebar: the aside, or the
  // drawer (opened through its Navigation toggle).
  const aside = page.locator("aside.sidebar");
  const drawer = page.locator("dialog.sidebar");
  const toggle = page.getByRole("button", { name: "Navigation", exact: true });
  const deadline = Date.now() + 30000;
  for (;;) {
    const compact = await page.evaluate(
      () => matchMedia("(max-width: 899px)").matches,
    );
    if (!compact && (await aside.isVisible())) return aside;
    if (compact && (await drawer.isVisible())) return drawer;
    if (compact && (await toggle.isVisible())) {
      // After a zoom reset the layout can switch back to the aside between
      // this check and the click; try briefly, then read the layout again.
      try {
        await toggle.click({ timeout: 2000 });
        await drawer.waitFor({ state: "visible", timeout: 2000 });
        return drawer;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        continue;
      }
    }
    if (Date.now() > deadline)
      throw new Error("Neither the sidebar nor the Navigation toggle appeared");
    await page.waitForTimeout(50);
  }
}

/** The selected project's menu (docs/UX_Cleanup_Plan.md §1). */
const menuItems = [
  "All sessions",
  "Project settings",
  "Provider tools",
  "Advanced workflows",
];
/**
 * Destinations before the cleanup, as the journeys still name some of them:
 * each opens its replacement, and the Advanced workflows section it became.
 */
const replaced = {
  Applications: { item: "Providers" },
  Overview: { item: "Advanced workflows", section: "Activity" },
  Tasks: { item: "Advanced workflows", section: "Builder–reviewer" },
  Changes: { item: "Advanced workflows", section: "Candidate review" },
  Context: { item: "Advanced workflows", section: "Context" },
  Workspaces: { item: "Advanced workflows", section: "Workspaces" },
  History: { item: "Provider tools" },
};

/**
 * Follow the same sidebar or native navigation dialog as the owner. A
 * project destination (All sessions, Project settings, Provider tools,
 * Advanced workflows) is in the selected project's menu.
 */
export async function navigate(page, name) {
  const target = replaced[name] ?? { item: name };
  const nav = await sidebar(page);
  if (menuItems.includes(target.item)) {
    await nav
      .locator(".project-node.selected .project-menu-button")
      .first()
      .click();
    await nav.getByRole("menuitem", { name: target.item, exact: true }).click();
  } else
    await nav.getByRole("button", { name: target.item, exact: true }).click();
  if (target.section)
    await page
      .getByRole("tablist", { name: "Section" })
      .getByRole("tab", { name: target.section })
      .click();
}

/**
 * Selects a project in the sidebar, which opens it where the owner left it:
 * its last viewed session, else its newest one, else New session.
 */
export async function selectProject(page, name) {
  const nav = await sidebar(page);
  await nav
    .getByRole("list", { name: "Projects and sessions" })
    .getByRole("button", { name, exact: true })
    .click();
}

/** Opens one of the selected project's conversations from the sidebar. */
export async function openThread(page, project, title) {
  const nav = await sidebar(page);
  const list = nav.getByRole("list", { name: `${project} sessions` });
  if (!(await list.count()))
    await nav
      .getByRole("button", { name: `Expand ${project}`, exact: true })
      .click();
  await list.getByRole("button", { name: title, exact: true }).click();
}
