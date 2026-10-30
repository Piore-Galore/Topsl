import { useEffect, useRef, useState } from "react";
import type { AppState, Provider } from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import type {
  HistoryReference,
  ImportPreview,
} from "../../../../packages/domain/history-imports";
import { ActionButton } from "../components/action-button";

const providerName = (provider: Provider) =>
  provider === "claude" ? "Claude Code" : "Codex";
const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const amount = (r: {
  structured: boolean;
  messageCount: number;
  characters: number;
}) =>
  r.structured
    ? `${r.messageCount.toLocaleString()} ${r.messageCount === 1 ? "message" : "messages"}`
    : `${r.characters.toLocaleString()} characters of text`;

/**
 * Settings → Imports (docs/UX_Cleanup_Plan.md §3): preview one exported
 * file for an explicit project and provider, import exactly what was
 * previewed, search and read imports, and continue one in a new session.
 */
export function ImportsSection({
  state,
  projectId: initialProject,
  onContinue,
}: {
  state: AppState;
  projectId: string;
  onContinue: (projectId: string, referenceId: string) => void;
}) {
  const [projectId, setProjectId] = useState(
    initialProject || state.projects[0]?.id || "",
  );
  const [provider, setProvider] = useState<Provider>("codex");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [committed, setCommitted] = useState<{
    reference: HistoryReference;
    duplicate: boolean;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<HistoryReference[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{
    reference: HistoryReference;
    text: string;
    nextOffset: number | null;
  } | null>(null);
  const [deleted, setDeleted] = useState("");
  const listTicket = useRef(0);
  const [error, setError] = useState("");
  /**
   * Imports name their own project, which need not be the one selected in
   * the sidebar, so their replies are not fenced to that project. A
   * cancelled native dialog returns nothing.
   */
  async function act(command: Command): Promise<any> {
    setError("");
    try {
      return await window.topsl.command(command);
    } catch (e: any) {
      setError(e.message);
      return undefined;
    }
  }
  const project = state.projects.find((p) => p.id === projectId);

  async function load(more = false) {
    if (!projectId) return;
    const ticket = ++listTicket.current;
    const page = await act({
      type: "history-imports",
      projectId,
      query: query.trim() || undefined,
      cursor: more ? cursor : null,
      limit: 25,
    });
    if (!page || ticket !== listTicket.current) return;
    setItems((current) => (more ? [...current, ...page.items] : page.items));
    setTotal(page.total);
    setCursor(page.nextCursor);
  }
  useEffect(() => {
    setPreview(null);
    setCommitted(null);
    setViewing(null);
    setDeleted("");
    void load();
  }, [projectId]);

  return (
    <section
      className="settings-card imports"
      aria-label="Imports"
      id="imports"
    >
      <h2>Imports</h2>
      <p>
        Bring an exported Codex or Claude Code history into a project. Topsl
        keeps exactly the text you preview, makes it searchable, and never reads
        the file again.
      </p>
      <div className="runtime-bar">
        <label>
          Project
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {!state.projects.length && <option value="">No projects</option>}
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value as Provider);
              setPreview(null);
            }}
          >
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <ActionButton
          disabled={!projectId}
          onClick={async () => {
            setCommitted(null);
            const value = await act({
              type: "history-import-preview",
              projectId,
              provider,
            });
            if (value) setPreview(value);
          }}
        >
          Choose file…
        </ActionButton>
      </div>
      <p className="tiny muted">
        One .md, .txt, .json, .jsonl or .ndjson file, up to 30 MB.
      </p>
      {error && <p role="alert">{error}</p>}
      {preview && (
        <article className="import-preview" aria-label="Import preview">
          <h3>{preview.fileName}</h3>
          <dl>
            <dt>Format</dt>
            <dd>{preview.formatLabel}</dd>
            <dt>Contains</dt>
            <dd>
              {amount(preview)} · {size(preview.bytes)}
            </dd>
            <dt>Into</dt>
            <dd>
              {project?.name ?? "Project"} · {providerName(preview.provider)}
            </dd>
            {(preview.nativeSessionId || preview.recordedFolder) && (
              <>
                <dt>Recorded with it</dt>
                <dd>
                  {[
                    preview.nativeSessionId &&
                      `session ${preview.nativeSessionId}`,
                    preview.recordedFolder &&
                      `folder ${preview.recordedFolder}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}{" "}
                  <span className="muted">
                    (kept as history only; nothing is resumed or added)
                  </span>
                </dd>
              </>
            )}
          </dl>
          {preview.duplicateOf && (
            <p role="status">
              This content is already imported as{" "}
              <strong>{preview.duplicateOf.fileName}</strong> (
              {new Date(preview.duplicateOf.importedAt).toLocaleString()}).
              Importing again keeps that one.
            </p>
          )}
          {preview.warnings.length > 0 && (
            <ul className="import-warnings">
              {preview.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <details>
            <summary>First lines</summary>
            <pre className="snapshot">{preview.sample}</pre>
          </details>
          <div className="actions">
            <ActionButton
              className="primary"
              onClick={async () => {
                const result = await act({
                  type: "history-import-commit",
                  projectId: preview.projectId,
                  previewId: preview.id,
                  contentHash: preview.contentHash,
                });
                if (!result) return;
                setPreview(null);
                setCommitted(result);
                await load();
              }}
            >
              {preview.duplicateOf ? "Use the existing import" : "Import"}
            </ActionButton>
            <ActionButton onClick={() => setPreview(null)}>Cancel</ActionButton>
          </div>
        </article>
      )}
      {committed && (
        <p role="status" className="import-done">
          {committed.duplicate
            ? `Already imported: ${committed.reference.fileName}. Nothing new was stored.`
            : `Imported ${committed.reference.fileName}.`}{" "}
          <ActionButton
            className="text-button"
            onClick={() =>
              onContinue(committed.reference.projectId, committed.reference.id)
            }
          >
            Continue in Topsl
          </ActionButton>
        </p>
      )}
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          aria-label="Search imports"
          placeholder="Search this project’s imports…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ActionButton disabled={!projectId}>Search</ActionButton>
      </form>
      {deleted && <p role="status">{deleted}</p>}
      {items.length ? (
        <ul className="import-list" aria-label="Imported histories">
          {items.map((r) => (
            <li key={r.id}>
              <div>
                <strong>{r.fileName}</strong>
                <span className="muted tiny">
                  {" "}
                  {providerName(r.provider)} · {r.formatLabel} · {amount(r)} ·
                  imported {new Date(r.importedAt).toLocaleString()}
                </span>
              </div>
              <div className="actions">
                <ActionButton
                  className="primary"
                  onClick={() => onContinue(r.projectId, r.id)}
                >
                  Continue in Topsl
                </ActionButton>
                <ActionButton
                  onClick={async () => {
                    const value = await act({
                      type: "history-import-read",
                      projectId: r.projectId,
                      id: r.id,
                      offset: 0,
                      limit: 100000,
                    });
                    if (value)
                      setViewing({
                        reference: r,
                        text: value.text,
                        nextOffset: value.nextOffset,
                      });
                  }}
                >
                  View
                </ActionButton>
                <ActionButton
                  aria-label={`Delete import ${r.fileName}`}
                  onClick={async () => {
                    const value = await act({
                      type: "history-import-delete",
                      projectId: r.projectId,
                      id: r.id,
                    });
                    if (!value) return;
                    setDeleted(
                      value.sessions
                        ? `Deleted ${r.fileName}. ${value.sessions} ${value.sessions === 1 ? "session keeps its" : "sessions keep their"} copy.`
                        : `Deleted ${r.fileName}.`,
                    );
                    if (viewing?.reference.id === r.id) setViewing(null);
                    await load();
                  }}
                >
                  Delete
                </ActionButton>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          {query.trim()
            ? "No matching imports."
            : "No imports in this project."}
        </p>
      )}
      {cursor && (
        <ActionButton onClick={() => void load(true)}>
          Show more ({items.length} of {total})
        </ActionButton>
      )}
      <p className="tiny muted">
        Deleting an import removes its text and search entries; sessions that
        already started with it keep their copy.
      </p>
      {viewing && (
        <section className="import-viewer" aria-label="Imported text">
          <div className="section-heading">
            <h3>{viewing.reference.fileName}</h3>
            <ActionButton onClick={() => setViewing(null)}>Close</ActionButton>
          </div>
          <pre className="snapshot">{viewing.text}</pre>
          {viewing.nextOffset !== null && (
            <ActionButton
              onClick={async () => {
                const value = await act({
                  type: "history-import-read",
                  projectId: viewing.reference.projectId,
                  id: viewing.reference.id,
                  offset: viewing.nextOffset!,
                  limit: 100000,
                });
                if (value)
                  setViewing({
                    ...viewing,
                    text: viewing.text + value.text,
                    nextOffset: value.nextOffset,
                  });
              }}
            >
              Show more of the file
            </ActionButton>
          )}
        </section>
      )}
    </section>
  );
}
