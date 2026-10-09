# sailorguard-charts

Offline depth charts for the SailorGuard app, served from
**https://charts.sailorguard.com**. The app downloads the regions the user
picks into a local SQLite database and draws depth soundings from it, with no
further requests. The app itself stays small.

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

## Deploy

1. Push to GitHub. The workflow runs the tests and publishes the nginx image to `ghcr.io/<owner>/sailorguard-charts`.
2. Point the DNS record `charts.sailorguard.com` at the Traefik host.
3. In Portainer, create a stack from [portainer-stack.yml](portainer-stack.yml). Traefik serves it on `websecure` with the `le` certificate resolver.
4. Upload the data: `SSH_HOST=user@server scripts/upload.sh`. You can also set `SSH_HOST` in `.env` (see `.env.example`).
   - The script streams `public/` into the `sailorguard-charts-data` volume.
   - It uploads the tiles first and the manifest last.
5. Check the deployment: `curl https://charts.sailorguard.com/v1/manifest.json`.

**Caching.** Tiles are sent with `Cache-Control: immutable`. The manifest is sent with `no-cache`, so the app sees new tiles and regions immediately.

## Tests

```sh
npm test
```
