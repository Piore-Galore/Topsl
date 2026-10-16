import type { ApprovalSummary } from "../domain/types";

/** Characters that change how text looks without showing themselves:
 * controls other than tab and newline, the soft hyphen, zero-width and
 * direction marks, line separators, invisible operators and tag
 * characters. */
const hidden =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

const escape = (character: string) =>
  `\\u{${character.codePointAt(0)!.toString(16)}}`;
const breaks = /[\n\t]/g;

/** Text a runtime supplied, for display: every character that could hide
 * or reorder it is written as an escape, and at most `limit` characters are
 * kept. A value meant for one line also has its line breaks and tabs
 * escaped, so no part of it can pass for a line of its own. */
export function visible(text: string, limit = 4000, multiline = true): string {
  let shown = text.replace(hidden, escape);
  if (!multiline) shown = shown.replace(breaks, escape);
  return shown.length > limit
    ? `${shown.slice(0, limit)}… (${shown.length - limit} more characters)`
    : shown;
}

const text = (value: unknown) =>
  typeof value === "string" && value ? value : null;
/** A runtime-supplied name for one line of a list, or `fallback`. */
const named = (value: unknown, fallback: string) =>
  text(value)?.replace(breaks, escape) ?? fallback;
const listed = (value: unknown) => Array.isArray(value) && value.length > 0;

const access: Record<string, string> = {
  read: "Read",
  write: "Write",
  deny: "No access to",
};
/** A file system path from Codex's experimental permission requests. */
function place(path: any): string {
  if (path?.type === "path") return named(path.path, "an unnamed path");
  if (path?.type === "glob_pattern")
    return `files matching ${named(path.pattern, "an unnamed pattern")}`;
  const special = path?.type === "special" ? path.value : null,
    subpath = named(special?.subpath, "");
  switch (special?.kind) {
    case "root":
      return "the whole file system";
    case "minimal":
      return "the minimal system folders";
    case "project_roots":
      return subpath ? `${subpath} in the project roots` : "the project roots";
    case "tmpdir":
      return "the temporary folder";
    case "slash_tmp":
      return "/tmp";
    case "unknown":
      return named(special.path, "an unnamed path");
    default:
      return "an unnamed path";
  }
}
/** The permissions a command asks for beyond its sandbox, one per line. */
function extraPermissions(requested: unknown): string[] {
  if (!requested || typeof requested !== "object") return [];
  const { fileSystem, network } = requested as Record<string, any>,
    lines: string[] = [];
  for (const entry of Array.isArray(fileSystem?.entries)
    ? fileSystem.entries
    : [])
    lines.push(`${access[entry?.access] ?? "Access to"} ${place(entry?.path)}`);
  for (const [key, verb] of [
    ["read", "Read"],
    ["write", "Write"],
  ] as const)
    for (const path of Array.isArray(fileSystem?.[key]) ? fileSystem[key] : [])
      lines.push(`${verb} ${named(path, "an unnamed path")}`);
  if (network?.enabled === true) lines.push("Network access");
  return lines;
}

/** Seen once, in the first live qualification, and not documented. */
export const sandboxNote =
  "Codex 0.163.0 appeared to run an approved command outside its sandbox when the sandbox blocked it, so this command may run with your own access. Topsl saw this once, in a live qualification on 16 October 2026, and Codex's documentation does not confirm it.";

/** An `item/commandExecution/requestApproval` request from Codex 0.163.0. */
export function commandApprovalSummary(
  request: Record<string, unknown>,
): ApprovalSummary {
  const input = request.kind === "writeStdin",
    command = text(request.command),
    cwd = text(request.cwd),
    environment = text(request.environmentId),
    reason = text(request.reason),
    network =
      request.networkApprovalContext &&
      typeof request.networkApprovalContext === "object"
        ? (request.networkApprovalContext as Record<string, unknown>)
        : null,
    host = text(network?.host),
    protocol = text(network?.protocol),
    extra = extraPermissions(request.additionalPermissions);
  return {
    title: input ? "Send input to a running command" : "Run a command",
    details: [
      {
        label: "Command",
        value: command ? visible(command) : "Codex did not report the command.",
      },
      ...(cwd ? [{ label: "Folder", value: visible(cwd, 1000, false) }] : []),
      ...(environment
        ? [{ label: "Environment", value: visible(environment, 200, false) }]
        : []),
      ...(host
        ? [
            {
              label: "Network",
              value: visible(
                protocol ? `${host} (${protocol})` : host,
                1000,
                false,
              ),
            },
          ]
        : []),
      ...(extra.length
        ? [
            {
              label: "Extra permissions",
              value: visible(
                extra.slice(0, 50).join("\n") +
                  (extra.length > 50 ? `\nand ${extra.length - 50} more` : ""),
                8000,
              ),
            },
          ]
        : []),
      ...(reason
        ? [{ label: "Codex's reason", value: visible(reason, 2000) }]
        : []),
    ],
    effects: [
      input
        ? "Allowing lets Codex send this input once."
        : "Allowing lets Codex run this command once.",
      ...(extra.length
        ? ["Allowing also gives it the extra permissions listed above."]
        : []),
      ...(input ? [] : [sandboxNote]),
      // Topsl answers only accept or decline, never the amendment decisions.
      ...(listed(request.proposedExecpolicyAmendment) ||
      listed(request.proposedNetworkPolicyAmendments)
        ? [
            "Codex also proposed a lasting rule for similar requests. Allowing once does not add it.",
          ]
        : []),
    ],
  };
}

const verbs: Record<string, string> = {
  add: "Create",
  delete: "Delete",
  update: "Edit",
};

/** An `item/fileChange/requestApproval` request from Codex 0.163.0. The
 * request names its `fileChange` item, which lists the files; `item` is that
 * item as Codex reported it when it started, if it did. */
export function fileChangeApprovalSummary(
  request: Record<string, unknown>,
  item: unknown,
): ApprovalSummary {
  const grantRoot = text(request.grantRoot),
    reason = text(request.reason),
    changes =
      item && typeof item === "object" && Array.isArray((item as any).changes)
        ? ((item as any).changes as unknown[])
        : [],
    files = changes.map((change: any) => {
      const target = named(change?.path, "an unnamed file"),
        moved = named(change?.kind?.move_path, "");
      return moved
        ? `Move ${target} to ${moved}`
        : `${verbs[change?.kind?.type] ?? "Change"} ${target}`;
    });
  return {
    title: "Change files",
    details: [
      {
        label: files.length === 1 ? "File" : "Files",
        value: files.length
          ? visible(
              files.slice(0, 50).join("\n") +
                (files.length > 50 ? `\nand ${files.length - 50} more` : ""),
              8000,
            )
          : "Codex did not report which files.",
      },
      ...(grantRoot
        ? [
            {
              label: "Write access requested",
              value: visible(grantRoot, 1000, false),
            },
          ]
        : []),
      ...(reason
        ? [{ label: "Codex's reason", value: visible(reason, 2000) }]
        : []),
    ],
    effects: [
      "Allowing lets Codex apply this change once.",
      ...(grantRoot
        ? [
            `Allowing also lets Codex write under ${visible(grantRoot, 1000, false)} for the rest of the session.`,
          ]
        : []),
    ],
  };
}
