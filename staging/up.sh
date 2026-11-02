#!/usr/bin/env bash
# Start a throwaway staging copy of CommonCents on 127.0.0.1:3041, loaded from a backup.
#   staging/up.sh [path/to/db.dump] [path/to/receipts-dir]
# Defaults to the newest files in ~/backups/commoncents. Every user's password in the COPY
# becomes "stage-only-password". The live containers and volumes are never touched.
# Remove it again with: docker compose -f staging/compose.yml down -v
set -euo pipefail
cd "$(dirname "$0")"
DUMP=${1:-$(ls -t ~/backups/commoncents/db-*.dump | head -1)}
DATA=${2:-$(ls -td ~/backups/commoncents/data-* | head -1)}
if [ ! -f stage.env ]; then   # throwaway credentials, only for this copy
  PW=$(head -c 18 /dev/urandom | base64 | tr -d '/+=')
  ( umask 077; printf '%s\n' NODE_ENV=production PORT=3040 POSTGRES_DB=commoncents POSTGRES_USER=commoncents \
    "POSTGRES_PASSWORD=$PW" "DATABASE_URL=postgres://commoncents:$PW@db:5432/commoncents" COOKIE_SECURE=false \
    DEFAULT_PASSWORD=stage-only-password > stage.env )
fi
docker compose down -v 2>/dev/null || true
docker compose up -d db
until [ "$(docker inspect -f '{{.State.Health.Status}}' ccstage-db-1)" = healthy ]; do sleep 1; done
docker exec -i ccstage-db-1 pg_restore -U commoncents -d commoncents --no-owner < "$DUMP"
docker exec ccstage-db-1 psql -U commoncents -d commoncents -qc \
  "CREATE EXTENSION IF NOT EXISTS pgcrypto; UPDATE users SET password_hash = crypt('stage-only-password', gen_salt('bf', 10));"
docker compose up -d --build app
sleep 3
docker cp "$DATA/." ccstage-app-1:/app/data/ && docker exec -u 0 ccstage-app-1 chown -R app:app /app/data
echo "Staging copy of $(basename "$DUMP") is up: http://127.0.0.1:3041 (password: stage-only-password)"
