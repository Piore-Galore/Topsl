// Synthetic project protocol only. This fixture is never used by a production service.
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.158.0-fixture");
  process.exit(0);
}
const home = process.env.CODEX_HOME;
if (!home || !home.includes("topsl-test-"))
  throw new Error("Expected an isolated test profile.");
const file = path.join(home, "topsl-project-fixture.json");
let data = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { projects: [], keys: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(data));
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
require("node:readline")
  .createInterface({ input: process.stdin })
  .on("line", (line) => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    fs.appendFileSync(
      path.join(home, "topsl-project-requests.jsonl"),
      JSON.stringify({ method, params }) + "\n",
    );
    try {
      let result;
      if (method === "initialize")
        result = { userAgent: "topsl-project-fixture/1.0" };
      else if (method === "project/list")
        result = { data: data.projects, nextCursor: null };
      else if (method === "project/read")
        result = {
          project: data.projects.find((p) => p.id === params.projectId),
        };
      else if (method === "project/create") {
        let project = data.projects.find(
          (p) => p.id === data.keys[params.idempotencyKey],
        );
        if (!project) {
          project = {
            id: require("node:crypto").randomUUID(),
            name: params.name,
            roots: params.roots,
            position: data.projects.length,
            metadata: {},
            createdAt: 1,
            updatedAt: 1,
          };
          data.projects.push(project);
          data.keys[params.idempotencyKey] = project.id;
        }
        result = { project };
        save();
      } else if (method === "project/update") {
        const project = data.projects.find((p) => p.id === params.projectId);
        if (!project) throw new Error("Missing fixture project");
        project.name = params.name;
        result = { project };
        save();
      } else if (method === "project/move") {
        const index = data.projects.findIndex((p) => p.id === params.projectId);
        if (index < 0) throw new Error("Missing fixture project");
        const [project] = data.projects.splice(index, 1);
        const before =
          params.beforeProjectId === null
            ? data.projects.length
            : data.projects.findIndex((p) => p.id === params.beforeProjectId);
        data.projects.splice(before, 0, project);
        data.projects.forEach((p, i) => (p.position = i));
        save();
        result = {};
      } else throw new Error("Unsupported fixture method");
      send({ id, result });
    } catch (error) {
      send({ id, error: { code: -32601, message: error.message } });
    }
  });
