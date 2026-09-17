import assert from "node:assert/strict";
import { PREPARED_ROAD_SCHEMA_VERSION, prepareAssets, surfacePolygon, taperZones } from "./prepare.mjs";
import { prepareRoads, roadVisible, laneLayout, nominalHeight } from "./road-network.mjs";
import { roadIndex, surfaceAt, retainElevated, pastSegmentEnd, pickNightLights, widthAt, stopLines, hatchBars } from "../app/js/roads.js";

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
const { tunnelPassage, trafficSignal, busShelter } = await import("../app/js/geometry.js");
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
const { stepCar, spawnPose } = await import('../app/js/physics.js');
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

// Shared preparation entry: one representation for rendering, contact,
// clearance widths and spawn data, with explicit surface polygons.
assert.equal(PREPARED_ROAD_SCHEMA_VERSION, 9);
const sharedFeatures = [
  road('shared-ground', [[103.85, 1.29], [103.851, 1.29]], { highway: 'primary' }),
  road('shared-bridge', [[103.851, 1.29], [103.852, 1.29]], { highway: 'primary', bridge: 'yes' }),
];
const first = prepareAssets(sharedFeatures, center);
const second = prepareAssets(sharedFeatures, center);
assert.deepEqual(first.samples, second.samples, 'Repeated preparation must be deterministic');
assert.deepEqual([...first.widths.values()], [...second.widths.values()]);
assert(Array.isArray(first.warnings));
assert(first.roads.length === 2);
for (const entry of first.roads) {
  assert(entry.samples.length >= 2 && entry.samples.every((p) => p.length === 6 && p.every(Number.isFinite)));
  assert(entry.width >= 4 && entry.width <= 32);
  assert(entry.laneLayout.total >= 1);
}
const straight = first.roads[0];
const ring = surfacePolygon(straight.samples, straight.width);
assert.equal(ring.length, straight.samples.length * 2 + 1, 'Polygon joins every cross-section without gaps');
assert.deepEqual(ring[0], ring.at(-1), 'Polygon ring is closed across the endpoint caps');
assert(Math.abs(Math.hypot(ring[0][0] - ring.at(-2)[0], ring[0][1] - ring.at(-2)[1]) - straight.width) < 0.01,
  'Endpoint cap spans the full road width');
assert.deepEqual(surfacePolygon([straight.samples[0]], straight.width), []);
console.log('shared preparation, schema version and surface polygon checks passed');

// Non-"no" bridge/tunnel values order levels; covered alone never implies underground.
assert.equal(nominalHeight({ bridge: "viaduct" }), 4);
assert.equal(nominalHeight({ tunnel: "building_passage" }), -4);
assert.equal(nominalHeight({ tunnel: "yes", covered: "yes" }), -4);
assert.equal(nominalHeight({ covered: "yes" }), 0);
assert.equal(nominalHeight({ layer: 2 }), 8);
assert.equal(nominalHeight({ layer: -1 }), -4);
const covered = prepareRoads([
  road("covered-road", [[103.85, 1.29], [103.851, 1.29]], { highway: "primary", covered: "yes" }),
], center);
assert(covered.samples.get("covered-road").every((p) => p[2] === 0));

// Losing contact past an elevated deck end retains position and height;
// lateral departures and ground roads keep existing behavior.
const deck = { a: [0, 0, 4], b: [100, 0, 4], width: 10 };
assert(pastSegmentEnd(deck, 101, 0));
assert(pastSegmentEnd(deck, -1, 0));
assert(!pastSegmentEnd(deck, 50, 30));
assert(!pastSegmentEnd(deck, 50, 0));
assert(retainElevated(deck, 4, 101, 0));
assert(retainElevated({ ...deck, a: [0, 0, -4], b: [100, 0, -4] }, -4, 101, 0));
assert(!retainElevated(deck, 4, 50, 30), "Side departures must still fall to ground");
assert(!retainElevated({ ...deck, a: [0, 0, 0], b: [100, 0, 0] }, 0, 101, 0));
assert(!retainElevated(null, 4, 101, 0));
console.log("covered levels and elevated edge retention checks passed");

