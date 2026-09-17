#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in seats.json|schedule.json) ;; *) echo 'Unsupported state file'; exit 1;; esac
if [ ! -f "$1" ]; then exit 0; fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -- "$1"
if git diff --cached --quiet; then exit 0; fi
git commit -m "Update acknowledged $1 state"
# Each workflow owns a different file; rebase preserves the other workflow's commit.
for attempt in 1 2 3 4 5; do
  git pull --rebase origin state
  if git push origin HEAD:state; then exit 0; fi
done
echo 'State push failed; next run will retry the unacknowledged change'
exit 1
