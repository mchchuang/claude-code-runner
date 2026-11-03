#!/bin/sh
# One-time: register this runner with Gitea, for this repo only. Token from the repo's Settings → Actions → Runners →
# Create new runner, or on the server: docker exec -u git gitea gitea actions generate-runner-token -s martin/claude-code-runner
# To re-register, delete state/.runner first.
# Usage: ./register.sh <registration-token>
set -e
cd "$(dirname "$0")"
[ -n "$1" ] || { echo "usage: $0 <registration-token>" >&2; exit 1; }
mkdir -p state
docker compose run --rm --build runner register --no-interactive --config /config.yaml \
  --instance https://git.mchserver.com --token "$1" --name claude-code-runner
