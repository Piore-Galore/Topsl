import { useEffect, useRef } from "react";
import {
  advanceSequence,
  type ChangePage,
} from "../../../../packages/domain/events";
/** Generation fences prevent a previous project's late response from replacing the selected scope. */
export function useScopedRefresh(
  projectId: string,
  refresh: () => Promise<unknown>,
) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!projectId) return;
    let alive = true,
      cursor = 0,
      epoch = "",
      timer: ReturnType<typeof setTimeout> | undefined,
      busy = false,
      again = false;
    const reload = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        const snapshot = await window.topsl.command({
          type: "scope-snapshot",
          projectId,
        });
        if (alive) {
          cursor = snapshot.sequence;
          epoch = snapshot.epoch;
          await callback.current();
        }
      } catch {
        /* The view exposes command errors; reconnect will retry the durable cursor. */
      } finally {
        busy = false;
        if (alive && again) {
          again = false;
          schedule();
        }
      }
    };
    const schedule = () => {
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          if (alive) void reload();
        }, 80);
    };
    const apply = (page: ChangePage) => {
      if (!alive) return;
      if (page.epoch !== epoch) {
        schedule();
        return;
      }
      // A large durable import may outrun bounded transport. Replace its scoped
      // projection immediately instead of waiting behind every message notice.
      if (
        page.headSequence > cursor &&
        (page.headSequence - cursor > 500 || page.throughSequence < cursor)
      )
        schedule();
      const next = advanceSequence(cursor, page);
      if (next.resync) {
        schedule();
        return;
      }
      cursor = next.sequence;
      if (
        page.events.some(
          (event) =>
            (event.projectId === projectId ||
              (event.projectId === null &&
                [
                  "installation",
                  "approval",
                  "run",
                  "conversation",
                  "usage",
                ].includes(event.kind))) &&
            !event.kind.endsWith("-revision"),
        )
      )
        schedule();
    };
    // Reconnect always replaces the snapshot and epoch, including restored vaults
    // whose sequence has since grown past the old client cursor.
    const reconnect = () => {
      schedule();
    };
    const unsubscribe = window.topsl.subscribe((event) => {
      if (event.type === "changes") apply(event.data);
    });
    window.addEventListener("focus", reconnect);
    void reload();
    return () => {
      alive = false;
      unsubscribe();
      window.removeEventListener("focus", reconnect);
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);
}
