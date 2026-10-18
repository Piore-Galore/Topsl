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
// passed. In bypassPermissions, it first asks the owner to accept that mode.
// A stand-in-question file there makes it ask, once the folder is trusted,
// whether to make auto mode the default permission mode, as Claude Code 2.1.300
// did in a live run. It first draws the input and the line below it, with
// spaces, then replaces them with the question, so that line stays in the raw
// output but leaves the screen. An answer is saved to stand-in-question-answer
// there, as Claude Code saves it in its settings.
//
// A workflow's Claude Code step. Topsl starts it with --session-id, which
// names its transcript, and it turns on bracketed paste, as Claude Code does,
// so pasted instructions arrive whole and show as "[Pasted text #1 +N lines]"
// until Enter sends them. Instructions that start "# Topsl task input" are a
// step: a build or repair applies the ten percent discount in src/order.mjs,
// as the Codex workflow stand-in does, and a review reads that file in its
// folder and replies with one JSON review naming the revision its
// instructions give. While it works, it shows "esc to interrupt" above its
// input. Its transcript has the record shapes Topsl recognizes
// (claude-code-session-v1): each part of a message is a record with the
// message's id, each tool call is followed by its result, and /exit is
// recorded as a local command. Around each prompt it also writes some of the
// bookkeeping records and attachments Claude Code 2.1.300 wrote in two live
// runs, by their type and field names. More files in CLAUDE_CONFIG_DIR
// change a step:
// - stand-in-permission: it first asks to run `npm run check`, in a
//   permission prompt with Yes selected. A No ends Claude's turn there, with
//   the declined call and an interruption in the transcript, as Claude Code
//   appears to do (inferred, not seen in a live run).
// - stand-in-plan: a review in Plan offers its plan for approval, as Claude
//   Code's ExitPlanMode does, with Yes selected. "No, keep planning" ends the
//   turn the same way.
// - stand-in-ask: Claude first asks a multiple-choice question, as Claude
//   Code's AskUserQuestion tool does.
// - stand-in-transcript: the transcript gets an attachment of a kind Topsl
//   does not recognize, a message typed while Claude works.
// - stand-in-finding: the review reports one finding on src/order.mjs.
// Each answer to these questions is saved to a file named after it with
// -answer, so a missing file shows the question went unanswered. An answer
// other than No lets the step go on, so a wrong answer shows in the result.
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
const config = process.env.CLAUDE_CONFIG_DIR;
const knob = (name) => fs.existsSync(path.join(config, name));
const save = (name, text) => fs.writeFileSync(path.join(config, name), text);
// A space drawn as a cursor move cannot wrap at the terminal's edge, so long
// lines are broken at its width, as Claude Code lays out its own.
const width = () => Math.max(20, (process.stdout.columns || 80) - 1);
const wrap = (text) => {
  let column = 0,
    result = "";
  for (let index = 0; index < text.length; index++) {
    const escape = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(
      text.slice(index, index + 16),
    );
    if (escape) {
      result += escape[0];
      index += escape[0].length - 1;
      continue;
    }
    if (text[index] === "\r" || text[index] === "\n") column = 0;
    else if (column++ >= width()) {
      result += "\r\n";
      column = 1;
    }
    result += text[index];
  }
  return result;
};
const out = (text) => process.stdout.write(wrap(text).replace(/ /g, "\x1b[C"));
const argument = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};
// Topsl names a step's session; anything else gets a new one, as Claude Code
// starts each session.
const sessionId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
  argument("--session-id") ?? "",
)
  ? argument("--session-id")
  : crypto.randomUUID();
