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
export const roadVisible = (p) => !((p.tunnel && p.tunnel !== "no") || Number(p.layer) < 0);
const key = (p) => p.slice(0, 2).map((v) => v.toFixed(7)).join(",");
const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const maxGrade = 0.0795; // Leaves rounding headroom in serialized metre coordinates.

export function prepareRoads(features, center) {
  const nodes = new Map(), edges = [], paths = new Map();
  const node = (p) => {
    const id = key(p);
    if (!nodes.has(id)) nodes.set(id, { id, p: project(p, center), edges: [] });
    return nodes.get(id);
  };
  for (const f of features) {
    const coordinates = f.geometry.coordinates;
    if (f.geometry.type !== "LineString" || !roadVisible(f.properties)) continue;
    const source = String(f.id).replace(/-\d+-\d+$/, "");
    for (let i = 1; i < coordinates.length; i++) {
      const a = node(coordinates[i - 1]), b = node(coordinates[i]);
      if (length(a.p, b.p) < 0.01) continue;
      const h = nominalHeight(f.properties);
      const e = { a, b, f, source, h, ah: h, bh: h, length: length(a.p, b.p) };
      a.edges.push(e); b.edges.push(e); edges.push(e);
      if (!paths.has(source)) paths.set(source, []);
      paths.get(source).push(e);
    }
  }
  // Shared endpoints define connections; geometric crossings never create nodes.
  const warnings = [];
  for (const n of nodes.values()) {
    const heights = n.edges.map((e) => e.h);
    if (n.edges.length > 2 && new Set(heights).size > 1) warnings.push(n.id);
  }
  const heightAt = (e, n) => e.a === n ? e.ah : e.bh;
  const setHeight = (e, n, h) => { if (e.a === n) e.ah = h; else e.bh = h; };
  const continuation = (e, n) => {
    const far = e.a === n ? e.b : e.a;
    const ux = (far.p[0] - n.p[0]) / e.length, uz = (far.p[1] - n.p[1]) / e.length;
    const matches = n.edges.filter((other) => other !== e).map((other) => {
      const end = other.a === n ? other.b : other.a;
      return { other, score: -(ux * (end.p[0] - n.p[0]) + uz * (end.p[1] - n.p[1])) / other.length };
    }).filter(({ score }) => score >= Math.cos(Math.PI / 6)).sort((a, b) => b.score - a.score);
    return matches.length && (matches.length === 1 || matches[0].score - matches[1].score >= 0.03) ? matches[0].other : null;
  };
  // A bridge may lift only one near-straight continuation; junction branches stay grounded.
  const queue = edges.filter((e) => e.h > 0 && e.f.properties.bridge && e.f.properties.bridge !== "no")
    .flatMap((e) => [[e, e.a], [e, e.b]]);
  for (let i = 0; i < queue.length; i++) {
    const [e, n] = queue[i], next = continuation(e, n);
    if (!next) continue;
    const far = next.a === n ? next.b : next.a;
    const nearHeight = heightAt(e, n);
    if (nearHeight > heightAt(next, n) + 0.00001) setHeight(next, n, nearHeight);
    const farHeight = Math.max(next.h, nearHeight - next.length * maxGrade);
    if (farHeight > heightAt(next, far) + 0.00001) {
      setHeight(next, far, farHeight);
      queue.push([next, far]);
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
      const a = [...e.a.p, e.ah], b = [...e.b.p, e.bh];
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
