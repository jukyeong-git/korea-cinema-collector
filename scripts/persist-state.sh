#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in schedule.json|seats-0[1-7].json) ;; *) echo 'Unsupported state file'; exit 1;; esac
state_branch="state-${1%.json}"
if [ ! -f "$1" ]; then exit 0; fi
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -- "$1"
if git diff --cached --quiet; then exit 0; fi
git commit -m "Update acknowledged $1 state"
# Each workflow owns its own branch, so other weekdays cannot race this push.
for attempt in 1 2 3 4 5; do
  git pull --rebase origin "$state_branch"
  if git push origin "HEAD:$state_branch"; then exit 0; fi
done
echo 'State push failed; next run will retry the unacknowledged change'
exit 1
