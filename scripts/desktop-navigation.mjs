/** Follow the same sidebar or native navigation dialog as the owner. */
export async function navigate(page, name) {
  // A viewport/zoom change can precede React's media-query reconciliation.
  if (await page.evaluate(() => innerWidth < 900)) {
    const drawer = page.locator("dialog.sidebar");
    await drawer.waitFor({ state: "attached" });
    if (!(await drawer.isVisible()))
      await page
        .getByRole("button", { name: "Navigation", exact: true })
        .click();
  } else {
    await page.locator("aside.sidebar").waitFor({ state: "visible" });
  }
  await page.getByRole("button", { name, exact: true }).click();
}
