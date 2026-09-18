import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PREPARED_ROAD_SCHEMA_VERSION, prepareAssets } from "./prepare.mjs";

const root = resolve(import.meta.dirname, "..");

// Deterministic generation ID: schema + normalized widths + warnings. Same
// inputs always produce the same ID; timestamps are never an input.
export function generationId(prepared) {
  const hash = createHash("sha1");
  hash.update(String(prepared.version));
  for (const r of [...prepared.roads].sort((a, b) => (a.id < b.id ? -1 : 1)))
    hash.update(`|${r.id}=${r.width.toFixed(3)}`);
  hash.update(`|warnings=${prepared.warnings.length}`);
  return hash.digest("hex").slice(0, 16);
}

function fail(message) {
  throw new Error(`build validation failed: ${message}`);
}

// Complete generation into `output`, validating before returning. Throws on
// any invalid asset; never leaves a partial generation behind.
export function buildInto(publicDir, appDir, output) {
  rmSync(output, { force: true, recursive: true });
  mkdirSync(output, { recursive: true });
  cpSync(publicDir, output, { recursive: true });
  cpSync(appDir, output, { recursive: true });

  const manifestPath = resolve(output, "data/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath));
  const chunks = manifest.chunks.map((c) => ({
    ...c, data: JSON.parse(readFileSync(resolve(output, "data", c.file))),
  }));
  const roadFeatures = chunks.flatMap((c) => c.data.features.filter((f) => f.geometry.type === "LineString"));
  // One shared preparation for rendering, contact, widths and spawn data.
  const prepared = prepareAssets(roadFeatures, manifest.center);
  if (prepared.version !== PREPARED_ROAD_SCHEMA_VERSION) fail("preparation version mismatch");
  const byId = new Map(prepared.roads.map((r) => [r.id, r]));
  console.log(`Suppressed street lamps on ${prepared.overlaps} overlapping road samples.`);
  const overview = [];
  mkdirSync(resolve(output, "data/map"), { recursive: true });
  for (const c of chunks) {
    const map = [];
    for (const f of c.data.features) {
      const road = byId.get(f.id);
      if (!road) continue;
      if (!Number.isFinite(road.width)) fail(`non-finite width in ${f.id}`);
      f.properties.roadVisible = true;
      f.properties.samples = road.samples.map((p) => p.map((v, i) => Number(v.toFixed(i === 2 || i >= 4 ? 6 : 3))));
      f.properties.layout = road.layout;
      f.properties.connections = road.connections;
      f.properties.sourceId = road.sourceId;
      // Derived width lives beside the raw tag: the source `width` (rare
      // OSM tag) stays untouched so rebuilds never lose input.
      f.properties.preparedWidth = road.width;
      if (road.tapers?.length) {
        const round = (v) => Number(v.toFixed(3));
        f.properties.tapers = road.tapers.map((t) =>
          ({ d0: round(t.d0), d1: round(t.d1), w0: round(t.w0), w1: round(t.w1) }));
      }
      f.properties.laneLayout = road.laneLayout;
      const entry = { id: f.id, name: f.properties.name || "Local road", highway: f.properties.highway,
        width: road.width, laneLayout: road.laneLayout,
        samples: f.properties.samples.map((p) => p.slice(0, 4)) };
      map.push(entry);
      if (/^(motorway|trunk|primary|secondary|tertiary)/.test(entry.highway)) {
        const samples = entry.samples.filter((_, i) => i % 3 === 0);
        if (samples.at(-1) !== entry.samples.at(-1)) samples.push(entry.samples.at(-1));
        overview.push({ ...entry, samples });
      }
    }
    writeFileSync(resolve(output, "data", c.file), JSON.stringify(c.data));
    writeFileSync(resolve(output, "data/map", c.file), JSON.stringify(map));
  }
  writeFileSync(resolve(output, "data/map/overview.json"), JSON.stringify(overview));
  writeFileSync(resolve(output, "data/road-warnings.json"), JSON.stringify(prepared.warnings));
  manifest.roadVersion = PREPARED_ROAD_SCHEMA_VERSION;
  manifest.generation = generationId(prepared);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`Prepared ${roadFeatures.length} road segments; ${prepared.warnings.length} mixed-level junctions flagged for inspection.`);

  for (const file of ["app.js", "geometry.js", "traffic.js"]) {
    const target = resolve(output, "js", file);
    writeFileSync(
      target,
      readFileSync(target, "utf8").replaceAll("../../public/vendor/", "../vendor/"),
    );
  }
  return { roadVersion: manifest.roadVersion, generation: manifest.generation, chunks: chunks.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Stage the full generation, then swap: the previous dist survives until
  // the replacement validates, and returns on failure (rollback).
  const output = resolve(root, "dist");
  const staging = mkdtempSync(join(tmpdir(), "singapore-dist-"));
  try {
    const summary = buildInto(resolve(root, "public"), resolve(root, "app"), staging);
    const backup = output + ".prev";
    rmSync(backup, { force: true, recursive: true });
    if (existsSync(output)) renameSync(output, backup);
    try {
      renameSync(staging, output);
    } catch (e) {
      if (existsSync(backup)) renameSync(backup, output);
      throw e;
    }
    rmSync(backup, { force: true, recursive: true });
    console.log(`dist ready: schema ${summary.roadVersion}, generation ${summary.generation}, ${summary.chunks} chunks.`);
  } catch (e) {
    rmSync(staging, { force: true, recursive: true });
    throw e;
  }
}
