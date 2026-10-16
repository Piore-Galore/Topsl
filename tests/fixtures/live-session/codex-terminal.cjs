#!/usr/bin/env node
// Stand-in for the parts of Codex's own terminal interface that
// scripts/live-session.mjs drives with --terminal, so the procedure can be
// checked without a model or an account. It shows the arguments it was started
// with and waits for startup, then answers the sum in a prompt and quits on
// Ctrl+C twice. If CODEX_HOME has a stand-in-question file naming trust,
// update, model or sign-in, it shows that startup question instead and waits.
// (Topsl passes only a few environment variables to the native terminal,
// CODEX_HOME among them.)
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.0.1 (stand-in)");
  process.exit(0);
}
const total = (text) =>
  (text.match(/\d+/g) ?? []).map(Number).reduce((a, b) => a + b, 0);
const questionFile =
  process.env.CODEX_HOME &&
  path.join(process.env.CODEX_HOME, "stand-in-question");
const questions = {
  trust: [
    "Trust this folder? Codex can read, edit, and run files here.",
    "› 1. Trust and continue",
    "  2. Open restricted",
  ],
  update: [
    "Update available! 0.0.1 -> 0.0.2",
    "› 1. Update now (runs `npm install -g @openai/codex`)",
    "  2. Skip",
    "  3. Skip until next version",
    "",
    "  Press Enter to continue.",
  ],
  model: [
    "Codex just got an upgrade. Introducing stand-in-model-2.",
    "› 1. Try new model",
    "  2. Use existing model",
  ],
  "sign-in": [
    "Welcome to Codex",
    "› 1. Sign in with ChatGPT",
    "  2. Provide your own API key",
  ],
};
const question =
  questions[
    questionFile && fs.existsSync(questionFile)
      ? fs.readFileSync(questionFile, "utf8").trim()
      : ""
  ];
const args = process.argv.slice(2);
const history = [];
let ready = false,
  line = "",
  interrupts = 0;
/** Redraws the screen: the header, then the question or the conversation. */
function draw() {
  const composer =
    line || (ready ? "Ask Codex to do anything" : "Waiting for startup");
  const footer = interrupts
    ? "  ctrl + c again to quit"
    : ready
      ? "  ? for shortcuts · 100% context left"
      : "";
  process.stdout.write(
    [
      "\x1b[2J\x1b[H>_ OpenAI Codex (stand-in)",
      `Started with: ${args.length ? args.join(" ") : "no arguments"}`,
      "",
      ...(question ?? [...history, "", `› ${composer}`, "", footer]),
    ].join("\r\n"),
  );
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
draw();
// A startup question waits until the session is closed.
if (!question)
  setTimeout(() => {
    ready = true;
    draw();
  }, 500);
process.stdin.on("data", (chunk) => {
  if (question || !ready) return;
  for (const character of chunk.toString("utf8")) {
    if (character === "\x03") {
      if (++interrupts >= 2) {
        process.stdout.write("\r\nToken usage: total=22 input=20 output=2\r\n");
        process.exit(0);
      }
    } else if (character === "\r") {
      const text = line.trim();
      interrupts = 0;
      line = "";
      history.push(`› ${text}`);
      setTimeout(() => {
        history.push(`• ${total(text)}`);
        draw();
      }, 1000);
    } else {
      interrupts = 0;
      line = character === "\x7f" ? line.slice(0, -1) : line + character;
    }
    draw();
  }
});
