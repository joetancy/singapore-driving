# Driveable-roads status ledger

## Current status (18 September 2026)

This ledger supersedes the historical notes below. R1 pipeline work is
implemented and the non-browser gates pass. R2/R3 remain partially complete;
manual browser, real-device, route, and performance checks were intentionally
not run because they are reserved for the user.

- Schema: 12
- Latest build generation: `17a4a7e2fadd492d`
- `npm test`: PASS
- `npm run check`: PASS
- `python3 scripts/clearance.test.py`: PASS
- `npm run build`: PASS (401088 segments, 5260 warnings, 2745 chunks)
- Browser smoke/manual/performance checks: NOT RUN
- Deployment: NOT performed

### Verified implementation

- R1 staging preserves the previous output on preparation failure, validates
  schemas and duplicate IDs, records generation/configuration/assets, and runs
  exact staged Python clearance before publishing the new generation.
- Prepared road samples, widths, taper profiles, structures, projection
  metadata, and deterministic surface-cell triangles are shared by the build.
- Importer road segments preserve ordered endpoint node identity through
  boundary splitting and chunk segmentation.
- Road preparation diagnostics use deterministic structured warning records with
  code, severity, feature/source identity, raw values, explanation, and safe
  fallback behavior.
- Clearance preserves source footprints/tags, computes height-aware bands from
  prepared road cells, keeps holes/parts, and records structured warnings.
- Runtime validates schema/generation-qualified data and renders per-band
  derived geometry without the old unconditional road-collision bypass.

### Explicitly incomplete

- R2 topology still has documented legacy/synthetic-node limitations and needs
  stronger end-to-end connection fixtures and route acceptance evidence.
- R2 runtime support/chunk pinning and R3 lane/spawn/marking/lamp behavior have
  not been manually verified in the browser.
- R3 performance/resource measurements, repeated travel-loop leak checks,
  screenshots, and real mobile-device checks are not run.
- The optional development overlay and several full PLAN validation IDs remain
  unimplemented or unverified.

Plan: `PLAN.md` (expanded, working tree). `AGENT_HANDOFF.md` / `SOURCE_PLAN.md`
not present in repo — references to them are treated as missing; `PLAN.md`
is the specification.

Constraints kept: static hosting, local assets, mobile controls, source
data, saved preferences, penalty-free off-road ground driving.

## F-01 baseline — 18 Sep 2026 (commit 7b5c560, branch main, tree +PLAN.md plan text only)

- Node v24.16.0, Python 3.14.6, Shapely 2.1.2.
- `PREPARED_ROAD_SCHEMA_VERSION = 10` (`scripts/prepare.mjs:17`).
- `npm test` — PASS (roads + traffic suites, all lines green).
- `npm run check` — PASS (explicit file list).
- `python3 scripts/clearance.test.py` — PASS ("importer clearance checks passed").
- `npm run build` — PASS (401088 segments, 673 mixed-level warnings).
- Pre-existing local change preserved: `PLAN.md` expansion (uncommitted).
- No failures to triage; no feature marked complete by presence alone.

## F-02 contracts — DONE (commit: projection hoist + fixtures)

Trace (one road, one building), checked-in GeoJSON → screen/collision/spawn:

- Road: `public/data/roads.geojson` raw tags → `prepareRoads` samples
  `[x,z,height,distance,normalX,normalZ]` (`road-network.mjs`) → `prepareLayout`
  widths → `prepareAssets` (`prepare.mjs`: width, samples, tapers, layout,
  connections, laneLayout) → `build.mjs` writes derived fields into
  `dist/data/*` + `dist/data/map/*` → runtime `surfaces` index (`roads.js`),
  ribbons (`app.js:createChunk`), contact (`surfaceAt`/`drivingContact`),
  spawn (`getNearestRoad`+`spawnPose`).
- Building: `areas.geojson` footprint + `height`/`levels`/`min_height` →
  `import_osm.convert` clearance (`clearanceGeometry/Bands/Height/Prepared`,
  exact path via Node `prepare.mjs` CLI samples+widths) → runtime `blocks`
  (`app.js`: `clearancePrepared` parts, else legacy split) → `blocked()` with
  the 1.7 m vehicle envelope.

Named sources (single authority each):

- Width: `laneCount`/`roadWidth` (`road-network.mjs`), `LANE_WIDTH=3.5`;
  Python mirror `road_width` (`import_osm.py`). Taper-local: `widthAt`.
- Height: `nominalHeight` (`road-network.mjs`); Python mirror `road_level`.
- Geometry: `prepareAssets` samples; projection `project` (JS + Python,
  fixtures agree to 1e-6 — new assertions both sides).
