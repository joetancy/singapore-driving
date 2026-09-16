# Singapore Drive: Driveable Roads First

## Summary

  Prioritize three releases:

  1. Road surfaces and building clearance.
  2. Reliable bridge, tunnel, and road-level transitions.
  3. Lanes, left-hand spawning, lane markings, and street lamps.

  Retain the remaining suggestions as a phased roadmap. Preserve static hosting, local map assets, mobile controls, and free-drive as the default.

  Current code already provides sampled road surfaces, graded approaches, height-aware building checks, and layered spawn selection. Extend those
  systems. Existing road tests and JavaScript syntax checks pass.

  This is the proposed content for PLAN.md; writing the file remains pending because Plan mode prohibits file edits.

## Implementation

### 1. Road surfaces and building clearance — P0

- Establish one prepared road representation for rendering, contact checks, clearance, and spawning. Preserve existing sample coordinates,
    heights, distances, and cross-section normals.

- Generate explicit surface polygons from those cross-sections, independently of Three.js meshes. Join consecutive samples without gaps and
    retain endpoint caps that prevent driving beyond a deck.

- Normalize road width once during preparation. Reuse current highway-class defaults and width limits across the renderer, map, and importer.
- Define a protected corridor of road width / 2 + 1.5 m. Ground roads receive this shoulder tolerance; bridges and tunnels must remain within
    their physical deck or passage.

- Use the existing Shapely dependency for polygon subtraction in metre coordinates matching the browser projection. Query nearby roads with a
    spatial index; process across chunk boundaries before assigning outputs to chunks.

- Preserve original OSM footprints. Generate separate derived collision and render geometry, retaining holes and disconnected polygon parts.
- Clip only where the road’s vehicle-clearance interval intersects the building’s vertical extent. Preserve buildings above tunnels and below
    elevated roads. For partial vertical overlap, split the building into vertical bands so clearance does not erase unrelated floors.

- Use the existing vehicle collision envelope, including its 1.7 m height, for clearance checks. Split sloped samples where their clearance
    envelope crosses building base or top heights.

- Replace the unconditional “on road means no building collision” bypass with checks against prepared geometry. Preserve off-road building,
    boundary, and water protection.

- Keep off-road ground driving with its existing speed penalty. Do not turn all road edges into invisible walls.

  Acceptance: a road crossing an erroneous building footprint is visibly open and driveable; the remaining building still blocks the car. A tunnel
  beneath that building does not remove its surface footprint.

### 2. Bridge, tunnel, and level continuity — P0

- Extend scripts/road-network.mjs as the authoritative elevation preparation step. Reuse its samples and approach generation.
- Preserve OSM node identities and way ordering during import. Geometric crossings alone must not establish connectivity. Older assets without
    node identities may use existing endpoint matching, with ambiguity reported.

- Treat layer as relative ordering, with the existing 4 m spacing as a configurable simulation estimate. Recognize non-no bridge and tunnel
    values. covered indicates overhead cover and must not independently imply an underground road.

- Retain the current 8% maximum approach grade. Extend approaches along connected roads where possible; report unresolved or ambiguous
    transitions instead of inserting vertical jumps or connecting unrelated branches.

- Use explicit endpoint connections and compatible heights for surface transfers. Prevent automatic switching between stacked roads, including
    roads from the same source way.

- Prevent loss of tunnel contact from snapping the car to ground level. At an unsupported bridge or tunnel edge, retain the previous valid
    position and height.

- When a required neighboring chunk has not loaded, stop at the last supported position and let streaming retry.
- Replace the player-centered circular terrain cutout with openings derived from prepared underground roads and approaches. Render tunnel walls
    and ceilings from the same passage geometry.

- Keep road meshes, collision surfaces, car pitch, spawn height, markings, and props aligned to the prepared elevation.

  Acceptance: drive continuously from ground onto a bridge and through a tunnel without jumps, unintended level changes, or collisions with
  vertically separated buildings.

### 3. Lanes, left-hand driving, markings, and lamps — P1

- Preserve and normalize lanes, lanes:forward, lanes:backward, oneway, turn:lanes, and maxspeed. Retain raw values when tags are unsupported or
    inconsistent.

- Support forward, two-way, and reverse one-way roads. Respect implied one-way motorway and roundabout behavior unless explicitly overridden.
- Use valid directional counts first. Otherwise divide a valid total count between directions; assign an unmatched lane to the forward direction
    and report the estimate. Untagged two-way roads default to one lane each way; untagged one-way roads use width-derived counts with a 3.2 m
    target lane width.

