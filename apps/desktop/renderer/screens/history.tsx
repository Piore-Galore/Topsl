import type { Dispatch, SetStateAction } from "react";
import type { Message } from "../../../../packages/domain/types";
import type { Command } from "../../../../packages/domain/commands";
import { ActionButton } from "../components/action-button";
type Props = {
  pending: Record<string, boolean>;
  projectId: string;
  act: (command: Command) => Promise<any>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  searchResults: Message[] | null;
  setSearchResults: Dispatch<SetStateAction<Message[] | null>>;
  searchCursor: string | null;
  setSearchCursor: Dispatch<SetStateAction<string | null>>;
  conversations: Array<{ id: string; title: string; createdAt: string }>;
  openConversation: (id: string) => void;
};
export function HistoryScreen({
  pending,
  projectId,
  act,
  query,
  setQuery,
  searchResults,
  setSearchResults,
  searchCursor,
  setSearchCursor,
  conversations,
  openConversation,
}: Props) {
  return (
    <>
      <h2>Provider history</h2>
      <form
        className="search"
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await act({
            type: "history-page",
            projectId,
            query,
            limit: 80,
          });
          if (result) {
            setSearchResults(result.items);
            setSearchCursor(result.nextCursor);
          }
        }}
      >
        <input
          aria-label="Search project history"
          placeholder="Search this project’s history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ActionButton className="primary" disabled={!projectId}>
          Search
        </ActionButton>
      </form>
      {searchResults ? (
        <>
          <p className="muted">
            {searchResults.length} matching messages{" "}
            <ActionButton
              className="text-button"
              onClick={() => setSearchResults(null)}
            >
              Clear
            </ActionButton>
          </p>
          {searchCursor && (
            <ActionButton
              disabled={pending["history-page"]}
              onClick={async () => {
                const result = await act({
                  type: "history-page",
                  projectId,
                  query,
                  cursor: searchCursor,
                  limit: 80,
                });
                if (result) {
                  setSearchResults((current) => [
                    ...(current ?? []),
                    ...result.items,
                  ]);
                  setSearchCursor(result.nextCursor);
                }
              }}
            >
              Load more search matches
            </ActionButton>
          )}
          {searchResults.map((m) => (
            <article key={m.id} className="history-result">
              <div className="message-meta">
                {m.provider} / {m.role}
                <ActionButton
                  onClick={() => {
                    openConversation(m.conversationId);
                  }}
                >
                  Open conversation →
                </ActionButton>
              </div>
              <pre>{m.text}</pre>
            </article>
          ))}
        </>
      ) : conversations.length ? (
        conversations.map((c: any) => (
          <div className="history-row" key={c.id}>
            <ActionButton
              className="text-button"
              onClick={() => {
                openConversation(c.id);
              }}
            >
              {c.title}
            </ActionButton>
            <span>{new Date(c.createdAt).toLocaleDateString()}</span>
            <ActionButton
              onClick={() => void act({ type: "history-delete", id: c.id })}
            >
              Delete locally
            </ActionButton>
          </div>
        ))
      ) : (
        <p className="muted">
          No provider conversations yet. Exported histories are imported in
          Settings → Imports.
        </p>
      )}
    </>
  );
}
