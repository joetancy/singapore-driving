export const VEHICLES = {
  car: { width: 1.8, length: 4.2, height: 1.4, mass: 1400, speed: 15, color: 0x5ba7bd },
  taxi: { width: 1.8, length: 4.4, height: 1.45, mass: 1450, speed: 16, color: 0x2456a6 },
  bus: { width: 2.4, length: 10, height: 3, mass: 11000, speed: 11, color: 0x80bf49 },
  doubleDecker: { width: 2.5, length: 12, height: 4.4, mass: 18000, speed: 10, color: 0x35a05a },
  motorcycle: { width: 0.7, length: 2, height: 1.3, mass: 240, speed: 17, color: 0xe5ab43 },
  lorry: { width: 2.3, length: 7, height: 2.8, mass: 7000, speed: 12, color: 0xc4b9a5 },
};
export const trafficLimit = value => Math.round(Math.max(0, Math.min(100, Number(value) || 0)) * 0.6);
// Independent fixed-time cycles (16 s: green 10, amber 2, red 4) with a
// deterministic per-signal offset, so aspects survive chunk reloads.
// Junction topology and player enforcement stay deferred: heads and stop
// lines are scenery for the player, timing for nearby AI.
export function signalCycle(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 16;
}
export function signalAspect(signal, time) {
  const phase = (((time + signalCycle(signal.id)) % 16) + 16) % 16;
  return phase < 10 ? "green" : phase < 12 ? "amber" : "red";
}
// Speed cap for stopping at a red (or comfortably amber) signal ahead on
// the vehicle's own segment. Signals carry {id, roadId, t}; Infinity when
// clear. Amber proceeds when too close to stop.
export function signalLimit(byRoad, time, v) {
  const r = v.road, len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
  if (!len) return Infinity;
  let cap = Infinity;
  for (const s of byRoad.get(r.id) || []) {
    const ahead = v.direction > 0 ? s.t - v.t : v.t - s.t;
    if (ahead <= 0) continue;
    const dist = ahead * len - (v.length / 2 + 1.5);
    const aspect = signalAspect(s, time);
    if (aspect === "green") continue;
    if (aspect === "amber" && dist < v.speed * 0.7 + 3) continue;
    cap = Math.min(cap, dist <= 0.5 ? 0 : Math.sqrt(6 * dist));
  }
  return cap;
}
const key = p => p.slice(0, 3).map(v => v.toFixed(3)).join(',');
const length = r => Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
export function allowedDirection(r, direction) {
  const lanes = r.laneLayout;
  return !lanes || (direction > 0 ? lanes.forward > 0 : lanes.backward > 0);
}
export function trafficGraph(roads) {
  const nodes = new Map();
  for (const road of roads) for (const [p, direction] of [[road.a, 1], [road.b, -1]]) {
    if (!allowedDirection(road, direction) || length(road) < 0.01) continue;
    const id = key(p);
    if (!nodes.has(id)) nodes.set(id, []);
    nodes.get(id).push({ road, direction });
  }
  return nodes;
}
export function nextRoad(vehicle, graph, random = Math.random) {
  const r = vehicle.road, direction = vehicle.direction;
  const end = direction > 0 ? r.b : r.a;
  const dx = (r.b[0] - r.a[0]) * direction / length(r);
  const dz = (r.b[1] - r.a[1]) * direction / length(r);
  const choices = (graph.get(key(end)) || []).filter(candidate => {
    const q = candidate.road;
    if (q.id === r.id || q.width / (q.laneLayout?.total || 2) < vehicle.width + 0.15) return false;
    if (q.featureId !== r.featureId && !r.connections?.includes(q.featureId)) return false;
    return ((q.b[0] - q.a[0]) * dx + (q.b[1] - q.a[1]) * dz) * candidate.direction / length(q) > -0.5;
  });
  return choices.length ? choices[Math.floor(random() * choices.length)] : null;
}
export function placeVehicle(v) {
  const r = v.road, t = Math.max(0, Math.min(1, v.t)), len = length(r);
  const dx = (r.b[0] - r.a[0]) / len, dz = (r.b[1] - r.a[1]) / len;
  const lanes = r.laneLayout?.total || 2;
  const offset = v.direction * (r.width / 2 - r.width / lanes / 2);
  v.x = r.a[0] + (r.b[0] - r.a[0]) * t + dz * offset;
  v.z = r.a[1] + (r.b[1] - r.a[1]) * t - dx * offset;
  v.y = r.a[2] + (r.b[2] - r.a[2]) * t;
  v.yaw = Math.atan2(dx * v.direction, -dz * v.direction);
}
export function advanceVehicle(v, dt, graph, random = Math.random) {
  let remaining = v.speed * dt;
  for (let i = 0; remaining > 0 && i < 30; i++) {
    const len = length(v.road), available = (v.direction > 0 ? 1 - v.t : v.t) * len;
    if (remaining <= available) { v.t += remaining / len * v.direction; remaining = 0; break; }
    remaining -= available;
    const next = nextRoad(v, graph, random);
    if (!next) { v.t = v.direction > 0 ? 1 : 0; v.speed = 0; v.deadEnd = true; break; }
    v.road = next.road; v.direction = next.direction; v.t = v.direction > 0 ? 0 : 1;
  }
  placeVehicle(v);
}
// Oriented box contact in the road plane, gated by elevation. Positive impulse
// removes closing velocity and a small restitution produces an arcade bump.
export function collideVehicles(a, b) {
  if (Math.abs(a.y - b.y) > 1.5) return false;
  const axes = v => [[Math.sin(v.yaw), -Math.cos(v.yaw)], [Math.cos(v.yaw), Math.sin(v.yaw)]];
  const aa = axes(a), bb = axes(b), dx = b.x - a.x, dz = b.z - a.z;
  let depth = Infinity, normal;
  const radius = (v, axes, n) => Math.abs(axes[0][0] * n[0] + axes[0][1] * n[1]) * v.length / 2 +
    Math.abs(axes[1][0] * n[0] + axes[1][1] * n[1]) * v.width / 2;
  for (const n of [...aa, ...bb]) {
    const d = dx * n[0] + dz * n[1];
    const overlap = radius(a, aa, n) + radius(b, bb, n) - Math.abs(d);
    if (overlap <= 0) return false;
    if (overlap < depth) { depth = overlap; normal = n.map(x => x * (d < 0 ? -1 : 1)); }
  }
  const ia = 1 / a.mass, ib = 1 / b.mass, total = ia + ib;
  a.x -= normal[0] * depth * ia / total; a.z -= normal[1] * depth * ia / total;
  b.x += normal[0] * depth * ib / total; b.z += normal[1] * depth * ib / total;
  const av = aa[0][0] * normal[0] + aa[0][1] * normal[1];
  const bv = bb[0][0] * normal[0] + bb[0][1] * normal[1];
  const closing = b.speed * bv - a.speed * av;
  if (closing < 0) {
    const impulse = -1.15 * closing / total;
    a.speed -= impulse * ia * av;
    b.speed += impulse * ib * bv;
  }
  return true;
}
