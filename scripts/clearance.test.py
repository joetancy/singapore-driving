#!/usr/bin/env python3
"""Minimal importer regression check for road/building clearance."""
import json
import sys
import tempfile
from pathlib import Path

from shapely.geometry import shape

sys.path.insert(0, str(Path(__file__).parent))
from import_osm import convert


def node(identifier, lon, lat):
    return {"type": "node", "id": identifier, "lon": lon, "lat": lat, "tags": {}}


def way(identifier, nodes, tags):
    return {"type": "way", "id": identifier, "nodes": nodes, "tags": tags}


def main():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        boundary = {"type": "Polygon", "coordinates": [[[103.849, 1.283], [103.853, 1.283], [103.853, 1.287], [103.849, 1.287], [103.849, 1.283]]]}
        elements = [
            node(1, 103.8495, 1.284), node(2, 103.8525, 1.284),
            node(3, 103.8495, 1.286), node(4, 103.8525, 1.286),
            node(10, 103.8505, 1.2837), node(11, 103.8515, 1.2837), node(12, 103.8515, 1.2843), node(13, 103.8505, 1.2843),
            node(20, 103.8505, 1.2857), node(21, 103.8515, 1.2857), node(22, 103.8515, 1.2863), node(23, 103.8505, 1.2863),
            way(100, [1, 2], {"highway": "residential"}),
            way(101, [3, 4], {"highway": "residential", "tunnel": "yes"}),
            way(200, [10, 11, 12, 13, 10], {"building": "yes"}),
            way(201, [20, 21, 22, 23, 20], {"building": "yes"}),
        ]
        source, boundary_file, output = root / "source.json", root / "boundary.geojson", root / "data"
        source.write_text(json.dumps({"elements": elements}))
        boundary_file.write_text(json.dumps(boundary))
        convert(source, boundary_file, output)
        buildings = [f for p in output.glob("*.geojson") for f in json.loads(p.read_text())["features"] if f["properties"].get("building")]
        assert len(buildings) == 2
        ground, tunnel = sorted(buildings, key=lambda f: f["id"])
        assert shape(ground["geometry"]).area > shape(ground["properties"]["clearanceGeometry"]).area
        assert shape(tunnel["geometry"]).equals(shape(tunnel["properties"]["clearanceGeometry"]))


if __name__ == "__main__":
    main()
    print("importer clearance checks passed")
