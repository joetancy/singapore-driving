import assert from 'node:assert/strict';
import { VEHICLES, trafficLimit, trafficGraph, nextRoad, advanceVehicle, placeVehicle, collideVehicles } from '../app/js/traffic-sim.js';
const road = (id, a, b, featureId = id) => ({id, a, b, featureId, width: 7, connections: ['b'], laneLayout: {forward: 1, backward: 1, total: 2}});
const a = road('a', [0, 0, 0], [10, 0, 0]);
const b = road('b', [10, 0, 0], [20, 0, 0]);
const overhead = road('overhead', [10, 0, 4], [20, 0, 4]);
const vehicle = {...VEHICLES.car, road: a, direction: 1, t: 0.95, speed: 10};
placeVehicle(vehicle);
assert(vehicle.z > 0, 'Forward traffic keeps left');
assert.equal(nextRoad(vehicle, trafficGraph([a, b, overhead]), () => 0).road.id, 'b');
advanceVehicle(vehicle, 0.1, trafficGraph([a, b]), () => 0);
assert.equal(vehicle.road.id, 'b');
assert(Math.abs(vehicle.x - 10.5) < 0.0001);
assert.equal(nextRoad({...vehicle, road: a}, trafficGraph([a, {...b, connections: [], laneLayout: {forward: 0, backward: 1, total: 1}}])), null);
assert.equal(trafficLimit(0), 0);
assert.equal(trafficLimit(100), 60);
assert.equal(trafficLimit(1000), 60);
assert.equal(trafficLimit('invalid'), 0);
for (const [type, spec] of Object.entries(VEHICLES)) {
  const player = {...VEHICLES.car, x: 0, y: 0, z: 0, yaw: 0, speed: 20};
  const npc = {...spec, x: 0, y: 0, z: -(player.length + spec.length) / 2 + 0.2, yaw: 0, speed: 0};
  assert(collideVehicles(player, npc), `${type} collision`);
  assert(player.speed < 20);
  assert(npc.speed > 0);
  assert(Number.isFinite(player.x + player.z + player.speed));
}
assert(!collideVehicles({...VEHICLES.car, x:0,y:0,z:0,yaw:0,speed:20}, {...VEHICLES.bus,x:0,y:-4,z:0,yaw:0,speed:0}), 'No collisions between stacked levels');
assert(!collideVehicles({...VEHICLES.car, x:0,y:0,z:0,yaw:0,speed:20}, {...VEHICLES.car,x:8,y:0,z:0,yaw:0,speed:0}));
console.log('Traffic routing, lane direction, density, and vehicle collision checks passed');

// Exercise real Three.js traffic meshes, gradual spawning, and immediate Off.
const THREE = await import('../public/vendor/three.module.js');
const { createTraffic } = await import('../app/js/traffic.js');
const scene = new THREE.Scene(), traffic = createTraffic(scene);
const trafficRoads = Array.from({length: 12}, (_, i) => road(`spawn-${i}`, [80, i * 14 - 80, 0], [240, i * 14 - 80, 0]));
traffic.syncRoads(trafficRoads);
traffic.density(30);
const player = {x: 0, z: 0, yaw: 0, speed: 0};
const originalRandom = Math.random;
let seed = 12345;
Math.random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
try {
  for (let i = 0; i < 600; i++) traffic.step(0.01, player, 0);
  assert(scene.children.length > 0 && scene.children.length <= 18);
  scene.traverse(object => { if (object.isMesh) assert(Number.isFinite(object.position.x + object.position.y + object.position.z)); });
  traffic.density(0);
  assert.equal(scene.children.length, 0);
  for (let i = 0; i < 50; i++) traffic.step(0.01, player, 0);
  assert.equal(scene.children.length, 0);
  traffic.density(100);
  for (let i = 0; i < 100; i++) traffic.step(0.01, player, 0);
  traffic.syncRoads([]);
  assert.equal(scene.children.length, 0, 'Unloaded roads must remove their traffic');
} finally { Math.random = originalRandom; }
console.log('Traffic mesh spawning, Off setting, and chunk cleanup checks passed');