const cwd = process.cwd();
const folder = path.join(config, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
fs.mkdirSync(folder, { recursive: true });
const transcript = path.join(folder, `${sessionId}.jsonl`);
let parentUuid = null;
/** Appends one record, with the fields Claude Code puts on each. */
const record = (fields) => {
  const uuid = crypto.randomUUID();
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      parentUuid,
      isSidechain: false,
      userType: "external",
      cwd,
      sessionId,
      version: "0.0.1",
      gitBranch: "",
      ...fields,
      uuid,
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  parentUuid = uuid;
};
/** A bookkeeping record, which carries no conversation. */
const bookkeeping = (fields) =>
  fs.appendFileSync(
    transcript,
    JSON.stringify({ ...fields, sessionId }) + "\n",
  );
/** Context attached to a turn, of the kind given. */
const attachment = (kind) =>
  record({ type: "attachment", attachment: { type: kind } });
const user = (content, extra = {}) =>
  record({ type: "user", message: { role: "user", content }, ...extra });
/** One message of Claude's: a record for each part, sharing its id. */
const assistant = (...parts) => {
  const id = `msg_${crypto.randomBytes(12).toString("hex")}`,
    requestId = `req_${crypto.randomBytes(12).toString("hex")}`;
  for (const part of parts)
    record({
      type: "assistant",
      requestId,
      message: {
        id,
        type: "message",
        role: "assistant",
        model: "stand-in",
        content: [part],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
};
const text = (value) => ({ type: "text", text: value });
const toolUse = (name, input) => ({
  type: "tool_use",
  id: `toolu_${crypto.randomBytes(12).toString("hex")}`,
  name,
  input,
});
const toolResult = (use, content, extra = {}) =>
  user([{ type: "tool_result", tool_use_id: use.id, content, ...extra }], {
    toolUseResult: extra.is_error ? `Error: ${content}` : { content },
  });

const modeAt = process.argv.indexOf("--permission-mode");
const modeFile = path.join(config, "stand-in-mode");
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
    bypassPermissions: "⏵⏵ bypass permissions on (shift+tab to cycle)",
  }[mode] ?? "? for shortcuts";
const prompt = () => out(`\r\n────────\r\n> \r\n────────\r\n  ${hint}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.resume();
// Bracketed paste, which Claude Code turns on too.
process.stdout.write("\x1b[?2004h");
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
let asking = knob("stand-in-question");
const question = () =>
  out(
    `\x1b[2J\x1b[HMake auto mode your default permission mode?\r\n\r\n Auto mode lets Claude handle permission prompts automatically.\r\n\r\n${choices
      .map((text, index) => ` ${index === choice ? "❯" : " "} ${text}\r\n`)
      .join("")}`,
  );

/**
 * A numbered choice drawn in place of the input, as Claude Code shows its
 * permission prompts and questions. `answer` gets the option picked with
 * Enter, or the one Esc picks.
 */
let menu = null;
const drawMenu = () =>
  out(
    `\x1b[2J\x1b[H${menu.above}\r\n${menu.options
      .map(
        (option, index) =>
          ` ${index === menu.selected ? "❯" : " "} ${index + 1}. ${option}\r\n`,
      )
      .join("")}\r\n ${menu.footer}\r\n`,
  );
const ask = (above, options, escape, footer) =>
  new Promise((resolve) => {
    menu = { above, options, selected: 0, escape, footer, resolve };
    drawMenu();
  });
// What the step's screen shows so far, above the input.
let shown = "";
const show = (line) => {
  shown += `${line}\r\n`;
};
const working = () => {
  out(`\x1b[2J\x1b[H${shown}\r\n✻ Working… (esc to interrupt)\r\n`);
  prompt();
};
const done = () => {
  out(`\x1b[2J\x1b[H${shown}`);
  prompt();
  busy = false;
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The turn ends at a declined call, as Claude Code's does. */
function declined(use, shownAs) {
  toolResult(use, "The user doesn't want to proceed with this tool use.", {
    is_error: true,
  });
  user([text("[Request interrupted by user for tool use]")]);
  show(`⏺ ${shownAs}`);
  show("  ⎿  No (tell Claude what to do differently)");
  done();
}

/** Plays one workflow step from the instructions Topsl copied. */
async function step(instructions) {
  const role = /^Role: (\w+)$/m.exec(instructions)?.[1] ?? "builder";
  working();
  await pause(600);
  if (knob("stand-in-ask")) {
    const use = toolUse("AskUserQuestion", {
      questions: [{ question: "Round the discounted total to whole cents?" }],
    });
    assistant(text("Before I change it, one question."), use);
    show("⏺ Before I change it, one question.");
    const options = ["Round to whole cents", "Keep fractions of a cent"];
    const picked = await ask(
      `${shown}\r\n ☐ Rounding\r\n\r\n Should the discounted total round to whole cents?\r\n`,
      [...options, "Type something."],
      null,
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    );
    save("stand-in-ask-answer", picked);
    toolResult(use, `The user answered: ${picked}`);
    working();
    await pause(300);
  }
  if (knob("stand-in-permission")) {
    const use = toolUse("Bash", {
      command: "npm run check",
      description: "Run the project's check",
    });
    assistant(text("I'll run the project's check first."), use);
    show("⏺ I'll run the project's check first.");
    const picked = await ask(
      `${shown}\r\n Bash command\r\n\r\n   npm run check\r\n   Run the project's check\r\n\r\n Do you want to proceed?\r\n`,
      [
        "Yes",
        `Yes, and don't ask again for npm run check commands in ${cwd}`,
        "No, and tell Claude what to do differently (esc)",
      ],
      2,
      "Esc to cancel",
    );
    save("stand-in-permission-answer", picked);
    if (picked.startsWith("No")) return declined(use, "Bash(npm run check)");
    toolResult(use, "The stand-in ran nothing.");
    show("⏺ Bash(npm run check)");
    working();
    await pause(300);
  }
  const order = path.join(cwd, "src", "order.mjs");
  if (role !== "reviewer") {
    const use = toolUse("Edit", { file_path: order });
    assistant(text("I'll apply the discount in src/order.mjs."), use);
    fs.writeFileSync(
      order,
      "import { totalCents } from './cart.mjs';\n// The approved order discount.\nexport function orderTotal(items) { return Math.round(totalCents(items) * 0.9); }\n",
    );
    toolResult(use, `The file ${order} has been updated.`);
    show("⏺ I'll apply the discount in src/order.mjs.");
    show("⏺ Update(src/order.mjs)");
    show("  ⎿  Updated src/order.mjs");
    await pause(600);
    if (knob("stand-in-transcript")) attachment("queued_command");
    const reply =
      "Applied the ten percent discount in src/order.mjs. No model was contacted.";
    assistant(text(reply));
    show(`⏺ ${reply}`);
    return done();
  }
  const read = toolUse("Read", { file_path: order });
  assistant(read);
  const source = fs.existsSync(order) ? fs.readFileSync(order, "utf8") : null;
  toolResult(read, source ?? "File does not exist.");
  show("⏺ Read(src/order.mjs)");
  working();
  await pause(600);
  const review = JSON.stringify({
    candidateRevision:
      /"candidateRevision":"([a-f0-9]{64})"/.exec(instructions)?.[1] ?? null,
    summary: source
      ? `Read src/order.mjs in the review's folder: ${source.trim().split("\n").pop()}`
      : "src/order.mjs is not in the review's folder.",
    findings: knob("stand-in-finding")
      ? [
          {
            title: "Discount rate is not named",
            severity: "low",
            file: "src/order.mjs",
            line: 3,
            behavior: "The rate is a bare number in orderTotal.",
            evidence: "Stand-in finding; no model was contacted.",
          },
        ]
      : [],
  });
  if (knob("stand-in-plan") && mode === "plan") {
    const use = toolUse("ExitPlanMode", { plan: review });
    assistant(use);
    const picked = await ask(
      `${shown}\r\n Ready to code?\r\n\r\n Here is Claude's plan:\r\n\r\n ${review}\r\n\r\n Would you like to proceed?\r\n`,
      [
        "Yes, and auto-accept edits",
        "Yes, and manually approve edits",
        "No, keep planning",
      ],
      2,
      "Esc to cancel",
    );
    save("stand-in-plan-answer", picked);
    if (picked.startsWith("No")) return declined(use, "Ready to code?");
    toolResult(use, "The user approved the plan.");
  }
  if (knob("stand-in-transcript")) attachment("queued_command");
  assistant(text(review));
  show(`⏺ ${review}`);
  done();
}

let trusted = false;
let accepting = mode === "bypassPermissions";
let line = "";
const pastes = [];
let interrupts = 0;
let busy = false;
let pasting = null;
const bypassAnswers = ["No, exit", "Yes, I accept"];
let bypassChoice = 0;
const bypassWarning = () =>
  out(
    `\x1b[2J\x1b[H WARNING: Claude Code running in Bypass Permissions mode\r\n\r\n In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.\r\n\r\n${bypassAnswers
      .map(
        (text, index) =>
          ` ${index === bypassChoice ? "❯" : " "} ${index + 1}. ${text}\r\n`,
      )
      .join("")}`,
  );
/** After trust, the bypass acceptance or the default mode question, if any, then the input. */
function ready() {
  if (accepting) return bypassWarning();
  if (asking) {
    process.stdout.write(`\r\n────────\r\n> \r\n────────\r\n  ${hint}\r\n`);
    return question();
  }
  prompt();
}
function submit() {
  let value = line.trim();
  pastes.forEach((pasted, index) => {
    value = value.replace(
      `[Pasted text #${index + 1} +${pasted.split("\n").length - 1} lines]`,
      pasted,
    );
  });
  line = "";
  pastes.length = 0;
  if (value === "/exit") {
    user(
      "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.",
      { isMeta: true },
    );
    user(
      "<command-name>/exit</command-name>\n            <command-message>exit</command-message>\n            <command-args></command-args>",
    );
    user("<local-command-stdout>Goodbye!</local-command-stdout>");
    process.exit(0);
  }
  bookkeeping({ type: "mode", mode: "normal" });
  bookkeeping({ type: "permission-mode", permissionMode: mode ?? "default" });
  attachment("date");
  attachment("skill_listing");
  user(value);
  bookkeeping({
    type: "last-prompt",
    lastPrompt: value.slice(0, 80),
    leafUuid: parentUuid,
  });
  const errorFile = path.join(config, "stand-in-api-error");
  const status = fs.existsSync(errorFile)
    ? fs.readFileSync(errorFile, "utf8").trim()
    : null;
  if (value.startsWith("# Topsl task input") && !status) {
    busy = true;
    shown = `> [Pasted text #1 +${value.split("\n").length - 1} lines]\r\n\r\n`;
    step(value).catch((error) => {
      show(`⏺ Stand-in error: ${error.message}`);
      done();
    });
    return;
  }
  const sum = (value.match(/\d+/g) ?? [])
    .map(Number)
    .reduce((a, b) => a + b, 0);
  setTimeout(() => {
    if (status)
      out(`\r\n⏺ Please run /login · API Error: ${status} stand-in\r\n`);
    else {
      out(`\r\n⏺ ${sum}\r\n`);
      assistant(text(String(sum)));
    }
    prompt();
  }, 1000);
}
function keys(input) {
  if (!trusted) {
    // The arrow keys move the selection; Enter confirms it.
    if (/\x1b[[O][AB]/.test(input)) {
      selected = 1 - selected;
      trustPrompt();
    } else if (input.includes("\r")) {
      if (answers[selected] === "No, exit") process.exit(1);
      trusted = true;
      ready();
    }
    return;
  }
  if (accepting) {
    if (/\x1b[[O][AB]/.test(input)) {
      bypassChoice = 1 - bypassChoice;
      bypassWarning();
    } else if (input.includes("\r")) {
      save("stand-in-bypass-answer", bypassAnswers[bypassChoice]);
      if (bypassChoice === 0) process.exit(1);
      accepting = false;
      out("\x1b[2J\x1b[H");
      ready();
    }
    return;
  }
  if (asking) {
    // Other keys are ignored while the question is shown.
    if (/\x1b[[O][AB]/.test(input)) {
      choice = 1 - choice;
      question();
    } else if (input.includes("\r")) {
      save("stand-in-question-answer", choices[choice]);
      asking = false;
      out("\x1b[2J\x1b[H");
      prompt();
    }
    return;
  }
  if (menu) {
    const count = menu.options.length;
    if (/\x1b[[O]A/.test(input))
      menu.selected = (menu.selected + count - 1) % count;
    else if (/\x1b[[O]B/.test(input))
      menu.selected = (menu.selected + 1) % count;
    else if (
      input.includes("\r") ||
      (input === "\x1b" && menu.escape !== null)
    ) {
      const { options, resolve } = menu,
        picked = options[input === "\x1b" ? menu.escape : menu.selected];
      menu = null;
      resolve(picked);
      return;
    } else return;
    drawMenu();
    return;
  }
  for (const character of input) {
    if (character === "\x03") {
      if (++interrupts >= 2) process.exit(0);
      out("\r\nPress Ctrl-C again to exit\r\n");
      continue;
    }
    interrupts = 0;
    // Claude Code keeps what is typed while Claude works; the stand-in drops it.
    if (busy) continue;
    if (character === "\r") submit();
    else if (character === "\x7f") line = line.slice(0, -1);
    else {
      line += character;
      out(character);
    }
  }
}
trustPrompt();
let pending = "";
process.stdin.on("data", (chunk) => {
  let input = pending + chunk.toString("utf8");
  pending = "";
  while (input) {
    if (pasting !== null) {
      // A paste ends at its closing bracket, which may come in a later chunk.
      pasting += input;
      const end = pasting.indexOf("\x1b[201~");
      if (end < 0) return;
      input = pasting.slice(end + 6);
      const pasted = pasting.slice(0, end).replace(/\r\n?/g, "\n");
      pasting = null;
      if (trusted && !accepting && !asking && !menu && !busy) {
        pastes.push(pasted);
        const placeholder = `[Pasted text #${pastes.length} +${pasted.split("\n").length - 1} lines]`;
        line += placeholder;
        out(placeholder);
      }
      continue;
    }
    const start = input.indexOf("\x1b[200~");
    if (start < 0) {
      // Keeps the start of a paste's opening bracket for the next chunk.
      const partial = ["\x1b[", "\x1b[2", "\x1b[20", "\x1b[200"].find((p) =>
        input.endsWith(p),
      );
      if (partial) {
        pending = partial;
        input = input.slice(0, -partial.length);
      }
      if (input) keys(input);
      return;
    }
    if (start > 0) keys(input.slice(0, start));
    pasting = "";
    input = input.slice(start + 6);
  }
});
