// Keep file bodies in Cache Storage, not a country-sized parsed object graph.
// Each build has its own content version; each deployment has its own scope.
export function createGeoJSONCache({ baseURL, version, fetcher = globalThis.fetch,
  storage, concurrency = 6, retries = 2, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!version) throw new Error("Map cache metadata is missing. Run npm run build.");
  const base = new URL(baseURL);
  const prefix = `singapore-driving:${base.href}:`;
  const name = prefix + version;
  const memory = new Map(), pending = new Map();
  let writable = true;
  const opened = (async () => {
    try {
      storage ??= globalThis.caches;
      return await storage?.open(name) || null;
    } catch { return null; }
  })();
  const key = file => {
    const url = new URL(file, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      throw new Error(`Map file is outside the data directory: ${file}`);
    // Also bypass an older HTTP/CDN cache when the deployed data changes.
    url.searchParams.set("v", version);
    return url.href;
  };
  async function load(url) {
    if (memory.has(url)) return new Response(memory.get(url));
    const cache = await opened;
    if (cache) {
      try {
        const hit = await cache.match(url);
        if (hit) return hit;
      } catch { writable = false; }
    }
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetcher(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        // A successful HTML error page must not poison the versioned cache.
        JSON.parse(await blob.text());
        if (cache && writable) {
          try {
            await cache.put(url, new Response(blob, { headers: { "Content-Type": "application/json" } }));
            return new Response(blob);
          } catch { writable = false; }
        }
        // Private browsing, denied storage and quota failures remain usable.
        // Blob bodies are retained for this session; parsed GeoJSON is not.
        memory.set(url, blob);
        return new Response(blob);
      } catch (error) {
        lastError = error;
        if (attempt < retries) await wait(200 * 2 ** attempt);
      }
    }
    throw new Error(`Could not cache ${new URL(url).pathname}: ${lastError.message}`, { cause: lastError });
  }
  async function response(file) {
    const url = key(file);
    if (!pending.has(url)) {
      const request = load(url).finally(() => pending.delete(url));
      pending.set(url, request);
    }
    return (await pending.get(url)).clone();
  }
  return {
    async json(file) { return (await response(file)).json(); },
    async preload(files, onProgress = () => {}) {
      const queue = [...new Set(files)], total = queue.length;
      let next = 0, loaded = 0, failure = null;
      const progress = () => onProgress({ loaded, total, sessionFiles: memory.size });
      progress();
      const worker = async () => {
        while (!failure && next < total) {
          const file = queue[next++];
          try {
            await response(file);
            loaded++;
            progress();
          } catch (error) { failure ??= error; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(total, Math.max(1, concurrency)) }, worker));
      if (failure) throw failure;
      // Do not delete a complete older cache after a failed or partial preload.
      if (await opened) {
        try {
          for (const old of await storage.keys())
            if (old.startsWith(prefix) && old !== name) await storage.delete(old);
        } catch { /* Cache cleanup must not block driving. */ }
      }
      return { loaded, total, sessionFiles: memory.size };
    },
  };
}
