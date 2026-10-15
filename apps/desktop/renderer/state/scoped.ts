import { useEffect, useRef, useState } from "react";
import { ScopedRefreshController, type ScopedState } from "./scoped-controller";
export { ScopedReadFence, observationOf } from "./scoped-controller";
export type { Observation, ScopedState } from "./scoped-controller";
const sources = new Map<string, ScopedRefreshController>();
function sourceFor(projectId: string) {
  let source = sources.get(projectId);
  if (!source) {
    source = new ScopedRefreshController(projectId, {
      snapshot: () =>
        window.topsl.command({ type: "scope-snapshot", projectId }),
      replay: (afterSequence) =>
        window.topsl.command({
          type: "scope-events",
          projectId,
          afterSequence,
          limit: 500,
        }),
      subscribe: (callback) =>
        window.topsl.subscribe((event) => {
          if (event.type === "changes") callback(event.data);
        }),
    });
    sources.set(projectId, source);
  }
  return source;
}
const empty = (projectId: string): ScopedState => ({
  projectId,
  status: "refreshing",
  snapshot: null,
  observation: null,
  lastSuccessAt: null,
  error: null,
  source: "Project snapshot",
});
/** Shared transport owner; loaders receive the accepted snapshot, never another global read. */
export function useScopedRefresh(
  projectId: string,
  refresh: (snapshot: any) => Promise<unknown> | unknown,
) {
  const callback = useRef(refresh);
  callback.current = refresh;
  const [state, setState] = useState<ScopedState>(() => empty(projectId));
  useEffect(() => {
    if (!projectId) {
      setState(empty(projectId));
      return;
    }
    let alive = true,
      request = 0,
      lastSnapshot: any = null,
      viewError: string | null = null;
    const source = sourceFor(projectId);
    setState(empty(projectId));
    const unsubscribe = source.subscribe((next) => {
      if (!alive) return;
      setState(
        viewError
          ? {
              ...next,
              status: "stale",
              source: "Project view",
              error: viewError,
            }
          : next,
      );
      if (!next.snapshot || next.snapshot === lastSnapshot) return;
      lastSnapshot = next.snapshot;
      const ticket = ++request;
      setState({ ...next, status: "refreshing" });
      void Promise.resolve()
        .then(() => {
          if (alive && ticket === request)
            return callback.current(next.snapshot);
        })
        .then(() => {
          if (alive && ticket === request) {
            viewError = null;
            setState(source.state);
          }
        })
        .catch((error) => {
          if (alive && ticket === request) {
            viewError = error instanceof Error ? error.message : String(error);
            setState({
              ...source.state,
              status: "stale",
              source: "Project view",
              error: viewError,
            });
          }
        });
    });
    const reconnect = () => {
      void source.refresh(true);
    };
    const offline = () => source.disconnected();
    const visible = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    window.addEventListener("focus", reconnect);
    window.addEventListener("online", reconnect);
    window.addEventListener("pageshow", reconnect);
    window.addEventListener("offline", offline);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive = false;
      request++;
      unsubscribe();
      if (!source.active) sources.delete(projectId);
      window.removeEventListener("focus", reconnect);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("pageshow", reconnect);
      window.removeEventListener("offline", offline);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [projectId]);
  return {
    ...(state.projectId === projectId ? state : empty(projectId)),
    retry: () =>
      projectId ? sourceFor(projectId).refresh(true) : Promise.resolve(),
  };
}
