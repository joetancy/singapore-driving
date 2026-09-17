import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PREPARED_ROAD_SCHEMA_VERSION, prepareAssets } from "./prepare.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");

rmSync(output, { force: true, recursive: true });
mkdirSync(output, { recursive: true });
cpSync(resolve(root, "public"), output, { recursive: true });
cpSync(resolve(root, "app"), output, { recursive: true });

const manifestPath = resolve(output, "data/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath));
const chunks = manifest.chunks.map((c) => ({
  ...c, data: JSON.parse(readFileSync(resolve(output, "data", c.file))),
}));
const roadFeatures = chunks.flatMap((c) => c.data.features.filter((f) => f.geometry.type === "LineString"));
// One shared preparation for rendering, contact, widths and spawn data.
const prepared = prepareAssets(roadFeatures, manifest.center);
const byId = new Map(prepared.roads.map((r) => [r.id, r]));
console.log(`Suppressed street lamps on ${prepared.overlaps} overlapping road samples.`);
const overview = [];
mkdirSync(resolve(output, "data/map"), { recursive: true });
for (const c of chunks) {
  const map = [];
  for (const f of c.data.features) {
    const road = byId.get(f.id);
    if (!road) continue;
    f.properties.roadVisible = true;
    f.properties.samples = road.samples.map((p) => p.map((v, i) => Number(v.toFixed(i === 2 || i >= 4 ? 6 : 3))));
    f.properties.layout = road.layout;
    f.properties.connections = road.connections;
    f.properties.sourceId = road.sourceId;
    f.properties.width = road.width;
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
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`Prepared ${roadFeatures.length} road segments; ${prepared.warnings.length} mixed-level junctions flagged for inspection.`);

for (const file of ["app.js", "geometry.js", "traffic.js"]) {
  const target = resolve(output, "js", file);
  writeFileSync(
    target,
    readFileSync(target, "utf8").replaceAll("../../public/vendor/", "../vendor/"),
  );
}
