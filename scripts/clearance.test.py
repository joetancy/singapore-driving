#!/usr/bin/env python3
"""Importer regression check for grade-aware road/building clearance."""
import json
import shutil
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
    has_node = shutil.which("node") is not None
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        boundary = {"type": "Polygon", "coordinates": [[[103.849, 1.283], [103.853, 1.283], [103.853, 1.287], [103.849, 1.287], [103.849, 1.283]]]}
        elements = [
            node(1, 103.8495, 1.284), node(2, 103.8525, 1.284),
            node(3, 103.8495, 1.286), node(4, 103.8525, 1.286),
            # Shared junction J (node 30): ground approach climbs to the bridge.
            node(31, 103.8495, 1.285), node(30, 103.851, 1.285), node(32, 103.8525, 1.285),
            node(10, 103.8505, 1.2837), node(11, 103.8515, 1.2837), node(12, 103.8515, 1.2843), node(13, 103.8505, 1.2843),
            node(20, 103.8505, 1.2857), node(21, 103.8515, 1.2857), node(22, 103.8515, 1.2863), node(23, 103.8505, 1.2863),
            # Small building fully inside the ground-road corridor.
            node(50, 103.851973, 1.283973), node(51, 103.852027, 1.283973),
            node(52, 103.852027, 1.284027), node(53, 103.851973, 1.284027),
            # 12 m buildings on the approach: elevated part vs flat part.
            # 12 m building on the elevated approach, 14 m building where it is flat.
            node(40, 103.850766, 1.284946), node(41, 103.850874, 1.284946),
            node(42, 103.850874, 1.285054), node(43, 103.850766, 1.285054),
            node(44, 103.8494928, 1.2849639), node(45, 103.8496186, 1.2849639),
            node(46, 103.8496186, 1.2850361), node(47, 103.8494928, 1.2850361),
            # Multipolygon relation building (outer + hole) crossed by road 100.
            node(60, 103.8497, 1.2839), node(61, 103.8503, 1.2839),
            node(62, 103.8503, 1.28415), node(63, 103.8497, 1.28415),
            node(65, 103.84997, 1.28406), node(66, 103.85003, 1.28406),
            node(67, 103.85003, 1.28412), node(68, 103.84997, 1.28412),
            # Tall building pierced by the bridge deck at 4 m.
            node(70, 103.85141, 1.28491), node(71, 103.85159, 1.28491),
            node(72, 103.85159, 1.28509), node(73, 103.85141, 1.28509),
            way(100, [1, 2], {"highway": "residential"}),
            way(101, [3, 4], {"highway": "residential", "tunnel": "yes"}),
            way(102, [31, 30], {"highway": "residential"}),
            way(103, [30, 32], {"highway": "residential", "bridge": "yes"}),
            way(200, [10, 11, 12, 13, 10], {"building": "yes"}),
            way(201, [20, 21, 22, 23, 20], {"building": "yes"}),
            way(202, [40, 41, 42, 43, 40], {"building": "yes"}),
            way(203, [44, 45, 46, 47, 44], {"building": "yes"}),
            way(204, [50, 51, 52, 53, 50], {"building": "yes"}),
            way(300, [60, 61, 62, 63, 60], {}),
            way(301, [65, 66, 67, 68, 65], {}),
            way(205, [70, 71, 72, 73, 70], {"building": "yes"}),
            {"type": "relation", "id": 400, "tags": {"building": "yes"},
             "members": [{"type": "way", "ref": 300, "role": "outer"}, {"type": "way", "ref": 301, "role": "inner"}]},
        ]
        source, boundary_file, output = root / "source.json", root / "boundary.geojson", root / "data"
        source.write_text(json.dumps({"elements": elements}))
        boundary_file.write_text(json.dumps(boundary))
        convert(source, boundary_file, output)
        buildings = {f["id"]: f for p in output.glob("*.geojson") for f in json.loads(p.read_text())["features"] if f["properties"].get("building")}
        # Ground road opens the footprint but splits it into disconnected parts.
        ground = buildings["way/200-0"]
        cleared = shape(ground["properties"]["clearanceGeometry"])
        assert cleared.area < shape(ground["geometry"]).area
        assert cleared.geom_type == "MultiPolygon", f"expected split parts, got {cleared.geom_type}"
        ground_bands = ground["properties"]["clearanceBands"]
        assert [(b["base"], b["height"], b["cleared"]) for b in ground_bands] == [
            (0, 1.7, True), (1.7, 12.8, False)]
        # A tunnel beneath a building does not remove its surface footprint.
        assert "clearanceGeometry" not in buildings["way/201-0"]["properties"]
        # Full removal keeps the source feature with its original geometry.
        removed = buildings["way/204-0"]
        assert shape(removed["geometry"]).area > 0
        assert shape(removed["properties"]["clearanceGeometry"]).is_empty
        assert removed["properties"]["clearancePrepared"] is True
        # Multipolygon hole survives the corridor cut.
        relation = buildings["relation/400-0"]
        assert shape(relation["geometry"]).interiors, "fixture must contain a hole"
        relation_cleared = shape(relation["properties"]["clearanceGeometry"])
        assert relation_cleared.area < shape(relation["geometry"]).area
        interiors = sum(len(p.interiors) for p in getattr(relation_cleared, "geoms", [relation_cleared]))
        assert interiors >= 1, "clearance must retain holes"
        # Flat approach section clears; the road spans a chunk boundary, so
        # this also covers cross-chunk corridors (prepared globally).
        flat = buildings["way/203-0"]
        assert shape(flat["properties"]["clearanceGeometry"]).area < shape(flat["geometry"]).area
        if has_node:
            # The shared-node approach ramp clips only its own vehicle
            # envelope out of the building; lower and upper floors keep
            # the original footprint.
            ramp = buildings["way/202-0"]
            ramp_bands = ramp["properties"]["clearanceBands"]
            assert [b["cleared"] for b in ramp_bands] == [False, True, False]
            assert ramp_bands[0]["base"] == 0
            assert 3.0 < ramp_bands[1]["base"] < 3.7
            assert round(ramp_bands[-1]["height"], 6) == 12.8
            assert 0 < shape(ramp["properties"]["clearanceGeometry"]).area < shape(ramp["geometry"]).area
            # A deck piercing a tall building clears only its own vehicle
            # envelope; lower and upper floors keep the original footprint.
            deck = buildings["way/205-0"]
            deck_bands = deck["properties"]["clearanceBands"]
            assert [b["cleared"] for b in deck_bands] == [False, True, False]
            assert [round(b["base"], 6) for b in deck_bands] == [0, 4, 5.7]
            assert round(deck_bands[-1]["height"], 6) == 12.8
            deck_cleared = shape(deck["properties"]["clearanceGeometry"])
            assert 0 < deck_cleared.area < shape(deck["geometry"]).area
        else:
            print("node unavailable; skipped sloped-approach assertion")


if __name__ == "__main__":
    main()
    print("importer clearance checks passed")
