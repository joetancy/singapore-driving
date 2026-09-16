import * as THREE from "../../public/vendor/three.module.js";
import {
  colourGeometry,
  ribbon,
  deck,
  mergeInto,
  polygonShape,
  ringsOf,
  quad,
  tunnelPassage,
} from "./geometry.js";
import { loadPreferences, saveNight, saveSpawn } from "./storage.js";
import { roadIndex, surfaceAt, sampleHeight, drivingContact } from "./roads.js";
import { createSpawnPicker } from "./spawn-map.js";
import {
  clamp,
  nearestPoint,
  inPolygon,
  touchesPolygon,
  stepCar,
} from "./physics.js";
const $ = (id) => document.getElementById(id),
  d3 = window.d3;
const canvas = $("world"),
  keys = new Set(),
  touches = new Map();
let renderer,
  scene,
  camera,
  projection,
  manifest,
  car,
  frontWheels = [],
  allWheels = [],
  ready = false,
  toastTimer,
  firstPerson = false,
  night = false,
  skyLight,
  sunLight,
  nightLights = [];
let roads = [],
  obstacles = [],
  waterPolygons = [],
  boundaryPolygons = [],
  areas = [],
  chunkState = new Map(),
  lastStream = 0,
  lastHud = 0,
  distance = 0;
let state = { x: 0, z: 0, yaw: 0, speed: 0, steer: 0 },
  clock = new THREE.Clock(),
  smoothGround = 0,
  nearRoad = null,
  frame = 0;
const lookTarget = new THREE.Vector3(),
  cameraTarget = new THREE.Vector3(),
  sunTarget = new THREE.Object3D();
const worldMaterials = {},
  buildingNightUniform = { value: 0 },
  tunnelCutout = {
    count: { value: 0 },
    segments: { value: Array.from({ length: 64 }, () => new THREE.Vector4()) },
    widths: { value: Array(64).fill(0) },
  };
