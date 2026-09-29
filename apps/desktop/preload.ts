import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("topsl", {
  command: async (command: unknown) => {
    const result = await ipcRenderer.invoke("topsl:command", command);
    if (result.error) throw new Error(result.error);
    return result.value;
  },
  subscribe: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on("topsl:event", listener);
    return () => ipcRenderer.removeListener("topsl:event", listener);
  },
});
