#!/usr/bin/env bash
# Uploads public/ (tiles + manifest) into the `sailorguard-charts-data` Docker
# volume on the server. Tiles go first and the manifest last, so the app never
# sees a manifest that points at tiles that are not there yet.
#
#   SSH_HOST=user@server scripts/upload.sh        (or set SSH_HOST in .env)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a
: "${SSH_HOST:?Set SSH_HOST (user@host of the Docker server)}"
VOLUME="${CHARTS_VOLUME:-sailorguard-charts-data}"
[ -f public/v1/manifest.json ] || { echo "public/v1/manifest.json missing: run npm run build:manifest" >&2; exit 1; }

echo "Uploading tiles to ${SSH_HOST}:${VOLUME} ..."
tar -C public -cf - --exclude=v1/manifest.json --exclude=v1/land-tiles.json v1 \
  | ssh "$SSH_HOST" "docker run --rm -i -v ${VOLUME}:/data alpine tar -C /data -xf -"

echo "Uploading manifest ..."
tar -C public -cf - v1/manifest.json \
  | ssh "$SSH_HOST" "docker run --rm -i -v ${VOLUME}:/data alpine tar -C /data -xf -"

echo "Done. Check: curl -sI https://charts.sailorguard.com/v1/manifest.json"
