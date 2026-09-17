import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareRoads, roadVisible, laneLayout, roadWidth } from "./road-network.mjs";

import { prepareLayout } from "./road-layout.mjs";

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
const prepared = prepareRoads(roadFeatures, manifest.center);
const layout = prepareLayout(roadFeatures, prepared.samples);
const roadsById = new Map(roadFeatures.map(feature => [feature.id, feature]));
console.log(`Suppressed street lamps on ${layout.overlaps} overlapping road samples.`);
const overview = [];
mkdirSync(resolve(output, "data/map"), { recursive: true });
for (const c of chunks) {
  const map = [];
  for (const f of c.data.features) {
    if (!prepared.samples.has(f.id)) continue;
    f.properties.roadVisible = roadVisible(f.properties);
    if (!f.properties.roadVisible) continue;
    f.properties.samples = prepared.samples.get(f.id).map((p) => p.map((v, i) => Number(v.toFixed(i === 2 || i >= 4 ? 6 : 3))));
    f.properties.layout = layout.segments.get(f.id);
    f.properties.connections = prepared.connections.get(f.id);
    f.properties.sourceId = String(f.id).replace(/-\d+-\d+$/, "");
    f.properties.width = layout.widths.get(f.properties.sourceId) ?? roadWidth(f.properties);
    f.properties.laneLayout = laneLayout(f.properties);
    const end = (which) => (f.properties.connections?.[which] || [])
      .map(id => roadsById.get(id))
      .filter(Boolean)
      .map(other => ({ width: layout.widths.get(String(other.id).replace(/-\d+-\d+$/, "")) ?? roadWidth(other.properties), lanes: laneLayout(other.properties).total }))
      .sort((a, b) => b.width - a.width)[0];
    f.properties.junctions = { start: end("start"), end: end("end") };
    const road = { id: f.id, name: f.properties.name || "Local road", highway: f.properties.highway,
      width: f.properties.width, laneLayout: f.properties.laneLayout,
      samples: f.properties.samples.map((p) => p.slice(0, 4)) };
    map.push(road);
    if (/^(motorway|trunk|primary|secondary|tertiary)/.test(road.highway)) {
      const samples = road.samples.filter((_, i) => i % 3 === 0);
      if (samples.at(-1) !== road.samples.at(-1)) samples.push(road.samples.at(-1));
      overview.push({ ...road, samples });
    }
  }
  writeFileSync(resolve(output, "data", c.file), JSON.stringify(c.data));
  writeFileSync(resolve(output, "data/map", c.file), JSON.stringify(map));
}
writeFileSync(resolve(output, "data/map/overview.json"), JSON.stringify(overview));
writeFileSync(resolve(output, "data/road-warnings.json"), JSON.stringify(prepared.warnings));
manifest.roadVersion = 6;
writeFileSync(manifestPath, JSON.stringify(manifest));
console.log(`Prepared ${roadFeatures.length} road segments; ${prepared.warnings.length} mixed-level junctions flagged for inspection.`);

for (const file of ["app.js", "geometry.js", "traffic.js"]) {
  const target = resolve(output, "js", file);
  writeFileSync(
    target,
    readFileSync(target, "utf8").replaceAll("../../public/vendor/", "../vendor/"),
  );
}
