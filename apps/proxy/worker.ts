import path from "node:path";
import { ProxyService, type ProxyCommand } from "../../packages/proxy/service";
import {
  startProxyServer,
  type ProxyServer,
} from "../../packages/proxy/server";
import { safeError } from "../../packages/domain/invariants";

/**
 * The Topsl local proxy as a dedicated Electron utility process
 * (docs/Native_Harness_Plan.md §2), separate from the control service and the
 * renderer. Electron main starts it after the vault opens and is its only
 * peer: account management arrives here over that trusted channel, and the
 * proxy's port and access token go back to main, which hands them privately
 * to the control service.
 */
const port = (process as any).parentPort;
if (!port)
  throw new Error(
    "The Topsl proxy must be started by the Topsl desktop broker.",
  );
let service: ProxyService | undefined;
let server: ProxyServer | undefined;
let closing = false;

port.on("message", async ({ data }: any) => {
  try {
    let value: unknown;
    if (data.kind === "initialize") {
      if (service) throw new Error("The proxy is already initialized.");
      service = new ProxyService({
        file: path.join(data.directory, "connections.sqlite"),
        key: data.key,
        onState: (state) =>
          port.postMessage({ event: { type: "proxy-state", data: state } }),
        openExternal: (url) =>
          port.postMessage({
            event: { type: "proxy-open-url", data: { url } },
          }),
      });
      server = await startProxyServer(service);
      value = {
        port: server.port,
        token: service.accessToken,
        state: service.view(),
      };
    } else if (data.kind === "close") {
      closing = true;
      await server?.close();
      service?.close();
      port.postMessage({ id: data.id, value: { closed: true } });
      setImmediate(() => process.exit(0));
      return;
    } else if (closing) throw new Error("The proxy is shutting down.");
    else if (!service) throw new Error("The proxy is not initialized.");
    else if (data.kind === "state") value = service.view();
    else if (data.kind === "command")
      value = await service.command(data.command as ProxyCommand);
    else throw new Error("Unknown proxy request.");
    port.postMessage({ id: data.id, value });
  } catch (error) {
    port.postMessage({ id: data.id, error: safeError(error) });
  }
});
