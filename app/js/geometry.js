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
