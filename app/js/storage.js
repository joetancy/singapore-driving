const SPAWN_KEY = "singapore-drive-spawn";
const NIGHT_KEY = "singapore-drive-night";

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

export function saveSpawn(spawn, spawnTarget) {
  try {
    localStorage.setItem(SPAWN_KEY, JSON.stringify({ spawn, spawnTarget }));
  } catch {}
}

export function saveNight(night) {
  try {
    localStorage.setItem(NIGHT_KEY, night ? "1" : "0");
  } catch {}
}
