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

/**
 * Follow the same sidebar or native navigation dialog as the owner. A
 * project tool (Overview, Provider tools, Tasks, …) is under the selected
 * project's Project tools, which this expands when it is collapsed.
 */
export async function navigate(page, name) {
  const nav = await sidebar(page);
  const tools = nav.getByRole("button", { name: "Project tools", exact: true });
  if (
    (await tools.count()) &&
    (await tools.getAttribute("aria-expanded")) === "false" &&
    !(await nav.getByRole("button", { name, exact: true }).count())
  )
    await tools.click();
  await nav.getByRole("button", { name, exact: true }).click();
}

/** Selects a project in the sidebar, which opens its New session page. */
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
