// The coordinator stand-ins' replies: each execution purpose's contract
// answered from the prompt alone. An implementation turn writes its permitted
// outputs into `cwd`. No model is contacted, and nothing here is evidence for
// any live model or route.
const fs = require("node:fs");
const path = require("node:path");
const match = (prompt, pattern) => pattern.exec(prompt)?.[1] ?? "";

/**
 * recursive-loop-v1 turns: a loop turn's read-only copy is its target (the
 * accepted checkpoint, or the candidate under evaluation), so the stand-in
 * judges "the value is two" from the actual bytes in `cwd`.
 */
function loopAnswer(prompt, cwd) {
  const skeleton =
    /"inputDigest": "([^"]+)", "expected": (\{.*?\}), "idempotencyKey": "([^"]+)"/.exec(
      prompt,
    );
  const stage = match(prompt, /Stage: (\w+)\./);
  const endless = /in an Endless loop run/.test(prompt);
  let file = "";
  try {
    file = fs.readFileSync(path.join(cwd, "file.ts"), "utf8");
  } catch {}
  const done = /value = 2/.test(file);
  const goals = [];
  const lines = prompt.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const g = /^- (\S+) v(\d+) \[/.exec(lines[i]);
    if (!g) continue;
    const criteria = [];
    for (let j = i + 1; j < lines.length && lines[j].startsWith("  - "); j++) {
      const c = /^ {2}- criterion (\S+) \(/.exec(lines[j]);
      if (c) criteria.push(c[1]);
    }
    goals.push({ id: g[1], version: Number(g[2]), criteria });
  }
  const assess = {
    kind: "assess_goals",
    assessments: goals.map((g) => ({
      goalId: g.id,
      goalVersion: g.version,
      result: done && g.criteria.length ? "satisfied" : "unmet",
      criteria: g.criteria.map((c) => ({
        criterionId: c,
        result: done ? "met" : "unmet",
        evidenceIds: [],
        citedPaths: done ? ["file.ts"] : [],
        note: done
          ? "file.ts sets the value to two."
          : "file.ts does not set the value to two yet.",
      })),
      proposedCriteria: g.criteria.length
        ? []
        : [
            {
              text: "file.ts sets the value to two",
              verification: "inspection",
              checkId: null,
            },
          ],
      blocker: null,
      conflictsWith: [],
    })),
  };
  const wait = (reason) => ({
    kind: "request_wait",
    condition: "no-opportunity",
    reason,
    question: null,
    goalIds: [],
    retryAfterSeconds: null,
  });
  let decisions;
  // Organization: the stand-in moves coordination to Astra once, through the
  // ordinary validated team-change path, then keeps that organization.
  const coordinatorLine = lines.find((l) => /^- coordinator \(/.test(l)) ?? "";
  if (stage === "organize")
    decisions =
      /fixture-astra/.test(coordinatorLine) || !/fixture-astra/.test(prompt)
        ? [wait("Keep the current organization.")]
        : [
            {
              kind: "reconfigure_team",
              operations: [
                {
                  op: "set_members",
                  roleId: "coordinator",
                  count: 1,
                  models: ["fixture-astra"],
                  effort: null,
                },
              ],
              reason: "One Astra coordinator is enough for a one-file change.",
              expectedBenefit: "Fewer coordination turns.",
              evidenceIds: [],
              trigger: "none",
            },
          ];
  else if (stage === "boundary" && endless)
    decisions = done
      ? [wait("Nothing worthwhile to improve: the value is already two.")]
      : [
          {
            kind: "propose_opportunity",
            opportunities: [
              {
                title: "Set the value to two",
                observedIssue: "file.ts sets the value to one.",
                area: "file.ts",
                expectedBenefit: "The value is two.",
                baselineEvidence: [],
                acceptanceConditions: ["file.ts sets the value to two"],
                estimatedScope: "small",
                dependencies: [],
                whyNow: "It is the only open improvement.",
                approach: "Change the constant in file.ts.",
                scores: {
                  benefit: 0.9,
                  confidence: 0.9,
                  urgency: 0.6,
                  effort: 0.1,
                  regressionRisk: 0.1,
                },
              },
            ],
          },
        ];
  else decisions = [assess];
  return JSON.stringify({
    schemaVersion: 1,
    protocolKind: "recursive-loop-v1",
    stage,
    inputDigest: skeleton[1],
    expected: JSON.parse(skeleton[2]),
    idempotencyKey: skeleton[3],
    decisions,
  });
}

/**
 * session-v1 turns (docs/Native_Sessions_Plan.md). The stand-in treats a
 * message as discussion when the owner chose Discuss or the message is a
 * question, and otherwise as new work; with the composer aimed at a running
 * goal, as steering. The shared wording turn repeats the decision.
 */
function sessionAnswer(prompt) {
  const inputDigest = match(prompt, /Input digest \(echo it exactly\): (\S+)/);
  const base = { schemaVersion: 1, protocolKind: "session-v1", inputDigest };
  if (/Prepare the shared response/.test(prompt))
    return JSON.stringify({
      ...base,
      reply: `The coordinators agree: ${match(prompt, /Recorded decision: (.+)/)}`,
    });
  const message = match(prompt, /The owner's message:\n([\s\S]*?)\n\n/);
  const discuss =
    /The owner chose Discuss/.test(prompt) ||
    (!/The owner chose Work/.test(prompt) && /\?\s*$/.test(message.trim()));
  const steer = /Composer target: the current goal/.test(prompt);
  const intent = discuss ? "discuss" : steer ? "steer" : "new-work";
  return JSON.stringify({
    ...base,
    intent,
    reply: discuss
      ? "file.ts holds one exported value; changing it is a one-line edit."
      : steer
        ? "I will pass that to the running goal."
        : "I will queue this as a goal for the implementer.",
    question: null,
    team: null,
  });
}

function answer(prompt, cwd = process.cwd()) {
  if (/"protocolKind": "session-v1"/.test(prompt)) return sessionAnswer(prompt);
  if (
    /"protocolKind": "recursive-loop-v1"/.test(prompt) &&
    /Stage: \w+\./.test(prompt)
  )
    return loopAnswer(prompt, cwd);
  const snapshot = match(prompt, /Snapshot digest \(echo it exactly\): (\S+)/);
  if (snapshot) {
    const roster =
      /- implementer: implementation, (\d+) member\(s\), (\S+)/.exec(prompt);
    const members = roster ? Number(roster[1]) : 1;
    const partitioned = roster?.[2] === "parallel-partitioned" && members > 1;
    return JSON.stringify({
      snapshotDigest: snapshot,
      summary: "Change the value in file.ts.",
      assumptions: [],
      actions: [
        {
          key: "build",
          title: "Change the value",
          kind: "implementation",
          roleId: "implementer",
          dependencies: [],
          permittedOutputs: ["file.ts"],
          acceptanceCriteria: ["The value is two."],
          brief: "Set value to 2 in file.ts.",
          partitions: partitioned
            ? Array.from({ length: members }, (_, i) => ({
                title: `Part ${i + 1}`,
                permittedOutputs: [i === 0 ? "file.ts" : `part-${i + 1}.ts`],
              }))
            : [],
        },
      ],
      concerns: [],
    });
  }
  const candidateDigest = match(
    prompt,
    /Candidate digest \(echo it exactly\): (\S+)/,
  );
  if (candidateDigest)
    return JSON.stringify({
      candidateDigest,
      stance: "endorse",
      rationale: "Fixture agrees.",
    });
  const revision = match(
    prompt,
    /Candidate revision \(echo it exactly\): (\S+)/,
  );
  if (revision)
    return JSON.stringify({
      candidateRevision: revision,
      summary: "Fixture review: no findings.",
      findings: [],
    });
  const inputDigest = match(prompt, /"inputDigest": "([^"]+)"/);
  if (/When done, reply/.test(prompt)) {
    const outputs =
      match(prompt, /Change only: ([^\n]+)\./) ||
      match(prompt, /Permitted outputs: ([^\n]+)\./);
    // A goal marked "[distinct versions]" makes each member write its own
    // version of file.ts, so two members conflict on it.
    const member = /\[distinct versions\]/.test(prompt)
      ? match(prompt, /You are member (\S+)\./)
      : "";
    for (const file of outputs.split(", ").filter(Boolean))
      fs.writeFileSync(
        path.join(cwd, file),
        file === "file.ts"
          ? `export const value = 2;${member ? ` // by ${member}` : ""}\n`
          : `export const ${file.replace(/\W/g, "_")} = true;\n`,
      );
    return JSON.stringify({
      inputDigest,
      summary: `Fixture changed ${outputs}.`,
    });
  }
  return JSON.stringify({
    inputDigest,
    summary: "Fixture report.",
    report: "Fixture findings; no model was contacted.",
    limitations: ["fixture"],
  });
}

module.exports = { answer };
