import { Service } from "./service";
import { commandSchema } from "../../packages/domain/commands";
import { safeError } from "../../packages/domain/invariants";
const port = (process as any).parentPort;
if (!port)
  throw new Error(
    "The control service must be started by the Topsl desktop broker.",
  );
let service: Service | undefined;
let initializing: Promise<void> | undefined;
let closing = false;
port.on("message", async ({ data }: any) => {
  try {
    let value: any;
    if (data.kind === "initialize") {
      if (service) throw new Error("Control service already initialized.");
      service = new Service(
        data.directory,
        data.key,
        (event) => port.postMessage({ event }),
        data.isolatedTest === true,
        undefined,
        typeof data.qualificationDirectory === "string"
          ? data.qualificationDirectory
          : undefined,
      );
      initializing = service.start();
      await initializing;
      value = service.state();
    } else if (data.kind === "close") {
      closing = true;
      await initializing?.catch(() => {});
      await service?.close();
      port.postMessage({ id: data.id, value: { closed: true } });
      setImmediate(() => process.exit(0));
      return;
    } else if (closing) throw new Error("Control service is shutting down.");
    else if (!service) throw new Error("Control service is locked.");
    else if (data.kind === "review")
      value = await service.review(data.recordKind, data.recordId);
    else
      value = await service.command(
        commandSchema.parse(data.command),
        data.trusted ?? {},
      );
    port.postMessage({ id: data.id, value });
  } catch (error) {
    port.postMessage({ id: data.id, error: safeError(error) });
  }
});
