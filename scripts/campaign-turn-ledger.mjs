// The campaign turn budget's ledger (docs/testing/2026-11-04-comprehensive/
// PLAN.md, "Live budget"): one JSON line per counted turn, written under a
// lock directory so that every proxy and the live harness count against the
// same cap. scripts/campaign-turn-proxy.mjs counts the turns it sees; the live
// harness counts the follow-up prompts it types into a Claude Code session,
// which no proxy can see. Nothing here is shipped.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
} from "node:fs";

/** The ledger's cap: `<ledger>.cap` when present, else `fallback`. */
export function capOf(ledger, fallback) {
  const file = `${ledger}.cap`;
  const value = existsSync(file)
    ? Number(readFileSync(file, "utf8").trim())
    : Number(fallback);
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Counts one turn under the ledger's lock. Returns its number, or null when
 * the cap is reached, in which case the refusal goes to `<ledger>.refused`.
 */
export function reserve(ledger, cap, provider, entry) {
  const lock = `${ledger}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (tries > 1000) throw new Error("campaign ledger lock is stuck");
      sleep(10);
    }
  }
  try {
    const counted = existsSync(ledger)
      ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).length
      : 0;
    const allowed = counted < cap;
    appendFileSync(
      allowed ? ledger : `${ledger}.refused`,
      JSON.stringify({
        at: new Date().toISOString(),
        provider,
        pid: process.pid,
        number: allowed ? counted + 1 : null,
        cap,
        ...entry,
      }) + "\n",
    );
    return allowed ? counted + 1 : null;
  } finally {
    rmdirSync(lock);
  }
}
