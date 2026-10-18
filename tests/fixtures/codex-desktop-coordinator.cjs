// Stand-in for Codex in the desktop coordinator journey: the runtime
// qualification suite's scripted app-server (codex-qualify.cjs), so the
// journey can register, connect and qualify it as the desktop test does, and
// which then answers the coordinator purposes' turns as the service tests'
// stand-in does (orchestration-answers.cjs). Its catalog lists the fixture
// qualification model and four fixture labels. No model or account is
// contacted; the labels are fixture catalog entries, not evidence for any
// model.
const fixture = require("./codex-qualify.cjs");
const { answer } = require("./orchestration-answers.cjs");

fixture.models = [
  ["fixture-model", "Fixture"],
  ["fixture-opus", "Opus"],
  ["fixture-astra", "Astra"],
  ["fixture-fable", "Fable"],
  ["fixture-sol", "Sol"],
].map(([model, displayName], index) => ({
  id: model,
  model,
  displayName,
  isDefault: index === 0,
}));
// A turn answers after FIXTURE_TURN_DELAY_MS, so the journey can watch a
// round in progress and pause it; a pause interrupts the pending answer.
const pending = new Map();
fixture.otherTurn = ({ threadId, turnId, prompt, cwd }) =>
  pending.set(
    turnId,
    setTimeout(
      () => {
        pending.delete(turnId);
        fixture.complete(threadId, turnId, answer(prompt, cwd));
      },
      Number(process.env.FIXTURE_TURN_DELAY_MS ?? 20),
    ),
  );
fixture.interrupt = ({ threadId, turnId }) => {
  if (!pending.has(turnId)) return false;
  clearTimeout(pending.get(turnId));
  pending.delete(turnId);
  setImmediate(() => fixture.complete(threadId, turnId, null, "interrupted"));
  return true;
};
