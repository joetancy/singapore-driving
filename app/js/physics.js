export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function nearestPoint(x, z, a, b) {
  const dx = b[0] - a[0],
    dz = b[1] - a[1],
    den = dx * dx + dz * dz;
  const t = den ? clamp(((x - a[0]) * dx + (z - a[1]) * dz) / den, 0, 1) : 0;
  const px = a[0] + dx * t,
    pz = a[1] + dz * t;
  return { x: px, z: pz, d: Math.hypot(x - px, z - pz), t };
}
export function inRing(x, z, ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a[1] > z !== b[1] > z &&
      x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]
    )
      hit = !hit;
  }
  return hit;
}
export function inPolygon(x, z, rings) {
  return inRing(x, z, rings[0]) && !rings.slice(1).some((r) => inRing(x, z, r));
}
export function touchesPolygon(x, z, rings, radius = 1.15) {
  if (inPolygon(x, z, rings)) return true;
  return rings.some((r) =>
    r.some((a, i) => nearestPoint(x, z, a, r[(i + 1) % r.length]).d < radius),
  );
}
// Deterministic integer hash for procedural scatter: same cell always
// yields the same tree, so chunk reloads never duplicate or move greenery.
export function hash2i(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
// Trunk collision as a ground circle: gated by the tree's vertical extent
// so decks above and tunnels below pass freely.
export function hitsTrunk(x, z, yaw, y, trees) {
  for (const t of trees) {
    if (y > t.top || y + 1.7 < 0) continue;
    if (Math.abs(x - t.x) > 1.5 || Math.abs(z - t.z) > 1.5) continue;
    for (const offset of [-1.4, 0, 1.4])
      if (Math.hypot(x + Math.sin(yaw) * offset - t.x, z - Math.cos(yaw) * offset - t.z) < 0.9)
        return true;
  }
  return false;
}
// Starting pose on a road: outermost legal lane matching the heading, with
// headings corrected on one-way roads (reverse one-ways face backward).
// Uses traffic-sim's left-hand lane offsets so spawns sit where forward
// traffic drives. `road` is a getNearestRoad-style hit ({a, b, width,
// laneLayout, x, z}); shared single-lane roads spawn centered.
export function spawnPose(road, yaw) {
  const dx = road.b[0] - road.a[0], dz = road.b[1] - road.a[1];
  const l = Math.hypot(dx, dz) || 1;
  let dir = Math.sin(yaw) * dx - Math.cos(yaw) * dz >= 0 ? 1 : -1;
  if (road.laneLayout?.oneWay) dir = road.laneLayout.reverse ? -1 : 1;
  const lanes = road.laneLayout;
  const lateral = lanes?.total
    ? (road.width / 2 - road.width / (2 * lanes.total)) * dir
    : road.width * 0.24 * dir;
  // East-positive x and south-positive z: left of the source tangent is
  // (tz, -tx), not the stored cross-section normal (which points right).
  return {
    x: road.x + (dz / l) * lateral,
    z: road.z - (dx / l) * lateral,
    yaw: Math.atan2(dx * dir, -dz * dir),
  };
}
export function stepCar(state, input, dt) {
  const throttle = input.forward ? 1 : 0,
    brake = input.back ? 1 : 0,
    handbrake = !!input.handbrake;
  let accel = 0;
  if (throttle) accel = state.speed < -0.2 ? 12 : 7.4;
  if (brake) accel = state.speed > 0.2 ? -16 : -4.2;
  if (!throttle && !brake)
    accel = -Math.sign(state.speed) * (1.25 + Math.abs(state.speed) * 0.018);
  if (handbrake) accel -= Math.sign(state.speed) * 22;
  accel -= state.speed * Math.abs(state.speed) * 0.0014;
  const before = state.speed;
  state.speed = clamp(state.speed + accel * dt, -8.3, 250 / 3.6);
  if (!throttle && !brake && before * state.speed < 0) state.speed = 0;
  if (Math.abs(state.speed) < 0.05 && !throttle && !brake) state.speed = 0;
  const desired = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  state.steer += (desired - state.steer) * (1 - Math.exp(-8 * dt));
  const angle = state.steer * (0.53 / (1 + Math.abs(state.speed) * 0.058));
  state.yaw += ((Math.tan(angle) * state.speed) / 2.85) * dt;
  state.x += Math.sin(state.yaw) * state.speed * dt;
  state.z -= Math.cos(state.yaw) * state.speed * dt;
  return state;
}
