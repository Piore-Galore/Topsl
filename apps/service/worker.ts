import { Service } from "./service";
import { commandSchema } from "../../packages/domain/commands";
import { safeError } from "../../packages/domain/invariants";
const port = (process as any).parentPort;
if (!port)
  throw new Error(
    "The control service must be started by the Topsl desktop broker.",
  );
let service: Service | undefined;
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
      );
      await service.start();
      value = service.state();
    } else if (data.kind === "close") {
      service?.close();
      process.exit(0);
    } else if (!service) throw new Error("Control service is locked.");
    else if (data.kind === "review")
      value = service.review(data.recordKind, data.recordId);
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
