import { expect, test } from "vitest";
import {
  debugSettings,
  inspectArgs,
} from "../apps/desktop/debug-settings";

test("a packaged or ordinary run has no debug settings", () => {
  const all = {
    TOPSL_DEBUG_DEVTOOLS: "1",
    TOPSL_DEBUG_LOGS: "1",
    TOPSL_DEBUG_SERVICE_INSPECT: "9230",
    TOPSL_DEBUG_PROXY_INSPECT: "9231",
  };
  expect(debugSettings(all, true)).toBeNull();
  expect(debugSettings({}, false)).toBeNull();
  expect(debugSettings(all, false)).toEqual({
    devTools: true,
    logs: true,
    serviceInspectPort: 9230,
    proxyInspectPort: 9231,
  });
});

test("inspector ports are checked and bind to loopback only", () => {
  for (const bad of ["80", "70000", "9230.5", "all"])
    expect(() =>
      debugSettings({ TOPSL_DEBUG_SERVICE_INSPECT: bad }, false),
    ).toThrow("TOPSL_DEBUG_SERVICE_INSPECT must be a port number");
  expect(inspectArgs(9230)).toEqual(["--inspect=127.0.0.1:9230"]);
  expect(inspectArgs(null)).toEqual([]);
});
