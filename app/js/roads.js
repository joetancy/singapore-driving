import { nearestPoint } from "./physics.js";

export const sampleHeight = (r, t) => r.a[2] + (r.b[2] - r.a[2]) * t;
const nodeKey = (p) => p.slice(0, 3).map((v) => v.toFixed(3)).join(",");

export function roadIndex(roads) {
  const cells = new Map(), nodes = new Map(), byId = new Map();
  for (const r of roads) {
    byId.set(r.id, r);
    for (const p of [r.a, r.b]) {
      const k = nodeKey(p);
      if (!nodes.has(k)) nodes.set(k, []);
      nodes.get(k).push(r);
    }
    for (let x = Math.floor((Math.min(r.a[0], r.b[0]) - r.width) / 50); x <= Math.floor((Math.max(r.a[0], r.b[0]) + r.width) / 50); x++)
      for (let z = Math.floor((Math.min(r.a[1], r.b[1]) - r.width) / 50); z <= Math.floor((Math.max(r.a[1], r.b[1]) + r.width) / 50); z++) {
        const k = `${x},${z}`;
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(r);
      }
  }
  return { cells, nodes, byId };
}

export function surfaceAt(index, x, z, active = null, height = 0) {
  const cellX = Math.floor(x / 50), cellZ = Math.floor(z / 50);
  const candidates = [];
  const seen = new Set();
  // Search neighboring cells so a car crossing a grid edge never loses its
  // current ribbon for one physics step.
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const r of index.cells.get(`${cellX + dx},${cellZ + dz}`) || []) {
      if (!seen.has(r.id)) { seen.add(r.id); candidates.push(r); }
    }
  }
  const connected = new Set(active ? [active.id] : []);
  if (active) {
    // A physics step can cross several short curve samples. Follow local
    // endpoint connections rather than assuming the next sample is adjacent.
    const pending = [active];
    for (let i = 0; i < pending.length; i++) {
      for (const p of [pending[i].a, pending[i].b]) {
        if (Math.hypot(x - p[0], z - p[1]) > pending[i].width + 3) continue;
        for (const r of index.nodes.get(nodeKey(p)) || []) {
          const samePath = r.featureId != null && r.featureId === pending[i].featureId;
          const declared = pending[i].connections;
          if (!samePath && declared && !declared.includes(r.featureId)) continue;
          if (connected.has(r.id)) continue;
          connected.add(r.id);
          pending.push(r);
        }
      }
    }
  }
  let best = null;
  for (const r of candidates) {
    const p = nearestPoint(x, z, r.a, r.b), y = sampleHeight(r, p.t);
    const length = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
    if (!length || p.d > r.width / 2 + 0.6) continue;
    const along = ((x - r.a[0]) * (r.b[0] - r.a[0]) +
      (z - r.a[1]) * (r.b[1] - r.a[1])) / length;
    // Do not let the rounded nearest-point cap carry the car past a deck end.
    if (along < -0.6 || along > length + 0.6) continue;
    const linked = connected.has(r.id);
    if (active && !linked) {
      // Only ground-level junctions allow transfers without an explicit link.
      // Similar source IDs alone never connect stacked or looping roads.
      if (Math.max(y, height) > 0.3 || Math.abs(y - height) > 0.08) continue;
    }
    if (Math.abs(y - height) > 0.6) continue;
    const score = p.d + Math.abs(y - height) * 8 - (active?.id === r.id ? 0.75 : 0);
    if (!best || score < best.score) best = { ...r, ...p, y, score };
  }
  return best;
}

export const mapLevel = (width) => width > 15000 ? 0 : width > 3000 ? 1 : 2;
export const visibleRoad = (r, level) => level === 2 ||
  (level === 0 ? /^(motorway|trunk|primary)/ : /^(motorway|trunk|primary|secondary|tertiary)/).test(r.highway);
