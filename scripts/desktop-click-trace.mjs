// Records, for a desktop journey, where each click landed in the renderer,
// when the main process received each command and when it settled, so a
// confirmation that never arrives can be placed: lost in the renderer, never
// requested by the main process, or missed by the harness (F-01 in
// docs/testing/TEST-DECISIONS.md). Nothing here changes what Topsl does.
// scripts/desktop-test.mjs prints the timeline when a start's confirmation
// does not arrive, and after every start with TOPSL_TEST_TRACE=1.

/** Starts recording in the main process and the renderer. */
export async function traceClicks(app, page) {
  const installed = await app.evaluate(({ ipcMain }) => {
    if (globalThis.topslTrace) return "installed";
    const handlers = ipcMain._invokeHandlers;
    const original = handlers?.get?.("topsl:command");
    if (!original) return "no topsl:command handler";
    const trace = (globalThis.topslTrace = []);
    const note = (entry) => {
      trace.push({ at: Date.now(), ...entry });
      if (trace.length > 400) trace.splice(0, trace.length - 400);
    };
    handlers.set("topsl:command", async (event, raw) => {
      const type = raw?.type;
      // Reads that every refresh repeats would crowd out the one that matters.
      const quiet = /-query$|^scope-|^state$/.test(type ?? "");
      if (!quiet) note({ where: "main", what: `received ${type}` });
      try {
        return await original(event, raw);
      } finally {
        if (!quiet) note({ where: "main", what: `settled ${type}` });
      }
    });
    globalThis.topslTraceNote = note;
    return "installed";
  });
  if (installed !== "installed")
    throw new Error(`Click trace unavailable: ${installed}`);
  await page.evaluate(() => {
    if (window.topslTrace) return;
    const trace = (window.topslTrace = []);
    const note = (entry) => {
      trace.push({ at: Date.now(), where: "renderer", ...entry });
      if (trace.length > 400) trace.splice(0, trace.length - 400);
    };
    const label = (element) =>
      (element?.getAttribute?.("aria-label") || element?.textContent || "")
        .trim()
        .slice(0, 60);
    for (const type of ["pointerdown", "mousedown", "mouseup", "click"])
      document.addEventListener(
        type,
        (event) => {
          const button = event.target?.closest?.("button");
          note({
            what: type,
            target: label(button ?? event.target),
            disabled: button ? button.disabled : null,
          });
        },
        true,
      );
    // Every enable and disable of a button, so a click can be lined up
    // with the state its target was in.
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target.tagName !== "BUTTON") continue;
        const disabled = record.target.disabled;
        if ((record.oldValue !== null) === disabled) continue;
        note({
          what: disabled ? "disabled" : "enabled",
          target: label(record.target),
        });
      }
    }).observe(document, {
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled"],
      attributeOldValue: true,
    });
  });
}

/** The recorded timeline since `since`, oldest first, as readable lines. */
export async function clickTimeline(app, page, since) {
  const [main, renderer] = await Promise.all([
    app.evaluate(() => globalThis.topslTrace ?? []).catch(() => []),
    page.evaluate(() => window.topslTrace ?? []).catch(() => []),
  ]);
  return [...main, ...renderer]
    .filter((entry) => entry.at >= since)
    .sort((a, b) => a.at - b.at)
    .map(
      (entry) =>
        `+${entry.at - since}ms ${entry.where}: ${entry.what}${
          entry.target ? ` "${entry.target}"` : ""
        }${entry.disabled === null || entry.disabled === undefined ? "" : entry.disabled ? " (disabled)" : " (enabled)"}`,
    );
}

/**
 * Slows the renderer's CPU by TOPSL_TEST_CPU_THROTTLE (for example 4), the
 * stress under which F-01 reproduced locally. Unset, it does nothing.
 */
export async function throttleRenderer(page) {
  const rate = Number(process.env.TOPSL_TEST_CPU_THROTTLE);
  if (!(rate > 1)) return;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
}
