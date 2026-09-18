"""Shared exact clearance for prepared roads; no raw-tag width/elevation fallback."""
import json
import math
import sys
from pathlib import Path

from shapely.geometry import Polygon, MultiPolygon, shape, mapping
from shapely.ops import transform, unary_union
from shapely.strtree import STRtree
from shapely.prepared import prep
from shapely.validation import make_valid

VEHICLE_HEIGHT = 1.7
BAND_ERROR = 0.05


def projection(center, inverse=False):
    import numpy as np
    radius = 6378137
    origin = math.log(math.tan(math.pi / 4 + math.radians(center[1]) / 2))
    if inverse:
        return lambda x, z, *_: (np.degrees(np.asarray(x) / radius) + center[0],
            np.degrees(2 * np.arctan(np.exp(origin - np.asarray(z) / radius)) - math.pi / 2))
    return lambda lon, lat, *_: (radius * np.radians(np.asarray(lon) - center[0]),
        radius * (origin - np.log(np.tan(math.pi / 4 + np.radians(np.asarray(lat)) / 2))))


def polygonal(geom):
    if geom.is_empty:
        return Polygon()
    if geom.geom_type in ('Polygon', 'MultiPolygon'):
        return geom
    polygons = []
    for part in geom.geoms:
        result = polygonal(part) if hasattr(part, 'geoms') or part.geom_type == 'Polygon' else Polygon()
        polygons.extend(result.geoms if result.geom_type == 'MultiPolygon' else [result])
    return unary_union([p for p in polygons if not p.is_empty]) if polygons else Polygon()


def number(value, default=0):
    try:
        n = float(value)
        return n if math.isfinite(n) else default
    except (ValueError, TypeError):
        return default


def width_at(tapers, distance, width):
    for zone in tapers:
        if zone['d0'] <= distance <= zone['d1']:
            t = (distance - zone['d0']) / (zone['d1'] - zone['d0'] or 1)
            return zone['w0'] + (zone['w1'] - zone['w0']) * (0.5 - 0.5 * math.cos(math.pi * t))
    return width


def corridor_cells(roads):
    for road in roads:
        samples = road['samples']
        for a, b in zip(samples, samples[1:]):
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 0.001:
                continue
            # Structure tags apply even at a zero-height structure endpoint.
            ground = road.get('structure', 'ground') == 'ground' and max(abs(a[2]), abs(b[2])) < 1e-6
            shoulder = 1.5 if ground else 0
            def edge(p, sign):
                half = width_at(road.get('tapers', []), p[3], road['width']) / 2 + shoulder
                return [p[0] + p[4] * sign * half, p[1] + p[5] * sign * half, p[2]]
            vertices = [edge(a, 1), edge(b, 1), edge(b, -1), edge(a, -1)]
            if not all(math.isfinite(n) for p in vertices for n in p):
                raise ValueError(f"Non-finite cell: {road['id']}")
            # Index one quad per section; split with the renderer's deterministic
            # diagonals only after a building is a spatial candidate.
            poly = Polygon([p[:2] for p in vertices])
            if poly.area > 1e-8:
                yield poly, vertices


def cell_triangles(vertices):
    return [[vertices[i] for i in ids] for ids in ((0, 1, 3), (1, 2, 3))]


def clip_height(vertices, level, above):
    result = []
    for a, b in zip(vertices, vertices[1:] + vertices[:1]):
        inside_a = a[2] > level if above else a[2] < level
        inside_b = b[2] > level if above else b[2] < level
        if inside_a:
            result.append(a)
        if inside_a != inside_b:
            t = (level - a[2]) / (b[2] - a[2])
            result.append([a[i] + (b[i] - a[i]) * t for i in range(3)])
    return result


