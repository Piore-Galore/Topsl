/** Opens the sidebar the owner would use: the aside, or the drawer below 900px. */
async function sidebar(page) {
  // A viewport/zoom change can precede React's media-query reconciliation.
  if (await page.evaluate(() => innerWidth < 900)) {
    const drawer = page.locator("dialog.sidebar");
    await drawer.waitFor({ state: "attached" });
    if (!(await drawer.isVisible()))
      await page
        .getByRole("button", { name: "Navigation", exact: true })
        .click();
    return drawer;
  }
  const aside = page.locator("aside.sidebar");
  await aside.waitFor({ state: "visible" });
  return aside;
}

/**
 * Follow the same sidebar or native navigation dialog as the owner. A
 * project tool (Overview, Sessions, Tasks, …) is under the selected
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

/** Selects a project in the sidebar, which opens its New conversation page. */
export async function selectProject(page, name) {
  const nav = await sidebar(page);
  await nav
    .getByRole("list", { name: "Projects and conversations" })
    .getByRole("button", { name, exact: true })
    .click();
}

/** Opens one of the selected project's conversations from the sidebar. */
export async function openThread(page, project, title) {
  const nav = await sidebar(page);
  const list = nav.getByRole("list", { name: `${project} conversations` });
  if (!(await list.count()))
    await nav
      .getByRole("button", { name: `Expand ${project}`, exact: true })
      .click();
  await list.getByRole("button", { name: title, exact: true }).click();
}
