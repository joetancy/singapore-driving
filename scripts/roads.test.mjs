import assert from "node:assert/strict";
import { prepareRoads, roadVisible } from "./road-network.mjs";
import { roadIndex, surfaceAt } from "../app/js/roads.js";

const center = [103.85, 1.29];
const features = [
  { id: "ground", geometry: { type: "LineString", coordinates: [[103.85, 1.29], [103.851, 1.29]] }, properties: { highway: "primary" } },
  { id: "bridge", geometry: { type: "LineString", coordinates: [[103.85, 1.29], [103.851, 1.29]], }, properties: { highway: "primary", bridge: "yes" } },
];
const prepared = prepareRoads(features, center);
assert(prepared.samples.get("ground").length >= 2);
assert(prepared.samples.get("bridge")[0][2] >= 4);
assert(prepared.connections.get("ground").start.includes("bridge"));

const road = (id, coordinates, properties = {}) => ({
  id, geometry: { type: "LineString", coordinates }, properties: { highway: "primary", ...properties },
});
const junction = [103.85, 1.29], bridgeEnd = [103.8501, 1.29];
const regression = prepareRoads([
  road("left-approach", [[103.84955, 1.29], junction]),
  road("test-bridge", [junction, bridgeEnd], { bridge: "yes" }),
  road("right-approach", [bridgeEnd, [103.85055, 1.29]]),
  road("side-road", [bridgeEnd, [103.8501, 1.2902]]),
  road("surface-by-tunnel", [[103.851, 1.29], [103.8512, 1.29]]),
  road("tunnel", [[103.8512, 1.29], [103.8514, 1.29]], { tunnel: "yes", layer: -1 }),
], center);
const heights = (id) => regression.samples.get(id).map((p) => p[2]);
assert.equal(heights("tunnel").length, 0);
assert.equal(roadVisible({ tunnel: "yes" }), false);
assert.equal(roadVisible({ layer: -1 }), false);
assert(heights("surface-by-tunnel").every((h) => h === 0));
assert(heights("side-road").every((h) => h === 0));
for (const id of ["left-approach", "test-bridge", "right-approach"]) {
  const samples = regression.samples.get(id);
  for (let i = 1; i < samples.length; i++) {
    const distance = Math.hypot(samples[i][0] - samples[i - 1][0], samples[i][1] - samples[i - 1][1]);
    assert(Math.abs(samples[i][2] - samples[i - 1][2]) / distance <= 0.080001);
  }
}
assert.equal(heights("left-approach").at(-1), 4);
assert.equal(heights("right-approach")[0], 4);
assert([...regression.samples.values()].flat().every((p) => p[2] >= 0));

const roads = [
  { id: "ground", featureId: "ground", connections: ["bridge"], a: [0, 0, 0], b: [100, 0, 0], width: 10 },
  { id: "bridge", featureId: "bridge", connections: ["ground"], a: [0, 0, 4], b: [100, 0, 4], width: 10 },
];
const index = roadIndex(roads);
assert.equal(surfaceAt(index, 49.9, 0, roads[0], 0).id, "ground");
assert.equal(surfaceAt(index, 50.1, 0, roads[1], 4).id, "bridge");
console.log("road preparation and surface contact checks passed");