// Width-derived one-way counts use a 3.2 m target lane width; impossible
// directional totals report and fall back to the class default.
assert.equal(laneLayout({ highway: "primary", oneway: "yes", width: "12" }).forward, 4);
const inconsistent = laneLayout({ highway: "residential", lanes: "3", "lanes:forward": "2", "lanes:backward": "2" });
assert.deepEqual([inconsistent.forward, inconsistent.backward, inconsistent.total], [1, 1, 2]);
assert.deepEqual(inconsistent.warnings, ["inconsistent lanes"]);
const overfilled = laneLayout({ highway: "residential", lanes: "2", "lanes:forward": "2" });
assert.deepEqual([overfilled.forward, overfilled.backward], [1, 1]);
assert.deepEqual(overfilled.warnings, ["inconsistent lanes"]);
assert.deepEqual(laneLayout({ highway: "residential", lanes: "3" }), {
  forward: 2, backward: 1, oneWay: false, reverse: false, total: 3, turnLanes: "", maxspeed: "",
});

// Night lighting serves at most the eight nearest lamp heads within 100 m.
const lampGrid = Array.from({ length: 12 }, (_, i) => [i * 10, 7, 0]);
assert.deepEqual(pickNightLights(lampGrid, 0, 0).map((p) => p[0]),
  [0, 10, 20, 30, 40, 50, 60, 70]);
assert.equal(pickNightLights([[150, 7, 0]], 0, 0).length, 0);
assert.equal(pickNightLights(lampGrid, 0, 0, 8, 25).length, 3);
console.log("lane estimates and night light budget checks passed");

// Roadside signal heads stand left of the way direction with double-faced
// red/amber/green aspects, red lit.
const signal = trafficSignal(0, 0, 0, 10, 0, 8);
assert.equal(signal.housing.length, 2);
assert.equal(signal.lamps.length, 6);
const finite = (g) => [...g.attributes.position.array].every(Number.isFinite);
assert([...signal.housing, ...signal.lamps].every(finite));
const box = (g) => { g.computeBoundingBox(); return g.boundingBox; };
const poleBox = box(signal.housing[0]);
assert(Math.abs((poleBox.max.z + poleBox.min.z) / 2 - 5.2) < 0.01, "Pole stands left of travel");
assert(Math.abs(poleBox.max.y - 4.6) < 0.01);
const housingBox = box(signal.housing[1]);
assert(Math.abs((housingBox.max.y - housingBox.min.y) - 1.0) < 0.01);
assert(Math.abs((housingBox.max.y + housingBox.min.y) / 2 - 4.1) < 0.01);
const lampCenters = signal.lamps.map((g) => {
  const b = box(g); return [(b.max.x + b.min.x) / 2, (b.max.y + b.min.y) / 2, (b.max.z + b.min.z) / 2];
});
assert(lampCenters.every(([, y]) => y > 3.7 && y < 4.5));
assert(lampCenters.every(([x]) => Math.abs(Math.abs(x) - 0.13) < 0.01), "Aspects face along the road");
const red = signal.lamps[0].attributes.color.array;
assert(Math.abs(red[0] - 1) < 0.01 && red[1] < 0.25, "Red aspect lit");
const amber = signal.lamps[2].attributes.color.array;
assert(amber[0] < 0.5, "Amber aspect dimmed");
const again = trafficSignal(0, 0, 0, 10, 0, 8);
assert.equal(again.housing[0].attributes.position.array[0], signal.housing[0].attributes.position.array[0]);
console.log("traffic signal head checks passed");

// Spawn poses use the outermost legal lane matching the heading, corrected
// on one-way roads, exactly where forward traffic drives.
const { placeVehicle } = await import('../app/js/traffic-sim.js');
const twoWay = { a: [0, 0, 0], b: [100, 0, 0], width: 10, x: 50, z: 0,
  laneLayout: { forward: 1, backward: 1, total: 2 } };
