import { nearestPoint } from "./physics.js";
import { allowedDirection } from "./traffic-sim.js";

export const sampleHeight = (r, t) => r.a[2] + (r.b[2] - r.a[2]) * t;

// Lost lateral contact must not turn an underground car into a ground-level
// car. Slide along the last tunnel surface; keep speed and steering unchanged.
export function drivingContact(index, state, active, height) {
  const contact = surfaceAt(index, state.x, state.z, active, height);
  if (contact || !active?.tunnel) return contact;
  const p = nearestPoint(state.x, state.z, active.a, active.b);
  const dx = state.x - p.x, dz = state.z - p.z;
  const radius = Math.max(0, active.width / 2 - 1.1);
  const scale = p.d > radius ? radius / p.d : 1;
  // At an unloaded or disconnected end, retain the last supported section.
  const ex = active.b[0] - active.a[0], ez = active.b[1] - active.a[1];
  const length = Math.hypot(ex, ez) || 1;
  const lateral = Math.max(-radius, Math.min(radius, (-ez * dx + ex * dz) / length));
  state.x = p.t === 0 || p.t === 1 ? p.x - ez / length * lateral : p.x + dx * scale;
  state.z = p.t === 0 || p.t === 1 ? p.z + ex / length * lateral : p.z + dz * scale;
  return { ...active, ...p, d: Math.min(p.d, radius), y: sampleHeight(active, p.t) };
}
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
      if (Math.max(Math.abs(y), Math.abs(height)) > 0.3 || Math.abs(y - height) > 0.08) continue;
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

// End-cap margin shared with surfaceAt: the rounded nearest-point cap must
// not carry the car past a deck end.
export function pastSegmentEnd(r, x, z, margin = 0.6) {
  const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1];
  const length = Math.hypot(dx, dz) || 1;
  const along = ((x - r.a[0]) * dx + (z - r.a[1]) * dz) / length;
  return along < -margin || along > length + margin;
}

// Width within a lane-merge taper zone (absolute sample distances, cosine
// easing); the feature width outside zones. Zones never overlap, so the
// first match wins.
export function widthAt(tapers, d, width) {
  for (const t of tapers || []) {
    if (d < t.d0 || d > t.d1) continue;
    const s = (d - t.d0) / (t.d1 - t.d0 || 1);
    return t.w0 + (t.w1 - t.w0) * (0.5 - 0.5 * Math.cos(Math.PI * s));
  }
  return width;
}

// Box-junction cross-hatch bars for one sample pair: diagonal bars every
// spacing metres, alternating direction for the criss-cross read,
// deterministic from absolute distances so chunk reloads never restart the
// pattern. Returns [{lo, hi, flip}] distances clamped to the pair.
export function hatchBars(a3, b3, spacing = 5, barLen = 2.4) {
  const bars = [];
  const start = Math.floor(a3 / spacing) * spacing;
  let k = 0;
  for (let d = start; d < b3 - 0.4; d += spacing, k++) {
    const lo = Math.max(d, a3), hi = Math.min(d + barLen, b3);
    if (hi - lo < 0.5) continue;
    bars.push({ lo, hi, flip: k % 2 === 1 });
  }
  return bars;
}

// Stop-line bars for a signalized approach: one transverse segment per
// legal travel direction, 2 m upstream of the signal node and spanning that
// direction's lanes (left-hand traffic: forward lanes sit left of the OSM
// way direction). Returns [{ax, az, bx, bz, y}] world-metre segments; the
// caller draws them with quad(). Degenerate spans are skipped.
export function stopLines(sx, sz, y, dx, dz, width, laneLayout) {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const total = laneLayout?.total || 2;
  const forward = laneLayout ? laneLayout.forward : 1;
  const backward = laneLayout ? laneLayout.backward : 1;
  const lane = width / total;
  const lines = [];
  // [lo, hi] lateral spans with left positive, mirroring the arrow and
  // divider placement used by the renderer.
  const approaches = [
    { count: forward, lo: width / 2 - forward * lane, hi: width / 2, dir: 1 },
    { count: backward, lo: -width / 2, hi: -width / 2 + backward * lane, dir: -1 },
  ];
  for (const { count, lo, hi, dir } of approaches) {
    if (!(count > 0) || hi - lo < 0.1) continue;
    const mid = (lo + hi) / 2, half = (hi - lo) / 2;
    // Left normal (-uz, ux); upstream is -dir for forward travel.
    const upstream = dir === 1 ? -2 : 2;
    const px = sx + ux * upstream, pz = sz + uz * upstream;
    lines.push({
      ax: px + -uz * half, az: pz + ux * half,
      bx: px - -uz * half, bz: pz - ux * half,
      y, lateral: mid,
    });
  }
  return lines;
}

