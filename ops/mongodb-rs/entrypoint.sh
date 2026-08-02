#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${MONGO_REPLICA_KEY:-}" ]]; then
  echo "MONGO_REPLICA_KEY is required" >&2
  exit 1
fi

umask 077
printf '%s' "$MONGO_REPLICA_KEY" > /tmp/mongodb-keyfile
chown mongodb:mongodb /tmp/mongodb-keyfile
chmod 400 /tmp/mongodb-keyfile

exec /usr/local/bin/docker-entrypoint.sh "$@"
