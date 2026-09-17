import * as THREE from "../../public/vendor/three.module.js";
import { mergeGeometries } from "../../public/vendor/BufferGeometryUtils.js";

export function ringsOf(feature) {
  const geometry = feature.geometry;
  if (geometry.type === "Polygon") return [geometry.coordinates];
  return geometry.type === "MultiPolygon" ? geometry.coordinates : [];
}

export function colourGeometry(geometry, color) {
  const rgb = new THREE.Color(color);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    colors[i * 3] = rgb.r;
    colors[i * 3 + 1] = rgb.g;
    colors[i * 3 + 2] = rgb.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function polygonShape(rings) {
  const shape = new THREE.Shape(
    rings[0].map(([x, z]) => new THREE.Vector2(x, -z)),
  );
  for (const ring of rings.slice(1)) {
    shape.holes.push(
      new THREE.Path(ring.map(([x, z]) => new THREE.Vector2(x, -z))),
    );
  }
  return shape;
}

export function mergeInto(group, geometries, material, cast = false) {
  if (!geometries.length) return;
  const prepared = geometries.map((geometry) => {
    const result = geometry.index ? geometry.toNonIndexed() : geometry;
    result.deleteAttribute("uv");
    return result;
  });
  const merged = mergeGeometries(prepared);
  if (!merged) throw new Error("Geometry attributes could not be combined");
  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = cast;
  mesh.receiveShadow = true;
  group.add(mesh);
  for (const geometry of new Set([...geometries, ...prepared])) geometry.dispose();
}

export function quad(a, b, width, y, color) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (length < 0.01) return null;
  const ox = ((-dz / length) * width) / 2;
  const oz = ((dx / length) * width) / 2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        a[0] + ox, y, a[1] + oz,
        b[0] + ox, y, b[1] + oz,
        a[0] - ox, y, a[1] - oz,
        b[0] + ox, y, b[1] + oz,
        b[0] - ox, y, b[1] - oz,
        a[0] - ox, y, a[1] - oz,
      ],
      3,
    ),
  );
  geometry.computeVertexNormals();
  return colourGeometry(geometry, color);
}

// Widths and laterals accept a scalar (constant cross-section) or an
// [a, b] pair (lane-merge taper between the two samples).
const asPair = (v) => (Array.isArray(v) ? v : [v, v]);

// A shared cross section at each sample keeps neighbouring ribbons watertight.
export function ribbon(a, b, width, offset, color, lateral = 0) {
  const [wa, wb] = asPair(width);
  const [la, lb] = asPair(lateral);
  const edge = (p, w, l, side) => [p[0] + p[4] * (l + side * w / 2),
    p[2] + offset, p[1] + p[5] * (l + side * w / 2)];
  const al = edge(a, wa, la, 1), ar = edge(a, wa, la, -1), bl = edge(b, wb, lb, 1), br = edge(b, wb, lb, -1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([...al, ...bl, ...ar, ...bl, ...br, ...ar], 3));
  geometry.computeVertexNormals();
  return colourGeometry(geometry, color);
}

export function deck(a, b, width, bottom = -0.7, top = 0.01, lateral = 0) {
  const [wa, wb] = asPair(width);
  const [la, lb] = asPair(lateral);
  const vertices = [];
  for (const [p, w, l] of [[a, wa, la], [b, wb, lb]]) for (const y of [bottom, top]) for (const side of [-1, 1])
    vertices.push(p[0] + p[4] * (l + side * w / 2), p[2] + y,
      p[1] + p[5] * (l + side * w / 2));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([0,1,2,1,3,2,4,6,5,5,6,7,0,4,1,1,4,5,2,3,6,3,7,6,0,2,4,2,6,4,1,5,3,3,5,7]);
  geometry.computeVertexNormals();
  return geometry;
}

export function tunnelPassage(a, b, width, clearance = 3.5, openings = {}) {
  const [wa, wb] = asPair(width);
  const edge = (p, w, side, height) => [p[0] + p[4] * side * w / 2,
    height ? Math.max(p[2], Math.min(-0.35, p[2] + height)) : p[2], p[1] + p[5] * side * w / 2];
  const al = edge(a, wa, 1, 0), ar = edge(a, wa, -1, 0), bl = edge(b, wb, 1, 0), br = edge(b, wb, -1, 0);
  const alt = edge(a, wa, 1, clearance), art = edge(a, wa, -1, clearance);
  const blt = edge(b, wb, 1, clearance), brt = edge(b, wb, -1, clearance);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    ...(openings.left ? [] : [...al, ...alt, ...bl, ...alt, ...blt, ...bl]),
    ...(openings.right ? [] : [...ar, ...br, ...art, ...art, ...br, ...brt]),
    ...(Math.max(a[2], b[2]) <= -3.85 ? [...alt, ...art, ...blt, ...art, ...brt, ...blt] : []),
  ], 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Static roadside traffic-signal head. The pole stands left of the OSM way
