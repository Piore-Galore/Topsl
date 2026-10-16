#!/usr/bin/env node
// Stand-in for `scripts/live-session.mjs --qualify`: the runtime qualification
// suite's scripted app-server, which answers each probe as a Codex runtime
// with a working sandbox would. No model or account is contacted.
require("../codex-qualify.cjs");
