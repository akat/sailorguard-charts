#!/bin/sh
# Entry point of the generator image: builds the requested areas into the
# shared data volume, then rebuilds the manifest. Re-running is cheap: tiles
# already present (and land-only tiles) are skipped.
set -e
AREAS="${AREAS:-mediterranean black-sea}"
echo "Building depth tiles for: ${AREAS}"
# shellcheck disable=SC2086
node generator/build-tiles.mjs ${AREAS}
node generator/build-manifest.mjs
echo "Charts are up to date."
