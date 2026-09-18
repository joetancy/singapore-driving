// A merge can span several short OSM features. Walking degree-two joins
// avoids squeezing the whole transition into the last five metres of a way.
const MAX_LENGTH = 90;
const desiredLength = (wide, narrow) => Math.max(20, Math.min(MAX_LENGTH, (wide - narrow) * 14));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const counts = lanes => ({ forward: lanes.forward, backward: lanes.backward, total: lanes.total });
const reverse = lanes => ({ forward: lanes.backward, backward: lanes.forward, total: lanes.total });
const links = (road, end) => [...new Set(road.connections?.[end] || [])].filter(id => id !== road.id);
const enteringDirection = (road, point) => distance(road.samples[0], point) < 0.02 ? 1 :
  distance(road.samples.at(-1), point) < 0.02 ? -1 : 0;

export function taperZones(samples, width, startNeighbor, endNeighbor) {
  if (!samples || samples.length < 2) return [];
  const first = samples[0][3], last = samples.at(-1)[3], length = last - first;
  if (!(length > 0)) return [];
  const ends = [[startNeighbor, true], [endNeighbor, false]]
    .filter(([neighbor]) => neighbor != null && width - neighbor > 0.05);
  return ends.map(([neighbor, start]) => {
    const span = Math.min(desiredLength(width, neighbor), length / ends.length);
    return start ? { d0: first, d1: first + span, w0: neighbor, w1: width } :
      { d0: last - span, d1: last, w0: width, w1: neighbor };
  });
}

export function applyLaneTapers(roads) {
  const byId = new Map(roads.map(road => [road.id, road]));
  for (const road of roads) road.tapers = [];
  for (const seed of roads) for (const atStart of [true, false]) {
    if (seed.samples.length < 2) continue;
    const join = links(seed, atStart ? "start" : "end");
    const neighbor = join.length === 1 ? byId.get(join[0]) : null;
    if (!neighbor || neighbor.samples.length < 2 || seed.width - neighbor.width <= 0.05) continue;
    const point = atStart ? seed.samples[0] : seed.samples.at(-1);
    const neighborAway = enteringDirection(neighbor, point);
    if (!neighborAway) continue; // No taper between disconnected/stacked ways.
    const seedDirection = atStart ? 1 : -1;
    const narrow = seedDirection === -neighborAway ? counts(neighbor.laneLayout) : reverse(neighbor.laneLayout);
    const parts = [], visited = new Set();
    let road = seed, direction = seedDirection, available = 0, oppositeDrop = false;
    while (road && !visited.has(road.id)) {
      visited.add(road.id);
      const length = road.samples.at(-1)[3] - road.samples[0][3];
      if (!(length > 0)) break;
      parts.push({ road, direction, length });
      available += length;
      const end = direction > 0 ? "end" : "start", nextLinks = links(road, end);
      const next = nextLinks.length === 1 ? byId.get(nextLinks[0]) : null;
      if (!next || next.samples.length < 2) break;
      const endpoint = direction > 0 ? road.samples.at(-1) : road.samples[0];
      const nextDirection = enteringDirection(next, endpoint);
      if (!nextDirection) break;
      if (seed.width - next.width > 0.05) { oppositeDrop = true; break; }
      const aligned = nextDirection === seedDirection ? next.laneLayout : reverse(next.laneLayout);
      if (Math.abs(next.width - seed.width) > 0.05 ||
          aligned.forward !== seed.laneLayout.forward || aligned.backward !== seed.laneLayout.backward ||
          available >= MAX_LENGTH * 2) break;
      road = next; direction = nextDirection;
    }
    const length = Math.min(desiredLength(seed.width, neighbor.width), available / (oppositeDrop ? 2 : 1));
    if (!(length > 0)) continue;
    let travelled = 0;
    for (const part of parts) {
      if (travelled >= length - 1e-7) break;
      const r = part.road, span = Math.min(part.length, length - travelled);
      const first = r.samples[0][3], last = r.samples.at(-1)[3];
      const zone = part.direction > 0 ? {
        d0: first, d1: first + span, u0: travelled / length, u1: (travelled + span) / length,
      } : {
        d0: last - span, d1: last, u0: (travelled + span) / length, u1: travelled / length,
      };
      zone.w0 = neighbor.width; zone.w1 = seed.width;
      const target = part.direction === seedDirection ? narrow : reverse(narrow);
      if (target.forward <= r.laneLayout.forward && target.backward <= r.laneLayout.backward) {
        zone.lanes0 = target;
        zone.lanes1 = counts(r.laneLayout);
      }
      r.tapers.push(zone);
      travelled += span;
    }
  }
  for (const road of roads) {
    road.tapers.sort((a, b) => a.d0 - b.d0);
    resampleTapers(road);
  }
}

// Preserve original corner/portal samples and their layout flags. Add exact
// taper boundaries and samples at most 3 m apart so short ways are smooth too.
export function resampleTapers(road) {
  if (!road.tapers.length || road.samples.length < 2) return;
  const samples = [road.samples[0]], layout = [];
  for (let i = 1; i < road.samples.length; i++) {
    const a = road.samples[i - 1], b = road.samples[i], cuts = new Set([b[3]]);
    for (const zone of road.tapers) {
      const lo = Math.max(a[3], zone.d0), hi = Math.min(b[3], zone.d1);
      if (hi <= lo) continue;
      const count = Math.max(1, Math.ceil((hi - lo) / 3));
      if (lo > a[3]) cuts.add(lo);
      for (let n = 1; n <= count; n++) cuts.add(lo + (hi - lo) * n / count);
    }
    for (const d of [...cuts].sort((x, y) => x - y)) {
      if (d - samples.at(-1)[3] < 1e-7 && d !== b[3]) continue;
      const t = (d - a[3]) / (b[3] - a[3] || 1);
      samples.push(d === b[3] ? b : a.map((v, k) => k === 3 ? d : v + (b[k] - v) * t));
      layout.push(road.layout[i - 1] || {});
    }
  }
  road.samples = samples;
  road.layout = layout;
}
