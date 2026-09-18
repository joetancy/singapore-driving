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
import { widthAt } from "../app/js/road-shape.js";

// Increment when derived road output changes shape or meaning; the build
// writes this into the manifest and requires a complete rebuild on mismatch.
export const PREPARED_ROAD_SCHEMA_VERSION = 11;

const sourceId = (id) => String(id).replace(/-\d+-\d+$/, "");

// Cosine easing for lane-merge tapers: zero slope at both ends so neither
// the narrowed boundary nor the full-width interior shows a kink.
const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));

// Width transition zones for one feature. Where a degree-1 continuation is
// narrower, only this (wider) side tapers down to meet it, so the shared
// boundary always matches exactly. Zones use absolute sample distances:
// [{d0, d1, w0, w1}]. Junction ends (multiple continuations) and dead ends
// keep full width; each zone is capped at half the feature length so the
// two ends never overlap.
export function taperZones(samples, width, startNeighbor, endNeighbor) {
  const zones = [];
  if (!samples || samples.length < 2) return zones;
  const first = samples[0][3], last = samples[samples.length - 1][3];
  const len = last - first;
  if (!(len > 0)) return zones;
  for (const [neighbor, atStart] of [[startNeighbor, true], [endNeighbor, false]]) {
    if (neighbor == null || width <= neighbor || width - neighbor <= 0.05) continue;
    const L = Math.min(Math.max(8, Math.min(30, (width - neighbor) * 8)), len / 2);
    if (!(L > 0)) continue;
    zones.push(atStart
      ? { d0: first, d1: first + L, w0: neighbor, w1: width }
      : { d0: last - L, d1: last, w0: width, w1: neighbor });
  }
  return zones;
}

export function prepareAssets(features, center) {
  const prepared = prepareRoads(features, center);
  const layout = prepareLayout(features, prepared.samples, prepared.connections);
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
      tapers: [],
      layout: layout.segments.get(f.id) || [],
      connections: prepared.connections.get(f.id) || { start: [], end: [] },
      laneLayout: laneLayout(f.properties),
    });
  }
  const byId = new Map(roads.map((r) => [r.id, r]));
  for (const r of roads) {
    const startLinks = r.connections.start || [], endLinks = r.connections.end || [];
    const startNeighbor = startLinks.length === 1 ? byId.get(startLinks[0])?.width : null;
    const endNeighbor = endLinks.length === 1 ? byId.get(endLinks[0])?.width : null;
    r.tapers = taperZones(r.samples, r.width, startNeighbor ?? null, endNeighbor ?? null);
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
// coordinates, properties}]} → stdout {version, widths, samples, tapers,
// warnings}. Samples are [x, z, height, distance, normalX, normalZ] metres in
// the same projection the browser uses; tapers carry the final width profile
// so Python clearance never reconstructs it from raw tags. Only runs when
// executed directly.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { center, features } = JSON.parse(readFileSync(0, "utf8"));
  const geo = features.map((f) => ({
    id: f.id, properties: f.properties || {},
    geometry: { type: "LineString", coordinates: f.coordinates },
  }));
  const prepared = prepareAssets(geo, center);
  const samples = {}, widths = {}, tapers = {};
  for (const r of prepared.roads) {
    samples[r.id] = r.samples;
    widths[r.id] = r.width;
    if (r.tapers?.length) tapers[r.id] = r.tapers;
  }
  process.stdout.write(JSON.stringify({ version: prepared.version, widths, samples, tapers, warnings: prepared.warnings }));
}

// Explicit surface polygon from prepared cross-sections, independent of any
// Three.js mesh. Consecutive samples share cross-section normals, so joining
// left/right edges sample-to-sample leaves no gaps; the ring closes across
// the first and last cross-sections, retaining endpoint caps that prevent
// driving beyond a deck end. Width is evaluated through taper zones at every
// sample so the polygon matches the rendered deck. Normals are unitized
// to represent the true physical half-width (sample normals include miter
// scaling for rendering joins). Returns a closed [x, z] ring.
export function surfacePolygon(samples, width, tapers = []) {
  if (!samples || samples.length < 2) return [];
  const left = samples.map((p) => {
    const half = widthAt(tapers, p[3], width) / 2;
    const len = Math.hypot(p[4], p[5]) || 1;
    return [p[0] + (p[4] / len) * half, p[1] + (p[5] / len) * half];
  });
  const right = samples.map((p) => {
    const half = widthAt(tapers, p[3], width) / 2;
    const len = Math.hypot(p[4], p[5]) || 1;
    return [p[0] - (p[4] / len) * half, p[1] - (p[5] / len) * half];
  });
  const ring = [...left, ...right.reverse()];
  ring.push([...ring[0]]);
  return ring;
}
