import { useEffect, useRef, useState } from "react";
import { workflowDraftInput } from "../../../../packages/domain/workflow-drafts";
import { ScopedReadFence } from "../state/scoped";
export function SpecificationDraft({
  projectId,
  workflow,
  publish,
}: {
  projectId: string;
  workflow: any;
  publish: (input: {
    objective: string;
    acceptanceCriteria: string[];
    interfaces: string[];
  }) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(() =>
      workflowDraftInput.parse({ objective: workflow.objective }),
    ),
    [revision, setRevision] = useState(0),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const fence = useRef(new ScopedReadFence(projectId)),
    edits = useRef(0),
    alive = useRef(true);
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  useEffect(() => {
    alive.current = true;
    fence.current.reset(projectId);
    const ticket = fence.current.begin(),
      before = edits.current;
    void window.topsl
      .command({
        type: "workflow-draft-query",
        projectId,
        workflowId: workflow.id,
      })
      .then((value) => {
        if (!alive.current || !fence.current.accept(ticket, value)) return;
        setRevision(value.draft?.revision ?? 0);
        if (value.draft && before === edits.current) {
          setDraft(value.draft.draft);
          setStatus(
            `Restored protected requirements draft revision ${value.draft.revision}.`,
          );
        }
      })
      .catch((error) => {
        if (alive.current) setError(error.message);
      });
    return () => {
      alive.current = false;
      fence.current.reset("");
    };
  }, [projectId, workflow.id]);
  async function perform(action: () => Promise<unknown>) {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (error: any) {
      if (alive.current) setError(error.message);
    } finally {
      if (alive.current) setPending(false);
    }
  }
  return (
    <form
      className="workflow-form"
      onSubmit={(event) => {
        event.preventDefault();
        void perform(() =>
          publish({
            objective: draft.objective,
            acceptanceCriteria: lines(draft.criteria),
            interfaces: lines(draft.interfaces),
          }),
        );
      }}
    >
      <label>
        Updated objective
        <textarea
          value={draft.objective}
          onChange={(event) => {
            edits.current++;
            setDraft({ ...draft, objective: event.target.value });
          }}
          required
        />
      </label>
      <label>
        Updated acceptance criteria · one per line
        <textarea
          value={draft.criteria}
          onChange={(event) => {
            edits.current++;
            setDraft({ ...draft, criteria: event.target.value });
          }}
          required
        />
      </label>
      <label>
        Interface requirements · one per line
        <textarea
          value={draft.interfaces}
          onChange={(event) => {
            edits.current++;
            setDraft({ ...draft, interfaces: event.target.value });
          }}
        />
      </label>
      <div className="workflow-actions full-width">
        <button disabled={pending}>Publish new specification</button>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void perform(async () => {
              const ticket = fence.current.begin();
              const value = await window.topsl.command({
                type: "workflow-draft-save",
                requestId: crypto.randomUUID(),
                projectId,
                workflowId: workflow.id,
                expectedRevision: revision,
                draft,
              });
              if (alive.current && fence.current.accept(ticket, value)) {
                setRevision(value.draft.revision);
                setStatus(
                  `Protected requirements draft revision ${value.draft.revision} saved.`,
                );
              }
            })
          }
        >
          Save requirements draft
        </button>
      </div>
      {status && (
        <p role="status">
          {status} Publishing creates new immutable inputs; saved drafts never
          change an active attempt.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
