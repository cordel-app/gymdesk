#!/usr/bin/env bash
# #2125 M6b — operator step on the corback VPS (dev): settle existing plan assignments, then validate.
#
# Runs the COMPILED scripts inside the running API container (it already holds the DB environment):
#   1. dry run   -> how many Product Sets would be re-synced
#   2. --execute -> asks for confirmation first (skip with --yes)
#   3. dry run   -> must report 0
#   4. validate  -> must be clean (exit 0)
#
# Usage:  ./settle-plan-assignments-vps.sh [--yes] [gymId]
#   CONTAINER=fitness-api   override the container name if it differs on this host.
set -euo pipefail

CONTAINER="${CONTAINER:-fitness-api}"
YES=0
GYM=""
for a in "$@"; do
  case "$a" in
    --yes) YES=1 ;;
    -*) echo "unknown option: $a" >&2; exit 2 ;;
    *) GYM="$a" ;;
  esac
done

run() { podman exec "$CONTAINER" node "dist/scripts/$1.js" "${@:2}"; }

podman container exists "$CONTAINER" || { echo "Container '$CONTAINER' not found on this host (run this on corback, dev)." >&2; exit 2; }

echo "== 1/4 dry run (writes nothing) =="
run settle-plan-assignments ${GYM:+"$GYM"} | tee /tmp/settle-dry-1.txt

if grep -q "hold a plan snapshot behind its assignment" /tmp/settle-dry-1.txt \
   && grep -qE "Dry run: 0 Product" /tmp/settle-dry-1.txt; then
  echo "Nothing to settle."
else
  if [ "$YES" -ne 1 ]; then
    read -r -p "Settle the Product Sets above on THIS database? [y/N] " ans
    [ "$ans" = "y" ] || [ "$ans" = "Y" ] || { echo "Aborted, nothing written."; exit 1; }
  fi
  echo "== 2/4 settle (--execute) =="
  run settle-plan-assignments ${GYM:+"$GYM"} --execute
fi

echo "== 3/4 dry run again (must report 0) =="
run settle-plan-assignments ${GYM:+"$GYM"} | tee /tmp/settle-dry-2.txt
grep -qE "Dry run: 0 Product" /tmp/settle-dry-2.txt || { echo "STILL NOT ZERO — do not confirm on the issue; paste the output there." >&2; exit 1; }

echo "== 4/4 validate (read-only drift check) =="
run validate-plan-assignments ${GYM:+"$GYM"}
echo
echo "Done: dry run reports 0 and validate is clean. Confirm both on issue #2125."
