import { nearestPoint } from "./physics.js";
import { mapLevel, visibleRoad } from "./roads.js";

// Curated jump-to presets for the spawn picker. Snap-to-road spawning
// forgives approximate coordinates; keep every preset inside Singapore.
export const SPAWN_PRESETS = [
  { name: "Marina Bay", lon: 103.8607, lat: 1.2836 },
  { name: "Orchard Road", lon: 103.8391, lat: 1.3005 },
  { name: "Changi Airport", lon: 103.99, lat: 1.362 },
  { name: "Jurong East", lon: 103.7412, lat: 1.3331 },
  { name: "Woodlands", lon: 103.7865, lat: 1.436 },
  { name: "Tuas", lon: 103.649, lat: 1.264 },
  { name: "Sentosa Gateway", lon: 103.829, lat: 1.278 },
  { name: "Punggol", lon: 103.902, lat: 1.4052 },
  { name: "Bukit Timah", lon: 103.776, lat: 1.33 },
  { name: "Tampines", lon: 103.944, lat: 1.353 },
];

// Segment bounds include roads crossing the viewport with both endpoints outside.
export function roadInView(road, min, max) {
  return road.samples.some((b, i, samples) => {
    const a = samples[Math.max(0, i - 1)];
    return Math.max(a[0], b[0]) >= min[0] && Math.min(a[0], b[0]) <= max[0] &&
      Math.max(a[1], b[1]) >= min[1] && Math.min(a[1], b[1]) <= max[1];
  });
}