const pose = spawnPose(twoWay, Math.PI / 2);
assert.deepEqual([pose.x, pose.z], [50, 2.5]);
assert(Math.abs(pose.yaw - Math.PI / 2) < 1e-9);
const npc = { road: twoWay, direction: 1, t: 0.5, speed: 0 };
placeVehicle(npc);
assert.deepEqual([pose.x, pose.z, pose.yaw], [npc.x, npc.z, npc.yaw]);
const reverse = { ...twoWay, laneLayout: { forward: 0, backward: 2, total: 2, oneWay: true, reverse: true } };
const reversePose = spawnPose(reverse, Math.PI / 2);
assert.deepEqual([reversePose.x, reversePose.z], [50, -2.5]);
assert(Math.abs(reversePose.yaw + Math.PI / 2) < 1e-9, "Reverse one-way spawn faces backward");
const corrected = spawnPose({ ...twoWay, laneLayout: { forward: 2, backward: 0, total: 2, oneWay: true, reverse: false } }, -Math.PI / 2);
assert(Math.abs(corrected.yaw - Math.PI / 2) < 1e-9, "One-way spawn corrects wrong-way headings");
assert.deepEqual([corrected.x, corrected.z], [50, 2.5]);
const shared = spawnPose({ ...twoWay, laneLayout: { forward: 1, backward: 0, total: 1 } }, Math.PI / 2);
assert.deepEqual([shared.x, shared.z], [50, 0], "Shared single lane spawns centered");
const unmarked = spawnPose({ a: [0, 0, 0], b: [100, 0, 0], width: 10, x: 50, z: 0 }, Math.PI / 2);
assert.deepEqual([unmarked.x, unmarked.z], [50, 2.4]);
console.log("legal spawn offset checks passed");

// Lane-merge tapers ease the wider side down to a narrower degree-1
// continuation; junctions and matched widths stay constant.
assert.equal(widthAt([], 5, 10), 10);
assert.equal(widthAt([{ d0: 0, d1: 20, w0: 6, w1: 10 }], 0, 10), 6);
assert.equal(widthAt([{ d0: 0, d1: 20, w0: 6, w1: 10 }], 20, 10), 10);
assert.equal(widthAt([{ d0: 0, d1: 20, w0: 6, w1: 10 }], 10, 10), 8);
assert.equal(widthAt([{ d0: 0, d1: 20, w0: 6, w1: 10 }], 30, 10), 10);
assert.deepEqual(taperZones([[0, 0, 0, 0, 0, 1]], 10, 6, 6), []);
const mergeJunction = [103.85, 1.29], mergeEnd = [103.85, 1.2901];
const merge = prepareAssets([
  road("merge-wide", [[103.849, 1.29], mergeJunction], { highway: "primary", lanes: "3", endNodeId: "merge-j" }),
  road("merge-narrow", [mergeJunction, mergeEnd], { highway: "primary", lanes: "2", startNodeId: "merge-j" }),
], center);
const wide = merge.roads.find((r) => r.id === "merge-wide");
const narrow = merge.roads.find((r) => r.id === "merge-narrow");
assert.equal(wide.width, 9.9);
assert.equal(narrow.width, 6.8);
assert.equal(wide.tapers.length, 1, "Wider side tapers to the merge");
assert.deepEqual(narrow.tapers, [], "Narrower side stays constant");
const [zone] = wide.tapers;
assert(Math.abs((zone.d1 - zone.d0) - 24.8) < 0.01, "Taper runs ~8 m per metre of width lost");
assert.equal(zone.w0, 9.9, "Interior side keeps full width");
assert.equal(zone.w1, 6.8, "Boundary matches the narrower road exactly");
assert.equal(zone.d1, wide.samples.at(-1)[3]);
assert.equal(widthAt(wide.tapers, zone.d1, wide.width), 6.8);
const forked = prepareAssets([
  road("merge-wide", [[103.849, 1.29], mergeJunction], { highway: "primary", lanes: "3", endNodeId: "merge-j" }),
  road("merge-narrow", [mergeJunction, mergeEnd], { highway: "primary", lanes: "2", startNodeId: "merge-j" }),
  road("merge-branch", [mergeJunction, [103.8501, 1.2901]], { highway: "primary", lanes: "2", startNodeId: "merge-j" }),
], center);
assert.deepEqual(forked.roads.find((r) => r.id === "merge-wide").tapers, [], "Junction ends keep full width");
const { ribbon } = await import("../app/js/geometry.js");
const tapered = ribbon([0, 0, 0, 0, 0, 1], [10, 0, 0, 10, 0, 1], [8, 4], 0, "#fff", 0);
const zAt = (i) => tapered.attributes.position.array[i * 3 + 2];
assert.equal(Math.abs(zAt(0)), 4, "Wide end keeps full half width");
assert.equal(Math.abs(zAt(2)), 4);
assert.equal(Math.abs(zAt(5)), 4, "Shared a-end vertex reused by both triangles");
for (const i of [1, 3, 4]) assert.equal(Math.abs(zAt(i)), 2, "Narrow end tapers down");
console.log("lane-merge taper checks passed");