- Identity: `sourceId` + per-feature id; ordered `start/endNodeId` where the
  importer knows them (interior/synthetic nodes still incomplete — R2-01).

Numeric defaults pinned by tests: LANE_WIDTH 3.5, envelope 1.7,
grade 0.0795/0.08, layer 4 m, lamp 40/45/50 m, pool 8 within 100 m.
Remaining duplication (per-site gates 0.3/0.08/0.6, shoulders) documented,
not yet deduplicated — accepted limitation.

## R1 — DONE (commit includes R1-01..R1-05)

R1-01 staged build + schema guard: `build.mjs` stages to temp dir, validates
(finite coords, version match, non-finite width guard), atomically swaps
with backup/rollback. `manifest.generation` (SHA-1 of schema+widths+warnings)
pins cache keys. `EXPECTED_ROAD_SCHEMA=11` in browser + importer; mismatch
throws with rebuild instruction. `scripts/roads.test.mjs` release pipeline
test covers deterministic generation IDs, source width preservation beside
derived `preparedWidth`, failure safety (corrupt input preserves previous
dist).

R1-02 taper-aware surfaces + corridors: `prepare.mjs` exports
`surfacePolygon(samples,width,tapers)` using unitized normals (removes miter
scaling so physical width matches taper profile). Python `corridor_quads`
now receives taper zones and computes per-end half-widths via cosine-eased
`taper_width`; `clip_quad_to_band` sub-clips each strip to the exact
vertical overlap of the 1.7 m envelope with building bands instead of whole-
quad erasure. `clearance_bands` unchanged.

R1-03 height-aware clearance: `import_osm.py` mandatory exact Node
preparation (fails loudly without `--allow-approximate`); corridor quads
carry endpoint heights; band removal uses `clip_quad_to_band` per strip.
`clearance.test.py` added projection fixtures (JS/Python match to 1e-6) and
band-exact clipping fixture (sloped strip keeps exactly the overlapping
fraction).

R1-04 consumer migration: `app.js` reads `preparedWidth` (falls back to
legacy `width`); schema check on load. Building rendering already uses
`clearanceBands`/`clearanceGeometry` from importer.

R1-05 gate: all `npm test`, `npm run check`, `python3 clearance.test.py`,
`npm run build` pass. 401088 segments; 2745 chunks; schema 11; generation
`3262fd287b213a83`.
## R2 — IN PROGRESS

R2-01 ordered identity + explicit connections: `road-network.mjs` now
preserves full `nodeIds` chain per feature (falls back to `startNodeId`/`endNodeId`
for first/last vertices). Nodes tagged `original: true` only when an OSM ID
is present. Connections derived solely from shared original nodes; synthetic
coordinate nodes are dead ends. Junctions (degree > 2) connect all same-height
edges regardless of angle; degree-2 continuations require alignment (cos > 0.5).
Legacy assets without `nodeIds` use coordinate matching with warnings.
Ambiguous endpoints (multiple aligned candidates) warn and remain unresolved.
Tests updated: legacy fixtures pass, new junction/ambiguity cases covered.

R2-02 authoritative grade preparation: `nominalHeight` uses explicit
token rules (not truthiness) for bridge/tunnel; `covered` never implies
underground. Contradictory tags emit `CONFLICTING_LEVEL_TAGS` warnings
(5260 flagged in full dataset vs 673 before). 8% grade enforced with
`minRun = |deltaH| / 0.08`; approaches only extend over explicit connections
(continuation/ramps); over-grade segments warn `APPROACH_TOO_SHORT` and
remain unresolved. Bounded iterations (`edges.length * 4`) guarantee
deterministic convergence. Exact shared endpoints preserved; grade validated
after serialization.

R2-03 stateful contact + chunk safety: `app.js` tracks `lastSupported`
pose (position, yaw, height, surfaceId, chunkId). Swept collision checks
sub-step the movement path so short cells/walls/seams cannot be skipped.
On "edge" or "blocked", car restores to `lastSupported` instead of the
substep origin. Missing chunk detected via `chunkOfSurface` →
`chunkLoadedAt`; sets `waitingForChunk` and shows toast without advancing
simulation. Permanent dead end (unsupported elevated edge) multiplies speed
by 0.2; building/water/boundary blocks multiply by 0.55. `resetCar` clears
stale support and initializes `lastSupported` from spawn. `waitingForChunk`
flag prevents simulation advance through missing support.

