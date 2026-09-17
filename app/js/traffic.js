import * as THREE from '../../public/vendor/three.module.js';
import { VEHICLES, trafficLimit, trafficGraph, allowedDirection, placeVehicle, advanceVehicle, collideVehicles, signalLimit } from './traffic-sim.js';

export function createTraffic(scene) {
  let roads = [], graph = new Map(), target = 18, timer = 0, simTime = 0;
  let signals = new Map();
  const vehicles = [];
  const box = new THREE.BoxGeometry(1, 1, 1);
  const bodyMaterials = Object.fromEntries(Object.entries(VEHICLES).map(([k, v]) => [k, new THREE.MeshStandardMaterial({ color: v.color, roughness: 0.65 })]));
  const glass = new THREE.MeshStandardMaterial({color: 0x223746, roughness: 0.3});
  const rubber = new THREE.MeshStandardMaterial({color: 0x151b20});
  const light = new THREE.MeshBasicMaterial({color: 0xffe5ab});
  function mesh(type) {
    const spec = VEHICLES[type], group = new THREE.Group();
    const part = (w, h, l, x, y, z, material) => {
      const m = new THREE.Mesh(box, material); m.scale.set(w, h, l); m.position.set(x, y, z); group.add(m);
    };
    part(spec.width, spec.height * 0.55, spec.length, 0, spec.height * 0.45, 0, bodyMaterials[type]);
    if (type === 'motorcycle') {
      part(0.45, 0.75, 0.55, 0, 1.05, 0, rubber);
    } else if (type === 'lorry') {
      part(spec.width * 0.98, 1.9, spec.length * 0.65, 0, 1.6, 0.8, bodyMaterials[type]);
      part(spec.width * 0.85, 0.6, 1.3, 0, 1.9, -spec.length * 0.35, glass);
    } else {
      part(spec.width * 0.86, spec.height * 0.4, spec.length * (type === 'bus' ? 0.88 : 0.55), 0, spec.height * 0.82, 0, glass);
    }
    for (const z of [-spec.length * 0.32, spec.length * 0.32])
      for (const side of type === 'motorcycle' ? [0] : [-1, 1])
        part(0.22, 0.55, 0.55, side * spec.width * 0.49, 0.3, z, rubber);
    for (const side of [-1, 1]) part(0.2, 0.15, 0.05, side * spec.width * 0.3, 0.7, -spec.length / 2 - 0.02, light);
    scene.add(group); return group;
  }
  const remove = i => { scene.remove(vehicles[i].mesh); vehicles.splice(i, 1); };
  function syncRoads(next, signalList = []) {
    roads = next; graph = trafficGraph(roads);
    signals = new Map();
    for (const s of signalList) {
      if (!signals.has(s.roadId)) signals.set(s.roadId, []);
      signals.get(s.roadId).push(s);
    }
    const ids = new Set(roads.map(r => r.id));
    for (let i = vehicles.length - 1; i >= 0; i--) if (!ids.has(vehicles[i].road.id)) remove(i);
  }
  function density(value) {
    target = trafficLimit(value);
    while (vehicles.length > target) remove(vehicles.length - 1);
  }
  function spawn(player) {
    const types = ['car', 'car', 'car', 'bus', 'motorcycle', 'motorcycle', 'lorry'];
    const type = types[Math.floor(Math.random() * types.length)], spec = VEHICLES[type];
    for (let attempt = 0; attempt < 35 && roads.length; attempt++) {
      const road = roads[Math.floor(Math.random() * roads.length)];
      if (road.width / (road.laneLayout?.total || 2) < spec.width + 0.15) continue;
      // Taller vehicles do not fit every tunnel approach.
      if (road.tunnel && spec.height > 2.8) continue;
      let direction = Math.random() < 0.5 ? 1 : -1;
      if (!allowedDirection(road, direction)) direction *= -1;
      if (!allowedDirection(road, direction)) continue;
      const v = { ...spec, type, road, direction, t: Math.random(), speed: spec.speed * 0.65, cruise: spec.speed };
      placeVehicle(v);
      const distance = Math.hypot(v.x - player.x, v.z - player.z);
      if (distance < 55 || distance > 260 || vehicles.some(q => Math.hypot(v.x - q.x, v.z - q.z) < (q.length + v.length) / 2 + 8 && Math.abs(v.y - q.y) < 2)) continue;
      v.mesh = mesh(type); vehicles.push(v); return;
    }
  }
  function step(dt, player, height) {
    timer += dt; simTime += dt;
    if (timer > 0.2) { timer = 0; if (vehicles.length < target) spawn(player); }
    const driver = { ...player, ...{width: 1.9, length: 4.5, mass: 1500, y: height} };
    for (let i = vehicles.length - 1; i >= 0; i--) {
      const v = vehicles[i];
      const distance = Math.hypot(v.x - player.x, v.z - player.z);
      if (distance > 330 || (v.deadEnd && distance > 65)) { remove(i); continue; }
      let desired = v.deadEnd ? 0 : v.cruise;
      // Nearby AI stops for red signals; the player is never restricted.
      desired = Math.min(desired, signalLimit(signals, simTime, v));
      const fx = Math.sin(v.yaw), fz = -Math.cos(v.yaw);
      for (const q of [...vehicles, driver]) {
        if (q === v || Math.abs(q.y - v.y) > 1.5) continue;
        const dx = q.x - v.x, dz = q.z - v.z, ahead = dx * fx + dz * fz;
        if (ahead <= 0 || Math.abs(dx * fz - dz * fx) > (q.width + v.width) / 2 + 0.4) continue;
        const gap = ahead - (q.length + v.length) / 2;
        desired = Math.min(desired, Math.max(0, (gap - 4) / 1.8));
      }
      v.speed = Math.max(0, v.speed + Math.max(-7 * dt, Math.min(2 * dt, desired - v.speed)));
      advanceVehicle(v, dt, graph);
      collideVehicles(driver, v);
      v.mesh.position.set(v.x, v.y + 0.08, v.z); v.mesh.rotation.y = -v.yaw;
    }
    player.x = driver.x; player.z = driver.z; player.speed = driver.speed;
  }
  return { syncRoads, density, step, clear() { while (vehicles.length) remove(vehicles.length - 1); } };
}
