const clamp01 = n => Math.max(0, Math.min(1, n));
// Canonical cross-section order: positive-normal start/end, negative end/start.
// Coordinates are [x,z,height]; triangles match geometry.ribbon exactly.
export function surfaceCell(a, b, wa, wb, shoulder = 0) {
  const edge = (p, w, side) => [p[0] + p[4] * side * (w / 2 + shoulder),
    p[1] + p[5] * side * (w / 2 + shoulder), p[2]];
  return [edge(a, wa, 1), edge(b, wb, 1), edge(b, wb, -1), edge(a, wa, -1)];
}
export const CELL_TRIANGLES = [[0, 1, 3], [1, 2, 3]];
export function cellHeight(cell, x, z) {
  for (const ids of CELL_TRIANGLES) {
    const [a, b, c] = ids.map(i => cell[i]);
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-10) continue;
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (z - c[1])) / den;
    const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (z - c[1])) / den;
    if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
      return u * a[2] + v * b[2] + (1 - u - v) * c[2];
  }
  return null;
}
export const taperProgress = (zone, distance) => {
  const local = clamp01((distance - zone.d0) / (zone.d1 - zone.d0 || 1));
  const u = (zone.u0 ?? 0) + ((zone.u1 ?? 1) - (zone.u0 ?? 0)) * local;
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp01(u));
};
export function widthAt(tapers, distance, width) {
  const zone = tapers?.find(t => distance >= t.d0 && distance <= t.d1);
  return zone ? zone.w0 + (zone.w1 - zone.w0) * taperProgress(zone, distance) : width;
}
export function segmentWidth(road, t) {
  const [a, b] = road.widths || [road.width, road.width];
  return a + (b - a) * clamp01(t);
}

// Keep the continuing lane boundaries. An outer lane that ends converges to
// the edge, instead of compressing every lane and then dropping a divider.
export function laneDividersAt(tapers, distance, width, layout) {
  if (!layout || layout.total < 2) return [];
  const zone = tapers?.find(t => distance >= t.d0 && distance <= t.d1 && t.lanes0 && t.lanes1);
  const w = widthAt(tapers, distance, width);
  const descriptors = [];
  for (let k = layout.backward - 1; k > 0; k--) descriptors.push([-1, k]);
  if (layout.forward && layout.backward) descriptors.push([0, 0]);
  for (let k = 1; k < layout.forward; k++) descriptors.push([1, k]);
  const offset = ([side, k], lanes) => {
    const lane = w / lanes.total, center = -w / 2 + lanes.backward * lane;
    if (!side) return center;
    return center + side * Math.min(k, side > 0 ? lanes.forward : lanes.backward) * lane;
  };
  if (!zone) return descriptors.map(d => offset(d, layout));
  const t = taperProgress(zone, distance);
  return descriptors.map(d => offset(d, zone.lanes0) * (1 - t) + offset(d, zone.lanes1) * t);
}

export function laneTotalAt(tapers, distance, layout) {
  const zone = tapers?.find(t => distance >= t.d0 && distance <= t.d1 && t.lanes0 && t.lanes1);
  return zone ? zone.lanes0.total + (zone.lanes1.total - zone.lanes0.total) * taperProgress(zone, distance) : layout?.total || 2;
}
export function segmentLaneCount(road, t) {
  const [a, b] = road.laneTotals || [road.laneLayout?.total || 2, road.laneLayout?.total || 2];
  return a + (b - a) * clamp01(t);
}
