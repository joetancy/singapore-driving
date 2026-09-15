// Shared build-time road preparation. All coordinates and heights are metres.
const R = 6378137;
export const project = ([lon, lat], center) => [
  R * (lon - center[0]) * Math.PI / 180,
  R * (Math.log(Math.tan(Math.PI / 4 + center[1] * Math.PI / 360)) -
    Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))),
];
export const nominalHeight = (p) => {
  const layer = Number(p.layer) || 0;
  if ((p.tunnel && p.tunnel !== "no") || layer < 0) return Math.min(-4, layer * 4);
  return p.bridge && p.bridge !== "no" ? Math.max(4, layer * 4) : Math.max(0, layer * 4);
};
const key = (p) => p.slice(0, 2).map((v) => v.toFixed(7)).join(",");
const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

export function prepareRoads(features, center) {
  const nodes = new Map(), edges = [], paths = new Map();
  const node = (p) => {
    const id = key(p);
    if (!nodes.has(id)) nodes.set(id, { id, p: project(p, center), edges: [], h: 0 });
    return nodes.get(id);
  };
  for (const f of features) {
    const coordinates = f.geometry.coordinates;
    if (f.geometry.type !== "LineString") continue;
    const source = String(f.id).replace(/-\d+-\d+$/, "");
    for (let i = 1; i < coordinates.length; i++) {
      const a = node(coordinates[i - 1]), b = node(coordinates[i]);
      if (length(a.p, b.p) < 0.01) continue;
      const e = { a, b, f, source, h: nominalHeight(f.properties), length: length(a.p, b.p) };
      a.edges.push(e); b.edges.push(e); edges.push(e);
      if (!paths.has(source)) paths.set(source, []);
      paths.get(source).push(e);
    }
  }
  // Shared endpoints define connections; geometric crossings never create nodes.
  const warnings = [];
  for (const n of nodes.values()) {
    const heights = n.edges.map((e) => e.h);
    n.h = heights.reduce((a, b) => Math.abs(b) > Math.abs(a) ? b : a, 0);
    if (n.edges.length > 2 && new Set(heights).size > 1) warnings.push(n.id);
  }
  // Propagate approach elevations at at most 8% grade. Queue only changed nodes.
  for (const sign of [1, -1]) {
    const queue = [...nodes.values()].filter((n) => n.h * sign > 0);
    for (let i = 0; i < queue.length; i++) {
      const n = queue[i];
      for (const e of n.edges) {
        const other = e.a === n ? e.b : e.a;
        const value = n.h * sign - e.length * 0.08;
        if (value > Math.max(0, other.h * sign) + 0.00001 && other.h * sign >= 0) {
          other.h = sign * value; queue.push(other);
        }
      }
    }
  }
  const result = new Map(features.map((f) => [f.id, []]));
  const connections = new Map(features.map((f) => [f.id, { start: [], end: [] }]));
  for (const e of edges) {
    for (const [node, end] of [[e.a, "start"], [e.b, "end"]]) {
      connections.get(e.f.id)[end] = node.edges
        .filter((other) => other !== e)
        .map((other) => other.f.id);
    }
  }
  for (const list of paths.values()) {
    list.sort((a, b) => String(a.f.id).localeCompare(String(b.f.id), undefined, { numeric: true }));
    let distance = 0;
    for (const e of list) {
      const neighbor = (n) => n.edges.length === 2 ? n.edges.find((q) => q !== e && q.source === e.source) : null;
      const previous = neighbor(e.a), next = neighbor(e.b);
      // Keep every shared endpoint exact. The cross section uses averaged
      // tangents below, so ribbons remain joined without visible gaps.
      const a = [...e.a.p, e.a.h], b = [...e.b.p, e.b.h];
      const positions = [a];
      const count = Math.max(1, Math.ceil(length(a, b) / 8));
      for (let i = 1; i < count; i++) positions.push(mix(a, b, i / count));
      positions.push(b);
      const arc = positions.map((p, i) => i ? length(positions[i - 1], p) : 0);
      const total = arc.reduce((sum, v) => sum + v, 0);
      let progress = 0;
      const samples = positions.map((p, i) => {
        progress += arc[i]; distance += arc[i];
        return [p[0], p[1], a[2] + (b[2] - a[2]) * progress / total, distance];
      });
      // Cross sections share the averaged tangent at every original join.
      for (let i = 0; i < samples.length; i++) {
        const before = samples[Math.max(0, i - 1)], after = samples[Math.min(samples.length - 1, i + 1)];
        let dx = after[0] - before[0], dz = after[1] - before[1];
        const adjacent = i === 0 ? previous : i === samples.length - 1 ? next : null;
        if (adjacent) {
          const n = i === 0 ? e.a : e.b, far = adjacent.a === n ? adjacent.b : adjacent.a;
          const sign = i === 0 ? 1 : -1;
          dx = (e.b.p[0] - e.a.p[0]) / e.length + sign * (n.p[0] - far.p[0]) / adjacent.length;
          dz = (e.b.p[1] - e.a.p[1]) / e.length + sign * (n.p[1] - far.p[1]) / adjacent.length;
        }
        const l = Math.hypot(dx, dz) || 1;
        samples[i].push(-dz / l, dx / l);
      }
      result.get(e.f.id).push(...samples);
    }
  }
  return { samples: result, connections, warnings };
}
