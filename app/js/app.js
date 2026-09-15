import * as THREE from "../../public/vendor/three.module.js";
import {
  colourGeometry,
  elevation,
  mergeInto,
  polygonShape,
  quad,
  ringsOf,
} from "./geometry.js";
import { loadPreferences, saveNight, saveSpawn } from "./storage.js";
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
  paused = false,
  ready = false,
  toastTimer,
  wasPausedBeforeInfo = false,
  wasPausedBeforePicker = false,
  firstPerson = false,
  night = false,
  skyLight,
  sunLight;
let roads = [],
  obstacles = [],
  waterPolygons = [],
  boundaryPolygons = [],
  areas = [],
  roadFeatures = [],
  chunkState = new Map(),
  lastStream = 0,
  lastHud = 0,
  distance = 0,
  spawnPickerReady = false,
  spawnZoom,
  trafficGroup = null,
  trafficKey = "";
let state = { x: 0, z: 0, yaw: 0, speed: 0, steer: 0 },
  clock = new THREE.Clock(),
  smoothGround = 0,
  nearRoad = null,
  frame = 0;
const lookTarget = new THREE.Vector3(),
  cameraTarget = new THREE.Vector3(),
  sunTarget = new THREE.Object3D();
const worldMaterials = {};
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2300);
}
function setNight(value) {
  night = value;
  document.documentElement.classList.toggle("night", night);
  $("night-toggle").setAttribute(
    "aria-label",
    night ? "Enable day mode" : "Enable night mode",
  );
  $("night-toggle").textContent = night ? "☀️" : "🌙";
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
function createChunk(data) {
  const group = new THREE.Group(),
    buildingGeo = [],
    roadGeo = [],
    pavementGeo = [],
    markGeo = [],
    segments = [],
    blocks = [];
  for (const f of data.features) {
    const props = f.properties || {};
    if (
      f.geometry.type === "LineString" ||
      f.geometry.type === "MultiLineString"
    ) {
      const lines =
        f.geometry.type === "LineString"
          ? [f.geometry.coordinates]
          : f.geometry.coordinates;
      const width = clamp(
          parseFloat(props.width) ||
            {
              motorway: 18,
              trunk: 18,
              primary: 16,
              secondary: 14,
              tertiary: 11,
              residential: 9,
              service: 6,
            }[props.highway] ||
            10,
          4,
          32,
        ),
        y = elevation(props),
        roadY =
          y +
          0.065 +
          (String(f.id)
            .split("")
            .reduce((n, c) => n + c.charCodeAt(0), 0) %
            17) *
            0.0001;
      for (const line of lines) {
        const pts = line.map(point);
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i],
            b = pts[i + 1],
            len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (len < 0.01) continue;
          const segment = {
            a,
            b,
            width,
            y,
            name: props.name || "Local road",
            oneway: props.oneway,
            source: f.id,
          };
          segments.push(segment);
          pavementGeo.push(quad(a, b, width + 4, y + 0.025, "#b4bdb8"));
          roadGeo.push(quad(a, b, width, roadY, "#48575b"));
          const dx = (b[0] - a[0]) / len,
            dz = (b[1] - a[1]) / len;
          for (let t = 0; t < len; t += 13) {
            const end = Math.min(t + 5, len);
            markGeo.push(
              quad(
                [a[0] + dx * t, a[1] + dz * t],
                [a[0] + dx * end, a[1] + dz * end],
                0.16,
                roadY + 0.02,
                "#e7e8d6",
              ),
            );
          }
          for (const side of [-1, 1]) {
            const off = side * (width / 2 - 0.65),
              aa = [a[0] - dz * off, a[1] + dx * off],
              bb = [b[0] - dz * off, b[1] + dx * off];
            markGeo.push(quad(aa, bb, 0.12, roadY + 0.019, "#d3c990"));
          }
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
      for (const raw of ringsOf(f)) {
        const rings = raw.map((r) => r.map(point));
        if (rings[0].length < 4) continue;
        const g = new THREE.ExtrudeGeometry(polygonShape(rings), {
          depth: Math.max(1, height - base),
          bevelEnabled: false,
          steps: 1,
          curveSegments: 1,
        });
        g.rotateX(-Math.PI / 2);
        g.translate(0, base, 0);
        const palette = ["#bac8c5", "#9badae", "#d3d7c9", "#a6b8b6", "#bac4b5"];
        const hash = String(f.id || height)
          .split("")
          .reduce((a, c) => a + c.charCodeAt(0), 0);
        buildingGeo.push(colourGeometry(g, palette[hash % palette.length]));
        blocks.push({
          rings,
          base,
          height,
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
  mergeInto(group, roadGeo.filter(Boolean), worldMaterials.road);
  mergeInto(group, markGeo.filter(Boolean), worldMaterials.mark);
  mergeInto(group, buildingGeo, worldMaterials.building, true);
  group.userData = { segments, blocks };
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
  updateTrafficLights();
}
function intersection(a, b, c, d) {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 0.001) return null;
  const t =
      ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den,
    u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  if (t < -0.02 || t > 1.02 || u < -0.02 || u > 1.02) return null;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}
function updateTrafficLights() {
  const key = [...chunkState.keys()].sort().join("|");
  if (key === trafficKey) return;
  trafficKey = key;
  if (trafficGroup) disposeGroup(trafficGroup);
  if (!roads.length) return;
  const size = 120,
    cells = new Map(),
    hits = [];
  for (let i = 0; i < roads.length; i++) {
    const r = roads[i];
    if (r.width < 10) continue;
    const minX = Math.floor(Math.min(r.a[0], r.b[0]) / size),
      maxX = Math.floor(Math.max(r.a[0], r.b[0]) / size),
      minZ = Math.floor(Math.min(r.a[1], r.b[1]) / size),
      maxZ = Math.floor(Math.max(r.a[1], r.b[1]) / size);
    for (let x = minX; x <= maxX; x++)
      for (let z = minZ; z <= maxZ; z++) {
        const cell = cells.get(`${x},${z}`) || [];
        for (const j of cell) {
          const q = roads[j];
          if (q.source === r.source || q.width < 10) continue;
          const p = intersection(r.a, r.b, q.a, q.b);
          if (!p || hits.some((h) => Math.hypot(h[0] - p[0], h[1] - p[1]) < 18))
            continue;
          hits.push(p);
          if (hits.length >= 120) break;
        }
        cell.push(i);
        cells.set(`${x},${z}`, cell);
        if (hits.length >= 120) break;
      }
    if (hits.length >= 120) break;
  }
  const group = new THREE.Group(),
    poleGeo = new THREE.CylinderGeometry(0.08, 0.11, 4.4, 6),
    headGeo = new THREE.BoxGeometry(0.24, 0.58, 0.18),
    lampGeo = new THREE.SphereGeometry(0.065, 8, 8),
    poleMat = new THREE.MeshStandardMaterial({
      color: "#26363b",
      roughness: 0.8,
    }),
    headMat = new THREE.MeshStandardMaterial({
      color: "#101b20",
      roughness: 0.7,
    }),
    redMat = new THREE.MeshStandardMaterial({
      color: "#ff413d",
      emissive: "#e11d18",
      emissiveIntensity: 1.8,
    }),
    amberMat = new THREE.MeshStandardMaterial({
      color: "#e4ae3d",
      emissive: "#b26c15",
      emissiveIntensity: 0.25,
    }),
    greenMat = new THREE.MeshStandardMaterial({
      color: "#4dce7e",
      emissive: "#1e8f51",
      emissiveIntensity: 0.2,
    });
  for (const p of hits) {
    const r = getNearestRoad(p[0], p[1]);
    if (!r) continue;
    const len = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]),
      nx = -(r.b[1] - r.a[1]) / len,
      nz = (r.b[0] - r.a[0]) / len,
      offset = r.width / 2 + 1.5;
    for (const side of [-1, 1]) {
      const x = p[0] + nx * offset * side,
        z = p[1] + nz * offset * side,
        pole = new THREE.Mesh(poleGeo, poleMat),
        head = new THREE.Mesh(headGeo, headMat);
      pole.position.set(x, 2.2, z);
      head.position.set(x, 4.05, z);
      head.rotation.y = Math.atan2(r.b[0] - r.a[0], r.b[1] - r.a[1]);
      group.add(pole, head);
      for (const [y, mat] of [
        [4.22, redMat],
        [4.05, amberMat],
        [3.88, greenMat],
      ]) {
        const lamp = new THREE.Mesh(lampGeo, mat);
        lamp.position.set(
          x + 0.13 * Math.sin(head.rotation.y),
          y,
          z + 0.13 * Math.cos(head.rotation.y),
        );
        group.add(lamp);
      }
    }
  }
  trafficGroup = group;
  scene.add(group);
}
function updateMinimapRoads() {
  const d = roads
    .map((r) => `M${r.a[0]},${r.a[1]}L${r.b[0]},${r.b[1]}`)
    .join("");
  for (const id of ["map-roads", "spawn-roads"]) {
    const map = $(id);
    if (map) map.setAttribute("d", d);
  }
}
async function streamChunks(force = false) {
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
    } catch (e) {
      chunkState.delete(c.id);
      if (force) throw e;
      toast("A map section could not load. Retrying…");
      console.error(e);
    }
  });
  await Promise.all(requests);
  rebuildCollisionLists();
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
function addTrees() {
  const trunks = [],
    crowns = [],
    trunk = new THREE.MeshStandardMaterial({ color: "#786f56" }),
    leaves = new THREE.MeshStandardMaterial({ color: "#5e846b", roughness: 1 });
  let n = 0,
    seed = 1717;
  const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296,
    add = (x, z, s) => {
      const h = 3 + s * 3.5,
        tg = new THREE.CylinderGeometry(0.22 + s * 0.12, 0.34 + s * 0.16, h, 5);
      tg.translate(x, h / 2, z);
      trunks.push(tg);
      const cg = new THREE.IcosahedronGeometry(2.4 + s * 1.8, 1);
      cg.scale(1, 1.1 + s * 0.12, 1);
      cg.translate(x, h + 1.3 + s, z);
      crowns.push(cg);
      n++;
    };
  for (const f of roadFeatures) {
    const pts = f.geometry.coordinates.map(point);
    for (let i = 0; i < pts.length - 1 && n < 900; i++) {
      const a = pts[i],
        b = pts[i + 1],
        dx = b[0] - a[0],
        dz = b[1] - a[1],
        len = Math.hypot(dx, dz);
      for (let t = 25; t < len && n < 900; t += 42 + rand() * 28) {
        const off = (parseFloat(f.properties.width) || 12) / 2 + 5 + rand() * 4,
          x = a[0] + (dx * t) / len - (dz / len) * off,
          z = a[1] + (dz * t) / len + (dx / len) * off;
        if (!waterPolygons.some((r) => inPolygon(x, z, r)))
          add(x, z, 0.55 + rand() * 1.25);
      }
    }
  }
  for (const area of areas.filter((a) => a.kind === "park")) {
    const ring = area.rings[0],
      xs = ring.map((p) => p[0]),
      zs = ring.map((p) => p[1]),
      count = Math.min(
        35,
        Math.max(
          6,
          Math.floor(
            ((Math.max(...xs) - Math.min(...xs)) *
              (Math.max(...zs) - Math.min(...zs))) /
              18000,
          ),
        ),
      );
    for (let i = 0; i < count && n < 1600; i++) {
      let placed = false;
      for (let tries = 0; tries < 8 && !placed; tries++) {
        const x =
            Math.min(...xs) + rand() * (Math.max(...xs) - Math.min(...xs)),
          z = Math.min(...zs) + rand() * (Math.max(...zs) - Math.min(...zs));
        if (inPolygon(x, z, area.rings)) {
          add(x, z, 0.4 + rand() * 1.7);
          placed = true;
        }
      }
    }
  }
  const group = new THREE.Group();
  mergeInto(group, trunks, trunk);
  mergeInto(group, crowns, leaves, true);
  scene.add(group);
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
function setupSpawnPicker() {
  if (spawnPickerReady) return;
  const svg = d3.select("#spawn-map"),
    layer = svg.append("g").attr("id", "spawn-layer"),
    path = d3.geoPath(projection),
    overview = {
      type: "FeatureCollection",
      features: roadFeatures.filter(
        (f) => !f.properties.highway.endsWith("_link"),
      ),
    };
  layer
    .append("path")
    .datum(overview)
    .attr("id", "spawn-overview")
    .attr("class", "road")
    .attr("d", path);
  layer.append("path").attr("id", "spawn-roads").attr("class", "road");
  layer.append("circle").attr("id", "spawn-marker").attr("r", 95);
  updateMinimapRoads();
  spawnZoom = d3
    .zoom()
    .scaleExtent([0.08, 3])
    .on("zoom", (event) => layer.attr("transform", event.transform));
  svg.call(spawnZoom).on("click", async (event) => {
    if (event.defaultPrevented) return;
    const [px, pz] = d3.pointer(event, svg.node()),
      [x, z] = d3.zoomTransform(svg.node()).invert([px, pz]),
      before = { ...state };
    d3.select("#spawn-marker").attr("cx", x).attr("cy", z);
    state.x = x;
    state.z = z;
    try {
      await streamChunks(true);
      const road = getNearestRoad(x, z);
      if (!road || road.d > 400) throw new Error("No nearby road");
      manifest.spawn = projection.invert([road.x, road.z]);
      manifest.spawnTarget = projection.invert(road.b);
      saveSpawn(manifest.spawn, manifest.spawnTarget);
      resetCar(false);
      $("spawn-dialog").close();
      toast("New starting road");
    } catch (error) {
      state = before;
      streamChunks().catch(console.error);
      toast("Choose closer to a road");
    }
  });
  $("spawn-zoom-in").onclick = () => svg.call(spawnZoom.scaleBy, 1.8);
  $("spawn-zoom-out").onclick = () => svg.call(spawnZoom.scaleBy, 0.55);
  $("spawn-zoom-reset").onclick = () =>
    svg.call(
      spawnZoom.transform,
      d3.zoomIdentity
        .translate(130, 110)
        .scale(0.19)
        .translate(-state.x, -state.z),
    );
  spawnPickerReady = true;
}
function openSpawnPicker() {
  if (!ready) return;
  wasPausedBeforePicker = paused;
  setPaused(true);
  setupSpawnPicker();
  d3.select("#spawn-map").call(
    spawnZoom.transform,
    d3.zoomIdentity
      .translate(130, 110)
      .scale(0.19)
      .translate(-state.x, -state.z),
  );
  d3.select("#spawn-marker").attr("cx", state.x).attr("cy", state.z);
  $("spawn-dialog").showModal();
  toast("Drag or scroll, then click a road");
}
function getNearestRoad(x, z) {
  let best = null;
  for (const road of roads) {
    const p = nearestPoint(x, z, road.a, road.b);
    if (!best || p.d < best.d) best = { ...road, ...p };
  }
  return best;
}
function blocked(x, z, y) {
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
  const nearest = getNearestRoad(state.x, state.z);
  if (nearest) {
    const dx = nearest.b[0] - nearest.a[0],
      dz = nearest.b[1] - nearest.a[1],
      l = Math.hypot(dx, dz);
    const dir =
      Math.sin(state.yaw) * dx - Math.cos(state.yaw) * dz >= 0 ? 1 : -1;
    state.x = nearest.x + (dz / l) * nearest.width * 0.24 * dir;
    state.z = nearest.z - (dx / l) * nearest.width * 0.24 * dir;
    smoothGround = nearest.y;
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
function setPaused(value) {
  paused = value;
  keys.clear();
  touches.clear();
  document
    .querySelectorAll("[data-key]")
    .forEach((b) => b.classList.remove("active"));
  $("pause").textContent = paused ? "▷" : "Ⅱ";
  $("pause").setAttribute(
    "aria-label",
    paused ? "Resume driving" : "Pause driving",
  );
  if (ready)
    toast(paused ? "Paused — press Esc to resume" : "Back to the road");
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
      if (!paused) keys.add(e.code);
    }
    if (!e.repeat && e.code === "KeyR" && ready) resetCar();
    if (!e.repeat && e.code === "KeyV" && ready) {
      firstPerson = !firstPerson;
      toast(firstPerson ? "Driver view" : "Chase view");
    }
    if (!e.repeat && e.code === "Escape" && ready) setPaused(!paused);
  });
  window.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => {
    if (ready) setPaused(true);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && ready) setPaused(true);
  });
  document.querySelectorAll("[data-key]").forEach((button) => {
    button.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (paused || !ready) return;
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
  $("pause").onclick = () => setPaused(!paused);
  $("reset").onclick = () => {
    if (ready) resetCar();
  };
  $("help").onclick = () => {
    wasPausedBeforeInfo = paused;
    setPaused(true);
    $("info").showModal();
  };
  $("close-info").onclick = $("resume").onclick = () => $("info").close();
  $("info").addEventListener("close", () => setPaused(wasPausedBeforeInfo));
  $("spawn-picker").onclick = openSpawnPicker;
  $("minimap").onclick = openSpawnPicker;
  $("night-toggle").onclick = () => setNight(!night);
  $("close-spawn").onclick = () => $("spawn-dialog").close();
  $("spawn-dialog").addEventListener("close", () =>
    setPaused(wasPausedBeforePicker),
  );
}
function hud() {
  const kmh = Math.round(Math.abs(state.speed) * 3.6);
  $("speed").textContent = kmh;
  $("speed-fill").style.width = clamp((kmh / 250) * 100, 0, 100) + "%";
  $("gear").textContent =
    state.speed < -0.2 ? "R" : state.speed > 0.2 ? "D" : "N";
  $("distance").innerHTML = distance.toFixed(2) + " <small>KM</small>";
  $("surface").textContent = paused
    ? "PAUSED"
    : nearRoad && nearRoad.d < nearRoad.width / 2 + 1
      ? firstPerson
        ? "DRIVER VIEW"
        : kmh
          ? "KEEP LEFT"
          : "READY TO DRIVE"
      : "OFF ROAD";
  $("street").textContent = nearRoad?.name || "Marina Bay";
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
  nearRoad = getNearestRoad(state.x, state.z);
  if (!paused) {
    const down = (...codes) =>
      codes.some((c) => keys.has(c) || [...touches.values()].includes(c));
    const input = {
      forward: down("KeyW", "ArrowUp"),
      back: down("KeyS", "ArrowDown"),
      left: down("KeyA", "ArrowLeft"),
      right: down("KeyD", "ArrowRight"),
      handbrake: down("Space"),
    };
    const onRoad = nearRoad && nearRoad.d < nearRoad.width / 2 + 1;
    const steps = Math.max(1, Math.ceil(dt / 0.012));
    for (let i = 0; i < steps; i++) {
      const oldX = state.x,
        oldZ = state.z;
      stepCar(state, input, dt / steps, onRoad);
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
        (!onRoad || nearRoad.y < 0.1) &&
        waterPolygons.some((r) => inPolygon(state.x, state.z, r));
      if (outside || water || blocked(state.x, state.z, smoothGround)) {
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
      }
      distance += Math.hypot(state.x - oldX, state.z - oldZ) / 1000;
    }
  }
  const ground =
    nearRoad && nearRoad.d < nearRoad.width / 2 + 2 ? nearRoad.y : 0;
  smoothGround += (ground - smoothGround) * (1 - Math.exp(-6 * dt));
  car.position.set(state.x, smoothGround + 0.08, state.z);
  car.rotation.y = -state.yaw;
  for (const wheel of allWheels) wheel.rotation.x -= (state.speed * dt) / 0.4;
  for (const wheel of frontWheels) wheel.rotation.y = -state.steer * 0.4;
  if (firstPerson) {
    camera.position.set(
      state.x + Math.cos(state.yaw) * 0.34 + Math.sin(state.yaw) * 0.98,
      smoothGround + 1.65,
      state.z + Math.sin(state.yaw) * 0.34 - Math.cos(state.yaw) * 0.98,
    );
    lookTarget.set(
      state.x + Math.sin(state.yaw) * 32,
      smoothGround + 1.65,
      state.z - Math.cos(state.yaw) * 32,
    );
  } else {
    const follow = 19 + Math.min(6, Math.abs(state.speed) * 0.16);
    cameraTarget.set(
      state.x - Math.sin(state.yaw) * follow,
      smoothGround + 8.5 + Math.abs(state.speed) * 0.045,
      state.z + Math.cos(state.yaw) * follow,
    );
    camera.position.lerp(cameraTarget, 1 - Math.exp(-5 * dt));
    lookTarget.lerp(
      new THREE.Vector3(
        state.x + Math.sin(state.yaw) * 9,
        smoothGround + 2.5,
        state.z - Math.cos(state.yaw) * 9,
      ),
      1 - Math.exp(-7 * dt),
    );
  }
  camera.lookAt(lookTarget);
  sunTarget.position.set(state.x, 0, state.z);
  const sun = scene.getObjectByName("sun");
  sun.position.set(state.x - 180, 250, state.z + 70);
  if (now - lastStream > 1500) {
    lastStream = now;
    streamChunks().catch(console.error);
  }
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
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
    renderer.shadowMap.enabled = false;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    scene = new THREE.Scene();
    scene.background = new THREE.Color("#b2d2d6");
    scene.fog = new THREE.FogExp2("#b2d2d6", 0.00052);
    camera = new THREE.PerspectiveCamera(60, 1, 0.15, 5000);
    skyLight = new THREE.HemisphereLight("#d9eeef", "#737765", 2.25);
    scene.add(skyLight);
    sunLight = new THREE.DirectionalLight("#fff0cb", 3.0);
    sunLight.name = "sun";
    sunLight.target = sunTarget;
    scene.add(sunLight, sunTarget);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(160000, 160000),
      new THREE.MeshStandardMaterial({ color: "#9daa94", roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.025;
    ground.receiveShadow = true;
    scene.add(ground);
    worldMaterials.road = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    worldMaterials.pavement = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
    });
    worldMaterials.mark = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
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
      shader.vertexShader =
        "varying vec3 vFacadePosition; varying vec3 vFacadeNormal;\n" +
        shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\nvFacadePosition=(modelMatrix*vec4(position,1.0)).xyz; vFacadeNormal=normalize(mat3(modelMatrix)*normal);",
      );
      shader.fragmentShader =
        "varying vec3 vFacadePosition; varying vec3 vFacadeNormal;\n" +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <color_fragment>",
        "#include <color_fragment>\nif(abs(vFacadeNormal.y)<0.5 && vFacadePosition.y>3.5){float u=fract((vFacadePosition.x+vFacadePosition.z)*0.22);float v=fract(vFacadePosition.y*0.28);float windowMask=step(0.18,u)*(1.0-step(0.81,u))*step(0.22,v)*(1.0-step(0.80,v));diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(0.59,0.76,0.80),windowMask*0.60);}",
      );
    };
    manifest = await json("./data/manifest.json");
    const preferences = loadPreferences();
    if (preferences.spawn) {
      manifest.spawn = preferences.spawn.spawn;
      manifest.spawnTarget = preferences.spawn.spawnTarget;
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
    const [rd, ar] = await Promise.all([
      json("./data/roads.geojson"),
      json("./data/areas.geojson"),
    ]);
    roadFeatures = rd.features;
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
    addTrees();
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
