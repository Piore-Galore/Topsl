import type {
  BuiltInRole,
  CollaborationMode,
  ExecutionPurpose,
  RoleDefinition,
} from "../domain/role-groups";

/**
 * What each execution purpose needs from a runtime route. These are task
 * requirements, never a provider or model-family whitelist: any model whose
 * qualified route satisfies them is eligible for any role with that purpose.
 */
export function purposeRequirements(purpose: ExecutionPurpose): string[] {
  const common = [
    "structured-turn",
    "native-subscription",
    "process-lifecycle",
  ];
  switch (purpose) {
    case "coordinator-contribution":
    case "coordinator-endorsement":
    case "information":
      return [...common, "fresh-session", "read-only"];
    case "candidate-review":
      return [...common, "fresh-session", "candidate-reader", "read-only"];
    case "implementation":
      return [...common, "workspace-write"];
    case "direct-chat":
      return ["structured-turn"];
  }
}

/** Purposes whose execution must not write the project. */
export const readOnlyPurposes: ReadonlySet<ExecutionPurpose> = new Set([
  "coordinator-contribution",
  "coordinator-endorsement",
  "information",
  "candidate-review",
]);

const definition = (
  id: BuiltInRole,
  title: string,
  purpose: ExecutionPurpose,
  outputContract: RoleDefinition["outputContract"],
  defaultCollaboration: CollaborationMode,
  instructions: string,
): RoleDefinition => ({
  id,
  projectId: null,
  revision: 1,
  title,
  instructions,
  purpose,
  requiredCapabilities: purposeRequirements(purpose),
  permittedOperations:
    purpose === "implementation"
      ? ["write-permitted-outputs"]
      : purpose === "coordinator-contribution"
        ? ["propose-plan", "propose-delegation"]
        : ["read-inputs"],
  outputContract,
  defaultCollaboration,
});

export const builtInRoleDefinitions: Record<BuiltInRole, RoleDefinition> = {
  coordinator: definition(
    "coordinator",
    "Coordinators",
    "coordinator-contribution",
    "coordinator-proposal",
    "peer-collaboration",
    "Decompose the goal into bounded tasks with dependencies, role assignments and acceptance criteria. Propose; never dispatch.",
  ),
  planner: definition(
    "planner",
    "Planners",
    "information",
    "information",
    "parallel-independent",
    "Produce a plan or alternative for the stated scope as an information artifact.",
  ),
  implementer: definition(
    "implementer",
    "Implementation",
    "implementation",
    "code-candidate",
    "parallel-partitioned",
    "Change only the permitted outputs of your assigned partition.",
  ),
  reviewer: definition(
    "reviewer",
    "Reviewers",
    "candidate-review",
    "candidate-review",
    "parallel-independent",
    "Review the exact pinned candidate and report substantiated findings with file and line evidence.",
  ),
  tester: definition(
    "tester",
    "Testers",
    "implementation",
    "code-candidate",
    "parallel-partitioned",
    "Design or write tests within the permitted outputs. Deterministic checks supply the check evidence.",
  ),
  integrator: definition(
    "integrator",
    "Integrators",
    "information",
    "information",
    "parallel-independent",
    "Propose merge or conflict resolutions. Only one admitted operation writes the integration workspace.",
  ),
  researcher: definition(
    "researcher",
    "Researchers",
    "information",
    "information",
    "parallel-partitioned",
    "Investigate the stated question and report findings with sources.",
  ),
  documentation: definition(
    "documentation",
    "Documentation",
    "implementation",
    "code-candidate",
    "parallel-partitioned",
    "Update documentation within the permitted outputs.",
  ),
};

/**
 * A custom role's definition: the caller supplies its purpose, and the
 * requirements follow from that purpose alone.
 */
export function customRoleDefinition(input: {
  id: string;
  projectId: string;
  revision: number;
  title: string;
  instructions: string;
  purpose: Exclude<ExecutionPurpose, "coordinator-endorsement" | "direct-chat">;
}): RoleDefinition {
  const contract: Record<
    typeof input.purpose,
    RoleDefinition["outputContract"]
  > = {
    "coordinator-contribution": "coordinator-proposal",
    information: "information",
    implementation: "code-candidate",
    "candidate-review": "candidate-review",
  };
  return {
    ...input,
    requiredCapabilities: purposeRequirements(input.purpose),
    permittedOperations:
      input.purpose === "implementation"
        ? ["write-permitted-outputs"]
        : ["read-inputs"],
    outputContract: contract[input.purpose],
    defaultCollaboration:
      input.purpose === "implementation"
        ? "parallel-partitioned"
        : input.purpose === "coordinator-contribution"
          ? "peer-collaboration"
          : "parallel-independent",
  };
}
