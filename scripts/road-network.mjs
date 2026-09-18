// Shared build-time road preparation. All coordinates and heights are metres.
const R = 6378137;
export const project = ([lon, lat], center) => [
  R * (lon - center[0]) * Math.PI / 180,
  R * (Math.log(Math.tan(Math.PI / 4 + center[1] * Math.PI / 360)) -
    Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))),
];
export const nominalHeight = (p) => {
  const layer = Number(p.layer) || 0;
  const isTunnel = p.tunnel && p.tunnel !== "no";
  const isBridge = p.bridge && p.bridge !== "no";
  const isCovered = p.covered && p.covered !== "no";
  // `covered` alone never implies underground (R2-02, R3).
  if (isTunnel || layer < 0) return Math.min(-4, layer * 4);
  if (isBridge) return Math.max(4, layer * 4);
  return Math.max(0, layer * 4);
};
const count = (value) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
// Fixed lane width: every road is lanes × LANE_WIDTH so a 2-lane road
// renders the same everywhere instead of varying by class or overlap fit.
export const LANE_WIDTH = 3.5;
export function laneCount(properties = {}) {
  const lanes = count(properties.lanes) ||
    count(properties["lanes:forward"]) + count(properties["lanes:backward"]);
  const link = /_link$/.test(properties.highway || "");
  const fast = /^(motorway|trunk)/.test(properties.highway || "");
  return lanes || (link ? 1 : fast ? 3 : properties.highway === "service" ? 1 : 2);
}
export function roadWidth(properties = {}) {
  const explicit = parseFloat(properties.width);
  if (explicit > 0) return Math.max(LANE_WIDTH, Math.min(32, explicit));
  return Math.min(32, laneCount(properties) * LANE_WIDTH);
}
// Parse a lane count value: returns { value: int|null, confidence: "exact"|"estimated"|"unsupported", source: string }.
function parseLaneCount(value) {
  if (value == null) return { value: null, confidence: "unsupported", source: "" };
  const str = String(value).trim();
  // Reject unsupported formats: ranges (2;3), decimals (1.5), conditionals.
  if (/[;|]/.test(str) || /^\d*\.\d+$/.test(str) || /@/.test(str)) {
    return { value: null, confidence: "unsupported", source: str };
  }
  const n = Number(str);
  if (Number.isInteger(n) && n > 0) return { value: n, confidence: "exact", source: str };
  return { value: null, confidence: "unsupported", source: str };
}