def prepare_clearance(buildings, roads, center):
    cells = list(corridor_cells(roads))
    tree = STRtree([p for p, _ in cells])
    forward, inverse = projection(center), projection(center, True)
    warnings = []
    for feature in buildings:
        props = feature['properties']
        for key in ('clearanceGeometry', 'clearanceBands', 'clearanceHeight', 'clearancePrepared'):
            props.pop(key, None)  # Always recompute from the original footprint.
        base = max(0, number(props.get('min_height')))
        levels = number(props.get('building:levels', props.get('building_levels')), 4)
        if levels <= 0:
            warnings.append({'code': 'INVALID_BUILDING_LEVELS', 'featureId': feature['id'],
                             'rawValues': {'building:levels': props.get('building:levels', props.get('building_levels'))},
                             'fallbackOrBlockedBehavior': 'Use the existing four-level height estimate; retain raw tags.'})
            levels = 4
        top = number(props.get('height')) or levels * 3.2
        if top <= base:
            top = base + max(number(props.get('roof:height')), 0.1)
            warnings.append({'code': 'SOURCE_FIELD_UNAVAILABLE', 'featureId': feature['id'],
                             'rawValues': {'height': props.get('height'), 'min_height': props.get('min_height')},
                             'fallbackOrBlockedBehavior': 'Use min_height plus roof height as derived top.'})
        props['clearancePrepared'] = True
        props['preparedExtent'] = [base, top]
        original = transform(forward, shape(feature['geometry']))
        local = polygonal(make_valid(original))
        localPrepared = prep(local)
        if local.is_empty or top <= base:
            raise ValueError(f"Invalid building volume: {feature['id']}")
        if not original.is_valid:
            warnings.append({'code': 'REPAIRED_POLYGON', 'featureId': feature['id']})
        hits = []
        for i in tree.query(local):
            poly, vertices = cells[i]
            if not localPrepared.intersects(poly):
                continue
            for triangle in cell_triangles(vertices):
                heights = [p[2] for p in triangle]
                if min(heights) < top and max(heights) + VEHICLE_HEIGHT > base:
                    hits.append((poly, triangle))
        if not hits:
            continue
        cuts = {base, top}
        for _, vertices in hits:
            low, high = min(p[2] for p in vertices), max(p[2] for p in vertices)
            cuts.update((max(base, min(top, low)), max(base, min(top, high + VEHICLE_HEIGHT))))
            if high - low > 1e-9:
                lo, hi = max(base, low), min(top, high + VEHICLE_HEIGHT)
                count = math.ceil((hi - lo) / BAND_ERROR)
                cuts.update(lo + (hi - lo) * i / count for i in range(1, count))
        bands = []
        footprints = []
        for lo, hi in zip(sorted(cuts), sorted(cuts)[1:]):
            if hi - lo < 1e-9:
                continue
            removal = []
            for _, vertices in hits:
                clipped = clip_height(vertices, lo - VEHICLE_HEIGHT + 1e-9, True)
                clipped = clip_height(clipped, hi - 1e-9, False) if clipped else []
                if len(clipped) >= 3:
                    removal.append(Polygon([p[:2] for p in clipped]))
            remaining = polygonal(local.difference(unary_union(removal)))
            if not remaining.is_valid:
                raise ValueError(f"Invalid derived band: {feature['id']}")
            if footprints and remaining.equals(footprints[-1]):
                bands[-1]['height'] = hi
                continue
            footprints.append(remaining)
            bands.append({'base': lo, 'height': hi, 'cleared': not remaining.equals(local),
                          'geometry': mapping(transform(inverse, remaining))})
        props['clearanceBands'] = bands
        # Legacy summary is for inspection only; consumers use per-band geometry.
        changed = [p for p, b in zip(footprints, bands) if b['cleared']]
        if changed:
            props['clearanceGeometry'] = mapping(transform(inverse, changed[0]))
        if any(p.is_empty for p in footprints):
            warnings.append({'code': 'EMPTY_DERIVED_BUILDING', 'featureId': feature['id']})
    return warnings


def prepare_directory(directory):
    directory = Path(directory)
    manifest = json.loads((directory / 'manifest.json').read_text())
    chunks = [(directory / c['file'], json.loads((directory / c['file']).read_text())) for c in manifest['chunks']]
    roads, buildings = [], []
    for _, chunk in chunks:
        for f in chunk['features']:
            p = f['properties']
            if f['geometry']['type'] == 'LineString':
                roads.append(dict(id=f['id'], samples=p['samples'], width=p['preparedWidth'],
                                  tapers=p.get('tapers', []), structure=p['structure']))
            elif p.get('building') or p.get('building:part'):
                buildings.append(f)
    warnings = prepare_clearance(buildings, roads, manifest['center'])
    for path, chunk in chunks:
        path.write_text(json.dumps(chunk, separators=(',', ':'), allow_nan=False))
    (directory / 'clearance-warnings.json').write_text(json.dumps(warnings, separators=(',', ':')))


if __name__ == '__main__':
    prepare_directory(sys.argv[1])
