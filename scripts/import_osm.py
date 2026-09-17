"""Convert a local Overpass JSON or OSM XML export to Singapore-only static assets.

Requires shapely. Input must include referenced nodes / full geometry. No network
requests are made. Boundary clipping is mandatory; the boundary must be a trusted
Singapore Polygon/MultiPolygon GeoJSON, not merely the regional extract's bbox.
"""
import argparse, hashlib, json, math, shutil, subprocess, tempfile
from pathlib import Path
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
import numpy as np
from shapely.geometry import shape, mapping, Polygon, LineString, Point
from shapely.ops import transform
from shapely.ops import unary_union, polygonize
from shapely.strtree import STRtree
from shapely.validation import make_valid

DRIVABLE={'motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service'}
ROOT=Path(__file__).resolve().parents[1]/'public'/'data'
def fc(fs):return {'type':'FeatureCollection','features':fs}
def write(path,obj):path.write_text(json.dumps(obj,separators=(',',':')))
def parts(geom,types):
 if geom.is_empty:return []
 if geom.geom_type in types:return [geom]
 return [p for g in getattr(geom,'geoms',[]) for p in parts(g,types)]
def boundary_geometry(data):
 if data['type']=='FeatureCollection':return unary_union([shape(f['geometry']) for f in data['features']])
 return shape(data['geometry'] if data['type']=='Feature' else data)
def read_osm(path):
 if path.suffix.lower() in {'.json','.geojson'}:
  data=json.loads(path.read_text());return data['elements']
 root=ET.parse(path).getroot();elements=[]
 for el in root:
  if el.tag not in {'node','way','relation'}:continue
  f={'type':el.tag,'id':int(el.attrib['id']),'tags':{t.attrib['k']:t.attrib['v'] for t in el.findall('tag')}}
  if el.tag=='node':f.update(lon=float(el.attrib['lon']),lat=float(el.attrib['lat']))
  if el.tag=='way':f['nodes']=[int(n.attrib['ref']) for n in el.findall('nd')]
  if el.tag=='relation':f['members']=[{'type':m.attrib['type'],'ref':int(m.attrib['ref']),'role':m.attrib.get('role','')} for m in el.findall('member')]
  elements.append(f)
 return elements