// OSM ways are drawn in their recorded direction. Singapore traffic keeps left.
// Forward = along OSM way order; backward = opposite.
// Returns { forward, backward, oneWay, reverse, total, turnLanes, maxspeed,
//   source: "tagged"|"estimated"|"fallback", warnings? }.
export function laneLayout(properties = {}) {
  const explicitNo = properties.oneway === "no" || properties.oneway === "0";
  const oneWay = !explicitNo && (properties.oneway === "yes" || properties.oneway === "1" ||
    properties.junction === "roundabout" || /^motorway/.test(properties.highway || ""));
  const reverse = properties.oneway === "-1";

  const fwdParsed = parseLaneCount(properties["lanes:forward"]);
  const bwdParsed = parseLaneCount(properties["lanes:backward"]);
  const totalParsed = parseLaneCount(properties.lanes);

  let forward = fwdParsed.value, backward = bwdParsed.value, total = totalParsed.value;
  let source = "tagged";
  const warnings = [];

  if (fwdParsed.confidence !== "exact" && fwdParsed.source) warnings.push(`INVALID_LANE_COUNT: lanes:forward=${fwdParsed.source}`);
  if (bwdParsed.confidence !== "exact" && bwdParsed.source) warnings.push(`INVALID_LANE_COUNT: lanes:backward=${bwdParsed.source}`);
  if (totalParsed.confidence !== "exact" && totalParsed.source) warnings.push(`INVALID_LANE_COUNT: lanes=${totalParsed.source}`);

  const widthDerived = () => Math.max(1, Math.round(roadWidth(properties) / LANE_WIDTH));

  if (oneWay) {
    // One-way: all travel lanes in the permitted direction.
    if (forward != null) {
      // lanes:forward given explicitly.
    } else if (total != null) {
      forward = total;
    } else {
      // Derive from width with LANE_WIDTH target.
      forward = widthDerived();
      source = "estimated";
      warnings.push(`ESTIMATED_LANES: one-way derived from width`);
    }
    backward = 0;
  } else {
    // Two-way.
    if (forward != null && backward != null) {
      // Both directional counts given.
    } else if (total != null) {
      // Total given, derive missing directional.
      if (forward == null && backward == null) {
        // Neither directional given: split total, extra to forward.
        forward = Math.ceil(total / 2);
        backward = Math.floor(total / 2);
      } else if (forward == null) {
        forward = Math.max(1, total - backward);
      } else if (backward == null) {
        backward = Math.max(1, total - forward);
      }
    } else {
      // No total given. If one directional is given, keep it and default
      // the other to 1. If neither given, untagged two-way defaults to 1+1.
      // But if lanes was explicitly given and invalid, don't double-warn.
      const lanesInvalid = totalParsed.confidence !== "exact" && totalParsed.source;
      if (forward == null && backward == null) {
        forward = 1; backward = 1;
        source = "fallback";
        if (!lanesInvalid) warnings.push(`ESTIMATED_LANES: untagged two-way defaults to 1+1`);
      } else if (forward == null) {
        forward = 1;
        if (bwdParsed.confidence === "exact") source = "tagged";
        else source = "fallback";
      } else if (backward == null) {
        backward = 1;
        if (fwdParsed.confidence === "exact") source = "tagged";
        else source = "fallback";
      }
    }
    // Validate against total if given.
    if (total != null && forward + backward !== total) {
      warnings.push(`INCONSISTENT_LANES: forward+backward (${forward+backward}) != total (${total})`);
      // Inconsistent counts: fall back to class default regardless of parse confidence.
      forward = 1; backward = 1;
      source = "fallback";
    }
  }

  const result = {
    forward: reverse ? 0 : forward,
    backward: reverse ? (forward + backward) : backward,
    oneWay: oneWay || reverse,
    reverse,
    total: reverse ? (forward + backward) : forward + backward,
    turnLanes: properties["turn:lanes"] || "",
    maxspeed: properties.maxspeed || "",
    source,
  };
  if (warnings.length) result.warnings = warnings;
  return result;
}
// Tunnels are rendered below the terrain and exposed through a local terrain
// cutout while the car is underground. They still need samples for spawning,
// surface contact and entrance/exit ramps.
export const roadVisible = () => true;
const key = (p) => p.slice(0, 2).map((v) => v.toFixed(7)).join(",");
const length = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const maxGrade = 0.08; // 8% maximum grade (0.08 rise/run).