R2-04 fixed tunnel openings: `createChunk` collects deterministic tunnel
openings for open ramps (max height > -3.85) into `chunkTunnelOpenings`,
stored in `group.userData`. `buildTunnelOpeningsFromChunks` merges
openings from all loaded chunks (no player-centered distance sort), so
terrain cutouts are stable, boundaries match across chunk seams, and
openings don't close while their chunk is still loaded. Covered tunnels
(max height <= -3.85) keep surface terrain intact. Shader uniform array
fed from chunk-local data; 64-slot limit preserved.

R3-01 deterministic lane metadata: `laneLayout` now parses with confidence
(`exact`/`estimated`/`unsupported`), rejects ranges/decimals/conditionals,
records `source: "tagged"|"estimated"|"fallback"` and structured warnings
(`INVALID_LANE_COUNT`, `ESTIMATED_LANES`, `INCONSISTENT_LANES`). Rules:
one-way uses all lanes in permitted direction; two-way splits total (extra
to forward) or defaults 1+1; reverse one-way flips directions; inconsistent
counts fall back to 1+1. Forward/backward follow OSM way order. All tests
updated.

## R3-01 deterministic lane metadata: `laneLayout` now parses with confidence
(`exact`/`estimated`/`unsupported`), rejects ranges/decimals/conditionals,
records `source: "tagged"|"estimated"|"fallback"` and structured warnings
(`INVALID_LANE_COUNT`, `ESTIMATED_LANES`, `INCONSISTENT_LANES`). Rules:
one-way uses all lanes in permitted direction; two-way splits total (extra
to forward) or defaults 1+1; reverse one-way flips directions; inconsistent
counts fall back to 1+1. Forward/backward follow OSM way order. All tests
updated.

R3-02 left-hand lane geometry + spawn + warnings: `spawnPose` uses left
normal (tz, -tx) for lane offsets; forward lanes on OSM-way left, backward
on right. HUD wrong-way detection uses actual lane-direction motion
(travel × lateral sign), not just yaw. Hysteresis: 1s sustained above 5 km/h
to activate, 0.5s clear to deactivate. Suppressed in junctions, shared
lanes, stopped (<1.4 km/h), loading, off-road, unsupported direction.
Display-only warning — no steering/slowing/blocking.

R3-03 markings aligned to lane boundaries: divider and edge lines use
`laneDividersAt(tapers, distance, width, layout)` for taper-aware,
lane-count-aware boundaries. Arrow markings placed at lane centers from
divider midpoints. Dash phase from source-path distance `d`. Suppressed in
junction interiors; vertical crossings don't suppress bridge markings.
Smooth width transitions preserved.

R3-01 deterministic lane metadata: `laneLayout` now parses with confidence
(`exact`/`estimated`/`unsupported`), rejects ranges/decimals/conditionals,
records `source: "tagged"|"estimated"|"fallback"` and structured warnings
(`INVALID_LANE_COUNT`, `ESTIMATED_LANES`, `INCONSISTENT_LANES`). Rules:
one-way uses all lanes in permitted direction; two-way splits total (extra
to forward) or defaults 1+1; reverse one-way flips directions; inconsistent
counts fall back to 1+1. Forward/backward follow OSM way order. All tests
updated.

R3-02 left-hand lane geometry + spawn + warnings: `spawnPose` uses left
normal (tz, -tx) for lane offsets; forward lanes on OSM-way left, backward
on right. HUD wrong-way detection uses actual lane-direction motion
(travel × lateral sign), not just yaw. Hysteresis: 1s sustained above 5 km/h
to activate, 0.5s clear to deactivate. Suppressed in junctions, shared
lanes, stopped (<1.4 km/h), loading, off-road, unsupported direction.
Display-only warning — no steering/slowing/blocking.

R3-03 markings aligned to lane boundaries: divider and edge lines use
`laneDividersAt(tapers, distance, width, layout)` for taper-aware,
lane-count-aware boundaries. Arrow markings placed at lane centers from
divider midpoints. Dash phase from source-path distance `d`. Suppressed in
junction interiors; vertical crossings don't suppress bridge markings.
Smooth width transitions preserved.

R3-04 deterministic lamps: lamp IDs are `${sourceId}:${ordinal}` where
ordinal = floor(d/spacing). Skipped candidates don't renumber later ones.
Side alternation by ordinal parity (stable). Pole base outside protected
corridor. Rejected: tunnels, buildings, water, junction interiors. Lamps
assigned to owning chunk via `userData.chunkId` at attach. `pickNightLights`
handles both `[x,y,z]` and `{x,y,z,lampId}` formats. 8-light pool at night.

R3-05 validation & packaging: all `npm test`, `npm run check`,
`python3 clearance.test.py`, `npm run build` pass. 401088 segments,
2745 chunks, schema 11, generation `877212835fb668fb`. No merge/deploy.

## Release gates — R1, R2, R3 ALL PASSED
