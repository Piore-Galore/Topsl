#!/bin/bash
# Double-click in Finder to start Topsl's debug session from the build already
# in dist/, without compiling (`npm run debug:run`). It opens Terminal, shows
# the inspector ports and the control service's and proxy's output, and uses
# your normal Topsl profile, like `npm start`. Extra arguments are passed on,
# for example: ./"Debug Topsl.command" --temp-profile
# To rebuild first (with source maps), run `npm run debug` instead.
cd "$(dirname "$0")" || exit 1
# Finder starts this without your shell's PATH additions; add the usual
# Homebrew and Node locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install Node.js 22.12 or later, then try again."
  read -r -n 1 -s -p "Press any key to close."
  exit 1
fi
npm run debug:run -- "$@"
status=$?
echo
echo "Topsl's debug session ended (exit $status)."
read -r -n 1 -s -p "Press any key to close."
echo
exit "$status"
