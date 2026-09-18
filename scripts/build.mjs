import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PREPARED_ROAD_SCHEMA_VERSION, prepareAssets } from "./prepare.mjs";

const root = resolve(import.meta.dirname, "..");

// Deterministic generation ID: schema + normalized widths + warnings. Same
// inputs always produce the same ID; timestamps are never an input.
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(stable(value))).digest('hex');
export function generationId(prepared) {
  return digest({ version: prepared.version, roads: [...prepared.roads].sort((a, b) => String(a.id).localeCompare(String(b.id))) }).slice(0, 16);
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
  const identities = new Map();
  for (const c of chunks) for (const f of c.data.features) {
    if (identities.has(f.id)) fail(`duplicate feature ID ${f.id} in ${identities.get(f.id)} and ${c.id}`);
    identities.set(f.id, c.id);
  }
  const configHash = digest(['prepare.mjs', 'road-network.mjs', 'road-layout.mjs', 'clearance.py', 'build.mjs']
    .map(name => readFileSync(resolve(root, 'scripts', name), 'utf8')));
  const generation = digest({ schema: PREPARED_ROAD_SCHEMA_VERSION, center: manifest.center, configHash,
    chunks: chunks.map(c => ({ id: c.id, features: [...c.data.features].sort((a,b) => String(a.id).localeCompare(String(b.id))) }))
      .sort((a,b) => a.id.localeCompare(b.id)) }).slice(0, 16);
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
      f.properties.structure = road.structure;
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
  manifest.generation = generation;
  manifest.configurationHash = configHash;
  manifest.projection = { name: 'mercator', radius: 6378137, center: manifest.center,
    units: 'metres', axes: ['east', 'south', 'height'], samplePrecision: [0.001, 0.001, 0.000001], triangles: [[0,1,3],[1,2,3]] };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const clearance = spawnSync(process.env.PYTHON || 'python3', [resolve(root, 'scripts/clearance.py'), resolve(output, 'data')],
    { encoding: 'utf8', timeout: 600000, maxBuffer: 1024 * 1024 });
  if (clearance.error || clearance.status !== 0) fail(`exact Python clearance failed: ${clearance.error?.message || clearance.stderr}`);
  manifest.assets = {};
  for (const c of chunks) {
    const path = resolve(output, 'data', c.file);
    const data = JSON.parse(readFileSync(path));
    data.generation = generation;
    data.roadVersion = manifest.roadVersion;
    const text = JSON.stringify(data);
    writeFileSync(path, text);
    manifest.assets[c.file] = digest(text);
  }
  manifest.preparationReport = 'road-warnings.json';
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

export function buildSite(publicDir, appDir, output) {
  // Stage the full generation, then swap: the previous dist survives until
  // the replacement validates, and returns on failure (rollback).
  const staging = mkdtempSync(output + '.stage-');
  try {
    const summary = buildInto(publicDir, appDir, staging);
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
    return summary;
  } catch (e) {
    rmSync(staging, { force: true, recursive: true });
    throw e;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  buildSite(resolve(root, 'public'), resolve(root, 'app'), resolve(root, 'dist'));
