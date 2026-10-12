// Where a build writes its tiles.
//
// Each generation pipeline writes into its own folder, tiles/<dataset>/<version>/,
// and the manifest points at it only once the build is complete. While a
// rebuild runs, the app keeps downloading the previous, consistent set: tiles
// are never overwritten under a manifest that holds their old sha256.
import {join} from 'node:path';

// Bump when the generated data changes: the next run builds every tile again.
export const BUILD_VERSION = 'osm-coast-fill-1';

/** Folder of the dataset, holding one subfolder per build version. */
export const datasetDir = (root, dataset) => join(root, 'public', 'v1', 'tiles', dataset.id);

/** Folder the current build version writes to. */
export const buildDir = (root, dataset) => join(datasetDir(root, dataset), BUILD_VERSION);
