// Reads the sandbox probe commands of Topsl's runtime qualification
// (`probeCommand` in packages/providers/qualification.ts) back into what they
// ask for. The qualification stand-in runs them in its pretend sandbox, and
// the tests use it to find a probe's target on any platform.
/** A single-quoted PowerShell literal's value. */
const unquote = (literal) => literal.slice(1, -1).replace(/(['\u2018\u2019\u201a\u201b])\1/g, "$1");
const literal = "('(?:[^'\u2018\u2019\u201a\u201b]|['\u2018\u2019\u201a\u201b]{2})*')";
const powershellPrint = new RegExp(
  `^\\$ErrorActionPreference = 'Stop'; try \\{ \\[Console\\]::Out\\.Write\\(${literal}\\) \\} catch \\{ \\[Console\\]::Error\\.Write\\(\\$_\\.Exception\\.Message\\); exit 1 \\}$`,
);
const powershellWrite = new RegExp(
  `^\\$ErrorActionPreference = 'Stop'; try \\{ \\[IO\\.File\\]::WriteAllText\\(${literal}, ${literal}\\) \\} catch \\{ \\[Console\\]::Error\\.Write\\(\\$_\\.Exception\\.Message\\); exit 1 \\}$`,
);
/** The probe a command asks for: `{ word }` to print, `{ word, file }` to
 * write, or null. Topsl sends the POSIX shell form on macOS and Linux and an
 * encoded Windows PowerShell command on Windows; both are known on every
 * platform. */
function probe(argv) {
  if (!Array.isArray(argv)) return null;
  const [shell, flag, script, , word, file] = argv;
  if (shell === "/bin/sh" && flag === "-c") {
    if (script === 'printf %s "$1"' && argv.length === 5) return { word };
    if (script === 'printf %s "$1" > "$2"' && typeof file === "string")
      return { word, file };
    return null;
  }
  const [executable, ...flags] = argv;
  if (
    !/[\\/]powershell\.exe$/i.test(String(executable)) ||
    flags.slice(0, 4).join(" ") !== "-NoLogo -NoProfile -NonInteractive -EncodedCommand" ||
    flags.length !== 5
  )
    return null;
  const decoded = Buffer.from(flags[4], "base64").toString("utf16le");
  const printed = powershellPrint.exec(decoded);
  if (printed) return { word: unquote(printed[1]) };
  const written = powershellWrite.exec(decoded);
  return written
    ? { file: unquote(written[1]), word: unquote(written[2]) }
    : null;
}
module.exports = { probe };