// Stop lines sit 2 m upstream of the signal per legal direction, spanning
// that direction's lanes on the left-hand side.
const twoWayLanes = { forward: 1, backward: 1, total: 2 };
const stops = stopLines(0, 0, 1.5, 10, 0, 10, twoWayLanes);
assert.equal(stops.length, 2);
const fwd = stops.find((l) => l.lateral > 0), bwd = stops.find((l) => l.lateral < 0);
assert.deepEqual([fwd.ax, fwd.az, fwd.bx, fwd.bz, fwd.y], [-2, 2.5, -2, -2.5, 1.5]);
assert.deepEqual([bwd.ax, bwd.az, bwd.bx, bwd.bz, bwd.y], [2, 2.5, 2, -2.5, 1.5]);
const oneWayStops = stopLines(0, 0, 0, 10, 0, 10, { forward: 2, backward: 0, total: 2, oneWay: true, reverse: false });
assert.equal(oneWayStops.length, 1);
assert.deepEqual([oneWayStops[0].ax, oneWayStops[0].az, oneWayStops[0].bx, oneWayStops[0].bz], [-2, 5, -2, -5]);
const reverseStops = stopLines(0, 0, 0, 10, 0, 10, { forward: 0, backward: 2, total: 2, oneWay: true, reverse: true });
assert.equal(reverseStops.length, 1);
assert.deepEqual([reverseStops[0].ax, reverseStops[0].az], [2, 5]);
assert.equal(stopLines(0, 0, 0, 10, 0, 10, null).length, 2);
console.log("signal stop line checks passed");

// Box-junction hatching tiles pairs deterministically with alternating
// diagonals, clamped to pair bounds.
const bars = hatchBars(0, 12);
assert.deepEqual(bars.map((b) => [b.lo, b.hi]), [[0, 2.4], [5, 7.4], [10, 12]]);
assert.deepEqual(bars.map((b) => b.flip), [false, true, false]);
assert.deepEqual(hatchBars(3, 14).map((b) => b.lo), [5, 10]);
assert.deepEqual(hatchBars(0, 1), [{ lo: 0, hi: 1, flip: false }]);
assert.deepEqual(hatchBars(5, 5), []);
const offset = hatchBars(2, 9);
assert.deepEqual(offset.map((b) => [b.lo, b.hi, b.flip]), [[5, 7.4, true]], "Phase follows absolute distance");
console.log("junction hatch checks passed");

// Bus shelters run parallel to the road, left of the way direction, with
// roof, poles, bench and an upstream stop sign.
const shelter = busShelter(0, 0, 0, 10, 0, 8);
assert.equal(shelter.length, 7);
assert(shelter.every((g) => [...g.attributes.position.array].every(Number.isFinite)));
const boundsOf = (parts) => {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of parts) {
    g.computeBoundingBox();
    for (const axis of [0, 1, 2]) {
      min[axis] = Math.min(min[axis], g.boundingBox.min[["x", "y", "z"][axis]]);
      max[axis] = Math.max(max[axis], g.boundingBox.max[["x", "y", "z"][axis]]);
    }
  }
  return { min, max };
};
const bounds = boundsOf(shelter);
assert(Math.abs((bounds.min[2] + bounds.max[2]) / 2 - 6.2) < 0.01, "Shelter stands left of travel");
assert(Math.abs(bounds.max[1] - 2.59) < 0.01, "Roof caps the shelter");
assert(Math.abs(bounds.min[1]) < 0.01, "Poles reach the ground");
const roofBox = shelter[0];
roofBox.computeBoundingBox();
assert(Math.abs((roofBox.boundingBox.max.x - roofBox.boundingBox.min.x) - 3.6) < 0.01, "Shelter runs along the road");
const repeat = busShelter(0, 0, 0, 10, 0, 8);
assert.equal(repeat[0].attributes.position.array[0], shelter[0].attributes.position.array[0]);
console.log("bus shelter checks passed");
