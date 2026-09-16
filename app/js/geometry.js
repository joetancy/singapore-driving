import * as THREE from "../../public/vendor/three.module.js";
import { mergeGeometries } from "../../public/vendor/BufferGeometryUtils.js";

export function ringsOf(feature) {
  const geometry = feature.geometry;
  if (geometry.type === "Polygon") return [geometry.coordinates];
  return geometry.type === "MultiPolygon" ? geometry.coordinates : [];
}

export function elevation(properties) {
  if (properties.tunnel === "yes" || Number(properties.layer) < 0) return -4;
  return properties.bridge === "yes"
    ? Math.max(4, Number(properties.layer || 1) * 4)
    : Math.max(0, Number(properties.layer || 0) * 4);
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

// A shared cross section at each sample keeps neighbouring ribbons watertight.
export function ribbon(a, b, width, offset, color, lateral = 0) {
  const edge = (p, side) => [p[0] + p[4] * (lateral + side * width / 2),
    p[2] + offset, p[1] + p[5] * (lateral + side * width / 2)];
  const al = edge(a, 1), ar = edge(a, -1), bl = edge(b, 1), br = edge(b, -1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([...al, ...bl, ...ar, ...bl, ...br, ...ar], 3));
  geometry.computeVertexNormals();
  return colourGeometry(geometry, color);
}

export function deck(a, b, width, bottom = -0.7, top = 0.01, lateral = 0) {
  const vertices = [];
  for (const p of [a, b]) for (const y of [bottom, top]) for (const side of [-1, 1])
    vertices.push(p[0] + p[4] * (lateral + side * width / 2), p[2] + y,
      p[1] + p[5] * (lateral + side * width / 2));
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setIndex([0,1,2,1,3,2,4,6,5,5,6,7,0,4,1,1,4,5,2,3,6,3,7,6,0,2,4,2,6,4,1,5,3,3,5,7]);
  geometry.computeVertexNormals();
  return geometry;
}

export function tunnelPassage(a, b, width, clearance = 3.5, openings = {}) {
  const edge = (p, side, height) => [p[0] + p[4] * side * width / 2,
    height ? Math.max(p[2], Math.min(-0.35, p[2] + height)) : p[2], p[1] + p[5] * side * width / 2];
  const al = edge(a, 1, 0), ar = edge(a, -1, 0), bl = edge(b, 1, 0), br = edge(b, -1, 0);
  const alt = edge(a, 1, clearance), art = edge(a, -1, clearance);
  const blt = edge(b, 1, clearance), brt = edge(b, -1, clearance);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    ...(openings.left ? [] : [...al, ...alt, ...bl, ...alt, ...blt, ...bl]),
    ...(openings.right ? [] : [...ar, ...br, ...art, ...art, ...br, ...brt]),
    ...(Math.max(a[2], b[2]) <= -3.85 ? [...alt, ...art, ...blt, ...art, ...brt, ...blt] : []),
  ], 3));
  geometry.computeVertexNormals();
  return geometry;
}