- Keep a one-lane two-way road shared, without an invented center divider. Report impossible lane counts and use the class fallback.
- Place forward lanes on the left of the OSM way direction and backward lanes on the opposite side. Spawn in the outermost legal lane matching
    the chosen heading; correct headings on one-way roads.

- Show a wrong-way warning above walking speed, without restricting free driving. Defer turn restrictions and junction enforcement.
- Render separators at actual lane boundaries using the existing ribbon geometry and continuous distance-based dash phase. Suppress markings
    within junction overlap areas.

- Preserve turn-lane metadata for later arrows and routing; do not build a lane-routing graph in this release.
- Generate lamps deterministically along each source road: 40 m spacing on ordinary roads, 45 m on major roads, and 50 m on expressways.
    Alternate sides and place poles outside the protected corridor.

- Skip outdoor lamps in tunnels and where pole bases overlap buildings, water, or junction interiors. Interpolate road height for elevated lamps.
- Use chunk-owned instanced poles and emissive heads. At night, reuse at most eight non-shadow-casting lights for the nearest lamps within 100 m.
    Release chunk geometry on unload.

  Acceptance: lane divisions follow OSM metadata, reverse one-way spawning works, left-lane placement is consistent, and chunk reloads do not
  duplicate lamps or restart marking patterns.

## Data Pipeline and Compatibility

- Extract a shared preparation entry point used by both scripts/import_osm.py and the static build. Elevation preparation must precede clearance
    so both use identical heights.

- Allow preparation from the checked-in GeoJSON chunks; the original OSM snapshot is not present in the repository. Future imports additionally
    preserve original node identities.

- Keep source geometry and raw tags intact. Store derived surfaces, building geometry, normalized lane metadata, and preparation warnings
    separately from their source fields.

- Increment the prepared-road schema version. Require a complete rebuild when versions differ; keep existing spawn preferences compatible through
    stable road IDs.

- Add no runtime dependencies, services, or network requests. Document Node and the existing Shapely requirement for preparation.
- Generate and validate outputs in staging before replacing generated assets. Keep the previous published site available if preparation fails.
- Update the README to distinguish supported graded road geometry from deferred real-world terrain elevation.

## Validation and Release

- Extend existing Node assertions for surface edges, curves, shared junctions, stacked crossings, positive and negative layers, covered roads,
    portal continuity, reverse one-way lanes, and legal spawn offsets.

- Add a small Python clearance test covering footprint overlap, holes, multipolygons, vertical separation, sloped approaches, and cross-chunk
    corridors.

- Include a fixture where clearance fully removes a derived polygon without deleting the original source feature.
- Check deterministic repeated preparation, finite coordinates, valid polygons, supported schema versions, and unresolved-transition warnings.
- Run npm test, npm run check, the Python clearance check, and npm run build.
- Manually drive ground, bridge, and tunnel routes on desktop and mobile layouts, including slow chunk loading and day/night toggles.
- Record frame time, draw calls, and memory on the same route before and after lamps; confirm bounded active lights and stable memory after
    repeated chunk travel.

- Deliver each release separately. Update limitations and regenerate assets with each schema change; deployment is a separate action.

## Later Roadmap

   Phase                Work
  ━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Road readability     OSM traffic-signal nodes and visible signal heads; crossings, arrows, stop lines, junction boxes, merge markings;
                        guardrails, bollards, bus stops, signs, and ERP/expressway gantries.
  ───────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Exploration          Named Singapore spawn locations; minimap road hierarchy, current road name, and compass heading; navigation after a
                        connected directional road graph exists.
                        body roll, and suspension visuals. Add chase/hood/driver cameras, damping, and speed-sensitive distance/FOV.
  ───────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Atmosphere           Rain streaks, wet roads, visibility changes, local tyre spray, and reduced traction; improve headlights, tail lights,
                        windows, reflective markings, and illuminated signs.
  ───────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Singapore scenery    OSM-based building styles, HDB details, and reusable instanced tropical vegetation.
  ───────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Terrain and scale    Offline DEM-derived terrain with bridge/tunnel integration; progressively simpler scenery with distance, tuned against
                        measured mobile performance.
  ───────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Traffic              Lane and intersection graphs, signal cycles, and nearby AI traffic within approximately 300–500 m; introduce Singapore
                        vehicle variants afterward.
  ───────────────────  ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   Challenges           Optional timed destinations, collision penalties, speed-limit and lane compliance. Keep free-drive as the default.

  Later phases are backlog items, not implementation commitments for the first three releases. Real terrain heights, legal navigation accuracy, AI
  traffic, and detailed junction rules remain outside the initial scope.