export function prepareRoads(features, center) {
  const nodes = new Map(), edges = [], paths = new Map();
  const node = (p, identity, isOriginal = false) => {
    const id = identity == null ? `coordinate:${key(p)}` : `osm:${identity}`;
    if (!nodes.has(id)) nodes.set(id, { id, p: project(p, center), edges: [], original: isOriginal });
    return nodes.get(id);
  };
  for (const f of features) {
    const coordinates = f.geometry.coordinates;
    if (f.geometry.type !== "LineString" || !roadVisible(f.properties)) continue;
    const source = String(f.id).replace(/-\d+-\d+$/, "");
    // Build the full node chain: if the feature carries an ordered nodeIds
    // array (from the importer), use it; otherwise fall back to start/end
    // tags for the first/last vertices only.
    const nodeIds = f.properties?.nodeIds || [];
    for (let i = 1; i < coordinates.length; i++) {
      const aIdent = nodeIds[i - 1] ?? (i === 1 ? f.properties.startNodeId : null);
      const bIdent = nodeIds[i] ?? (i === coordinates.length - 1 ? f.properties.endNodeId : null);
      const a = node(coordinates[i - 1], aIdent, !!aIdent);
      const b = node(coordinates[i], bIdent, !!bIdent);
      if (length(a.p, b.p) < 0.01) continue;
      const h = nominalHeight(f.properties);
      const e = { a, b, f, source, h, ah: h, bh: h, length: length(a.p, b.p) };
      a.edges.push(e); b.edges.push(e); edges.push(e);
      if (!paths.has(source)) paths.set(source, []);
      paths.get(source).push(e);
    }
  }
  // Shared endpoints define connections; geometric crossings never create nodes.
  // Only original OSM nodes create connections. Synthetic coordinate nodes
  // are dead ends unless they connect to an original node.
  const warnings = [];
  for (const n of nodes.values()) {
    const heights = n.edges.map((e) => e.h);
    if (n.edges.length > 2 && new Set(heights).size > 1) warnings.push(n.id);
  }
  // Validate bridge/tunnel/covered/layer tag combinations per feature.
  for (const f of features) {
    if (f.geometry?.type !== "LineString" || !roadVisible(f.properties)) continue;
    const p = f.properties;
    const isTunnel = p.tunnel && p.tunnel !== "no";
    const isBridge = p.bridge && p.bridge !== "no";
    const isCovered = p.covered && p.covered !== "no";
    const layer = Number(p.layer) || 0;
    if (isTunnel && isBridge) warnings.push(`CONFLICTING_LEVEL_TAGS: ${f.id} has both tunnel and bridge`);
    if (isTunnel && isCovered) warnings.push(`CONFLICTING_LEVEL_TAGS: ${f.id} has both tunnel and covered`);
    if (isBridge && layer < 0) warnings.push(`CONFLICTING_LEVEL_TAGS: ${f.id} bridge with negative layer`);
    if (isTunnel && layer > 0) warnings.push(`CONFLICTING_LEVEL_TAGS: ${f.id} tunnel with positive layer`);
  }
  const heightAt = (e, n) => e.a === n ? e.ah : e.bh;
  const setHeight = (e, n, h) => { if (e.a === n) e.ah = h; else e.bh = h; };
  const continuation = (e, n) => {
    const far = e.a === n ? e.b : e.a;
    const ux = (far.p[0] - n.p[0]) / e.length, uz = (far.p[1] - n.p[1]) / e.length;
    // Continue a declared level before considering a portal transition. A
    // surface branch at a shared node must not pull an ongoing tunnel upward.
    const alternatives = n.edges.filter((other) => other !== e);
    const sameLevel = alternatives.filter((other) => other.h === e.h);
    const matches = (sameLevel.length ? sameLevel : alternatives).map((other) => {
      const end = other.a === n ? other.b : other.a;
      return { other, score: -(ux * (end.p[0] - n.p[0]) + uz * (end.p[1] - n.p[1])) / other.length };
    }).filter(({ score }) => score >= (n.edges.length === 2 ? -0.5 : Math.cos(Math.PI / 6))).sort((a, b) => b.score - a.score);
    return matches.length && (matches.length === 1 || matches[0].score - matches[1].score >= 0.03) ? matches[0].other : null;
  };
  // A bridge or tunnel may pull only one near-straight continuation toward its
  // level. Junction branches stay at their declared height. This creates a
  // driveable grade at portals instead of a four-metre vertical step.
  // 8% grade limit: for a height change deltaH, require at least
  // minRun = |deltaH| / 0.08 horizontal distance. Propagation only follows
  // explicit connections (continuation or declared ramps) and stops at
  // ambiguous branches. Bounded iterations ensure deterministic convergence.
  const queue = edges.filter((e) => Math.abs(e.h) > 0.00001)
    .flatMap((e) => [[e, e.a], [e, e.b]]);
  const MAX_ITERATIONS = edges.length * 4;
  for (let iter = 0; iter < queue.length && iter < MAX_ITERATIONS; iter++) {
    const [e, n] = queue[iter];
    // Explicit slip roads connect to the mainline even when a same-level
    // mainline continuation exists or the slip road bends away sharply.
    const ramps = n.edges.filter(other => other !== e &&
      /^(motorway|trunk)_link$/.test(other.f.properties.highway || "") &&
      other.h !== e.h && n.id.startsWith("osm:"));
    const targets = new Set([continuation(e, n), ...ramps].filter(Boolean));
    for (const next of targets) {
      const far = next.a === n ? next.b : next.a;
      const nearHeight = heightAt(e, n);
      const direction = Math.sign(nearHeight - next.h);
      if (!direction) continue;
      // Minimum horizontal run for this grade change.
      const deltaH = Math.abs(nearHeight - next.h);
      const minRun = deltaH / maxGrade;
      if (next.length < minRun - 1e-6) {
        warnings.push(`APPROACH_TOO_SHORT: ${next.f.id} grade ${(deltaH/next.length*100).toFixed(1)}% exceeds 8% over ${next.length.toFixed(1)}m (need ${minRun.toFixed(1)}m)`);
        continue; // Do not force an over-grade approach.
      }
      if (direction * (nearHeight - heightAt(next, n)) > 0.00001)
        setHeight(next, n, nearHeight);
      const farHeight = direction > 0
        ? Math.max(next.h, nearHeight - next.length * maxGrade)
        : Math.min(next.h, nearHeight + next.length * maxGrade);
      if (direction * (farHeight - heightAt(next, far)) > 0.00001) {
        setHeight(next, far, farHeight);
        queue.push([next, far]);
      }
    }
  }
  const result = new Map(features.map((f) => [f.id, []]));
  const connections = new Map(features.map((f) => [f.id, { start: [], end: [], warnings: [] }]));
  // Legacy fallback: if no features have nodeIds, use coordinate matching
  // with warnings, to support older assets.
  const hasNodeIds = features.some((f) => f.properties?.nodeIds?.length);
  for (const e of edges) {
    for (const [node, end] of [[e.a, "start"], [e.b, "end"]]) {
      // Only connect via original OSM nodes. Synthetic coordinate nodes
      // are dead ends (no automatic transfer). Ambiguous legacy endpoints
      // (multiple candidates at same coordinate) are warned, not connected.
      if (!node.original && hasNodeIds) {
        connections.get(e.f.id).warnings.push(
          `${end} endpoint at synthetic node ${node.id}; no connection`,
        );
        connections.get(e.f.id)[end] = [];
        continue;
      }
      const candidates = node.edges.filter((other) => other !== e);
      if (candidates.length === 0) {
        connections.get(e.f.id)[end] = [];
      } else if (candidates.length === 1) {
        connections.get(e.f.id)[end] = [candidates[0].f.id];
      } else {
        // Multiple edges at this node: deduplicate by feature ID first.
        const byFeature = new Map();
        for (const c of candidates) {
          if (!byFeature.has(c.f.id)) byFeature.set(c.f.id, c);
        }
        const uniqueCandidates = [...byFeature.values()];
        // Junction (degree > 2): connect all same-height edges regardless of angle.
        // Continuation (degree == 2): require geometric alignment.
        const isJunction = uniqueCandidates.length > 1 && node.edges.length > 2;
        const sameHeight = uniqueCandidates.filter((other) => Math.abs(heightAt(other, node) - heightAt(e, node)) < 0.01);
        let aligned;
        if (isJunction) {
          aligned = sameHeight; // all same-height edges connect at junctions
        } else {
          // Degree-2 continuation: require alignment within ~60°
          aligned = sameHeight.filter((other) => {
            const far = other.a === node ? other.b : other.a;
            const dx = (far.p[0] - node.p[0]) / other.length;
            const dz = (far.p[1] - node.p[1]) / other.length;
            const ex = (e.b.p[0] - e.a.p[0]) / e.length;
            const ez = (e.b.p[1] - e.a.p[1]) / e.length;
            return ex * dx + ez * dz > 0.5;
          });
        }
        if (aligned.length >= 1) {
          connections.get(e.f.id)[end] = aligned.map((a) => a.f.id);
        } else {
          connections.get(e.f.id).warnings.push(
            `${end} endpoint ambiguous at ${node.id}: ${uniqueCandidates.map((c) => c.f.id).join(",")}`,
          );
          connections.get(e.f.id)[end] = [];
        }
      }
    }
  }
  for (const list of paths.values()) {
    list.sort((a, b) => String(a.f.id).localeCompare(String(b.f.id), undefined, { numeric: true }));
    let distance = 0;
    for (const e of list) {
      const neighbor = (n) => {
        if (n.edges.length !== 2) return null;
        const other = n.edges.find(q => q !== e);
        return other && Math.abs(heightAt(other, n) - heightAt(e, n)) < 0.01 ? other : null;
      };
      const previous = neighbor(e.a), next = neighbor(e.b);
      // Keep every shared endpoint exact. The cross section uses averaged
      // tangents below, so ribbons remain joined without visible gaps.
      const a = [...e.a.p, e.ah], b = [...e.b.p, e.bh];
      const positions = [a];
      const count = Math.max(1, Math.ceil(length(a, b) / 8));
      for (let i = 1; i < count; i++) positions.push(mix(a, b, i / count));
      // Exact cover and ground thresholds keep ramp walls, portal frames,
      // terrain openings and tunnel roofs aligned at the same cross section.
      for (const level of [-3.85, -0.3]) {
        const t = (level - a[2]) / (b[2] - a[2]);
        if (t > 0 && t < 1) positions.push(mix(a, b, t));
      }
      positions.push(b);
      positions.sort((p, q) => length(a, p) - length(a, q));
      for (let i = positions.length - 1; i > 0; i--)
        if (length(positions[i], positions[i - 1]) < 0.00001) positions.splice(i, 1);
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
        const ownX = (e.b.p[0] - e.a.p[0]) / e.length;
        const ownZ = (e.b.p[1] - e.a.p[1]) / e.length;
        // A bounded miter meets both road edges; unit averaged normals shrink
        // the join and produce wedges at corners. Cap sharp turns safely.
        const miter = Math.min(2, 1 / Math.max(0.5, (dx * ownX + dz * ownZ) / l));
        samples[i].push(-dz / l * miter, dx / l * miter);
      }
      result.get(e.f.id).push(...samples);
    }
  }
  return { samples: result, connections, warnings };
}
