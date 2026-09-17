// Shared static-build road preparation (PLAN Phase 1, release 1).
//
// Single entry point for deriving driveable-road data from checked-in GeoJSON
// chunks. scripts/build.mjs and the road tests must use this module instead of
// combining prepareRoads/prepareLayout directly, so rendering, contact checks,
// clearance widths and spawn selection share one representation.
//
// Sample format is preserved: [x, z, height, distance, normalX, normalZ] in
// metres, with cross-section normals shared at joins (see road-network.mjs).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareRoads, roadVisible, laneLayout, roadWidth } from "./road-network.mjs";
import { prepareLayout } from "./road-layout.mjs";

// Increment when derived road output changes shape or meaning; the build
// writes this into the manifest and requires a complete rebuild on mismatch.
export const PREPARED_ROAD_SCHEMA_VERSION = 7;

const sourceId = (id) => String(id).replace(/-\d+-\d+$/, "");

export function prepareAssets(features, center) {
  const prepared = prepareRoads(features, center);
  const layout = prepareLayout(features, prepared.samples);
  const widths = new Map();
  const roads = [];
  for (const f of features) {
    if (f.geometry?.type !== "LineString" || !roadVisible(f.properties)) continue;
    const source = sourceId(f.id);
    // Width is normalized once here: the globally fitted source width from
    // layout (which narrows distinct parallel carriageways together), falling
    // back to the highway-class default. Renderer, map and importer reuse it.
    const width = layout.widths.get(source) ?? roadWidth(f.properties);
    widths.set(f.id, width);
    const samples = prepared.samples.get(f.id) || [];
    for (const p of samples) {
      if (!p.every(Number.isFinite))
        throw new Error(`Non-finite prepared coordinate in ${f.id}`);
    }
    roads.push({
      id: f.id,
      sourceId: source,
      width,
      samples,
      layout: layout.segments.get(f.id) || [],
      connections: prepared.connections.get(f.id) || { start: [], end: [] },
      laneLayout: laneLayout(f.properties),
    });
  }
  return {
    version: PREPARED_ROAD_SCHEMA_VERSION,
    roads,
    samples: prepared.samples,
    connections: prepared.connections,
    segments: layout.segments,
    widths,
    overlaps: layout.overlaps,
    warnings: prepared.warnings,
  };
}

// JSON CLI for scripts/import_osm.py so elevation preparation precedes
// clearance with identical heights: stdin {center, features: [{id,
// coordinates, properties}]} → stdout {version, widths, samples, warnings}.
// Samples are [x, z, height, distance, normalX, normalZ] metres in the same
// projection the browser uses. Only runs when executed directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { center, features } = JSON.parse(readFileSync(0, "utf8"));
  const geo = features.map((f) => ({
    id: f.id, properties: f.properties || {},
    geometry: { type: "LineString", coordinates: f.coordinates },
  }));
  const prepared = prepareAssets(geo, center);
  const samples = {}, widths = {};
  for (const r of prepared.roads) {
    samples[r.id] = r.samples;
    widths[r.id] = r.width;
  }
  process.stdout.write(JSON.stringify({ version: prepared.version, widths, samples, warnings: prepared.warnings }));
}

// Explicit surface polygon from prepared cross-sections, independent of any
// Three.js mesh. Consecutive samples share cross-section normals, so joining
// left/right edges sample-to-sample leaves no gaps; the ring closes across
// the first and last cross-sections, retaining endpoint caps that prevent
// driving beyond a deck end. Returns a closed [x, z] ring.
export function surfacePolygon(samples, width) {
  if (!samples || samples.length < 2) return [];
  const half = width / 2;
  const left = samples.map((p) => [p[0] + p[4] * half, p[1] + p[5] * half]);
  const right = samples.map((p) => [p[0] - p[4] * half, p[1] - p[5] * half]);
  const ring = [...left, ...right.reverse()];
  ring.push([...ring[0]]);
  return ring;
}
