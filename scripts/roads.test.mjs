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

// Separate underground passages cannot transfer at an undeclared crossing.
const crossing = [
  { id: "east", featureId: "east", connections: [], a: [-20, 0, -4], b: [20, 0, -4], width: 6 },
  { id: "north", featureId: "north", connections: [], a: [0, -20, -4], b: [0, 20, -4], width: 6 },
];
assert.equal(surfaceAt(roadIndex(crossing), 0, 5, crossing[0], -4), null);
const crossingLevels = prepareRoads([
  road("below-in", [[103.849, 1.29], junction], { tunnel: "yes" }),
  road("below-out", [junction, [103.851, 1.29]], { tunnel: "yes" }),
  road("surface-out", [junction, [103.851, 1.2901]]),
], center);
assert(crossingLevels.samples.get("surface-out").every(p => p[2] === 0));
const { tunnelPassage } = await import("../app/js/geometry.js");
const passage = tunnelPassage([0, 0, -4, 0, 0, 1], [10, 0, -4, 10, 0, 1], 12);
const positions = passage.attributes.position;
for (let i = 0; i < positions.count; i++) assert(positions.getY(i) < 0, "Tunnel roof must stay below surface roads");
passage.dispose();

// Single-lane slip roads must not inherit an oversized multi-lane surface.
const { roadWidth } = await import('./road-network.mjs');
assert.equal(roadWidth({ highway: 'motorway_link', lanes: '1' }), 4.5);
assert.equal(roadWidth({ highway: 'motorway', lanes: '3' }), 11.5);
assert.equal(roadWidth({ highway: 'motorway_link', width: '6.2', lanes: '1' }), 6.2);

// An explicit off-ramp joins the elevated mainline even at a diverging angle.
const interchange = prepareRoads([
  road('main-in', [[103.849, 1.29], junction], { highway: 'motorway', bridge: 'yes', endNodeId: 'ramp-node' }),
  road('main-out', [junction, [103.851, 1.29]], { highway: 'motorway', bridge: 'yes', startNodeId: 'ramp-node' }),
  road('off-ramp', [junction, [103.8506, 1.2906]], { highway: 'motorway_link', startNodeId: 'ramp-node' }),
], center);
const rampSamples = interchange.samples.get('off-ramp');
assert.equal(rampSamples[0][2], 4);
assert.equal(rampSamples.at(-1)[2], 0);
for (let i = 1; i < rampSamples.length; i++) {
  const a = rampSamples[i - 1], b = rampSamples[i];
  assert(Math.abs(b[2] - a[2]) / Math.hypot(b[0] - a[0], b[1] - a[1]) <= 0.08);
}
// A bend between separate OSM ways shares a watertight mitered cross section.
const bend = prepareRoads([
  road('bend-a', [[103.849, 1.29], junction]),
  road('bend-b', [junction, [103.8507, 1.2907]]),
], center);
const bendA = bend.samples.get('bend-a').at(-1), bendB = bend.samples.get('bend-b')[0];
assert(Math.abs(bendA[4] - bendB[4]) < 0.001);
assert(Math.abs(bendA[5] - bendB[5]) < 0.001);
assert(regression.samples.get('surface-by-tunnel').some(p => Math.abs(p[2] + 3.85) < 0.00001));

const { prepareLayout } = await import('./road-layout.mjs');
const overlapFeatures = [road('lower', [[0, 0], [1, 1]]), road('upper', [[0, 0], [1, 1]])];
const overlapSamples = new Map([
  ['lower', [[-8, 0, 0, 0, 0, 1], [8, 0, 0, 16, 0, 1]]],
  ['upper', [[0, -8, 4, 0, -1, 0], [0, 8, 4, 16, -1, 0]]],
]);
const layout = prepareLayout(overlapFeatures, overlapSamples);
assert(layout.segments.get('lower')[0].noLamps);
assert(layout.segments.get('upper')[0].noLamps);
assert(layout.segments.get('upper')[0].noPier);
assert(!layout.segments.get('lower')[0].left);
assert(!layout.segments.get('lower')[0].right);
const isolated = prepareLayout([overlapFeatures[0]], overlapSamples);
assert(!isolated.segments.get('lower')[0].noLamps);
const openPassage = tunnelPassage([0, 0, -4, 0, 0, 1], [10, 0, -4, 10, 0, 1], 12, 3.5, { left: true });
assert.equal(openPassage.attributes.position.count, 12); // Remaining wall and roof.
openPassage.dispose();
const { taperedRibbon } = await import('../app/js/geometry.js');
const taper = taperedRibbon([0, 0, 0, 0, 0, 1], [10, 0, 0, 10, 0, 1], 6, 12, 0, '#fff');
const taperPositions = taper.attributes.position;
assert.equal(taperPositions.count, 6);
assert.equal(Math.abs(taperPositions.getZ(0)), 3);
assert.equal(Math.abs(taperPositions.getZ(1)), 6);
taper.dispose();
console.log('ramp joins, portal thresholds, widths and global overlap checks passed');

