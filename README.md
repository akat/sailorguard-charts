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
- **Contours.** Each tile also has a contour file (`.sgc`) with isobaths at 2, 5, 10, 20, 50, 100 and 200 m, and depth areas (water ≤ 2, 5, 10 and 20 m) for the chart's blue bands.
  - The contours are computed with marching squares (`d3-contour`) on the native ~115 m grid, simplified, then rounded with Chaikin smoothing (two passes) so they curve like on a paper chart.
  - **Real coastline.** EMODnet's grid draws small islands too big and coasts up to a few hundred metres off. The [OpenStreetMap land polygons](https://osmdata.openstreetmap.de/data/land-polygons.html) (© OpenStreetMap contributors, ODbL) are used to mark samples on real land as land, and to cut isobaths and depth areas where they cross real land. See [generator/land.mjs](generator/land.mjs).
  - **Misplaced coast.** Where EMODnet says land but OSM shows sea (EMODnet often draws islets bigger and a few hundred metres off), the isobaths would ring land that is not there. For the contours only, those cells get a depth by harmonic interpolation: 0 m along the real coast, rising smoothly to the EMODnet depths around them. Only cells within 8 samples (~900 m) of both EMODnet water and real land are filled. Soundings and point depths keep EMODnet's own values, so such a spot still has no sounding.
  - **Lines at the coast.** Isobaths stop ~10–15 m short of the real coast, and the short stubs a cut leaves (< ~50 m) are dropped. Base maps (Apple, Google) draw coasts a few metres differently, and a line touching the shore looks as if it ran under the land. Simplification never shortcuts a line over land.
  - Each file holds two levels of detail: coarse for zoomed-out views, fine for close-up views.
  - A contour file is about 240–300 KB for a tile with a lot of coast.
  - The format is defined in [generator/contour-format.mjs](generator/contour-format.mjs) and mirrored in the app (`src/services/contourTile.ts`).

```
public/v1/
  manifest.json                       regions, tile sizes and sha256 (depths and contours)
  tiles/emodnet-2024/<build>/N37E023.sgd   depth tiles (immutable; each build gets a new folder)
  tiles/emodnet-2024/<build>/N37E023.sgc   contour tiles
```

## Build data

You need Node 20 or later.

```sh
npm install
npm run build:tiles -- mediterranean black-sea   # areas from generator/regions.json, or west,south,east,north
npm run build:manifest
```

- **Requests.** The build makes one EMODnet WCS request per tile.
- **Land polygons.** The first build downloads the OSM land polygons (~930 MB), unzips them (1.3 GB) and splits them by tile (`public/.cache/land-tiles`, ~1.4 GB). This happens once; nginx does not serve `public/.cache`.
- **Duration.** It is slow: about an hour for the Mediterranean and the Black Sea.
- **Resuming.** It can be stopped and restarted. Tiles that already have both a depth file and a contour file, and tiles known to be land only, are skipped.
- **Versions.** Each build writes into its own folder, `tiles/<dataset>/<BUILD_VERSION>/` (see [generator/build-info.mjs](generator/build-info.mjs)). The manifest points at it only after `build:manifest`, so while a rebuild runs the app keeps downloading the previous, consistent set (tiles are cached as immutable and verified by sha256; overwriting them in place broke downloads). When the generation changes, bump `BUILD_VERSION` and every tile is built again into a new folder. `build:manifest` keeps the previous folder one more build, then removes it.
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
