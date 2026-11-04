#!/usr/bin/env bash
# sync-to-server.sh — run ON YOUR MAC. Copies agent code + career-ops USER LAYER
# (cv, profile, portals, data, reports...) to the server over SSH (encrypted).
# Does NOT copy career-ops system files or node_modules (the server clones upstream).
#
#   ./agent/sync-to-server.sh user@server            # dry run (shows what would be copied)
#   ./agent/sync-to-server.sh user@server --apply    # really copy
set -euo pipefail
DEST="${1:?usage: sync-to-server.sh user@host [--apply]}"
APPLY="${2:-}"
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RSYNC=(rsync -az --itemize-changes)
if [ "$APPLY" != "--apply" ]; then RSYNC+=(--dry-run); fi

ssh "$DEST" 'mkdir -p ~/Headhunter-Assistant/career-ops'

# agent code (never .env, logs or node_modules)
"${RSYNC[@]}" --exclude node_modules --exclude logs --exclude .env \
  "$BASE/agent" "$DEST:Headhunter-Assistant/"

# career-ops user layer only (only paths that exist; macOS openrsync lacks --ignore-missing-args)
cd "$BASE/career-ops"
PATHS=()
for p in cv.md article-digest.md voice-dna.md portals.yml \
         config/profile.yml config/cv-facts.json \
         modes/_profile.md modes/_custom.md modes/_brief.md \
         data reports output jds interview-prep documents batch/tracker-additions; do
  if [ -e "$p" ]; then PATHS+=("$p"); fi
done
"${RSYNC[@]}" --relative --exclude 'data/tmp/' "${PATHS[@]}" "$DEST:Headhunter-Assistant/career-ops/"

if [ "$APPLY" = "--apply" ]; then echo "Synced."; else echo "(dry run — add --apply to copy)"; fi
