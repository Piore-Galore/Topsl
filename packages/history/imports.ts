import path from "node:path";
import {
  IMPORT_MAX_BYTES,
  importExtensions,
  type ImportedMessage,
  type ParsedImport,
} from "../domain/history-imports";

/**
 * Reads one exported history file (docs/UX_Cleanup_Plan.md §3). Recognized
 * transcript structures become messages with the speakers the export
 * recorded. Everything else that is readable is kept as attributed
 * reference text: no speaker is invented and nothing is dropped silently.
 * Binary input is refused.
 */

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Text from a string, or from text parts of a content array. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : object(part) &&
              ["text", "input_text", "output_text"].includes(
                String(part.type ?? "text"),
              ) &&
              typeof part.text === "string"
            ? part.text
            : "",
      )
      .filter(Boolean)
      .join("\n");
  if (object(content) && Array.isArray(content.parts))
    return textOf(content.parts);
  return "";
}

const roleOf = (value: unknown): ImportedMessage["role"] | null => {
  const role = String(value ?? "").toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "ai" || role === "model")
    return "assistant";
  return null;
};

const timeOf = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value))
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  return null;
};

const idOf = (value: unknown): string | null =>
  typeof value === "string" && value.length && value.length <= 512
    ? value
    : null;

/** A message from one record, or null when the record is not one. */
function messageOf(
  value: Record<string, unknown>,
): { message: ImportedMessage; kind: "codex" | "claude" | "generic" } | null {
  // Codex rollout: {type: "response_item", payload: {type: "message", role, content}}.
  if (value.type === "response_item" && object(value.payload)) {
    const p = value.payload;
    const role = roleOf(p.role);
    const text = textOf(p.content);
    if ((p.type ?? "message") !== "message" || !role || !text.trim())
      return null;
    return {
      kind: "codex",
      message: {
        role,
        text,
        at: timeOf(value.timestamp),
        nativeId: idOf(p.id),
      },
    };
  }
  // Claude Code: {type: "user" | "assistant", message: {role, content}}.
  if (
    (value.type === "user" || value.type === "assistant") &&
    object(value.message)
  ) {
    const role = roleOf(value.message.role ?? value.type);
    const text = textOf(value.message.content);
    if (!role || !text.trim()) return null;
    return {
      kind: "claude",
      message: {
        role,
        text,
        at: timeOf(value.timestamp),
        nativeId: idOf(value.uuid),
      },
    };
  }
  // A plain message: {role, content | text}, or a Claude export's {sender, text}.
  const role = roleOf(value.role ?? value.sender ?? value.author);
  const text = textOf(value.content ?? value.text);
  if (!role || !text.trim()) return null;
  return {
    kind: "generic",
    message: {
      role,
      text,
      at: timeOf(value.timestamp ?? value.created_at ?? value.create_time),
      nativeId: idOf(value.id ?? value.uuid),
    },
  };
}

/** Session identity and working folder a record states, if any. */
function metadataOf(value: Record<string, unknown>) {
  const payload = object(value.payload) ? value.payload : null;
  if (value.type === "session_meta" && payload)
    return { session: idOf(payload.id), folder: idOf(payload.cwd) };
  return { session: idOf(value.sessionId), folder: idOf(value.cwd) };
}

function decode(bytes: Buffer): string {
  if (bytes.includes(0))
    throw new Error(
      "This file is binary, not text. Export the history as Markdown, text, JSON or JSON Lines.",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "This file is not readable UTF-8 text. Export the history as Markdown, text, JSON or JSON Lines.",
    );
  }
  return text.replace(/^﻿/, "");
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function lines(text: string, label: string): ParsedImport {
  const messages: ImportedMessage[] = [];
  const kinds = new Map<string, number>();
  const remainder: string[] = [];
  let invalid = 0,
    other = 0,
    session: string | null = null,
    folder: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalid++;
      remainder.push(line);
      continue;
    }
    if (!object(value)) {
      other++;
      remainder.push(line);
      continue;
    }
    const meta = metadataOf(value);
    session ??= meta.session;
    folder ??= meta.folder;
    const found = messageOf(value);
    if (!found) {
      other++;
      remainder.push(line);
      continue;
    }
    kinds.set(found.kind, (kinds.get(found.kind) ?? 0) + 1);
    messages.push(found.message);
  }
  const kind = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const warnings: string[] = [];
  if (invalid)
    warnings.push(
      `${plural(invalid, "line is", "lines are")} not valid JSON; ${invalid === 1 ? "it is" : "they are"} kept as text.`,
    );
  if (messages.length && other)
    warnings.push(
      `${plural(other, "record is", "records are")} not a message (metadata, tool calls or other entries). ${other === 1 ? "It stays" : "They stay"} with the import and in search, but not in a session's excerpt.`,
    );
  if (!messages.length)
    warnings.push(
      "No messages with recorded speakers were recognized. The whole file is kept as reference text.",
    );
  return {
    format: messages.length ? `${kind}-jsonl` : "jsonl",
    formatLabel: messages.length
      ? kind === "codex"
        ? "Codex session (JSON Lines)"
        : kind === "claude"
          ? "Claude Code session (JSON Lines)"
          : "Messages (JSON Lines)"
      : `${label} (unrecognized records)`,
    structured: messages.length > 0,
    messages,
    remainder: messages.length ? remainder.join("\n") : text,
    characters: text.length,
    warnings,
    nativeSessionId: session,
    recordedFolder: folder,
  };
}

