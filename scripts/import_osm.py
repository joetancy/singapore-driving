"""Convert a local Overpass JSON or OSM XML export to Singapore-only static assets.

Requires shapely. Input must include referenced nodes / full geometry. No network
requests are made. Boundary clipping is mandatory; the boundary must be a trusted
Singapore Polygon/MultiPolygon GeoJSON, not merely the regional extract's bbox.
"""
import argparse, hashlib, json, math, shutil, tempfile
from pathlib import Path
from datetime import datetime, timezone
import xml.etree.ElementTree as ET
from shapely.geometry import shape, mapping, Polygon, LineString, Point
from shapely.ops import unary_union, polygonize
from shapely.validation import make_valid

DRIVABLE={'motorway','motorway_link','trunk','trunk_link','primary','primary_link','secondary','secondary_link','tertiary','tertiary_link','residential','unclassified','living_street','service'}
ROOT=Path(__file__).resolve().parents[1]/'dist'/'data'
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
 elements=read_osm(source);nodes={e['id']:[e['lon'],e['lat']] for e in elements if e['type']=='node'};ways={e['id']:e for e in elements if e['type']=='way'}
 def coords(w):
  if 'geometry' in w:return [[p['lon'],p['lat']] for p in w['geometry'] if p and 'lon' in p]
  refs=w.get('nodes',[])
  return [nodes[n] for n in refs] if all(n in nodes for n in refs) else []
 features=[];roads=[];areas=[];consumed=set();missing=0
 def add(geom,props,id,kind):
  geom=make_valid(geom).intersection(boundary)
  for i,g in enumerate(parts(geom,{'LineString'} if kind=='road' else {'Polygon'})):
   f={'type':'Feature','id':f'{id}-{i}','properties':props,'geometry':mapping(g)}
   (roads if kind=='road' else areas if kind=='area' else features).append(f)
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
   add(LineString(c),t,f"way/{w['id']}",'road')
  elif w['id'] not in consumed and category(t) and len(c)>3 and c[0]==c[-1]:
   kind=category(t);props=dict(t)
   if kind=='area':props['kind']='water' if t.get('natural')=='water' or t.get('waterway')=='riverbank' else 'park'
   add(Polygon(c),props,f"way/{w['id']}",kind)
 assert roads and features,'Export must contain both driveable roads and buildings with complete geometry'
 center=[103.851,1.284];cos=math.cos(math.radians(center[1]));chunks={};segments=[]
 for r in roads:
  points=r['geometry']['coordinates']
  for i,(a,b) in enumerate(zip(points,points[1:])):
   length=math.hypot((b[0]-a[0])*111320*cos,(b[1]-a[1])*111320)
   n=max(1,math.ceil(length/180))
   for j in range(n):
    coords2=[[round(a[k]+(b[k]-a[k])*v/n,7) for k in range(2)] for v in (j,j+1)]
    segments.append(dict(type='Feature',id=f"{r['id']}-{i}-{j}",properties=r['properties'],geometry=dict(type='LineString',coordinates=coords2)))
 for f in features+segments:
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
 write(output/'manifest.json',dict(version=1,mode='osm',name='Singapore',center=center,bounds=list(boundary.bounds),boundaryFile='boundary.geojson',spawn=spawn,spawnTarget=target,chunks=index,counts=dict(buildings=len(features),roadSegments=len(segments)),estimatedHeights=True))
 print(f'Imported {len(features)} building polygons and {len(segments)} road segments in {len(chunks)} chunks; skipped {missing} ways with missing geometry.')
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('input',type=Path);parser.add_argument('--boundary',required=True,type=Path);parser.add_argument('--output',type=Path,default=ROOT);args=parser.parse_args()
 # Generate completely before touching any deployed data.
 with tempfile.TemporaryDirectory(prefix='singapore-osm-') as temp:
  staging=Path(temp)/'data';convert(args.input,args.boundary,staging)
  args.output.mkdir(parents=True,exist_ok=True)
  for p in staging.iterdir():shutil.copy2(p,args.output/p.name)
