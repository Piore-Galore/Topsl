import path from "node:path";
import { hash, now, stable } from "../domain/invariants";
import type { Store } from "../persistence/store";
import type { CandidateFile, CandidateSnapshot } from "./candidates";
import type { CheckDefinition } from "./verification";

interface CheckInputBinding {
  id: string;
  projectId: string;
  workflowId: string;
  baselineId: string;
  definitionId: string;
  definitionHash: string;
  protectedFiles: Array<{ path: string; hash: string; mode: number | null }>;
  packageScript: {
    path: string;
    command: string;
    hash: string;
    baselineScripts: Record<string, string>;
  } | null;
  createdAt: string;
}

// Existing tests and verification scripts are the declared regression protocol.
// New tests can be added to a candidate; revising an existing protocol needs a
// newly reviewed workflow rather than a model-authored weakening of this one.
const acceptanceFile =
  /(^|\/)(?:__tests__|tests?|specs?)(\/|$)|[._-](?:test|spec)\.[^/]+$|(^|\/)(?:test_|spec_)[^/]+$|(^|\/)scripts\/(?:[^/]*[-_.])?(?:check|test|verify|validate|acceptance)(?:[-_.][^/]*)?$/i;
const checkConfiguration =
  /(^|\/)(?:(?:vitest|vite|jest|playwright|eslint)\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json|pytest\.ini|tox\.ini|setup\.cfg|ruff\.toml|\.(?:mocharc|nycrc|eslintrc)(?:\.[^/]+)?)$/i;

function referencedInputs(
  baseline: CandidateSnapshot,
  definition: CheckDefinition,
): Set<string> {
  const referenced = new Set<string>();
  for (let index = 0; index < definition.args.length; index++) {
    const argument = definition.args[index];
    // Inline programs are already frozen as part of the exact command. They
    // are not filenames even when the source string contains a file suffix.
    if (
      ["-e", "--eval", "-p", "--print", "-c", "--command"].includes(argument)
    ) {
      index++;
      continue;
    }
    let input: string | undefined;
    if (argument === "--config" || argument === "--configuration")
      input = definition.args[++index];
    else if (/^--(?:config|configuration)=/.test(argument))
      input = argument.slice(argument.indexOf("=") + 1);
    else if (
      !argument.startsWith("-") &&
      /\.(?:[cm]?[jt]sx?|py|sh|bash|rb|pl)$/i.test(argument) &&
      !/[\s*?{}]/.test(argument)
    )
      input = argument;
    if (input === undefined) continue;
    const relative = path.posix.normalize(
      (path.isAbsolute(input)
        ? path.relative(baseline.sourceRoot, input)
        : input
      ).replaceAll("\\", "/"),
    );
    if (
      relative === ".." ||
      relative.startsWith("../") ||
      path.posix.isAbsolute(relative) ||
      !baseline.files.some((file) => file.path === relative && file.hash)
    )
      throw new Error(
        `Required check input is absent from the approved capture: ${input}. Capture and review the actual harness before dispatch.`,
      );
    referenced.add(relative);
  }
  return referenced;
}

function bindingId(workflowId: string, definitionId: string): string {
  return hash(stable([workflowId, definitionId]));
}
function jsonFile(file: CandidateFile): Record<string, unknown> {
  if (!file.content)
    throw new Error("A required check configuration is missing.");
  const value: unknown = JSON.parse(
    Buffer.from(file.content, "base64").toString("utf8"),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("A required check configuration must be a JSON object.");
  return value as Record<string, unknown>;
}
function packageScript(
  candidate: CandidateSnapshot,
  definition: CheckDefinition,
): CheckInputBinding["packageScript"] {
  const executable = path
    .basename(definition.executable)
    .replace(/\.(?:exe|cmd|bat)$/i, "");
  if (!["npm", "pnpm", "yarn"].includes(executable)) return null;
  const args = definition.args;
  const command =
    args[0] === "run" || args[0] === "run-script"
      ? args[1]
      : ["test", "start", "check"].includes(args[0])
        ? args[0]
        : null;
  if (!command) return null;
  const file = candidate.files.find(
    (file) => file.path === "package.json" && file.hash,
  );
  if (!file)
    throw new Error(
      "The selected package-script check requires a captured package.json.",
    );
  const scripts = jsonFile(file).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    throw new Error(
      "The selected check has no captured package-script definition.",
    );
  const script = (scripts as Record<string, unknown>)[command];
  if (typeof script !== "string" || !script.trim())
    throw new Error(
      "The selected package-script check is missing from the approved baseline.",
    );
  return {
    path: file.path,
    command,
    hash: hash(script),
    baselineScripts: Object.fromEntries(
      Object.entries(scripts).map(([name, value]) => [
        name,
        hash(stable(value)),
      ]),
    ),
  };
}

export function bindCheckInputs(
  store: Store,
  workflowId: string,
  baseline: CandidateSnapshot,
  definitions: readonly CheckDefinition[],
): void {
  if (baseline.workflowId !== workflowId)
    throw new Error("Check protocol baseline belongs to another workflow.");
  store.transaction(() => {
    for (const definition of definitions) {
      const referencedScripts = referencedInputs(baseline, definition);
      const protectedFiles = baseline.files
        .filter(
          (file) =>
            file.hash &&
            (acceptanceFile.test(file.path) ||
              checkConfiguration.test(file.path) ||
              referencedScripts.has(file.path)),
        )
        .map((file) => ({
          path: file.path,
          hash: file.hash!,
          mode: file.mode,
        }));
      const id = bindingId(workflowId, definition.id);
      const previous = store.get<CheckInputBinding>("workflow-check-input", id);
      const binding: CheckInputBinding = {
        id,
        projectId: baseline.projectId,
        workflowId,
        baselineId: baseline.id,
        definitionId: definition.id,
        definitionHash: hash(stable(definition)),
        protectedFiles,
        packageScript: packageScript(baseline, definition),
        createdAt: previous?.createdAt ?? now(),
      };
      store.immutable("workflow-check-input", binding);
    }
  });
}

export function assertCheckInputs(
  store: Store,
  workflowId: string,
  candidate: CandidateSnapshot,
  definition: CheckDefinition,
): void {
  const binding = store.get<CheckInputBinding>(
    "workflow-check-input",
    bindingId(workflowId, definition.id),
  );
  if (
    !binding ||
    binding.workflowId !== workflowId ||
    binding.projectId !== candidate.projectId ||
    candidate.workflowId !== workflowId
  )
    throw new Error(
      "The required check has no approved input protocol for this candidate. Review a new workflow before running it.",
    );
  if (binding.definitionHash !== hash(stable(definition)))
    throw new Error(
      "The required check definition changed after approval. Review a new workflow with the revised protocol.",
    );
  const changed = binding.protectedFiles.filter((expected) => {
    const file = candidate.files.find((file) => file.path === expected.path);
    return !file || file.hash !== expected.hash || file.mode !== expected.mode;
  });
  if (changed.length)
    throw new Error(
      `Required acceptance inputs changed: ${changed
        .map((file) => file.path)
        .slice(0, 8)
        .join(
          ", ",
        )}. Review a new workflow to revise the test protocol; this candidate cannot silently replace it.`,
    );
  if (binding.packageScript) {
    const current = packageScript(candidate, definition);
    if (
      !current ||
      current.hash !== binding.packageScript.hash ||
      Object.entries(binding.packageScript.baselineScripts).some(
        ([name, scriptHash]) => current.baselineScripts[name] !== scriptHash,
      )
    )
      throw new Error(
        "The selected package-script check changed after approval. Review its revised test protocol in a new workflow.",
      );
  }
}