export function createSpawnPicker({ manifest, project, fetchJSON, onSelect }) {
  const d3 = window.d3, svg = d3.select("#spawn-map"), element = svg.node();
  const layer = svg.append("g"), overviewPath = layer.append("path").attr("class", "road overview"),
    detailPath = layer.append("path").attr("class", "road detail"),
    marker = layer.append("circle").attr("class", "spawn-marker");
  const status = document.createElement("p"), choices = document.createElement("div");
  status.setAttribute("role", "status"); status.className = "spawn-status";
  choices.className = "spawn-choices";
  element.parentElement.after(status, choices);
  const cache = new Map();
  let overview = [], displayed = [], serial = 0, timer, center = [0, 0], busy = false;
  const pixelScale = () => element.getScreenCTM()?.a || 1;
  const corners = [project(manifest.bounds.slice(0, 2)), project(manifest.bounds.slice(2))];
  const min = [Math.min(corners[0][0], corners[1][0]), Math.min(corners[0][1], corners[1][1])];
  const max = [Math.max(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1])];
  const minScale = Math.min(240 / (max[0] - min[0]), 200 / (max[1] - min[1]));
  const chunkBounds = manifest.chunks.map((c) => {
    const a = project(c.bbox.slice(0, 2)), b = project(c.bbox.slice(2));
    return { ...c, min: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
      max: [Math.max(a[0], b[0]), Math.max(a[1], b[1])] };
  });
  const path = (roads) => roads.map((r) => "M" + r.samples.map((p) => `${p[0]},${p[1]}`).join("L")).join("");
  const load = (file) => {
    if (!cache.has(file)) cache.set(file, fetchJSON("./data/map/" + file).catch((e) => { cache.delete(file); throw e; }));
    return cache.get(file);
  };
  const update = async () => {
    const request = ++serial, t = d3.zoomTransform(element), level = mapLevel(260 / t.k);
    const a = t.invert([0, 0]), b = t.invert([260, 220]);
    const inView = (r) => roadInView(r, a, b);
    displayed = overview.filter((r) => visibleRoad(r, level) && inView(r));
    overviewPath.attr("d", path(displayed)); detailPath.attr("d", "");
    status.textContent = level === 0 ? "Island view · major roads" : level === 1 ? "District view · connecting roads" : "Loading local roads…";
    if (level !== 2) return;
    try {
      const wanted = chunkBounds.filter((c) => c.max[0] >= a[0] && c.min[0] <= b[0] && c.max[1] >= a[1] && c.min[1] <= b[1]);
      const results = await Promise.allSettled(wanted.map((c) => load(c.file)));
      if (request !== serial) return;
      const failed = results.some((r) => r.status === "rejected");
      const data = results.flatMap((r) => r.status === "fulfilled" ? r.value : []);
      displayed = [...new Map([...displayed, ...data.filter(inView)].map((r) => [r.id, r])).values()];
      detailPath.attr("d", path(displayed)); overviewPath.attr("d", "");
      status.textContent = failed ? "Some local roads failed to load. Move or zoom to retry." : "Street view · click a road to spawn";
      // Bound the completed-request cache; active data remains in displayed.
      while (cache.size > 160) cache.delete(cache.keys().next().value);
    } catch {
      if (request === serial) status.textContent = "Some local roads failed to load. Move or zoom to retry.";
    }
  };
  const zoom = d3.zoom().scaleExtent([minScale, 260 / 150])
    .extent([[0, 0], [260, 220]])
    .clickDistance(5)
    .translateExtent([[min[0] - 3000, min[1] - 3000], [max[0] + 3000, max[1] + 3000]])
    .on("zoom", (event) => {
      serial++;
      layer.attr("transform", event.transform);
      marker.attr("r", 5 / (event.transform.k * pixelScale()));
      choices.replaceChildren();
      clearTimeout(timer); timer = setTimeout(update, 100);
    });
  svg.call(zoom).on("click", async (event) => {
    if (event.defaultPrevented || busy) return;
    const t = d3.zoomTransform(element), mouse = t.invert(d3.pointer(event, element));
    const hits = [];
    for (const r of displayed) {
      let best;
      for (let i = 1; i < r.samples.length; i++) {
        const a = r.samples[i - 1], b = r.samples[i], p = nearestPoint(...mouse, a, b);
        if (!best || p.d < best.d) best = { ...p, a, b, sampleIndex: i - 1, y: a[2] + (b[2] - a[2]) * p.t };
      }
      if (best && best.d * t.k * pixelScale() <= 10) hits.push({ ...r, ...best });
    }
    hits.sort((a, b) => a.d - b.d || a.y - b.y || String(a.id).localeCompare(String(b.id)));
    const options = hits.filter((h, i) => !hits.slice(0, i).some((q) => q.id === h.id)).slice(0, 6);
    choices.replaceChildren();
    const choose = async (hit) => {
      if (busy) return;
      busy = true; status.textContent = "Loading starting road…";
      choices.querySelectorAll("button").forEach((b) => b.disabled = true);
      try { await onSelect(hit); marker.attr("cx", hit.x).attr("cy", hit.z); status.textContent = "Starting road selected."; }
      catch (e) { status.textContent = "Could not load this road. Please try again."; console.error(e); }
      finally { busy = false; choices.querySelectorAll("button").forEach((b) => b.disabled = false); }
    };
    if (!options.length) { status.textContent = "Click closer to a visible road, or zoom in."; return; }
    if (options.length === 1) { await choose(options[0]); return; }
    status.textContent = "Choose a road and height:";
    for (const hit of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${hit.name || "Unnamed road"} · ${hit.y < -0.3 ? "below ground" : hit.y > 0.3 ? "elevated" : "ground"} (${hit.y.toFixed(1)} m)`;
      button.onclick = () => choose(hit); choices.append(button);
    }
  });
  document.getElementById("spawn-zoom-in").onclick = () => svg.call(zoom.scaleBy, 1.6);
  document.getElementById("spawn-zoom-out").onclick = () => svg.call(zoom.scaleBy, 1 / 1.6);
  const reset = () => svg.call(zoom.transform, d3.zoomIdentity.translate(130, 110).scale(minScale).translate(-center[0], -center[1]));
  document.getElementById("spawn-zoom-reset").onclick = reset;
  const presetBar = document.createElement("div");
  presetBar.className = "spawn-presets";
  const presetLabel = document.createElement("span");
  presetLabel.textContent = "Jump to:";
  presetBar.append(presetLabel);
  for (const preset of SPAWN_PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = preset.name;
    button.onclick = () => {
      const p = project([preset.lon, preset.lat]);
      svg.transition().duration(350).call(zoom.transform,
        d3.zoomIdentity.translate(130, 110).scale(260 / 150).translate(-p[0], -p[1]));
      status.textContent = `${preset.name} — click a nearby road to spawn`;
    };
    presetBar.append(button);
  }
  element.parentElement.before(presetBar);
  return async (position) => {
    center = position;
    marker.attr("cx", center[0]).attr("cy", center[1]);
    reset();
    try { if (!overview.length) overview = await fetchJSON("./data/map/overview.json"); await update(); }
    catch { status.textContent = "Map overview failed to load. Close and reopen to retry."; }
  };
}