// Height propagation must follow a bending slip road, not stop at a 30° turn.
const bentRamp = prepareRoads([
  road('ramp-deck', [[103.849, 1.29], junction], { bridge: 'yes', endNodeId: 'curve-start' }),
  road('curve-1', [junction, [103.8501, 1.29]], { highway: 'motorway_link', startNodeId: 'curve-start', endNodeId: 'curve-bend' }),
  road('curve-2', [[103.8501, 1.29], [103.8501, 1.291]], { highway: 'motorway_link', startNodeId: 'curve-bend' }),
], center);
assert.equal(bentRamp.samples.get('curve-1').at(-1)[2], bentRamp.samples.get('curve-2')[0][2]);
assert.equal(bentRamp.samples.get('curve-2').at(-1)[2], 0);
assert.equal(laneLayout({ highway: 'motorway' }).total, 3);
const duplicates = prepareLayout(overlapFeatures, new Map([
  ['lower', [[-8, 0, 0, 0, 0, 1], [8, 0, 0, 16, 0, 1]]],
  ['upper', [[-8, 0, 0, 0, 0, 1], [8, 0, 0, 16, 0, 1]]],
]));
assert(duplicates.segments.get('lower')[0].noLamps);

// Leaving mapped asphalt must not change acceleration or impose a speed cap.
const { stepCar } = await import('../app/js/physics.js');
const onAsphalt = { x: 0, z: 0, yaw: 0, steer: 0, speed: 40 };
const offAsphalt = { ...onAsphalt };
for (let i = 0; i < 120; i++) {
  stepCar(onAsphalt, { forward: true }, 1 / 60, true);
  stepCar(offAsphalt, { forward: true }, 1 / 60, false);
}
assert.deepEqual(offAsphalt, onAsphalt);
assert(offAsphalt.speed > 40, 'Off-road throttle must still accelerate above the old limit');

const { drivingContact } = await import('../app/js/roads.js');
const tunnelEdge = { ...tunnelRoads[1], tunnel: true };
const underSurface = { id: 'surface-above', a: [50, 0, 0], b: [100, 0, 0], width: 20 };
const edgeIndex = roadIndex([tunnelEdge, underSurface]);
const edgeCar = { x: 70, z: 7, speed: 40, yaw: 0 };
const edgeContact = drivingContact(edgeIndex, edgeCar, tunnelEdge, -4);
assert.equal(edgeContact.y, -4);
assert.equal(edgeContact.id, tunnelEdge.id);
assert(edgeCar.z <= tunnelEdge.width / 2 - 1.1 + 1e-9);
assert.equal(edgeCar.speed, 40);
const lostEnd = { x: 110, z: 0, speed: 40 };
assert.equal(drivingContact(edgeIndex, lostEnd, tunnelEdge, -4).y, -4);
assert.equal(lostEnd.x, 100);
// Connected tunnel exits still climb the ramp normally.
const exiting = { id: 'exit', featureId: 'exit', connections: ['tunnel'], a: [100, 0, -4], b: [150, 0, 0], width: 10, tunnel: true };
const connectedTunnel = { ...tunnelEdge, connections: ['exit'] };
assert(drivingContact(roadIndex([connectedTunnel, exiting]), {x: 101, z: 0}, connectedTunnel, -4).y > -4);

const parallelSamples = new Map([
  ['lower', [[0, 0, 0, 0, 0, 1], [20, 0, 0, 20, 0, 1]]],
  ['upper', [[0, 7, 0, 0, 0, 1], [20, 7, 0, 20, 0, 1]]],
]);
const fitted = prepareLayout(overlapFeatures, parallelSamples);
assert((fitted.widths.get('lower') + fitted.widths.get('upper')) / 2 + 1.8 <= 7.00001);
const stackedSamples = new Map(parallelSamples);
stackedSamples.set('upper', [[0, 7, 4, 0, 0, 1], [20, 7, 4, 20, 0, 1]]);
assert.equal(prepareLayout(overlapFeatures, stackedSamples).widths.get('lower'), roadWidth(overlapFeatures[0].properties));
const twinTunnels = new Map([
  ['lower', [[0, 0, -4, 0, 0, 1], [20, 0, -4, 20, 0, 1]]],
  ['upper', [[20, 7, -4, 0, 0, -1], [0, 7, -4, 20, 0, -1]]],
]);
const fittedTunnels = prepareLayout(overlapFeatures, twinTunnels);
assert((fittedTunnels.widths.get('lower') + fittedTunnels.widths.get('upper')) / 2 + 2.5 <= 7.00001);
assert(!fittedTunnels.segments.get('lower')[0].left, 'Adjacent tunnels must retain their separating walls');
