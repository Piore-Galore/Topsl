import { useEffect, useState } from "react";

/**
 * Unsent composer text per thread, kept for this window's life so leaving a
 * thread and coming back keeps what was typed. Nothing is persisted.
 */
export class DraftStore {
  private drafts = new Map<string, string>();
  get(key: string) {
    return this.drafts.get(key) ?? "";
  }
  set(key: string, value: string) {
    if (value) this.drafts.set(key, value);
    else this.drafts.delete(key);
  }
}

const drafts = new DraftStore();

export function useDraft(key: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => drafts.get(key));
  useEffect(() => setValue(drafts.get(key)), [key]);
  return [
    value,
    (next: string) => {
      drafts.set(key, next);
      setValue(next);
    },
  ];
}
