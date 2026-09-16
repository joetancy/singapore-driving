import assert from "node:assert/strict";
import { prepareRoads, roadVisible, laneLayout } from "./road-network.mjs";
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
  road("side-road", [bridgeEnd, [103.8503, 1.29008]]),
  road("surface-by-tunnel", [[103.8506, 1.29], [103.8512, 1.29]]),
  road("tunnel", [[103.8512, 1.29], [103.8514, 1.29]], { tunnel: "yes", layer: -1 }),
], center);
const heights = (id) => regression.samples.get(id).map((p) => p[2]);
assert(heights("tunnel").length >= 2);
assert.equal(roadVisible({ tunnel: "yes" }), true);
assert.equal(roadVisible({ layer: -1 }), true);
assert(heights("tunnel").every((h) => h === -4));
assert.equal(heights("surface-by-tunnel").at(-1), -4);
assert.equal(heights("surface-by-tunnel")[0], 0);
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
assert([...regression.samples.values()].flat().every((p) => Number.isFinite(p[2])));

const identities = prepareRoads([
  road("identity-a", [[103.853, 1.29], [103.8531, 1.29]], { endNodeId: "10" }),
  road("identity-b", [[103.8531, 1.29], [103.8532, 1.29]], { startNodeId: "11" }),
  road("identity-c", [[103.8531, 1.29], [103.8531, 1.2901]], { startNodeId: "10" }),
], center);
assert(!identities.connections.get("identity-a").end.includes("identity-b"));
assert(identities.connections.get("identity-a").end.includes("identity-c"));

assert.deepEqual(laneLayout({ highway: "residential" }), {
  forward: 1, backward: 1, oneWay: false, reverse: false, total: 2, turnLanes: "", maxspeed: "",
});
assert.deepEqual(laneLayout({ highway: "primary", oneway: "yes", lanes: "3", "turn:lanes": "left|through|right", maxspeed: "50" }), {
  forward: 3, backward: 0, oneWay: true, reverse: false, total: 3,
  turnLanes: "left|through|right", maxspeed: "50",
});
assert.deepEqual(laneLayout({ highway: "primary", "lanes:forward": "2" }), {
  forward: 2, backward: 1, oneWay: false, reverse: false, total: 3, turnLanes: "", maxspeed: "",
});
assert.deepEqual(laneLayout({ highway: "service", oneway: "-1", lanes: "1" }), {
  forward: 0, backward: 1, oneWay: true, reverse: true, total: 1, turnLanes: "", maxspeed: "",
});
assert.equal(laneLayout({ highway: "motorway", oneway: "no" }).oneWay, false);
assert.deepEqual(laneLayout({ highway: "residential", lanes: "x" }).warnings, ["invalid lanes"]);

const layered = prepareRoads([
  road("layer-deck", [[103.852, 1.29], [103.8521, 1.29]], { layer: 1 }),
  road("layer-ramp", [[103.8521, 1.29], [103.8526, 1.29]]),
], center);
assert.equal(layered.samples.get("layer-ramp")[0][2], 4);
assert.equal(layered.samples.get("layer-ramp").at(-1)[2], 0);

const roads = [
  { id: "ground", featureId: "ground", connections: ["bridge"], a: [0, 0, 0], b: [100, 0, 0], width: 10 },
  { id: "bridge", featureId: "bridge", connections: ["ground"], a: [0, 0, 4], b: [100, 0, 4], width: 10 },
];
const index = roadIndex(roads);
assert.equal(surfaceAt(index, 49.9, 0, roads[0], 0).id, "ground");
assert.equal(surfaceAt(index, 50.1, 0, roads[1], 4).id, "bridge");

const tunnelRoads = [
  { id: "portal", featureId: "portal", connections: ["tunnel"], a: [0, 0, 0], b: [50, 0, -4], width: 10 },
  { id: "tunnel", featureId: "tunnel", connections: ["portal"], a: [50, 0, -4], b: [100, 0, -4], width: 10 },
];
const tunnelIndex = roadIndex(tunnelRoads);
assert.equal(surfaceAt(tunnelIndex, 50.7, 0, tunnelRoads[0], -4).id, "tunnel");
console.log("road preparation and surface contact checks passed");
