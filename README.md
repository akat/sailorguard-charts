# sailorguard-charts

Offline depth charts for the SailorGuard app, served from
**https://charts.sailorguard.com**. The app downloads the regions the user
picks into a local SQLite database and draws depth soundings from it, with no
further requests. The app itself stays small!

## Data

- **Source.** The data comes from the [EMODnet Bathymetry](https://emodnet.ec.europa.eu/en/bathymetry) DTM (CC BY 4.0). The app shows the attribution "© EMODnet Bathymetry Consortium". The data is not for navigation.
- **Tiles.** The world is split into **1° × 1° tiles**, named by their south-west corner (for example `N37E023`). Each tile is roughly 50–120 KB.
- **Cells.** Each tile has 240 × 240 cells (about 460 m × 360 m each). A cell covers 4 × 4 EMODnet samples (about 115 m apart).
- **What a cell holds.** A cell stores its **shallowest** sample and which of the 16 samples that was. The app places each sounding at that sample's real position, so soundings are accurate to about 115 m, and shoals are never averaged away.
- **File format.** The format is defined in [generator/tile-format.mjs](generator/tile-format.mjs) and mirrored in the app (`src/services/depthGrid.ts`).

```
public/v1/
  manifest.json                       regions, tile sizes and sha256
  tiles/emodnet-2024/N37E023.sgd      tiles (immutable; a new dataset gets a new folder)
```

## Build data

You need Node 20 or later.

```sh
npm install
npm run build:tiles -- mediterranean black-sea   # areas from generator/regions.json, or west,south,east,north
npm run build:manifest
```

- **Requests.** The build makes one EMODnet WCS request per tile.
- **Duration.** It is slow: about an hour for the Mediterranean and the Black Sea.
- **Resuming.** It can be stopped and restarted. Tiles already on disk, and tiles known to be land only, are skipped.
- **Areas.** The `areas` in `regions.json` are what to build. The `regions` are the named regions shown in the app. A region lists every built tile its bounding box touches.

To add a region, add an entry to `regions` and run `build:manifest` again. To cover new waters, build the area that contains them first.

## Deploy (Portainer)

The stack has two services that share the `sailorguard-charts-data` volume:

- `sailorguard-charts` is the nginx server behind Traefik.
- `sailorguard-charts-generator` builds the tiles from EMODnet straight into the volume, writes the manifest, and exits.

The generator runs again on every deploy or redeploy. Tiles that are already built are skipped, so a redeploy only fetches what is new.

1. Push to GitHub. The workflow publishes two images: `ghcr.io/<owner>/sailorguard-charts` and `ghcr.io/<owner>/sailorguard-charts-generator`.
2. Point the DNS record `charts.sailorguard.com` at the Traefik host.
3. In Portainer, create a stack from [portainer-stack.yml](portainer-stack.yml). You can set two optional stack variables:
   - `CHART_AREAS`: which areas to build (default `mediterranean black-sea`).
   - `CHART_CONCURRENCY`: how many tiles to fetch at once (default 3).
4. Follow the generator's container logs. When it is done, the log ends with `Charts are up to date.`
5. Check the result: `curl https://charts.sailorguard.com/v1/manifest.json`.

To add waters later, extend `CHART_AREAS` (for example `mediterranean black-sea atlantic-iberia`) and redeploy the stack.

`scripts/upload.sh` is an optional alternative: it uploads data built on another machine into the same volume.

## Tests

```sh
npm test
```
