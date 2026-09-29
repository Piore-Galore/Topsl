import type { Command } from "../../../packages/domain/commands";
declare global {
  interface Window {
    topsl: {
      command: (command: Command) => Promise<any>;
      subscribe: (callback: (event: any) => void) => () => void;
    };
  }
}
export {};