/** Messages of one ChatGPT-style export: a `mapping` of message nodes. */
function mappingMessages(mapping: Record<string, unknown>): ImportedMessage[] {
  const nodes = Object.values(mapping)
    .filter(object)
    .map((node) => (object(node.message) ? node.message : null))
    .filter((m): m is Record<string, unknown> => !!m);
  return nodes
    .map((m) => {
      const role = roleOf(object(m.author) ? m.author.role : m.role);
      const text = textOf(m.content);
      return role && text.trim()
        ? {
            role,
            text,
            at: timeOf(m.create_time),
            nativeId: idOf(m.id),
          }
        : null;
    })
    .filter((m): m is ImportedMessage => !!m)
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
}

/** Messages of one conversation object, or null when it is not one. */
function conversationMessages(
  value: Record<string, unknown>,
): ImportedMessage[] | null {
  if (object(value.mapping)) return mappingMessages(value.mapping);
  const list = Array.isArray(value.messages)
    ? value.messages
    : Array.isArray(value.chat_messages)
      ? value.chat_messages
      : null;
  if (!list) return null;
  return list
    .filter(object)
    .map((m) => messageOf(m)?.message ?? null)
    .filter((m): m is ImportedMessage => !!m);
}

function json(text: string): ParsedImport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ...unstructured(text, "json", "JSON (not valid; kept as text)"),
      warnings: ["The file is not valid JSON. It is kept as reference text."],
    };
  }
  let messages: ImportedMessage[] = [];
  let conversations = 0;
  if (Array.isArray(value)) {
    const direct = value
      .filter(object)
      .map((m) => messageOf(m)?.message ?? null);
    if (direct.some(Boolean))
      messages = direct.filter((m): m is ImportedMessage => !!m);
    else
      for (const item of value.filter(object)) {
        const found = conversationMessages(item);
        if (found?.length) {
          conversations++;
          messages.push(...found);
        }
      }
  } else if (object(value)) {
    const found = conversationMessages(value);
    if (found?.length) {
      conversations = 1;
      messages = found;
    }
  }
  if (!messages.length)
    return {
      ...unstructured(text, "json", "JSON (unrecognized structure)"),
      warnings: [
        "No messages with recorded speakers were recognized. The JSON is kept as reference text.",
      ],
    };
  const meta = object(value)
    ? metadataOf(value)
    : { session: null, folder: null };
  return {
    format: "messages-json",
    formatLabel: "Messages (JSON)",
    structured: true,
    messages,
    remainder: "",
    characters: text.length,
    warnings:
      conversations > 1
        ? [
            `${plural(conversations, "conversation")} in this file are combined in time order.`,
          ]
        : [],
    nativeSessionId: meta.session,
    recordedFolder: meta.folder,
  };
}

const speakerHeading =
  /^(?:#{1,6}\s*|\*\*)\s*(user|you|human|me|assistant|ai|claude|claude code|codex|chatgpt|gpt)\s*:?\s*(?:\*\*)?\s*:?\s*$/i;

/** A Markdown transcript with one heading per speaker, or unstructured text. */
function markdown(text: string, extension: string): ParsedImport {
  const sections: Array<{ role: ImportedMessage["role"]; lines: string[] }> =
    [];
  const preamble: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const heading = speakerHeading.exec(line.trim());
    if (heading) {
      const speaker = heading[1].toLowerCase();
      sections.push({
        role: ["user", "you", "human", "me"].includes(speaker)
          ? "user"
          : "assistant",
        lines: [],
      });
    } else if (sections.length) sections.at(-1)!.lines.push(line);
    else preamble.push(line);
  }
  const messages = sections
    .map((s) => ({
      role: s.role,
      text: s.lines.join("\n").trim(),
      at: null,
      nativeId: null,
    }))
    .filter((m) => m.text);
  const label = extension === ".md" ? "Markdown" : "Text";
  if (messages.length < 2 || !messages.some((m) => m.role === "user"))
    return unstructured(text, extension === ".md" ? "markdown" : "text", label);
  const before = preamble.join("\n").trim();
  return {
    format: "markdown-transcript",
    formatLabel: `${label} transcript`,
    structured: true,
    messages,
    remainder: before,
    characters: text.length,
    warnings: before
      ? [
          "Text before the first speaker heading stays with the import and in search, but not in a session's excerpt.",
        ]
      : [],
    nativeSessionId: null,
    recordedFolder: null,
  };
}

function unstructured(
  text: string,
  format: string,
  formatLabel: string,
): ParsedImport {
  return {
    format,
    formatLabel,
    structured: false,
    messages: [],
    remainder: text,
    characters: text.length,
    warnings: [],
    nativeSessionId: null,
    recordedFolder: null,
  };
}

/** Checks a file's name and size before it is read. */
export function checkImportFile(fileName: string, bytes: number): string {
  const extension = path.extname(fileName).toLowerCase();
  if (!(importExtensions as readonly string[]).includes(extension))
    throw new Error(
      `Choose one .md, .txt, .json, .jsonl or .ndjson file. ZIP archives and other files are not imported.`,
    );
  if (bytes > IMPORT_MAX_BYTES)
    throw new Error("The file is larger than the 30 MB import limit.");
  return extension;
}

/** Decodes and recognizes one exported file. */
export function parseImport(
  bytes: Buffer,
  fileName: string,
): ParsedImport & { text: string } {
  const extension = checkImportFile(fileName, bytes.length);
  const text = decode(bytes);
  if (!text.trim()) throw new Error("This file is empty.");
  const parsed =
    extension === ".json"
      ? json(text)
      : extension === ".jsonl" || extension === ".ndjson"
        ? lines(text, "JSON Lines")
        : markdown(text, extension);
  return { ...parsed, text };
}
