import { widthAt } from "./road-shape.js";

// Actual ribbon corners, including taper widths and the bounded miter used
// by geometry.js. Nearest-centreline tests miss wider overlapping roads.
export function roadFootprint(a, b, wa, wb, shoulder = 0.7) {
  const edge = (p, width, sign) => [p[0] + p[4] * sign * (width / 2 + shoulder),
    p[1] + p[5] * sign * (width / 2 + shoulder)];
  return [edge(a, wa, 1), edge(b, wb, 1), edge(b, wb, -1), edge(a, wa, -1)];
}
export const intersectsBounds = (a, b, padding = 0) =>
  a[0] <= b[2] + padding && a[2] >= b[0] - padding &&
  a[1] <= b[3] + padding && a[3] >= b[1] - padding;

export function preparedRoadBounds(roads) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const road of roads) for (const p of road.samples || []) {
    const half = widthAt(road.tapers, p[3], road.width) / 2 + 0.7;
    const dx = Math.abs(p[4] * half), dz = Math.abs(p[5] * half);
    bounds[0] = Math.min(bounds[0], p[0] - dx);
    bounds[1] = Math.min(bounds[1], p[1] - dz);
    bounds[2] = Math.max(bounds[2], p[0] + dx);
    bounds[3] = Math.max(bounds[3], p[1] + dz);
  }
  return bounds.every(Number.isFinite) ? bounds : null;
}
function nearPolygon(x, z, ring, radius) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i], dx = b[0] - a[0], dz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz || 1)));
    if (Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t) <= radius) return true;
    if ((a[1] > z) !== (b[1] > z) && x < a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}
export function createRoadClearanceIndex() {
  const size = 40, cells = new Map(), seen = new Set();
  return {
    add(features) {
      for (const f of features) {
        const p = f.properties || {}, samples = p.samples;
        if (!samples || p.roadVisible === false || seen.has(f.id)) continue;
        seen.add(f.id);
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1], b = samples[i];
          if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.001) continue;
          // Covered tunnels permit surface trees; open portal trenches do not.
          if (Math.max(a[2], b[2]) < -3.85) continue;
          const ring = roadFootprint(a, b, widthAt(p.tapers, a[3], p.width), widthAt(p.tapers, b[3], p.width));
          const xs = ring.map(v => v[0]), zs = ring.map(v => v[1]);
          const bounds = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
          const entry = { ring, bounds, bottom: Math.min(a[2], b[2]) - 0.7 };
          for (let x = Math.floor(bounds[0] / size); x <= Math.floor(bounds[2] / size); x++)
            for (let z = Math.floor(bounds[1] / size); z <= Math.floor(bounds[3] / size); z++) {
              const key = `${x},${z}`;
              if (!cells.has(key)) cells.set(key, []);
              cells.get(key).push(entry);
            }
        }
      }
    },
    blocksTree(x, z, radius = 2, top = 8) {
      const checked = new Set(), bounds = [x - radius, z - radius, x + radius, z + radius];
      for (let gx = Math.floor(bounds[0] / size); gx <= Math.floor(bounds[2] / size); gx++)
        for (let gz = Math.floor(bounds[1] / size); gz <= Math.floor(bounds[3] / size); gz++)
          for (const road of cells.get(`${gx},${gz}`) || []) {
            if (checked.has(road)) continue;
            checked.add(road);
            if (road.bottom > top || !intersectsBounds(road.bounds, bounds)) continue;
            if (nearPolygon(x, z, road.ring, radius)) return true;
          }
      return false;
    },
  };
}
