#!/usr/bin/env bash
# Run every test (unit + integration) the way CI does: a disposable Postgres 16 and Node 24,
# both in Docker, on their own network. Everything is removed afterwards.
set -euo pipefail
cd "$(dirname "$0")/.."
NET=cc-test-$$; PG=cc-test-pg-$$
cleanup() { docker rm -f "$PG" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_USER=cc -e POSTGRES_PASSWORD=cc -e POSTGRES_DB=cc_test postgres:16-alpine >/dev/null
until docker exec "$PG" pg_isready -U cc -d cc_test >/dev/null 2>&1; do sleep 1; done
sleep 1
docker run --rm --network "$NET" -u "$(id -u):$(id -g)" -e npm_config_cache=/tmp/npm -v "$PWD":/w -w /w \
  -e TEST_DATABASE_URL="postgres://cc:cc@$PG:5432/cc_test" node:24-alpine \
  sh -c '[ -d node_modules ] && npm ls --silent >/dev/null 2>&1 || npm ci --no-audit --no-fund --silent; node --test'
