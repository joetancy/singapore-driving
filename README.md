# Singapore Drive

A static Three.js + D3 driving sandbox using an OpenStreetMap snapshot clipped to Singapore. Readable source lives in `app/`, static map assets in `public/`, and `dist/` is generated only for publishing. There is no application backend, API key, runtime package CDN, or live OSM request.

## Map data

The bundled data comes from the dated Geofabrik Malaysia, Singapore and Brunei extract, clipped to the OpenStreetMap Singapore administrative boundary during the build. The browser loads only static GeoJSON: a light overview plus nearby 500 m road/building chunks. Provenance and the input checksum are in `public/data/source.json`.

Building heights use recorded OSM heights, then floor counts, then a conservative estimate. Road widths use recorded widths or a highway-class estimate. The environment is stylised and is not suitable for navigation.

## Controls

W / Up accelerates, S / Down brakes and reverses, A/D or Left/Right steers. Space handbrakes, R resets, Esc pauses. Touch arrows support mobile. Input clears on blur, pause, visibility change and touch cancellation.

## Rebuild the Singapore data

Download the regional Geofabrik PBF, clip it to a trusted Singapore administrative boundary, and filter it to the tags listed in `scripts/osm-tags.filter`. Convert the result to OSM XML with osmium before running the importer.

```bash
python -m pip install 'shapely>=2,<3'
python scripts/import_osm.py singapore.osm --boundary singapore-boundary.geojson
```

The importer clips again to the supplied boundary, reconstructs multipolygon relations and holes, preserves OSM tags in detailed chunks, segments roads, and writes 500 m chunks, simplified overview layers, the boundary, manifest and source provenance. It sets `mode: osm`, switching the visible attribution to OpenStreetMap. Keep the input snapshot and its ODbL provenance. The derivative GeoJSON database is in `public/data/`.

For direct GeoJSON replacement use the schema in the existing manifest and chunk files. Building heights use `height`, then `building:levels * 3.2`, then a 12.8 m estimate. Road widths use the OSM `width` tag or a highway-class fallback. The build prepares sampled, graded bridge and tunnel approaches plus lane metadata; this is stylised road elevation, not surveyed terrain or legal navigation.

The loader fetches nearby static chunks and unloads distant building/road meshes. The road overview and vegetation are prepared at startup; extremely large extracts may need additional overview simplification and vegetation tiling. There is no measured performance guarantee for a full-island extract yet.

## Layout

- `app/`: page structure, styles and readable browser modules.
- `app/js/app.js`: Three.js rendering, input, camera, chunk loading and D3 minimap.
- `app/js/geometry.js`: reusable Three.js mesh construction helpers.
- `app/js/physics.js`: driving math and collision helpers.
- `app/js/storage.js`: local browser preferences for spawn and night mode.
- `public/data/`: static GeoJSON and map manifest.
- `public/vendor/`: locally bundled Three.js 0.180.0 and D3 7.9.0, with licenses.
- `dist/`: ignored output from `npm run build`, used only by deployment.
- `scripts/make_demo.py`: optional small illustrative fixture for development.
- `scripts/import_osm.py`: build-time local OSM conversion. Not used by the website at runtime.
- `scripts/osm-tags.filter`: osmium filter used before import.

## Validation

Run `npm test`, `npm run check`, and `npm run build`. With Shapely installed, also run `python scripts/clearance.test.py`. These checks cover road preparation, surface contact, lane normalization, and importer building-clearance geometry.