// direction (Singapore keeps left); the double-faced housing carries red,
// amber and green aspects with red lit. Pure geometry: housing merges into
// a dark material, lamps are vertex-colored for an emissive-style material.
export function trafficSignal(px, pz, groundY, dx, dz, width) {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const x = px - uz * (width / 2 + 1.2), z = pz + ux * (width / 2 + 1.2);
  const yaw = Math.atan2(ux, uz);
  const pole = new THREE.CylinderGeometry(0.09, 0.12, 4.6, 8);
  pole.translate(x, groundY + 2.3, z);
  const housing = new THREE.BoxGeometry(0.34, 1.0, 0.24);
  housing.rotateY(yaw);
  housing.translate(x, groundY + 4.1, z);
  const lamps = [];
  const aspects = [["#ff3b30", 1], ["#ffb340", 0.35], ["#2eff7a", 0.35]];
  aspects.forEach(([color, strength], i) => {
    const lit = new THREE.Color(color).multiplyScalar(strength).getStyle();
    for (const face of [-1, 1]) {
      const lamp = new THREE.BoxGeometry(0.15, 0.15, 0.06);
      lamp.rotateY(yaw);
      lamp.translate(x + ux * face * 0.13, groundY + 4.38 - i * 0.28, z + uz * face * 0.13);
      lamps.push(colourGeometry(lamp, lit));
    }
  });
  return { housing: [pole, housing], lamps };
}

// Roadside bus shelter running parallel to the road, left of the OSM way
// direction: roof on two poles, bench with backrest, and a stop sign at the
// upstream end. Plain geometries merge into a metal material; pure for
// testability. Returns the part list.
export function busShelter(px, pz, groundY, dx, dz, width) {
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const x = px - uz * (width / 2 + 2.2), z = pz + ux * (width / 2 + 2.2);
  const yaw = Math.atan2(ux, uz);
  const parts = [];
  const box = (w, h, d, along, up, left) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(yaw);
    g.translate(x + ux * along - uz * left, groundY + up, z + uz * along + ux * left);
    parts.push(g);
  };
  box(1.7, 0.08, 3.6, 0, 2.55, 0);
  for (const a of [-1.5, 1.5]) box(0.09, 2.55, 0.09, a, 1.275, 0);
  box(0.45, 0.07, 2.6, 0, 0.62, 0);
  box(0.07, 0.5, 2.6, 0, 0.95, 0.35);
  box(0.07, 2.6, 0.07, -2.2, 1.3, 0);
  box(0.5, 0.35, 0.06, -2.2, 2.4, 0);
  return parts;
}

// Expressway gantry (ERP-style): two poles flanking the road with a beam
// and one hanging antenna unit per lane. Plain geometries merge into a
// metal material; pure for testability. Returns the part list.
export function gantry(x, z, groundY, yaw, width, lanes) {
  const parts = [];
  const half = width / 2 + 0.8;
  for (const side of [-1, 1]) {
    const pole = new THREE.CylinderGeometry(0.12, 0.16, 6, 8);
    const nx = Math.cos(yaw), nz = -Math.sin(yaw);
    pole.translate(x + nx * half * side, groundY + 3, z + nz * half * side);
    parts.push(pole);
  }
  const beam = new THREE.BoxGeometry(width + 1.6, 0.25, 0.3);
  beam.rotateY(yaw);
  beam.translate(x, groundY + 5.9, z);
  parts.push(beam);
  const count = Math.max(1, Math.min(6, Math.round(lanes) || 2));
  for (let i = 0; i < count; i++) {
    const lateral = (i + 0.5) * width / count - width / 2;
    const unit = new THREE.BoxGeometry(0.4, 0.25, 0.5);
    unit.rotateY(yaw);
    // Local x maps to the road's left normal; reuse the pole-side basis.
    const nx = Math.cos(yaw), nz = -Math.sin(yaw);
    unit.translate(x + nx * lateral, groundY + 5.5, z + nz * lateral);
    parts.push(unit);
  }
  return parts;
}