let surfaces = roadIndex([]), activeRoad = null, spawnSelection = null;
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2300);
}
function setNight(value) {
  night = value;
  buildingNightUniform.value = night ? 1 : 0;
  document.documentElement.classList.toggle("night", night);
  $("night-toggle").setAttribute(
    "aria-label",
    night ? "Disable dark mode" : "Enable dark mode",
  );
  $("night-toggle").querySelector(".mode-label").textContent = night ? "Dark mode: On" : "Dark mode: Off";
  $("night-toggle").setAttribute("aria-pressed", String(night));
  saveNight(night);
  if (!scene) return;
  scene.background.set(night ? "#07131f" : "#b2d2d6");
  scene.fog.color.set(night ? "#07131f" : "#b2d2d6");
  skyLight.color.set(night ? "#7899be" : "#d9eeef");
  skyLight.groundColor.set(night ? "#16202d" : "#737765");
  skyLight.intensity = night ? 0.7 : 2.25;
  sunLight.color.set(night ? "#91b7ff" : "#fff0cb");
  sunLight.intensity = night ? 0.45 : 3;
  worldMaterials.water?.color.set(night ? "#173d65" : "#4f939a");
  if (worldMaterials.lampGlow)
    worldMaterials.lampGlow.opacity = night ? 0.3 : 0;
  if (worldMaterials.lampHead) {
    worldMaterials.lampHead.emissiveIntensity = night ? 2.6 : 0;
    worldMaterials.lampHead.color.set(night ? "#fff0b0" : "#879393");
  }
  updateNightLights();
}
async function json(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not load ${url} (${response.status})`);
  return response.json();
}
function point(p) {
  return projection(p);
}
function orientedBox(width, height, depth, x, y, z, yaw = 0) {
  const geometry = new THREE.BoxGeometry(width, height, depth);
  geometry.rotateY(yaw);
  geometry.translate(x, y, z);
  return geometry;
}
function downGlow(x, y, z, radius = 2.2, height = 5) {
  const geometry = new THREE.ConeGeometry(radius, height, 16, 1, true);
  const colors = [];
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    const strength = geometry.attributes.position.getY(i) > 0 ? 0.7 : 0;
    colors.push(strength, strength, strength);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.translate(x, y - height / 2, z);
  return geometry;
}
function lightPool(x, y, z, radius) {
  const geometry = new THREE.CircleGeometry(radius, 24);
  const colors = [];
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    const strength = i === 0 ? 1 : 0;
    colors.push(strength, strength, strength);
  }
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(x, y + 0.09, z);
  return geometry;
}
function addTunnelPortal(a, b, width, frames, insets) {
  // Frame the covered mouth, not the start of the open approach trench.
  const threshold = -3.85;
  const t = (threshold - a[2]) / (b[2] - a[2]);
  if (!(t > 0 && t <= 1)) return;
  const x = a[0] + (b[0] - a[0]) * t,
    z = a[1] + (b[1] - a[1]) * t,
    yaw = Math.atan2(b[0] - a[0], b[1] - a[1]),
    nx = Math.cos(yaw), nz = -Math.sin(yaw), side = width / 2 + 0.85;
  for (const direction of [-1, 1]) {
    frames.push(orientedBox(0.6, 3.5, 1.4,
      x + nx * side * direction, threshold + 1.75, z + nz * side * direction, yaw));
    // Recessed vertical bands give the mouth a readable concrete reveal.
    insets.push(orientedBox(0.12, 2.8, 1.44,
      x + nx * (side - 0.15) * direction, threshold + 1.5,
      z + nz * (side - 0.15) * direction, yaw));
  }
  frames.push(orientedBox(width + 2.3, 0.25, 1.4, x, threshold + 3.62, z, yaw));
  insets.push(orientedBox(width + 1.1, 0.08, 1.44, x, threshold + 3.46, z, yaw));
}
function createChunk(data) {
  const group = new THREE.Group(),
    buildingGeo = [],
    bridgeGeo = [],
    roadGeo = [],
    tunnelRoadGeo = [],
    pavementGeo = [],
    markGeo = [], tunnelGeo = [], lampGeo = [], lampHeadGeo = [],
    lampGlowGeo = [],
    portalGeo = [],
    portalInsetGeo = [],
    tunnelLightGeo = [],
    tunnelGlowGeo = [],
    segments = [],
    lampPoints = [],
    blocks = [],
    buildingBases = data.features
      .filter((f) => {
        const p = f.properties || {};
        return (
          f.geometry.type !== "LineString" &&
          f.geometry.type !== "MultiLineString" &&
          p.building &&
          !p["building:part"]
        );
      })
      .flatMap((f) => ringsOf(f).map((raw) => raw.map((ring) => ring.map(point))));
  const roadAt = (x, z, height = null) => {
    let best = null;
    for (const f of data.features) if (f.geometry.type === "LineString") {
      const width = clamp(parseFloat(f.properties?.width) || 10, 4, 32),
        pts = f.properties?.samples || f.geometry.coordinates.map(point);
      for (let i = 1; i < pts.length; i++) {
        const hit = nearestPoint(x, z, pts[i - 1], pts[i]);
        const y = (pts[i - 1][2] || 0) + ((pts[i][2] || 0) - (pts[i - 1][2] || 0)) * hit.t;
        if ((height == null || Math.abs(y - height) < 1) && (!best || hit.d < best.d))
          best = { ...hit, a: pts[i - 1], b: pts[i], width, y };
      }
    }
    return best;
  };
  for (const f of data.features) {
    const props = f.properties || {};
    if (f.geometry.type === "Point" && props.highway === "traffic_signals") continue;
    if (f.geometry.type === "Point" && props.highway === "crossing") {
      const [x, z] = point(f.geometry.coordinates), road = roadAt(x, z);
      if (!road || road.d > road.width / 2 + 2) continue;
      const dx = road.b[0] - road.a[0], dz = road.b[1] - road.a[1], length = Math.hypot(dx, dz);
      for (let offset = -1.4; offset <= 1.4; offset += 0.55) {
        const cx = x + dx / length * offset, cz = z + dz / length * offset;
        markGeo.push(quad([cx + dz / length * road.width / 2, cz - dx / length * road.width / 2],
          [cx - dz / length * road.width / 2, cz + dx / length * road.width / 2], 0.32, 0.1, "#f4f3e6"));
      }
      continue;
    }
    if (
      f.geometry.type === "LineString" ||
      f.geometry.type === "MultiLineString"
    ) {
      if (props.roadVisible === false) continue;
      const width = clamp(parseFloat(props.width) ||
        ({ motorway: 18, trunk: 18, primary: 16, secondary: 14, tertiary: 11,
          residential: 9, service: 6 }[props.highway] || 10), 2, 32);
      const pts = props.samples;
      if (!pts?.length) throw new Error("Road assets require npm run build");
      const startDistance = pts[0][3], endDistance = pts[pts.length - 1][3];
      const lampsAllowed = !props.layout?.some(section => section.noLamps || section.junction);
      const atJunction = (d) =>
        (props.connections?.start?.length > 1 && d - startDistance < 14) ||
        (props.connections?.end?.length > 1 && endDistance - d < 14);
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.01) continue;
        const layout = props.layout?.[i] || {};
        const segment = { a, b, width, y: a[2], id: f.id + ":" + i,
          name: props.name || "Local road", oneway: props.oneway,
          source: props.sourceId || String(f.id).replace(/-\d+-\d+$/, ""), featureId: f.id,
          connections: [...(props.connections?.start || []), ...(props.connections?.end || [])],
          highway: props.highway, laneLayout: props.laneLayout,
          tunnel: Math.min(a[2], b[2]) < -0.3 };
        segments.push(segment);
        if (segment.tunnel) tunnelGeo.push(tunnelPassage(a, b, width + 2, 3.5, layout));
        const elevated = Math.max(a[2], b[2]) > 0.3,
          underground = Math.min(a[2], b[2]) < -0.3;
        if (elevated) {
          bridgeGeo.push(deck(a, b, width + 1.4));
          if (!atJunction(a[3]) && !atJunction(b[3])) for (const side of [-1, 1]) {
            if (layout[side === -1 ? "right" : "left"]) continue;
            bridgeGeo.push(deck(a, b, 0.16, 0.01, 0.81, side * (width / 2 + 0.6)));
          }
          if (!layout.noPier && Math.floor(a[3] / 40) !== Math.floor(b[3] / 40)) {
            const h = Math.max(0.1, (a[2] + b[2]) / 2 - 0.7);
            const pier = new THREE.BoxGeometry(1.3, h, 1.3);
            pier.translate((a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2);
            bridgeGeo.push(pier);
          }
        }
        pavementGeo.push(ribbon(a, b, width + 1.4, 0.025, "#b4bdb8"));
        (underground ? tunnelRoadGeo : roadGeo).push(
          ribbon(a, b, width, 0.065, underground ? "#252d31" : "#48575b"),
        );
        if (!layout.junction) addTunnelPortal(a, b, width, portalGeo, portalInsetGeo);
        const interpolate = (t) => a.map((v, j) => v + (b[j] - v) * t);
        const lanes = props.laneLayout;
        const dividers = lanes?.total > 1 ? Array.from({ length: lanes.total - 1 }, (_, n) =>
          (n + 1 - lanes.total / 2) * width / lanes.total) : [];
        if (
          Math.max(a[2], b[2]) < -3.85 &&
          Math.floor(a[3] / 22) !== Math.floor(b[3] / 22)
        ) {
          const distance = Math.ceil((a[3] + 0.001) / 22) * 22,
            light = interpolate(clamp((distance - a[3]) / (b[3] - a[3]), 0, 1)),
            yaw = Math.atan2(b[0] - a[0], b[1] - a[1]),
            ceiling = light[2] + 3.35;
          tunnelLightGeo.push(orientedBox(1.35, 0.12, 0.34,
            light[0], ceiling, light[1], yaw));
          tunnelGlowGeo.push(lightPool(light[0], light[2], light[1], width * 0.65));
          tunnelGlowGeo.push(downGlow(
            light[0], ceiling - 0.05, light[1], 2.5, 3.15,
          ));
        }
        for (const lateral of dividers) for (let d = Math.floor(a[3] / 13) * 13; d < b[3]; d += 13) {
          const lo = Math.max(d, a[3]), hi = Math.min(d + 5, b[3]);
          if (!layout.junction && hi > lo && !atJunction(lo) && !atJunction(hi)) markGeo.push(ribbon(
            interpolate((lo - a[3]) / (b[3] - a[3])),
            interpolate((hi - a[3]) / (b[3] - a[3])), 0.16, 0.09, "#e7e8d6", lateral));
        }
        if (!atJunction(a[3]) && !atJunction(b[3])) for (const side of [-1, 1]) {
          if (layout[side === -1 ? "right" : "left"]) continue;
          markGeo.push(ribbon(a, b, 0.12, 0.09, "#d3c990", side * (width / 2 - 0.3)));
        }
        const spacing = { motorway: 50, trunk: 45, primary: 45 }[props.highway] || 40;
        if (lampsAllowed && !segment.tunnel && !layout.noLamps) for (let d = Math.ceil((a[3] + 0.01) / spacing) * spacing; d < b[3] - 0.01; d += spacing) {
          if (atJunction(d)) continue;
          const t = (d - a[3]) / (b[3] - a[3]), p = interpolate(t), side = Math.floor(d / spacing) % 2 ? 1 : -1;
          const x = p[0] + p[4] * side * (width / 2 + 1.5), z = p[1] + p[5] * side * (width / 2 + 1.5);
          const road = roadAt(x, z, p[2]);
          const blocked = (road && road.d < road.width / 2 + 0.5) || buildingBases.some((rings) => inPolygon(x, z, rings)) || waterPolygons.some((rings) => inPolygon(x, z, rings));
          if (blocked) continue;
          const pole = new THREE.CylinderGeometry(0.08, 0.12, 8, 6); pole.translate(x, p[2] + 4, z); lampGeo.push(pole);
          const rx = -p[4] * side, rz = -p[5] * side, angle = Math.atan2(-rz, rx);
          const arm = new THREE.BoxGeometry(2.6, 0.12, 0.12); arm.rotateY(angle); arm.translate(x + rx * 1.3, p[2] + 7.9, z + rz * 1.3); lampGeo.push(arm);
          const head = new THREE.BoxGeometry(0.7, 0.14, 0.3); head.rotateY(angle); head.translate(x + rx * 2.45, p[2] + 7.82, z + rz * 2.45); lampHeadGeo.push(head);
          lampPoints.push([x + rx * 2.45, p[2] + 7.75, z + rz * 2.45]);
          lampGlowGeo.push(lightPool(x + rx * 2.45, p[2], z + rz * 2.45, 5));
          lampGlowGeo.push(downGlow(x + rx * 2.45, p[2] + 7.7, z + rz * 2.45, 2.8, 6.4));
        }
        if (lanes?.total > 1 && !segment.tunnel && !layout.junction) for (let d = Math.ceil((a[3] + 0.01) / 45) * 45; d < b[3] - 0.01; d += 45) {
          if (atJunction(d)) continue;
          const p = interpolate((d - a[3]) / (b[3] - a[3])), laneWidth = width / lanes.total;
          const arrow = (lateral, direction) => {
            const x = p[0] + p[4] * lateral, z = p[1] + p[5] * lateral, tx = p[5] * direction, tz = -p[4] * direction;
            markGeo.push(quad([x - tx * 1.6, z - tz * 1.6], [x + tx * 1.6, z + tz * 1.6], 0.24, p[2] + 0.095, "#e7e8d6"));
            markGeo.push(quad([x + tx * 1.55, z + tz * 1.55], [x + tx * 0.55 + p[4] * 0.75, z + tz * 0.55 + p[5] * 0.75], 0.2, p[2] + 0.095, "#e7e8d6"));
            markGeo.push(quad([x + tx * 1.55, z + tz * 1.55], [x + tx * 0.55 - p[4] * 0.75, z + tz * 0.55 - p[5] * 0.75], 0.2, p[2] + 0.095, "#e7e8d6"));
          };
          for (let n = 0; n < lanes.forward; n++) arrow(width / 2 - laneWidth * (n + 0.5), 1);
          for (let n = 0; n < lanes.backward; n++) arrow(-width / 2 + laneWidth * (n + 0.5), -1);
        }
      }
    } else {
      const height = clamp(
          parseFloat(props.height) ||
            (parseFloat(props["building:levels"] || props.building_levels) ||
              4) * 3.2,
          3,
          310,
        ),
        base = Math.max(0, parseFloat(props.min_height) || 0);
      const clearance = props.clearanceGeometry,
        clearanceHeight = Math.min(height, Number(props.clearanceHeight) || height),
        bands = clearance ? [
          [ringsOf({ geometry: clearance }), base, clearanceHeight],
          ...(height > clearanceHeight ? [[ringsOf(f), clearanceHeight, height]] : []),
        ] : [[ringsOf(f), base, height]];
      for (const [shapes, bandBase, bandHeight] of bands) for (const raw of shapes) {
        const rings = raw.map((r) => r.map(point));
        if (!rings[0] || rings[0].length < 4) continue;
        if (
          props["building:part"] &&
          buildingBases.some((base) => inPolygon(rings[0][0][0], rings[0][0][1], base))
        )
          continue;
        const hash = String(f.id || height)
            .split("")
            .reduce((a, c) => a + c.charCodeAt(0), 0),
          renderBase = bandBase + (hash % 23) * 0.006,
          g = new THREE.ExtrudeGeometry(polygonShape(rings), {
            depth: Math.max(0.01, bandHeight - bandBase),
            bevelEnabled: false,
            steps: 1,
            curveSegments: 1,
          });
        g.rotateX(-Math.PI / 2);
        g.translate(0, renderBase, 0);
        const palette = ["#bac8c5", "#9badae", "#d3d7c9", "#a6b8b6", "#bac4b5"];
        buildingGeo.push(colourGeometry(g, palette[hash % palette.length]));
        blocks.push({
          rings,
          clearancePrepared: !!clearance,
          base: bandBase,
          height: bandHeight,
          bbox: [
            Math.min(...rings[0].map((p) => p[0])),
            Math.min(...rings[0].map((p) => p[1])),
            Math.max(...rings[0].map((p) => p[0])),
            Math.max(...rings[0].map((p) => p[1])),
          ],
        });
      }
    }
  }
  mergeInto(group, pavementGeo.filter(Boolean), worldMaterials.pavement);
  mergeInto(group, bridgeGeo, worldMaterials.bridge);
  mergeInto(group, tunnelGeo, worldMaterials.tunnel);
  mergeInto(group, roadGeo.filter(Boolean), worldMaterials.road);
  mergeInto(group, tunnelRoadGeo.filter(Boolean), worldMaterials.tunnelRoad);
  mergeInto(group, markGeo.filter(Boolean), worldMaterials.mark);
  mergeInto(group, lampGeo, worldMaterials.lamp);
  mergeInto(group, lampHeadGeo, worldMaterials.lampHead);
  mergeInto(group, lampGlowGeo, worldMaterials.lampGlow);
  mergeInto(group, portalGeo, worldMaterials.tunnelPortal);
  mergeInto(group, portalInsetGeo, worldMaterials.tunnelInset);
  mergeInto(group, tunnelLightGeo, worldMaterials.tunnelLamp);
  mergeInto(group, tunnelGlowGeo, worldMaterials.tunnelGlow);
  mergeInto(group, buildingGeo, worldMaterials.building, true);
  group.userData = { segments, blocks, lamps: lampPoints };
  return group;
}
function createAreas(data) {
  const group = new THREE.Group(),
    waterGeo = [],
    parkGeo = [];
  for (const f of data.features) {
    for (const raw of ringsOf(f)) {
      const rings = raw.map((r) => r.map(point)),
        kind = f.properties?.kind || f.properties?.natural,
        isWater = kind === "water";
      if (isWater) waterPolygons.push(rings);
      const g = new THREE.ShapeGeometry(polygonShape(rings));
      g.rotateX(-Math.PI / 2);
      g.translate(0, isWater ? 0.005 : 0.009, 0);
      (isWater ? waterGeo : parkGeo).push(g);
      areas.push({ rings, kind: isWater ? "water" : "park" });
    }
  }
  mergeInto(group, waterGeo, worldMaterials.water);
  mergeInto(group, parkGeo, worldMaterials.park);
  scene.add(group);
}
function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
  });
  scene.remove(group);
}
function rebuildCollisionLists() {
  roads = [];
  obstacles = [];
  for (const c of chunkState.values()) {
    if (c.group) {
      roads.push(...c.group.userData.segments);
      obstacles.push(...c.group.userData.blocks);
    }
  }
  updateMinimapRoads();
  surfaces = roadIndex(roads);
  updateTunnelOpenings();
  updateNightLights();
}
function updateNightLights() {
  for (const light of nightLights) scene.remove(light);
  nightLights = [];
  if (!night) return;
  const lamps = [...chunkState.values()].flatMap((c) => c.group?.userData.lamps || [])
    .sort((a, b) => Math.hypot(a[0] - state.x, a[2] - state.z) - Math.hypot(b[0] - state.x, b[2] - state.z))
    .slice(0, 8);
  for (const [x, y, z] of lamps) {
    const light = new THREE.PointLight("#ffe6a5", 1.2, 100, 2);
    light.position.set(x, y, z);
    scene.add(light);
    nightLights.push(light);
  }
}
function updateTunnelOpenings() {
  // Only open ramps cut the terrain; covered tunnels retain the surface above.
  const nearby = roads.filter((r) => r.tunnel && Math.max(r.a[2], r.b[2]) > -3.85)
    .sort((a, b) => Math.min(Math.hypot(state.x - a.a[0], state.z - a.a[1]), Math.hypot(state.x - a.b[0], state.z - a.b[1])) -
      Math.min(Math.hypot(state.x - b.a[0], state.z - b.a[1]), Math.hypot(state.x - b.b[0], state.z - b.b[1])))
    .slice(0, 64);
  tunnelCutout.count.value = nearby.length;
  for (let i = 0; i < 64; i++) {
    const r = nearby[i];
    tunnelCutout.segments.value[i].set(r?.a[0] || 0, r?.a[1] || 0, r?.b[0] || 0, r?.b[1] || 0);
    tunnelCutout.widths.value[i] = r ? r.width / 2 + 1 : 0;
  }
}
function updateMinimapRoads() {
  const d = roads
    .map((r) => `M${r.a[0]},${r.a[1]}L${r.b[0]},${r.b[1]}`)
    .join("");
  for (const id of ["map-roads"]) {
    const map = $(id);
    if (map) map.setAttribute("d", d);
  }
}
async function streamChunks(force = false) {
  let changed = false;
  const loadRadius = innerWidth < 768 ? 900 : 1400,
    unloadRadius = loadRadius + 400,
    distanceTo = (c) => {
      const a = point([c.bbox[0], c.bbox[1]]),
        b = point([c.bbox[2], c.bbox[3]]),
        dx = Math.max(
          Math.min(a[0], b[0]) - state.x,
          0,
          state.x - Math.max(a[0], b[0]),
        ),
        dz = Math.max(
          Math.min(a[1], b[1]) - state.z,
          0,
          state.z - Math.max(a[1], b[1]),
        );
      return Math.hypot(dx, dz);
    },
    wanted = manifest.chunks.filter((c) => distanceTo(c) < loadRadius);
  for (const [id, c] of chunkState) {
    const chunk = manifest.chunks.find((x) => x.id === id);
    if (chunk && distanceTo(chunk) > unloadRadius && c.group) {
      disposeGroup(c.group);
      chunkState.delete(id);
      changed = true;
    }
  }
  const requests = wanted.map(async (c) => {
    if (chunkState.has(c.id)) return;
    chunkState.set(c.id, { loading: true });
    try {
      const data = await json("./data/" + c.file);
      const group = createChunk(data);
      scene.add(group);
      chunkState.set(c.id, { group });
      changed = true;
    } catch (e) {
      chunkState.delete(c.id);
      if (force) throw e;
      toast("A map section could not load. Retrying…");
      console.error(e);
    }
  });
  await Promise.all(requests);
  if (changed) rebuildCollisionLists();
}
function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
function createCar() {
  const group = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({
      color: "#d2f581",
      roughness: 0.32,
      metalness: 0.25,
    }),
    glass = new THREE.MeshStandardMaterial({
      color: "#24424b",
      roughness: 0.19,
      metalness: 0.55,
    }),
    black = new THREE.MeshStandardMaterial({
      color: "#142229",
      roughness: 0.85,
    }),
    chrome = new THREE.MeshStandardMaterial({
      color: "#cbd4cb",
      roughness: 0.4,
      metalness: 0.7,
    });
  group.add(
    box(1.9, 0.53, 4.35, paint, 0, 0.7, 0),
    box(1.88, 0.15, 4.08, black, 0, 0.4, 0),
    box(1.62, 0.58, 2.0, glass, 0, 1.2, 0.15),
    box(1.68, 0.1, 2.03, paint, 0, 1.52, 0.15),
    box(1.91, 0.17, 0.13, black, 0, 0.57, 2.2),
  );
  const white = new THREE.MeshStandardMaterial({
      color: "#fff9d8",
      emissive: "#fff0b0",
      emissiveIntensity: 0.3,
    }),
    red = new THREE.MeshStandardMaterial({
      color: "#fc5a4f",
      emissive: "#d42317",
      emissiveIntensity: 0.7,
    });
  for (const side of [-1, 1]) {
    group.add(
      box(0.5, 0.13, 0.08, white, side * 0.63, 0.78, -2.19),
      box(0.55, 0.13, 0.08, red, side * 0.62, 0.82, 2.2),
      box(0.25, 0.13, 0.35, paint, side * 1.0, 1.14, -0.58),
    );
    for (const z of [-1.35, 1.32]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.94, 0.4, z);
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 0.24, 16),
        black,
      );
      tire.rotation.z = Math.PI / 2;
      wheel.add(tire);
      const hub = new THREE.Mesh(
        new THREE.CylinderGeometry(0.23, 0.23, 0.253, 12),
        chrome,
      );
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      pivot.add(wheel);
      group.add(pivot);
      allWheels.push(wheel);
      if (z < 0) frontWheels.push(pivot);
    }
  }
  group.add(box(0.42, 0.13, 0.08, chrome, 0, 0.64, 2.22));
  scene.add(group);
  return group;
}
function setupMinimap() {
  const svg = d3.select("#minimap");
  svg
    .append("defs")
    .append("clipPath")
    .attr("id", "map-clip")
    .append("rect")
    .attr("width", 260)
    .attr("height", 220);
  const clipped = svg.append("g").attr("clip-path", "url(#map-clip)");
  const layer = clipped.append("g").attr("id", "map-world");
  layer
    .selectAll("path.area")
    .data(areas)
    .enter()
    .append("path")
    .attr("class", (d) => d.kind)
    .attr("d", (d) =>
      d.rings
        .map((r) => "M" + r.map((p) => p.join(",")).join("L") + "Z")
        .join(""),
    )
    .attr("fill-rule", "evenodd");
  layer.append("path").attr("id", "map-roads").attr("class", "road");
  updateMinimapRoads();
  svg
    .append("circle")
    .attr("cx", 130)
    .attr("cy", 110)
    .attr("r", 14)
    .attr("fill", "#bafa9c")
    .attr("opacity", 0.13);
  svg
    .append("path")
    .attr("id", "map-car")
    .attr("d", "M0,-8L6,6L0,3L-6,6Z")
    .attr("fill", "#c4ffa6")
    .attr("stroke", "#18372d")
    .attr("stroke-width", 1.5);
  svg
    .append("path")
    .attr("d", "M18,196v4h" + 250 * 0.19 + "v-4")
    .attr("fill", "none")
    .attr("stroke", "#a4c0ca")
    .attr("stroke-width", 1);
}
let showSpawnMap;
function openSpawnPicker() {
  if (!ready) return;
  clearDrivingInput();
  if (!showSpawnMap) showSpawnMap = createSpawnPicker({
    manifest, project: point, fetchJSON: json,
    onSelect: async (hit) => {
      const before = { ...state }, previousSelection = spawnSelection;
      state.x = hit.x; state.z = hit.z;
      try {
        await streamChunks(true);
        const selection = { roadId: hit.id, progress: hit.a[3] + (hit.b[3] - hit.a[3]) * hit.t };
        spawnSelection = selection;
        const candidate = getNearestRoad(hit.x, hit.z);
        if (!candidate) throw new Error("Selected road is unavailable");
        manifest.spawn = projection.invert([candidate.x, candidate.z]);
        manifest.spawnTarget = projection.invert(candidate.b);
        saveSpawn(manifest.spawn, manifest.spawnTarget, selection);
        resetCar(false);
        $("spawn-dialog").close();
        toast("Starting road saved");
      } catch (e) {
        state = before; spawnSelection = previousSelection;
        await streamChunks();
        throw e;
      }
    },
  });
  $("spawn-dialog").showModal();
  showSpawnMap([state.x, state.z]);
}
function getNearestRoad(x, z) {
  let best = null;
  for (const road of roads) {
    const p = nearestPoint(x, z, road.a, road.b);
    if (spawnSelection && road.featureId !== spawnSelection.roadId) continue;
    if (!best || p.d < best.d) best = { ...road, ...p, y: sampleHeight(road, p.t) };
  }
  return best;
}
function blocked(x, z, y, road = null) {
  // Imported buildings occasionally overlap a mapped road. The road contract
  // wins at the point of contact so bad footprints cannot make a route
  // impassable; off-road collisions remain unchanged.
  // Legacy source assets lack import-time clearance. Newer assets carry
  // clearancePrepared and can use their derived building polygons directly.
  if (road && road.d <= road.width / 2 + 0.6 && !obstacles.some((b) => b.clearancePrepared)) return false;
  const boxRadius = 2.3;
  for (const b of obstacles) {
    if (b.base > y + 1.7 || b.height < y) continue;
    if (
      x < b.bbox[0] - boxRadius ||
      x > b.bbox[2] + boxRadius ||
      z < b.bbox[1] - boxRadius ||
      z > b.bbox[3] + boxRadius
    )
      continue;
    for (const offset of [-1.4, 0, 1.4])
      if (
        touchesPolygon(
          x + Math.sin(state.yaw) * offset,
          z - Math.cos(state.yaw) * offset,
          b.rings,
          1,
        )
      )
        return true;
  }
  return false;
}
function resetCar(announce = true) {
  const p = point(manifest.spawn),
    q = point(manifest.spawnTarget);
  state = {
    x: p[0],
    z: p[1],
    yaw: Math.atan2(q[0] - p[0], -(q[1] - p[1])),
    speed: 0,
    steer: 0,
  };
  let nearest = getNearestRoad(state.x, state.z);
  if (!nearest && spawnSelection) {
    spawnSelection = null;
    nearest = getNearestRoad(state.x, state.z);
  }
  if (nearest) {
    const dx = nearest.b[0] - nearest.a[0],
      dz = nearest.b[1] - nearest.a[1],
      l = Math.hypot(dx, dz);
    let dir =
      Math.sin(state.yaw) * dx - Math.cos(state.yaw) * dz >= 0 ? 1 : -1;
    if (nearest.laneLayout?.oneWay) dir = nearest.laneLayout.reverse ? -1 : 1;
    state.yaw = Math.atan2(dx * dir, -dz * dir);
    const lanes = nearest.laneLayout,
      lateral = lanes?.total ? (nearest.width / 2 - nearest.width / (2 * lanes.total)) * dir : nearest.width * 0.24 * dir;
    state.x = nearest.x - (dz / l) * lateral;
    state.z = nearest.z + (dx / l) * lateral;
    smoothGround = nearest.y;
    activeRoad = nearest;
    nearRoad = nearest;
    spawnSelection = { roadId: nearest.featureId, progress: nearest.a[3] + (nearest.b[3] - nearest.a[3]) * nearest.t };
    saveSpawn(manifest.spawn, manifest.spawnTarget, spawnSelection);
  }
  car.position.set(state.x, smoothGround + 0.1, state.z);
  car.rotation.y = -state.yaw;
  camera.position.set(
    state.x - Math.sin(state.yaw) * 19,
    smoothGround + 9,
    state.z + Math.cos(state.yaw) * 19,
  );
  lookTarget.set(state.x, smoothGround + 3, state.z);
  camera.lookAt(lookTarget);
  if (announce) toast("Back on the road");
}
function clearDrivingInput() {
  keys.clear();
  touches.clear();
  document
    .querySelectorAll("[data-key]")
    .forEach((b) => b.classList.remove("active"));
}
function setHudHidden(value) {
  document.documentElement.classList.toggle("hud-hidden", value);
  $("hud-toggle").textContent = value ? "👁️" : "🙈";
  $("hud-toggle").dataset.label = value ? "Show interface" : "Hide interface";
  $("hud-toggle").setAttribute(
    "aria-label",
    value ? "Show driving interface" : "Hide driving interface",
  );
}
function toggleView() {
  firstPerson = !firstPerson;
  $("view-toggle").setAttribute("aria-pressed", String(firstPerson));
  $("view-toggle").querySelector(".view-label").textContent = firstPerson ? "Chase view" : "Driver view";
  $("view-toggle").dataset.label = firstPerson ? "Chase view" : "Driver view";
  $("view-toggle").setAttribute(
    "aria-label",
    firstPerson ? "Switch to chase view" : "Switch to driver view",
  );
  toast(firstPerson ? "Driver view" : "Chase view");
}
function setActionsCollapsed(value) {
  const actions = document.querySelector(".top-actions"),
    button = $("actions-toggle");
  actions.classList.toggle("actions-collapsed", value);
  button.textContent = value ? "☰" : "×";
  button.setAttribute("aria-expanded", String(!value));
  button.setAttribute(
    "aria-label",
    value ? "Open driving controls" : "Close driving controls",
  );
}
function setMinimapCollapsed(value) {
  const panel = document.querySelector(".map-panel"),
    button = $("minimap-toggle");
  panel.classList.toggle("collapsed", value);
  button.textContent = value ? "+" : "−";
  button.setAttribute("aria-expanded", String(!value));
  button.setAttribute("aria-label", value ? "Expand minimap" : "Collapse minimap");
}
function bindControls() {
  const valid = [
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
  ];
  window.addEventListener("keydown", (e) => {
    if (
      e.target instanceof HTMLButtonElement &&
      ["Space", "Enter"].includes(e.code)
    )
      return;
    if ($("info").open || $("spawn-dialog").open) return;
    if (valid.includes(e.code)) {
      e.preventDefault();
      keys.add(e.code);
    }
    if (!e.repeat && e.code === "KeyR" && ready) resetCar();
    if (!e.repeat && e.code === "KeyV" && ready) toggleView();
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => {
    clearDrivingInput();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearDrivingInput();
  });
  document.querySelectorAll("[data-key]").forEach((button) => {
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (!ready) return;
      button.setPointerCapture(e.pointerId);
      touches.set(e.pointerId, button.dataset.key);
      button.classList.add("active");
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
      button.addEventListener(event, (e) => {
        touches.delete(e.pointerId);
        button.classList.remove("active");
      });
  });
  $("reset").onclick = () => {
    if (ready) resetCar();
  };
  $("help").onclick = () => {
    clearDrivingInput();
    $("info").showModal();
  };
  $("close-info").onclick = $("back-to-road").onclick = () => $("info").close();
  $("spawn-picker").onclick = openSpawnPicker;
  $("view-toggle").onclick = toggleView;
  $("actions-toggle").onclick = () =>
    setActionsCollapsed(!document.querySelector(".top-actions").classList.contains("actions-collapsed"));
  setActionsCollapsed(matchMedia("(max-width: 760px)").matches);
  $("minimap").onclick = openSpawnPicker;
  $("minimap-toggle").onclick = () =>
    setMinimapCollapsed(!document.querySelector(".map-panel").classList.contains("collapsed"));
  setMinimapCollapsed(matchMedia("(max-width: 760px)").matches);
  $("night-toggle").onclick = () => setNight(!night);
  $("hud-toggle").onclick = () =>
    setHudHidden(!document.documentElement.classList.contains("hud-hidden"));
  $("close-spawn").onclick = () => $("spawn-dialog").close();
}
function hud() {
  const kmh = Math.round(Math.abs(state.speed) * 3.6);
  $("speed").textContent = kmh;
  $("speed-fill").style.width = clamp((kmh / 250) * 100, 0, 100) + "%";
  $("gear").textContent =
    state.speed < -0.2 ? "R" : state.speed > 0.2 ? "D" : "N";
  $("distance").innerHTML = distance.toFixed(2) + " <small>KM</small>";
  const roadDx = nearRoad?.b[0] - nearRoad?.a[0], roadDz = nearRoad?.b[1] - nearRoad?.a[1];
  const roadLength = nearRoad && Math.hypot(roadDx, roadDz);
  const travel = nearRoad && (Math.sin(state.yaw) * roadDx - Math.cos(state.yaw) * roadDz);
  const lateral = nearRoad && ((state.x - nearRoad.x) * -roadDz + (state.z - nearRoad.z) * roadDx) / roadLength;
  const wrongWay = nearRoad?.laneLayout && kmh > 5 && Math.abs(lateral) > 0.5 &&
    (travel * lateral < 0 || (nearRoad.laneLayout.oneWay && travel * (nearRoad.laneLayout.reverse ? -1 : 1) < 0));
  $("surface").textContent = wrongWay
      ? "WRONG WAY"
    : nearRoad && nearRoad.d < nearRoad.width / 2 + 1
      ? firstPerson
        ? "DRIVER VIEW"
        : kmh
          ? "KEEP LEFT"
          : "READY TO DRIVE"
      : "OFF ROAD";
  $("street").textContent = nearRoad && nearRoad.d < nearRoad.width / 2 + 1
    ? nearRoad.name || ""
    : "";
  const ll = projection.invert([state.x, state.z]);
  $("coordinates").textContent =
    ll[1].toFixed(3) + "° N, " + ll[0].toFixed(3) + "° E";
  const bearing = ((((state.yaw * 180) / Math.PI) % 360) + 360) % 360;
  $("heading").textContent =
    ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(bearing / 45) % 8] +
    " " +
    String(Math.round(bearing)).padStart(3, "0") +
    "°";
  d3.select("#map-world").attr(
    "transform",
    `translate(130,110) scale(.19) translate(${-state.x},${-state.z})`,
  );
  d3.select("#map-car").attr(
    "transform",
    `translate(130,110) rotate(${bearing})`,
  );
}
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  frame++;
  if (!ready) return;
  const now = performance.now();
  nearRoad = surfaceAt(surfaces, state.x, state.z, activeRoad, smoothGround);
  {
    const down = (...codes) =>
      codes.some((c) => keys.has(c) || [...touches.values()].includes(c));
    const input = {
      forward: down("KeyW", "ArrowUp"),
      back: down("KeyS", "ArrowDown"),
      left: down("KeyA", "ArrowLeft"),
      right: down("KeyD", "ArrowRight"),
      handbrake: down("Space"),
    };
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    for (let i = 0; i < steps; i++) {
      const oldX = state.x,
        oldZ = state.z;
      stepCar(state, input, dt / steps);
      const contact = drivingContact(surfaces, state, activeRoad, smoothGround);
      const ll = projection.invert([state.x, state.z]),
        bb = manifest.bounds;
      const outside =
        ll[0] < bb[0] ||
        ll[0] > bb[2] ||
        ll[1] < bb[1] ||
        ll[1] > bb[3] ||
        (boundaryPolygons.length &&
          !boundaryPolygons.some((r) => inPolygon(state.x, state.z, r)));
      const water =
        !contact?.tunnel && (!contact || contact.y < 0.1) &&
        waterPolygons.some((r) => inPolygon(state.x, state.z, r));
      if (outside || water || blocked(
        state.x,
        state.z,
        contact?.y ?? smoothGround,
        contact,
      )) {
        state.x = oldX;
        state.z = oldZ;
        state.speed = 0;
        if (now - lastHud > 2000) {
          lastHud = now;
          toast(
            outside
              ? "Edge of the available map"
              : water
                ? "Stay on land — reverse to return"
                : "Building ahead — reverse to return",
          );
        }
      } else {
        nearRoad = contact;
        activeRoad = contact;
        smoothGround = contact?.y ?? 0;
      }
      distance += Math.hypot(state.x - oldX, state.z - oldZ) / 1000;
    }
  }
  car.position.set(state.x, smoothGround + 0.08, state.z);
  car.rotation.y = -state.yaw;
  const slope = activeRoad ? (activeRoad.b[2] - activeRoad.a[2]) /
    Math.hypot(activeRoad.b[0] - activeRoad.a[0], activeRoad.b[1] - activeRoad.a[1]) : 0;
  const alignment = activeRoad ? (Math.sin(state.yaw) * (activeRoad.b[0] - activeRoad.a[0]) -
    Math.cos(state.yaw) * (activeRoad.b[1] - activeRoad.a[1])) /
    Math.hypot(activeRoad.b[0] - activeRoad.a[0], activeRoad.b[1] - activeRoad.a[1]) : 0;
  car.rotation.x = Math.atan(slope * alignment);
  for (const wheel of allWheels) wheel.rotation.x -= (state.speed * dt) / 0.4;
  for (const wheel of frontWheels) wheel.rotation.y = -state.steer * 0.4;
  const underground = !!activeRoad?.tunnel;
  if (firstPerson) {
    camera.position.set(
      state.x + Math.cos(state.yaw) * 0.34 + Math.sin(state.yaw) * 0.98,
      smoothGround + 1.65,
      state.z + Math.sin(state.yaw) * 0.34 - Math.cos(state.yaw) * 0.98,
    );
    lookTarget.set(
      state.x + Math.sin(state.yaw) * (underground ? 12 : 32),
      smoothGround + 1.65,
      state.z - Math.cos(state.yaw) * (underground ? 12 : 32),
    );
  } else {
    const follow = underground ? 3 : 19 + Math.min(6, Math.abs(state.speed) * 0.16);
    cameraTarget.set(
      state.x - Math.sin(state.yaw) * follow,
      smoothGround + (underground ? 1.8 : 8.5 + Math.abs(state.speed) * 0.045),
      state.z + Math.cos(state.yaw) * follow,
    );
    const cameraRoad = underground && surfaceAt(surfaces, cameraTarget.x, cameraTarget.z, activeRoad, smoothGround);
    if (underground && !cameraRoad?.tunnel) cameraTarget.set(
      state.x - Math.sin(state.yaw) * 0.7, smoothGround + 1.8, state.z + Math.cos(state.yaw) * 0.7);
    if (underground) camera.position.copy(cameraTarget);
    else camera.position.lerp(cameraTarget, 1 - Math.exp(-5 * dt));
    lookTarget.lerp(
      new THREE.Vector3(
        state.x + Math.sin(state.yaw) * 9,
        smoothGround + (underground ? 1.7 : 2.5),
        state.z - Math.cos(state.yaw) * 9,
      ),
      underground ? 1 : 1 - Math.exp(-7 * dt),
    );
  }
  for (const material of [worldMaterials.building, worldMaterials.water, worldMaterials.park])
    if (material) material.visible = !underground;
  camera.lookAt(lookTarget);
  sunTarget.position.set(state.x, 0, state.z);
  const sun = scene.getObjectByName("sun");
  sun.position.set(state.x - 180, 250, state.z + 70);
  if (now - lastStream > 1500) {
    lastStream = now;
    streamChunks().catch(console.error);
  }
  if (frame % 30 === 0) updateNightLights();
  if (frame % 5 === 0) hud();
  renderer.render(scene, camera);
}
async function init() {
  bindControls();
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
      logarithmicDepthBuffer: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#b2d2d6");
    scene.fog = new THREE.FogExp2("#b2d2d6", 0.00052);
    camera = new THREE.PerspectiveCamera(60, 1, 0.15, 3000);
    skyLight = new THREE.HemisphereLight("#d9eeef", "#737765", 2.25);
    scene.add(skyLight);
    sunLight = new THREE.DirectionalLight("#fff0cb", 3.0);
    sunLight.name = "sun";
    sunLight.target = sunTarget;
    scene.add(sunLight, sunTarget);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: "#9daa94",
      roughness: 1,
      side: THREE.DoubleSide,
    });
    groundMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uTunnelCount = tunnelCutout.count;
      shader.uniforms.uTunnelSegments = tunnelCutout.segments;
      shader.uniforms.uTunnelWidths = tunnelCutout.widths;
      shader.vertexShader = "varying vec2 vTunnelWorld;\n" + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <worldpos_vertex>",
        "#include <worldpos_vertex>\nvTunnelWorld = (modelMatrix * vec4(transformed, 1.0)).xz;",
      );
      shader.fragmentShader =
        "uniform int uTunnelCount; uniform vec4 uTunnelSegments[64]; uniform float uTunnelWidths[64]; varying vec2 vTunnelWorld;\n" +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
        for (int i = 0; i < 64; i++) {
          if (i >= uTunnelCount) break;
          vec2 a = uTunnelSegments[i].xy, b = uTunnelSegments[i].zw, ab = b - a;
          float t = clamp(dot(vTunnelWorld - a, ab) / max(dot(ab, ab), 0.001), 0.0, 1.0);
          if (distance(vTunnelWorld, a + ab * t) < uTunnelWidths[i]) discard;
        }`,
      );
    };
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160000, 160000),
      groundMaterial,
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.025;
    ground.receiveShadow = true;
    scene.add(ground);
    worldMaterials.road = new THREE.MeshStandardMaterial({
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    worldMaterials.tunnelRoad = new THREE.MeshStandardMaterial({
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      vertexColors: true,
      roughness: 0.86,
      side: THREE.DoubleSide,
    });
    worldMaterials.pavement = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    worldMaterials.bridge = new THREE.MeshStandardMaterial({
      color: "#718184",
      roughness: 0.9,
    });
    worldMaterials.tunnel = new THREE.MeshStandardMaterial({
      color: "#5d6668",
      roughness: 1,
      side: THREE.DoubleSide,
    });
    worldMaterials.tunnelLamp = new THREE.MeshBasicMaterial({ color: "#fff0c0" });
    worldMaterials.tunnel.emissive = new THREE.Color("#546777");
    worldMaterials.tunnel.emissiveIntensity = 0.28;
    worldMaterials.tunnelRoad.emissive = new THREE.Color("#303942");
    worldMaterials.tunnelRoad.emissiveIntensity = 0.2;
    worldMaterials.tunnelPortal = new THREE.MeshStandardMaterial({
      color: "#697477",
      roughness: 0.96,
      metalness: 0.02,
    });
    worldMaterials.tunnelInset = new THREE.MeshStandardMaterial({
      color: "#20292d",
      roughness: 0.82,
    });
    worldMaterials.lampGlow = new THREE.MeshBasicMaterial({
      color: "#ffe6a0",
      transparent: true,
      opacity: 0,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    worldMaterials.tunnelGlow = new THREE.MeshBasicMaterial({
      color: "#ffe3a0",
      transparent: true,
      opacity: 0.42,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    worldMaterials.mark = new THREE.MeshBasicMaterial({
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    worldMaterials.lamp = new THREE.MeshStandardMaterial({ color: "#808080", roughness: 0.65 });
    worldMaterials.lampHead = new THREE.MeshStandardMaterial({
      color: "#fff0b0",
      emissive: "#ffd36a",
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    worldMaterials.building = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.77,
    });
    worldMaterials.water = new THREE.MeshStandardMaterial({
      color: "#4f939a",
      roughness: 0.27,
      metalness: 0.18,
      side: THREE.DoubleSide,
    });
    worldMaterials.park = new THREE.MeshStandardMaterial({
      color: "#769779",
      roughness: 1,
      side: THREE.DoubleSide,
    });
    worldMaterials.building.onBeforeCompile = (shader) => {
      shader.uniforms.uNight = buildingNightUniform;
      shader.vertexShader =
        "varying vec3 vFacadePosition; varying vec3 vFacadeNormal;\n" +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFacadePosition=(modelMatrix*vec4(position,1.0)).xyz; vFacadeNormal=normalize(mat3(modelMatrix)*normal);",
      );
      shader.fragmentShader =
        "uniform float uNight; varying vec3 vFacadePosition; varying vec3 vFacadeNormal;\n" +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        "#include <color_fragment>\nif(abs(vFacadeNormal.y)<0.5 && vFacadePosition.y>3.5){float u=fract((vFacadePosition.x+vFacadePosition.z)*0.22);float v=fract(vFacadePosition.y*0.28);float windowMask=step(0.18,u)*(1.0-step(0.81,u))*step(0.22,v)*(1.0-step(0.80,v));float lit=step(0.5,fract(sin(dot(floor(vec2((vFacadePosition.x+vFacadePosition.z)*0.22,vFacadePosition.y*0.28)),vec2(12.9898,78.233)))*43758.5453));windowMask*=lit;diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(0.59,0.76,0.80),windowMask*0.60);}",
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\nif(abs(vFacadeNormal.y)<0.5 && vFacadePosition.y>3.5){float u=fract((vFacadePosition.x+vFacadePosition.z)*0.22);float v=fract(vFacadePosition.y*0.28);float windowMask=step(0.18,u)*(1.0-step(0.81,u))*step(0.22,v)*(1.0-step(0.80,v));float lit=step(0.5,fract(sin(dot(floor(vec2((vFacadePosition.x+vFacadePosition.z)*0.22,vFacadePosition.y*0.28)),vec2(12.9898,78.233)))*43758.5453));windowMask*=lit;totalEmissiveRadiance+=windowMask*uNight*vec3(1.0,0.52,0.16)*1.65;}",
      );
    };
    manifest = await json("./data/manifest.json");
    const preferences = loadPreferences();
    if (preferences.spawn) {
      manifest.spawn = preferences.spawn.spawn;
      manifest.spawnTarget = preferences.spawn.spawnTarget;
      spawnSelection = preferences.spawn.roadId ? preferences.spawn : null;
    }
    night = preferences.night;
    projection = d3
      .geoMercator()
      .center(manifest.center)
      .translate([0, 0])
      .scale(6378137);
    if (manifest.mode === "osm") {
      $("map-status").textContent = "OPENSTREETMAP · SINGAPORE";
      $("source-note").innerHTML =
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · Heights may be estimated';
      $("info-data-title").textContent = "About the map";
      $("info-data-text").textContent =
        "Singapore geometry derived from OpenStreetMap, licensed under ODbL. Buildings use recorded heights or estimated floor heights; roads and vehicle physics are simplified. Coverage is limited to the bundled extract. See data/source.json for provenance.";
    }
    $("district").textContent = manifest.name || "Singapore";
    const ar = await json("./data/areas.geojson");
    if (manifest.boundaryFile) {
      const border = await json("./data/" + manifest.boundaryFile);
      boundaryPolygons = border.features.flatMap((f) =>
        ringsOf(f).map((rings) => rings.map((r) => r.map(point))),
      );
    }
    createAreas(ar);
    const spawn = point(manifest.spawn);
    state.x = spawn[0];
    state.z = spawn[1];
    $("loading-message").textContent = "Loading the neighbourhood…";
    await streamChunks(true);
    car = createCar();
    setupMinimap();
    resetCar(false);
    setNight(night);
    const resize = () => {
      const w = canvas.clientWidth,
        h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", resize);
    resize();
    ready = true;
    hud();
    renderer.render(scene, camera);
    $("loading").classList.add("hidden");
    clock.start();
    animate();
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      setPaused(true);
      $("loading").classList.remove("hidden");
      $("loading-message").textContent =
        "The graphics context was interrupted. Reload the page to resume.";
    });
  } catch (e) {
    console.error(e);
    $("loading-message").textContent =
      "The driving view could not start. Check that WebGL is enabled and reload to retry. " +
      e.message;
    document.querySelector(".loading-track").style.display = "none";
  }
}
init();
