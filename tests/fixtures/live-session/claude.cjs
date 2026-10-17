#!/usr/bin/env node
// Stand-in for the parts of Claude Code's terminal that scripts/live-session.mjs
// drives, so the procedure can be checked without a model or an account. It
// asks for folder trust as Claude Code 2.1.300 does, with "No, exit" selected
// first, answers the sum in a prompt, and records the exchange in a Claude Code
// style transcript. It moves the cursor over blank cells instead of writing
// spaces, so, as with Claude Code's prompts, its words run together in the raw
// output and read correctly only on the rendered screen.
// If CLAUDE_CONFIG_DIR has a stand-in-api-error file, it shows an API error
// with the status in that file instead of the answer. (Topsl passes only a few
// environment variables to the native terminal, CLAUDE_CONFIG_DIR among them.)
// Started with --permission-mode, it shows that mode below the input in place
// of the shortcuts hint, as Claude Code does; a stand-in-mode file there names
// another mode to show, as if Claude Code's settings had overridden the one
// passed.
// A stand-in-question file there makes it ask, once the folder is trusted,
// whether to make auto mode the default permission mode, as Claude Code 2.1.300
// did in a live run. It first draws the input and the line below it, with
// spaces, then replaces them with the question, so that line stays in the raw
// output but leaves the screen. An answer is saved to stand-in-question-answer
// there, as Claude Code saves it in its settings.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
if (process.argv.includes("--version")) {
  console.log("0.0.1 (Claude Code stand-in)");
  process.exit(0);
}
if (!process.env.CLAUDE_CONFIG_DIR) {
  console.error(
    "Set CLAUDE_CONFIG_DIR to a temporary folder; this stand-in never writes into a real Claude Code profile.",
  );
  process.exit(2);
}
const out = (text) => process.stdout.write(text.replace(/ /g, "\x1b[C"));
const sessionId = crypto.randomUUID();
const cwd = process.cwd();
const folder = path.join(
  process.env.CLAUDE_CONFIG_DIR,
  "projects",
  cwd.replace(/[^a-zA-Z0-9]/g, "-"),
);
fs.mkdirSync(folder, { recursive: true });
const transcript = path.join(folder, `${sessionId}.jsonl`);
const record = (role, text) =>
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: role,
      message: {
        role,
        content: role === "user" ? text : [{ type: "text", text }],
      },
      uuid: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId,
      cwd,
    }) + "\n",
  );
const modeAt = process.argv.indexOf("--permission-mode");
const modeFile = path.join(process.env.CLAUDE_CONFIG_DIR, "stand-in-mode");
const mode = fs.existsSync(modeFile)
  ? fs.readFileSync(modeFile, "utf8").trim()
  : modeAt >= 0
    ? process.argv[modeAt + 1]
    : null;
const hint =
  {
    plan: "⏸ plan mode on (shift+tab to cycle)",
    acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle)",
    auto: "⏵⏵ auto mode on (shift+tab to cycle)",
  }[mode] ?? "? for shortcuts";
const prompt = () => out(`\r\n────────\r\n> \r\n────────\r\n  ${hint}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.resume();
const answers = ["No, exit", "Yes, I trust this folder"];
let selected = 0;
const trustPrompt = () =>
  out(
    `\x1b[2J\x1b[HClaude Code stand-in\r\n\r\n Accessing workspace:\r\n\r\n ${cwd}\r\n\r\n Quick safety check: Is this a project you created or one you trust?\r\n\r\n${answers
      .map(
        (answer, index) => ` ${index === selected ? "❯" : " "} ${answer}\r\n`,
      )
      .join("")}\r\n Enter to confirm · Esc to cancel\r\n`,
  );
const choices = [
  "Yes, set auto mode as my default permission mode",
  "No, keep my current default",
];
let choice = 0;
let asking = fs.existsSync(
  path.join(process.env.CLAUDE_CONFIG_DIR, "stand-in-question"),
);
const question = () =>
  out(
    `\x1b[2J\x1b[HMake auto mode your default permission mode?\r\n\r\n Auto mode lets Claude handle permission prompts automatically.\r\n\r\n${choices
      .map((text, index) => ` ${index === choice ? "❯" : " "} ${text}\r\n`)
      .join("")}`,
  );
let trusted = false;
let line = "";
let interrupts = 0;
trustPrompt();
process.stdin.on("data", (chunk) => {
  const input = chunk.toString("utf8");
  if (!trusted) {
    // The arrow keys move the selection; Enter confirms it.
    if (/\x1b[[O][AB]/.test(input)) {
      selected = 1 - selected;
      trustPrompt();
    } else if (input.includes("\r")) {
      if (answers[selected] === "No, exit") process.exit(1);
      trusted = true;
      if (asking) {
        process.stdout.write(`\r\n────────\r\n> \r\n────────\r\n  ${hint}\r\n`);
        question();
      } else prompt();
    }
    return;
  }
  if (asking) {
    // Other keys are ignored while the question is shown.
    if (/\x1b[[O][AB]/.test(input)) {
      choice = 1 - choice;
      question();
    } else if (input.includes("\r")) {
      fs.writeFileSync(
        path.join(process.env.CLAUDE_CONFIG_DIR, "stand-in-question-answer"),
        choices[choice],
      );
      asking = false;
      out("\x1b[2J\x1b[H");
      prompt();
    }
    return;
  }
  for (const character of input) {
    if (character === "\x03") {
      if (++interrupts >= 2) process.exit(0);
      out("\r\nPress Ctrl-C again to exit\r\n");
      continue;
    }
    interrupts = 0;
    if (character === "\r") {
      const text = line.trim();
      line = "";
      if (text === "/exit") process.exit(0);
      record("user", text);
      const sum = (text.match(/\d+/g) ?? [])
        .map(Number)
        .reduce((a, b) => a + b, 0);
      const errorFile = path.join(
        process.env.CLAUDE_CONFIG_DIR,
        "stand-in-api-error",
      );
      const status = fs.existsSync(errorFile)
        ? fs.readFileSync(errorFile, "utf8").trim()
        : null;
      setTimeout(() => {
        if (status)
          out(`\r\n⏺ Please run /login · API Error: ${status} stand-in\r\n`);
        else {
          out(`\r\n⏺ ${sum}\r\n`);
          record("assistant", String(sum));
        }
        prompt();
      }, 1000);
    } else if (character === "\x7f") line = line.slice(0, -1);
    else {
      line += character;
      out(character);
    }
  }
});
