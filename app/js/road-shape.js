const clamp01 = n => Math.max(0, Math.min(1, n));
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
