#!/usr/bin/env bash
# deploy.sh — smart git-based deploy for familyHelp
# Usage:
#   ./deploy.sh                   # deploy origin/main
#   ./deploy.sh feat/my-branch    # deploy a specific branch
#   FORCE_DEPLOY=1 ./deploy.sh    # skip dirty-check

set -euo pipefail

APP_DIR="/data/apps/familyHelp"
SERVICE="family-help"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

REF="${1:-origin/main}"

echo "==> familyHelp deploy: $REF"

cd "$REPO_DIR"

# Warn on local changes
if [[ -z "${FORCE_DEPLOY:-}" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "ERROR: Uncommitted local changes. Commit, stash, or set FORCE_DEPLOY=1."
    exit 1
  fi
fi

git fetch origin

echo "==> Checking out $REF into $APP_DIR"
git --work-tree="$APP_DIR" checkout "$REF" -- .

echo "==> Installing production dependencies"
cd "$APP_DIR"
npm ci --omit=dev

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"
sudo systemctl status  "$SERVICE" --no-pager -l

echo "==> Done."
