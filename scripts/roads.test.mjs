import assert from "node:assert/strict";
import { prepareRoads } from "./road-network.mjs";
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

const roads = [
  { id: "ground", featureId: "ground", connections: ["bridge"], a: [0, 0, 0], b: [100, 0, 0], width: 10 },
  { id: "bridge", featureId: "bridge", connections: ["ground"], a: [0, 0, 4], b: [100, 0, 4], width: 10 },
];
const index = roadIndex(roads);
assert.equal(surfaceAt(index, 49.9, 0, roads[0], 0).id, "ground");
assert.equal(surfaceAt(index, 50.1, 0, roads[1], 4).id, "bridge");
console.log("road preparation and surface contact checks passed");
