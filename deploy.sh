#!/usr/bin/env bash
# Deploy the latest main on this server: pull, rebuild, wait for the healthcheck, roll back if it fails.
#   ./deploy.sh
# Uses compose.tailscale.yaml (the live setup); set COMPOSE_FILE=compose.yaml to use the plain one.
set -euo pipefail

cd "$(dirname "$0")"
COMPOSE_FILE="${COMPOSE_FILE:-compose.tailscale.yaml}"
SERVICE=recall
TIMEOUT=120 # seconds; the Dockerfile healthcheck runs every 30s

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

# 1. Only deploy what's in git: refuse if anything is modified or untracked.
if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has uncommitted changes; commit them on your Mac or discard them here first:" >&2
  git status --short >&2
  exit 1
fi

# 2. Remember what's running now (before switching branches; after a rollback HEAD is detached), so we can go back.
previous=$(git rev-parse HEAD)
git switch -q main

# 3. Take only fast-forwards from GitHub; never merge or rewrite here.
git pull --ff-only -q origin main
current=$(git rev-parse HEAD)
if [ "$current" = "$previous" ]; then
  echo "Already at $(git log -1 --format='%h %s'); rebuilding anyway."
fi

# 4. Wait for Docker's healthcheck (GET /api/health inside the container) to report healthy.
wait_healthy() {
  local id status
  id=$(compose ps -q "$SERVICE")
  for _ in $(seq "$TIMEOUT"); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && break
    sleep 1
  done
  echo "Health check did not pass (last status: $status)." >&2
  compose logs --tail 30 "$SERVICE" >&2
  return 1
}

# 5. Rebuild and restart; on any failure, go back to the previous commit.
echo "Deploying $(git log -1 --format='%h %s')"
if ! compose up -d --build || ! wait_healthy; then
  echo "Deploy of ${current:0:7} failed; rolling back to ${previous:0:7}." >&2
  git checkout -q --detach "$previous"
  compose up -d --build
  wait_healthy || echo "Rollback is up but not healthy either; check 'docker compose logs'." >&2
  echo "Rolled back. This checkout is pinned to ${previous:0:7}; push a fix and run ./deploy.sh again." >&2
  exit 1
fi

# 6. Mark what's live, so you can see deploy history with: git tag -l 'deploy-*'
tag="deploy-$(date +%Y%m%d-%H%M)"
git tag -f "$tag" >/dev/null
echo "Deployed ${current:0:7}, tagged $tag."
