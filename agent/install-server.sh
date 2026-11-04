#!/usr/bin/env bash
# install-server.sh — run ON THE LINUX SERVER as the user that will own the agent.
# Idempotent. Needs sudo only for: apt packages, swap file, systemd units.
#
#   cd ~/Headhunter-Assistant/agent && ./install-server.sh
set -euo pipefail
AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="$(dirname "$AGENT_DIR")"
CO="$BASE/career-ops"
ME="$(id -un)"

echo "==> user=$ME base=$BASE"
[ "$BASE" = "$HOME/Headhunter-Assistant" ] || { echo "Expected repo at $HOME/Headhunter-Assistant (systemd units assume it)"; exit 1; }

# 1) Node >= 22.13
if ! command -v node >/dev/null || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  echo "==> installing Node 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

# 2) swap (4 GB RAM box + headless Chromium)
if [ "$(/sbin/swapon --show --noheadings 2>/dev/null | wc -l)" -eq 0 ] && ! grep -q "^/swapfile" /etc/fstab; then
  echo "==> creating 2G swap"
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

# 3) career-ops checkout (system layer from upstream; user data synced separately)
if [ ! -d "$CO/.git" ]; then
  # career-ops/ may already hold the synced user layer (all gitignored) -> init in place
  mkdir -p "$CO" && cd "$CO"
  git init -q
  git remote add origin https://github.com/career-ops-hq/career-ops.git 2>/dev/null || true
  git fetch -q --depth 1 origin main
  git checkout -q -f -B main origin/main   # only touches tracked (system) files
fi
cd "$CO" && npm install --no-audit --no-fund
npx playwright install-deps chromium || sudo npx playwright install-deps chromium
npx playwright install chromium

# 4) agent deps + env
cd "$AGENT_DIR" && npm install --no-audit --no-fund
if [ ! -f .env ]; then cp .env.example .env; fi
chmod 600 .env
sed -i "s|^CAREER_OPS_DIR=.*|CAREER_OPS_DIR=$CO|" .env
chmod +x run-cycle.sh

# 5) checks
command -v agy >/dev/null || echo "!! agy not found in PATH — install/login Antigravity CLI for $ME"
(cd "$CO" && node doctor.mjs --json | head -c 400; echo)

# 6) systemd
sudo cp systemd/headhunter-cycle@.service systemd/headhunter-cycle@.timer \
        systemd/headhunter-digest@.service systemd/headhunter-digest@.timer systemd/headhunter-bot@.service /etc/systemd/system/
sudo systemctl daemon-reload
echo
echo "Installed. NOT enabled yet. When ready:"
echo "  sudo systemctl enable --now headhunter-cycle@$ME.timer headhunter-digest@$ME.timer"
echo "Manual run:  sudo systemctl start headhunter-cycle@$ME.service && journalctl -u headhunter-cycle@$ME -f"
