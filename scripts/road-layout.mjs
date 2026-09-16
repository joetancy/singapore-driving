import { roadWidth } from './road-network.mjs';

const nearest = (p, a, b) => {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return { d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dz), y: a[2] + t * (b[2] - a[2]) };
};

// Build globally before writing chunks: a neighbouring tile must participate
// in exactly the same junction, barrier and street-lamp clearance decisions.
export function prepareLayout(features, samples) {
  const cells = new Map(), edges = [], result = new Map();
  const widths = new Map();
  const size = 40;
  for (const f of features) {
    const pts = samples.get(f.id) || [], width = roadWidth(f.properties);
    const flags = [];
    result.set(f.id, flags);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.001) { flags.push({}); continue; }
      const e = { a, b, width, f, index: i - 1, source: String(f.id).replace(/-\d+-\d+$/, '') };
      widths.set(e.source, Math.min(widths.get(e.source) ?? Infinity, width));
      edges.push(e); flags.push({});
      const margin = width / 2 + 2;
      for (let x = Math.floor((Math.min(a[0], b[0]) - margin) / size); x <= Math.floor((Math.max(a[0], b[0]) + margin) / size); x++)
        for (let z = Math.floor((Math.min(a[1], b[1]) - margin) / size); z <= Math.floor((Math.max(a[1], b[1]) + margin) / size); z++) {
          const key = `${x},${z}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(e);
        }
    }
  }
  let overlaps = 0;
  for (const e of edges) {
    const flags = result.get(e.f.id)[e.index];
    const dx = e.b[0] - e.a[0], dz = e.b[1] - e.a[1], len = Math.hypot(dx, dz);
    const nx = -dz / len, nz = dx / len;
    const candidates = new Set();
    const margin = e.width / 2 + 2;
    const minX = Math.min(e.a[0], e.b[0]) - margin, maxX = Math.max(e.a[0], e.b[0]) + margin;
    const minZ = Math.min(e.a[1], e.b[1]) - margin, maxZ = Math.max(e.a[1], e.b[1]) + margin;
    for (let x = Math.floor(minX / size); x <= Math.floor(maxX / size); x++)
      for (let z = Math.floor(minZ / size); z <= Math.floor(maxZ / size); z++)
        for (const q of cells.get(`${x},${z}`) || []) candidates.add(q);
    for (const q of candidates) {
      if (q === e) continue;
      const radius = q.width / 2 + 2;
      if (Math.max(q.a[0], q.b[0]) + radius < minX || Math.min(q.a[0], q.b[0]) - radius > maxX ||
          Math.max(q.a[1], q.b[1]) + radius < minZ || Math.min(q.a[1], q.b[1]) - radius > maxZ) continue;
      // Consecutive samples along the same road share a ribbon by design.
      const arcGap = Math.max(e.a[3], q.a[3]) - Math.min(e.b[3], q.b[3]);
      if (e.source === q.source && arcGap < Math.max(e.width, q.width) * 2) continue;
      const shared = [e.a, e.b].some(a => [q.a, q.b].some(b => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 0.01));
      const qdx = q.b[0] - q.a[0], qdz = q.b[1] - q.a[1];
      // Fit distinct parallel carriageways into the space between their
      // centre lines. Use one width per source way to avoid sample-by-sample
      // pinching, and never squeeze stacked roads or actual junctions.
      const qlen = Math.hypot(qdx, qdz);
      const alignment = Math.abs((dx * qdx + dz * qdz) / (len * qlen));
      if (!shared && e.source !== q.source && alignment > 0.995) {
        const mid = [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2];
        const along = ((mid[0] - q.a[0]) * qdx + (mid[1] - q.a[1]) * qdz) / qlen;
        const separation = Math.abs((mid[0] - q.a[0]) * qdz - (mid[1] - q.a[1]) * qdx) / qlen;
        const hit = nearest(mid, q.a, q.b);
        const underground = Math.min(e.a[2], e.b[2], q.a[2], q.b[2]) < -0.3;
        const margin = underground ? 2.5 : 1.8;
        const available = separation - margin;
        if (along >= 0 && along <= qlen && available >= 3 &&
            Math.abs(hit.y - (e.a[2] + e.b[2]) / 2) < 0.3 &&
            available < (e.width + q.width) / 2) {
          const factor = available / ((e.width + q.width) / 2);
          if (Math.min(e.width, q.width) * factor < 2.8) continue;
          widths.set(e.source, Math.min(widths.get(e.source), e.width * factor));
          widths.set(q.source, Math.min(widths.get(q.source), q.width * factor));
          flags.noLamps = true;
          // These remain separate carriageways, not an open merge.
          continue;
        }
      }
      // Ordinary end-to-end joins between separately named ways aren't overlaps.
      const straightJoin = shared && [e.a, e.b].some((p, ei) => [q.a, q.b].some((r, qi) => {
        if (Math.hypot(p[0] - r[0], p[1] - r[1], p[2] - r[2]) >= 0.01) return false;
        const sign = (ei === 0 ? 1 : -1) * (qi === 0 ? 1 : -1);
        return sign * (dx * qdx + dz * qdz) / (len * Math.hypot(qdx, qdz)) < -0.98;
      }));
      if (straightJoin) continue;
      for (const t of [0.05, 0.5, 0.95]) {
        const p = e.a.map((v, i) => v + t * (e.b[i] - v));
        const hit = nearest(p, q.a, q.b);
        if (hit.d < (e.width + q.width) / 2 + 2) flags.noLamps = true;
        if (Math.abs(hit.y - p[2]) > 0.5) continue;
        // Never open a wall between unconnected underground passages merely
        // because the source data places them at the same depth.
        if (p[2] < -0.3 && !shared && e.source !== q.source) continue;
        for (const side of [-1, 1]) {
          const edge = [p[0] + nx * side * (e.width / 2 + 0.6), p[1] + nz * side * (e.width / 2 + 0.6)];
          if (nearest(edge, q.a, q.b).d < q.width / 2 + 0.8) flags[side === -1 ? 'right' : 'left'] = true;
        }
        if (hit.d < (e.width + q.width) / 2) flags.junction = true;
      }
      // No support columns through a road below an elevated crossing.
      const midpoint = e.a.map((v, i) => (v + e.b[i]) / 2), under = nearest(midpoint, q.a, q.b);
      if (under.d < q.width / 2 + 1.5 && under.y >= -0.1 && under.y < midpoint[2] - 0.5) flags.noPier = true;
    }
    if (flags.noLamps) overlaps++;
  }
  return { segments: result, overlaps, widths };
}
