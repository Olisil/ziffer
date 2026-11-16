#!/usr/bin/env bash
# Runs one deploy step and, if it fails, puts the end of its output on the run's summary page.
# Usage: cloudflare/step.sh "Name of the step" command [args...]
name="$1"; shift
log="$(mktemp)"
if "$@" > >(tee "$log") 2>&1; then exit 0; fi
tail="$(sed 's/\x1b\[[0-9;]*m//g' "$log" | grep -v '^[[:space:]]*$' | tail -n 14 | tr '\n' '|' | cut -c1-900)"
echo "::error title=${name}::${tail}"
exit 1
