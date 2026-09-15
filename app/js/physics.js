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
export function stepCar(state, input, dt, onRoad = true) {
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
  if (!onRoad) accel -= state.speed * 0.65;
  const before = state.speed;
  state.speed = clamp(state.speed + accel * dt, -8.3, onRoad ? 250 / 3.6 : 9);
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
