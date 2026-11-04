#!/usr/bin/env bash
# run-cycle.sh — one headhunter cycle: scan -> evaluate (agy headless) -> merge -> email alerts.
# Safe to run from systemd timer or cron. Never applies/submits anything.
set -uo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Load .env without overriding variables already set in the environment
if [ -f "$AGENT_DIR/.env" ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[1]}"
    [ -n "${!key+x}" ] && continue
    eval "export $line"
  done < "$AGENT_DIR/.env"
fi

CAREER_OPS_DIR="${CAREER_OPS_DIR:-$AGENT_DIR/../career-ops}"
AGY_BIN="${AGY_BIN:-agy}"
MAX_EVALS="${MAX_EVALS_PER_CYCLE:-8}"
AGY_TIMEOUT="${AGY_TIMEOUT_SECONDS:-5400}"
LOG_DIR="${LOG_DIR:-$AGENT_DIR/logs}"
SKIP_EVAL="${SKIP_EVAL:-0}"        # 1 = scan + notify only (no LLM)
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/cycle-$(date +%Y-%m-%d).log"

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

# --- single instance lock ---
LOCK="$LOG_DIR/.cycle.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || { log "another cycle is running — skip"; exit 0; }
fi

cd "$CAREER_OPS_DIR" || { log "CAREER_OPS_DIR not found: $CAREER_OPS_DIR"; exit 1; }
log "=== cycle start (max_evals=$MAX_EVALS) ==="

# 1) zero-token scan
if node scan.mjs --quiet >>"$LOG" 2>&1; then
  log "scan ok"
else
  log "scan exit=$? (continuing)"
fi

PENDING=$(grep -cE '^- \[ \]' data/pipeline.md 2>/dev/null || echo 0)
log "pending in pipeline: $PENDING"

# 2) evaluation with Antigravity CLI (headless)
if [ "$SKIP_EVAL" != "1" ] && [ "$PENDING" -gt 0 ]; then
  PROMPT=$(cat <<EOF
Run the career-ops pipeline mode for data/pipeline.md.
This is an UNATTENDED headless run: nobody can answer, follow modes/_shared.md "Unattended runs".
Process AT MOST ${MAX_EVALS} pending URLs in this run. Prioritise roles located in Barcelona or elsewhere in Spain,
then remote EU/EMEA/worldwide roles; leave the rest pending for the next run. Use the two-pass triage.
Hard rules: never apply, submit, send emails or messages, and never click Apply. Do not edit cv.md, config/,
modes/_profile.md, modes/_custom.md, modes/_brief.md or portals.yml.
Tooling rules (permissions are pre-approved only for these; anything else is auto-denied and aborts the run):
- To create or edit files (temp URL lists, reports, TSVs) use your native file-writing tool, never shell
  redirection (>, >>), heredocs or tee. Put temp files under data/tmp/ (create it if needed), not /tmp.
- Shell commands allowed: node <script>.mjs, npx playwright, ls, cat, head, tail, grep, wc, sed, awk, cut, sort,
  uniq, find, echo, date, mkdir, jq, diff, git status/diff/log. Do not use python, curl, wget, cp, mv or rm.
- For web pages use your URL-reading tool or the career-ops node scripts (fetch-jd.mjs, browser-extract.mjs, check-liveness.mjs).
When done, merge tracker additions (node merge-tracker.mjs) and end with one line: evaluated=<n> pass=<n> fail=<n>.
EOF
)
  AGY_ARGS=(-p "$PROMPT" --output-format stream-json)
  [ -n "${AGY_MODEL:-}" ] && AGY_ARGS+=(--model "$AGY_MODEL")
  log "agy evaluation start"
  # --- integrity guard: agy file-permission rules can't be path-scoped, so snapshot protected files ---
  SNAP="$LOG_DIR/.protected-snapshot"
  rm -rf "$SNAP" && mkdir -p "$SNAP"
  PROTECTED=(cv.md portals.yml config modes/_profile.md modes/_custom.md modes/_brief.md article-digest.md voice-dna.md)
  for p in "${PROTECTED[@]}"; do [ -e "$p" ] && mkdir -p "$SNAP/$(dirname "$p")" && cp -Rp "$p" "$SNAP/$p"; done
  SUM_BEFORE=$(cd "$SNAP" && find . -type f -exec shasum {} + | sort)
  if command -v timeout >/dev/null 2>&1; then
    timeout --kill-after=60 "$AGY_TIMEOUT" "$AGY_BIN" "${AGY_ARGS[@]}" >>"$LOG" 2>&1; RC=$?
  else
    "$AGY_BIN" "${AGY_ARGS[@]}" --print-timeout "${AGY_TIMEOUT}s" >>"$LOG" 2>&1; RC=$?
  fi
  log "agy evaluation exit=$RC"
  DENIED=$(grep -o '"denied_actions": \[[^]]*\]' "$LOG" | tail -1)
  [ -n "$DENIED" ] && log "agy denied actions: $DENIED"
  SUM_AFTER=$(cd "$CAREER_OPS_DIR" && for p in "${PROTECTED[@]}"; do [ -e "$p" ] && find "$p" -type f -exec shasum {} +; done | sed 's|  |  ./|' | sort)
  if [ "$SUM_BEFORE" != "$SUM_AFTER" ]; then
    log "!! PROTECTED FILES CHANGED by agy — restoring from snapshot"
    diff <(echo "$SUM_BEFORE") <(echo "$SUM_AFTER") >>"$LOG" 2>&1 || true
    for p in "${PROTECTED[@]}"; do
      if [ -e "$SNAP/$p" ]; then rm -rf "$p"; cp -Rp "$SNAP/$p" "$p"; fi
    done
    echo "$(date '+%F %T') protected files were modified and restored" >> "$LOG_DIR/integrity-alerts.log"
  else
    log "integrity ok (protected files unchanged)"
  fi
  node merge-tracker.mjs >>"$LOG" 2>&1 || log "merge-tracker exit=$?"
else
  log "evaluation skipped (SKIP_EVAL=$SKIP_EVAL, pending=$PENDING)"
fi

# 3) alerts
if node "$AGENT_DIR/notify.mjs" >>"$LOG" 2>&1; then
  log "notify ok"
else
  log "notify FAILED (will retry next cycle)"
fi

log "=== cycle end ==="
# keep 30 days of logs
find "$LOG_DIR" -name 'cycle-*.log' -mtime +30 -delete 2>/dev/null || true