// Night lighting budget: at most eight non-shadow-casting lights for the
// nearest lamp heads within 100 m.
export function pickNightLights(lamps, x, z, limit = 8, radius = 100) {
  return lamps
    .map((p) => ({ p, d: Math.hypot(p[0] - x, p[2] - z) }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .map(({ p }) => p);
}

// Losing contact on an elevated deck driven past its end (or into a chunk
// that has not loaded yet) must retain the last supported position and
// height instead of snapping to ground level. Lateral departures off the
// side of the deck keep the existing fall-to-ground behavior so road edges
// never become invisible walls.
export function retainElevated(active, height, x, z) {
  return !!active && Math.abs(height) > 0.3 && pastSegmentEnd(active, x, z);
}

// Turn-by-turn routing over the connected directional road graph. A* with
// a Euclidean heuristic (admissible: straight lines never exceed road
// distance), one-way aware via allowedDirection. destPoint guides the
// search; yaw picks the starting direction. Returns {steps: [{road,
// direction}], distance} or null when unreachable within maxPops.
const segLength = (r) => Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]);
const endPoint = (r, direction) => direction > 0 ? r.b : r.a;

function heapPush(heap, item) {
  heap.push(item);
  for (let i = heap.length - 1; i > 0;) {
    const parent = (i - 1) >> 1;
    if (heap[parent].f <= heap[i].f) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap) {
  const top = heap[0], last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    for (let i = 0;;) {
      const left = i * 2 + 1, right = left + 1;
      let next = i;
      if (left < heap.length && heap[left].f < heap[next].f) next = left;
      if (right < heap.length && heap[right].f < heap[next].f) next = right;
      if (next === i) break;
      [heap[next], heap[i]] = [heap[i], heap[next]];
      i = next;
    }
  }
  return top;
}

export function findRoute(index, startRoad, destFeatureId, destPoint, yaw, maxPops = 50000) {
  if (!startRoad || !index?.nodes) return null;
  if (startRoad.featureId === destFeatureId) return { steps: [], distance: 0 };
  const dx = startRoad.b[0] - startRoad.a[0], dz = startRoad.b[1] - startRoad.a[1];
  const startDir = Math.sin(yaw) * dx - Math.cos(yaw) * dz >= 0 ? 1 : -1;
  const behind = nodeKey(startDir > 0 ? startRoad.a : startRoad.b);
  const estimate = (p) => Math.hypot(p[0] - destPoint.x, p[1] - destPoint.z);
  const heap = [], best = new Map(), cameFrom = new Map();
  heapPush(heap, { node: behind, g: 0, f: estimate(startDir > 0 ? startRoad.a : startRoad.b) });
  best.set(behind, 0);
  let pops = 0;
  while (heap.length && pops++ < maxPops) {
    const { node, g } = heapPop(heap);
    if (g > (best.get(node) ?? Infinity)) continue;
    const options = [];
    for (const road of index.nodes.get(node) || []) {
      if (segLength(road) < 0.01) continue;
      if (nodeKey(road.a) === node && allowedDirection(road, 1)) options.push({ road, direction: 1 });
      if (nodeKey(road.b) === node && allowedDirection(road, -1)) options.push({ road, direction: -1 });
    }
    const prev = cameFrom.get(node);
    const continuing = options.filter(({ road, direction }) =>
      !prev || road.id !== prev.road.id || direction !== -prev.direction);
    for (const { road, direction } of continuing.length ? continuing : options) {
      const end = endPoint(road, direction);
      const key = nodeKey(end);
      const ng = g + segLength(road);
      if (ng >= (best.get(key) ?? Infinity)) continue;
      best.set(key, ng);
      cameFrom.set(key, { from: node, road, direction });
      if (road.featureId === destFeatureId) {
        const steps = [{ road, direction }];
        for (let at = node; cameFrom.get(at)?.road; at = cameFrom.get(at).from)
          steps.unshift({ road: cameFrom.get(at).road, direction: cameFrom.get(at).direction });
        return { steps, distance: ng };
      }
      heapPush(heap, { node: key, g: ng, f: ng + estimate(end) });
    }
  }
  return null;
}

// Driver-relative maneuver between two route steps, using the same yaw
// convention as the car (yaw = atan2(dx, -dz)): positive yaw change reads
// as a right turn on the north-up minimap.
export function turnManeuver(prev, prevDir, next, nextDir) {
  const ux = (prev.b[0] - prev.a[0]) * prevDir, uz = (prev.b[1] - prev.a[1]) * prevDir;
  const vx = (next.b[0] - next.a[0]) * nextDir, vz = (next.b[1] - next.a[1]) * nextDir;
  const before = Math.atan2(ux, -uz), after = Math.atan2(vx, -vz);
  let delta = after - before;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  if (Math.abs(delta) < 0.44) return "straight";
  if (Math.abs(delta) > 2.62) return "uturn";
  return delta > 0 ? "right" : "left";
}
