const SPAWN_KEY = "singapore-drive-spawn";
const NIGHT_KEY = "singapore-drive-night";
const TRAFFIC_KEY = "singapore-drive-traffic";
const NAV_KEY = "singapore-drive-nav";

export function loadTraffic() {
  try {
    const value = localStorage.getItem(TRAFFIC_KEY);
    return value === null ? 30 : Math.max(0, Math.min(100, Number(value) || 0));
  } catch { return 30; }
}
export function saveTraffic(value) {
  try { localStorage.setItem(TRAFFIC_KEY, String(value)); } catch {}
}

export function loadPreferences() {
  try {
    const spawn = JSON.parse(localStorage.getItem(SPAWN_KEY));
    return {
      spawn:
        Array.isArray(spawn?.spawn) && Array.isArray(spawn?.spawnTarget)
          ? spawn
          : null,
      night: localStorage.getItem(NIGHT_KEY) === "1",
    };
  } catch {
    return { spawn: null, night: false };
  }
}

export function saveSpawn(spawn, spawnTarget, selection = {}) {
  try {
    localStorage.setItem(SPAWN_KEY, JSON.stringify({ spawn, spawnTarget, ...selection }));
  } catch {}
}

export function saveNight(night) {
  try {
    localStorage.setItem(NIGHT_KEY, night ? "1" : "0");
  } catch {}
}

export function loadNav() {
  try {
    const nav = JSON.parse(localStorage.getItem(NAV_KEY));
    return nav && typeof nav.roadId === "string" && Number.isFinite(nav.x) && Number.isFinite(nav.z) ? nav : null;
  } catch { return null; }
}

export function saveNav(destination) {
  try { localStorage.setItem(NAV_KEY, JSON.stringify(destination)); } catch {}
}

export function clearNav() {
  try { localStorage.removeItem(NAV_KEY); } catch {}
}