def convert(source,boundary_path,output):
 boundary=make_valid(boundary_geometry(json.loads(boundary_path.read_text())))
 assert boundary.geom_type in {'Polygon','MultiPolygon'},'Singapore boundary must be polygonal'
 assert not boundary.is_empty,'Empty Singapore boundary'
 assert all(103.4<=x<=104.7 and 1.0<=y<=1.7 for p in parts(boundary,{'Polygon'}) for x,y in p.exterior.coords),'Boundary is outside Singapore region'
 elements=read_osm(source);node_records={e['id']:e for e in elements if e['type']=='node'};nodes={id:[e['lon'],e['lat']] for id,e in node_records.items()};ways={e['id']:e for e in elements if e['type']=='way'}
 def coords(w):
  if 'geometry' in w:return [[p['lon'],p['lat']] for p in w['geometry'] if p and 'lon' in p]
  refs=w.get('nodes',[])
  return [nodes[n] for n in refs] if all(n in nodes for n in refs) else []
 features=[];roads=[];areas=[];signals=[];crossings=[];consumed=set();missing=0
 def add(geom,props,id,kind):
  geom=make_valid(geom).intersection(boundary)
  created=[]
  for i,g in enumerate(parts(geom,{'LineString'} if kind=='road' else {'Polygon'})):
   f={'type':'Feature','id':f'{id}-{i}','properties':props,'geometry':mapping(g)}
   (roads if kind=='road' else areas if kind=='area' else features).append(f)
   created.append(f)
  return created
 def category(t):
  if t.get('building') not in (None,'no') or t.get('building:part') not in (None,'no'):return 'building'
  if t.get('natural')=='water' or t.get('waterway')=='riverbank':return 'area'
  if t.get('leisure') in {'park','garden'} or t.get('landuse') in {'grass','forest','recreation_ground'}:return 'area'
  return None
 for relation in [e for e in elements if e['type']=='relation']:
  t=relation.get('tags',{});kind=category(t)
  if not kind:continue
  outer=[];inner=[];refs=[]
  for m in relation.get('members',[]):
   if m['type']!='way':continue
   w=ways.get(m['ref'],m);c=coords(w)
   if len(c)<2:continue
   (inner if m.get('role')=='inner' else outer).append(LineString(c));refs.append(m['ref'])
  op=list(polygonize(unary_union(outer)));ip=list(polygonize(unary_union(inner)))
  if op:
   g=unary_union(op).difference(unary_union(ip));props=dict(t)
   if kind=='area':props['kind']='water' if t.get('natural')=='water' or t.get('waterway')=='riverbank' else 'park'
   add(g,props,f"relation/{relation['id']}",kind);consumed.update(refs)
 for w in ways.values():
  t=w.get('tags',{});c=coords(w)
  if len(c)<2:missing+=1;continue
  if t.get('highway') in DRIVABLE and t.get('access') not in {'private','no'}:
   refs=w.get('nodes',[])
   for f in add(LineString(c),t,f"way/{w['id']}",'road'):
    # Preserve OSM node identities so geometric crossings alone never
    # establish connectivity during elevation preparation. Boundary-split
    # ends keep coordinate matching; unresolved joins are reported.
    ends=f['geometry']['coordinates'];props=dict(f['properties'])
    props['startNodeId']=str(refs[0]) if refs and abs(ends[0][0]-c[0][0])<1e-9 and abs(ends[0][1]-c[0][1])<1e-9 else None
    props['endNodeId']=str(refs[-1]) if refs and abs(ends[-1][0]-c[-1][0])<1e-9 and abs(ends[-1][1]-c[-1][1])<1e-9 else None
    f['properties']=props
  elif w['id'] not in consumed and category(t) and len(c)>3 and c[0]==c[-1]:
   kind=category(t);props=dict(t)
   if kind=='area':props['kind']='water' if t.get('natural')=='water' or t.get('waterway')=='riverbank' else 'park'
   add(Polygon(c),props,f"way/{w['id']}",kind)
 for n in node_records.values():
  if n['tags'].get('highway')=='traffic_signals' and boundary.covers(Point(n['lon'],n['lat'])):
   signals.append(dict(type='Feature',id=f"node/{n['id']}",properties=dict(n['tags']),geometry=mapping(Point(n['lon'],n['lat']))))
  if n['tags'].get('highway')=='crossing' and boundary.covers(Point(n['lon'],n['lat'])):
   crossings.append(dict(type='Feature',id=f"node/{n['id']}",properties=dict(n['tags']),geometry=mapping(Point(n['lon'],n['lat']))))
 center=[103.851,1.284];cos=math.cos(math.radians(center[1]));chunks={};segments=[]
 node_at={(round(v[0],7),round(v[1],7)):str(k) for k,v in nodes.items()}
 assert roads and features,'Export must contain both driveable roads and buildings with complete geometry'
 # Derive clearance in local metres once, before chunking, so roads at a chunk
 # edge open the same building footprint from either side.
 def xy(x,y,z=None):return ((x-center[0])*111320*cos,(y-center[1])*111320)
 # Exact browser projection: road-network.mjs project() equals the renderer's
 # d3.geoMercator().center().translate([0,0]).scale(6378137). Clearance math
 # uses this space so derived geometry matches the browser exactly.
 # NumPy ops handle scalars, tuples and arrays (shapely may call either way).
 R=6378137
 def project(lon,lat):
  return (R*np.radians(np.asarray(lon)-center[0]),R*(np.log(np.tan(np.pi/4+np.radians(center[1])/2))-np.log(np.tan(np.pi/4+np.radians(lat)/2))))
 def unproject(x,y):
  merc=np.log(np.tan(np.pi/4+np.radians(center[1])/2))-np.asarray(y)/R
  return (np.degrees(np.asarray(x)/R)+center[0],np.degrees(2*np.arctan(np.exp(merc))-np.pi/2))
 def road_width(p):
  # Mirrors scripts/road-network.mjs roadWidth so importer clearance uses the
  # same normalized widths as the static build. Explicit widths win; otherwise
  # lane counts (then highway-class lane defaults) set the width. Limits 4-32m.
  try:
   explicit=float(p.get('width',0))
   if explicit>0:return max(4,min(32,explicit))
  except ValueError:pass
  def count(value):
   try:return int(value) if int(value)>0 else 0
   except (TypeError,ValueError):return 0
  lanes=count(p.get('lanes')) or count(p.get('lanes:forward'))+count(p.get('lanes:backward'))
  highway=p.get('highway','');link=highway.endswith('_link');fast=highway in {'motorway','motorway_link','trunk','trunk_link'}
  fallback=1 if link else 3 if fast else 1 if highway=='service' else 2
  return max(4,min(32,(lanes or fallback)*(3.5 if fast else 3.1)+(1 if fast else .6)))
 def number(value,default=0):
  try:return float(value)
  except (TypeError,ValueError):return default
 def road_level(p):
  try:layer=int(float(p.get('layer',0)))
  except ValueError:layer=0
  if p.get('tunnel') not in (None,'no') or layer<0:return min(-4,layer*4)
  return max(4,layer*4) if p.get('bridge') not in (None,'no') else max(0,layer*4)
 def building_height(p):return number(p.get('height')) or number(p.get('building:levels',p.get('building_levels')),4)*3.2
 def prepare_road_elevations():
  # Elevation preparation must precede clearance so both use identical
  # heights. Runs the shared scripts/prepare.mjs entry point on the full
  # road set; returns {widths, samples, warnings} or None when Node is
  # unavailable (approximate fallback below).
  script=Path(__file__).parent/'prepare.mjs'
  if not shutil.which('node'):
   print('Node not found; using approximate ground-only clearance.')
   return None
  tags=('highway','bridge','tunnel','layer','covered','lanes','lanes:forward','lanes:backward','width','oneway','junction','startNodeId','endNodeId')
  payload=json.dumps(dict(center=center,features=[dict(id=r['id'],coordinates=r['geometry']['coordinates'],properties={k:v for k,v in r['properties'].items() if k in tags}) for r in roads]))
  try:
   out=subprocess.run(['node',str(script)],input=payload.encode(),stdout=subprocess.PIPE,timeout=600,check=True).stdout
  except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as e:
   print(f'Road preparation failed ({e}); using approximate ground-only clearance.')
   return None
  result=json.loads(out)
  print(f"Prepared {len(result['samples'])} roads for clearance; {len(result['warnings'])} mixed-level junctions flagged.")
  return result
 def corridor_quads(samples,width):
  # Explicit surface quads from prepared cross-sections (normals shared at
  # joins, so consecutive quads meet without gaps). Sloped pairs are split
  # where the vehicle-clearance envelope changes height. Ground pairs carry
  # the shoulder tolerance; elevated pairs keep their physical deck or
  # passage width. Each quad returns (polygon, h0, h1, deck).
  quads=[]
  for a,b in zip(samples,samples[1:]):
   if math.hypot(b[0]-a[0],b[1]-a[1])<0.001:continue
   steps=max(1,math.ceil(abs(b[2]-a[2])/0.5))
   for s in range(steps):
    t0=s/steps;t1=(s+1)/steps
    p0=[a[i]+(b[i]-a[i])*t0 for i in range(6)];p1=[a[i]+(b[i]-a[i])*t1 for i in range(6)]
    ground=max(abs(p0[2]),abs(p1[2]))<=0.3
    half=width/2+(1.5 if ground else 0)
    o0x=p0[4]*half;o0z=p0[5]*half;o1x=p1[4]*half;o1z=p1[5]*half
    quads.append((Polygon([(p0[0]+o0x,p0[1]+o0z),(p1[0]+o1x,p1[1]+o1z),(p1[0]-o1x,p1[1]-o1z),(p0[0]-o0x,p0[1]-o0z)]),min(p0[2],p1[2]),max(p0[2],p1[2]),not ground))
  return quads
 def clearance_bands(base,top,groundHit,decks):
  # Split a building into vertical bands so clearance never erases unrelated
  # floors: ground contact clears [base,1.7]; each deck envelope [h0,h1+1.7]
  # clears only its own interval. Strict overlap (touching does not cut).
  cuts={base,top}
  if groundHit:cuts.add(min(top,1.7))
  for h0,h1 in decks:
   cuts.add(min(max(h0,base),top));cuts.add(min(max(h1+1.7,base),top))
  bands=[]
  for lo,hi in zip(sorted(cuts),sorted(cuts)[1:]):
   if hi-lo<1e-9:continue
   mid=(lo+hi)/2
   cleared=(groundHit and base<=mid<min(top,1.7)) or any(h0<mid<h1+1.7 for h0,h1 in decks)
   bands.append([lo,hi,cleared])
  merged=[]
  for lo,hi,cleared in bands:
   if merged and merged[-1][2]==cleared and abs(merged[-1][1]-lo)<1e-9:merged[-1][1]=hi
   else:merged.append([lo,hi,cleared])
  return merged
 prepared=prepare_road_elevations()
 if prepared is None:
  ground=[transform(xy,shape(r['geometry'])).buffer(road_width(r['properties'])/2+1.5,cap_style=2,join_style=2)
   for r in roads if abs(road_level(r['properties']))<.1]
  road_tree=STRtree(ground) if ground else None
  if road_tree:
   for f in features:
    p=f['properties'];base=max(0,number(p.get('min_height')))
    if base<1.7:
     original=shape(f['geometry']);local=transform(xy,original)
     nearby=road_tree.query(local)
     corridor=unary_union([ground[i] for i in nearby])
     if corridor.is_empty:continue  # no road contact: footprint preserved
     cleared=transform(lambda x,y,z=None:(x/(111320*cos)+center[0],y/111320+center[1]),local.difference(corridor))
     height=building_height(p);split=min(height,1.7)
     p['clearanceGeometry']=mapping(cleared);p['clearanceHeight']=split
     p['clearanceBands']=[dict(base=base,height=split,cleared=True)]+([dict(base=split,height=height,cleared=False)] if height>split else [])
     p['clearancePrepared']=True
 else:
  quads=[]
  for r in roads:
   samples=prepared['samples'].get(r['id'])
   if not samples or len(samples)<2:continue
   quads.extend(corridor_quads(samples,prepared['widths'].get(r['id'],road_width(r['properties']))))
  quad_tree=STRtree([q for q,_,_,_ in quads]) if quads else None
  if quad_tree:
   for f in features:
    p=f['properties'];base=max(0,number(p.get('min_height')))
    top=building_height(p)
    if base>=top:continue
    original=shape(f['geometry']);local=transform(lambda x,y,z=None:project(x,y),original)
    # Clip only where the vehicle-clearance envelope [h,h+1.7] strictly
    # intersects the building's vertical extent. Tunnels below and buildings
    # below decks keep their surface footprints; partial overlap splits the
    # building into vertical bands. Holes and disconnected parts are retained.
    nearby=quad_tree.query(local)
    hits=[quads[i] for i in nearby if quads[i][1]<top and quads[i][2]+1.7>base]
    if not hits:continue  # vertically separated: footprint preserved
    groundHit=any(not deck for _,_,_,deck in hits)
    decks=[(h0,h1) for _,h0,h1,deck in hits if deck]
    bands=clearance_bands(base,top,groundHit,decks)
    clearedBands=[(lo,hi) for lo,hi,cleared in bands if cleared]
    if not clearedBands:continue
    corridor=unary_union([poly for poly,h0,h1,_ in hits if any(h0<hi and h1+1.7>lo for lo,hi in clearedBands)])
    if corridor.is_empty:continue
    cleared=transform(lambda x,y,z=None:unproject(x,y),local.difference(corridor))
    p['clearanceGeometry']=mapping(cleared);p['clearanceHeight']=min(top,1.7)
    p['clearanceBands']=[dict(base=lo,height=hi,cleared=cleared) for lo,hi,cleared in bands]
    p['clearancePrepared']=True
 for r in roads:
  points=r['geometry']['coordinates']
  for i,(a,b) in enumerate(zip(points,points[1:])):
   length=math.hypot((b[0]-a[0])*111320*cos,(b[1]-a[1])*111320)
   n=max(1,math.ceil(length/180))
   for j in range(n):
    coords2=[[round(a[k]+(b[k]-a[k])*v/n,7) for k in range(2)] for v in (j,j+1)]
    ids=[node_at.get(tuple(coords2[0]),f"{r['id']}:{i}:{j}"),node_at.get(tuple(coords2[1]),f"{r['id']}:{i}:{j+1}")]
    props=dict(r['properties'],startNodeId=ids[0],endNodeId=ids[1])
    segments.append(dict(type='Feature',id=f"{r['id']}-{i}-{j}",properties=props,geometry=dict(type='LineString',coordinates=coords2)))
 for f in features+signals+crossings+segments:
  g=shape(f['geometry']);p=g.centroid;x=(p.x-center[0])*111320*cos;z=(center[1]-p.y)*111320
  key=f'{math.floor(x/500)}_{math.floor(z/500)}';chunks.setdefault(key,[]).append(f)
 preferred=[r for r in roads if r['properties'].get('name')=='Bayfront Avenue' and not r['properties'].get('tunnel')]
 start=min(preferred or roads,key=lambda r:shape(r['geometry']).distance(Point(103.86,1.282)))
 sp=list(start['geometry']['coordinates']);spawn=sp[0];target=sp[1]
 index=[]
 output.mkdir(parents=True,exist_ok=True)
 for key,fs in chunks.items():
  file=key+'.geojson';write(output/file,fc(fs));boxes=[shape(f['geometry']).bounds for f in fs]
  index.append(dict(id=key,file=file,bbox=[min(b[0] for b in boxes),min(b[1] for b in boxes),max(b[2] for b in boxes),max(b[3] for b in boxes)]))
 overview=[];overview_classes={'motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link'}
 for r in roads:
  if r['properties'].get('highway') not in overview_classes:continue
  g=shape(r['geometry']).simplify(.00004)
  p=r['properties'];overview.append(dict(type='Feature',id=r['id'],properties={k:p[k] for k in ('name','highway','width') if k in p},geometry=mapping(g)))
 area_overview=[dict(type='Feature',id=a['id'],properties={'kind':a['properties']['kind']},geometry=mapping(shape(a['geometry']).simplify(.00001,preserve_topology=True))) for a in areas]
 write(output/'roads.geojson',fc(overview));write(output/'areas.geojson',fc(area_overview));write(output/'boundary.geojson',fc([dict(type='Feature',properties={},geometry=mapping(boundary))]))
 write(output/'source.json',dict(source='OpenStreetMap via Geofabrik',license='ODbL-1.0',attribution='© OpenStreetMap contributors',url='https://www.openstreetmap.org/copyright',extract_url='https://download.geofabrik.de/asia/malaysia-singapore-brunei.html',input=source.name,input_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),converted_at=datetime.now(timezone.utc).isoformat(),boundary=boundary_path.name,missing_geometry=missing))
 write(output/'manifest.json',dict(version=1,mode='osm',name='Singapore',center=center,bounds=list(boundary.bounds),boundaryFile='boundary.geojson',spawn=spawn,spawnTarget=target,chunks=index,counts=dict(buildings=len(features),roadSegments=len(segments),trafficSignals=len(signals),crossings=len(crossings)),estimatedHeights=True))
 print(f'Imported {len(features)} building polygons, {len(segments)} road segments, {len(signals)} traffic signals and {len(crossings)} crossings in {len(chunks)} chunks; skipped {missing} ways with missing geometry.')
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('input',type=Path);parser.add_argument('--boundary',required=True,type=Path);parser.add_argument('--output',type=Path,default=ROOT);args=parser.parse_args()
 # Generate completely before touching any deployed data.
 with tempfile.TemporaryDirectory(prefix='singapore-osm-') as temp:
  staging=Path(temp)/'data';convert(args.input,args.boundary,staging)
  args.output.mkdir(parents=True,exist_ok=True)
  for p in staging.iterdir():shutil.copy2(p,args.output/p.name)
