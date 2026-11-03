// Stand-in for Codex in the campaign soak and recovery journeys
// (scripts/campaign-soak.mjs, scripts/campaign-recovery-desktop.mjs): the
// desktop coordinator stand-in (codex-desktop-coordinator.cjs), whose
// session turns answer after FIXTURE_TURN_DELAY_MS, plus a streamed reply.
// A turn whose prompt names "Soak stream N" streams its reply in
// FIXTURE_STREAM_PARTS deltas, FIXTURE_STREAM_DELTA_MS apart, beginning
// "Streamed soak answer N:" and ending "End of soak answer N.", then
// completes it. An interrupt ends such a turn as interrupted.
//
// Fault modes for the recovery journeys (none by default):
// FIXTURE_FAULT=malformed-stream writes a line that is not JSON in the middle
// of a streamed reply, then carries on and completes the turn.
// FIXTURE_FAULT=malformed-exit writes a line that is not JSON in the middle of
// a streamed reply and exits, as a crashed runtime would.
// FIXTURE_FAULT=wrong-shape answers a streamed turn's deltas with frames that
// are JSON but lack the fields Codex sends, then completes the turn.
// FIXTURE_FAULT=stall streams the first part of a streamed reply, then
// writes nothing more and never completes the turn; it acknowledges an
// interrupt but still never completes the turn, as a hung runtime would.
// FIXTURE_PID_FILE appends this process's PID, so a journey can find it.
// No model or account is contacted.
const fs = require("node:fs");
const fixture = require("./codex-qualify.cjs");
require("./codex-desktop-coordinator.cjs");

if (process.env.FIXTURE_PID_FILE)
  fs.appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`);
const coordinatorTurn = fixture.otherTurn;
const coordinatorInterrupt = fixture.interrupt;
const streams = new Map();
const stalled = new Set();
const parts = Number(process.env.FIXTURE_STREAM_PARTS ?? 40);
const gap = Number(process.env.FIXTURE_STREAM_DELTA_MS ?? 75);
const fault = process.env.FIXTURE_FAULT ?? "";

fixture.otherTurn = (turn) => {
  const n = /Soak stream (\d+)/.exec(turn.prompt)?.[1];
  if (!n) return coordinatorTurn(turn);
  const { threadId, turnId } = turn;
  const itemId = `${turnId}-msg`;
  const chunks = [`Streamed soak answer ${n}: `];
  for (let i = 1; i < parts - 1; i++) chunks.push(`chunk ${i} `);
  chunks.push(`End of soak answer ${n}.`);
  let index = 0;
  const step = () => {
    if (!streams.has(turnId)) return;
    if (index === 1 && fault === "stall") {
      stalled.add(turnId);
      return;
    }
    if (index === Math.floor(parts / 2) && fault.startsWith("malformed")) {
      process.stdout.write("{not json: the stand-in's malformed frame\n");
      if (fault === "malformed-exit") process.exit(3);
    }
    if (index < chunks.length) {
      fixture.send(
        fault === "wrong-shape" && index > 0
          ? { method: "item/agentMessage/delta", params: { delta: 7 } }
          : {
              method: "item/agentMessage/delta",
              params: { threadId, turnId, itemId, delta: chunks[index] },
            },
      );
      index++;
      streams.set(turnId, setTimeout(step, gap));
      return;
    }
    streams.delete(turnId);
    fixture.complete(threadId, turnId, chunks.join(""));
  };
  streams.set(turnId, setTimeout(step, gap));
};
fixture.interrupt = (params) => {
  if (stalled.has(params.turnId)) return true;
  if (!streams.has(params.turnId)) return coordinatorInterrupt(params);
  clearTimeout(streams.get(params.turnId));
  streams.delete(params.turnId);
  setImmediate(() =>
    fixture.complete(params.threadId, params.turnId, null, "interrupted"),
  );
  return true;
};
