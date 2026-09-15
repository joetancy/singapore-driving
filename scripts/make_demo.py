"""Generate explicitly illustrative Singapore demo GeoJSON, never represented as OSM."""
import json, math, random
from pathlib import Path
random.seed(23)
ROOT = Path(__file__).resolve().parents[1] / 'public' / 'data'
ROOT.mkdir(parents=True, exist_ok=True)
CENTER = [103.851, 1.284]
def ll(p): return [round(CENTER[0]+p[0]/111292,7), round(CENTER[1]-p[1]/111320,7)]
def feature(kind, points, props, id):
    coords=[ll(p) for p in points]
    if kind=='Polygon': coords=[coords+[coords[0]]]
    return dict(type='Feature',id=id,properties=props,geometry=dict(type=kind,coordinates=coords))
roads=[]; buildings=[]; areas=[]
def road(name,pts,width=12):
    roads.append(feature('LineString',pts,dict(name=name,highway='secondary',width=width,source='illustrative'),f'demo-road-{len(roads)}'))
xs=[-1300,-1050,-800,-550,-300,-50]
zs=[-1450,-1200,-950,-700,-450,-200,50,300,550,800,1050]
for x,name in zip(xs,['Cecil Street','Robinson Road','Shenton Way','Raffles Quay','Collyer Quay','Marina Boulevard']): road(name,[(x,zs[0]),(x,zs[-1])],16 if x in [-550,-50] else 12)
for z,name in zip(zs,['North Bridge Road','Stamford Road','High Street','Boat Quay','Battery Road','Market Street','Boon Tat Street','McCallum Street','Straits View','Central Boulevard','Marina View']):road(name,[(xs[0],z),(xs[-1],z)],12)
road('Marina Boulevard',[(-50,550),(420,610),(1020,590),(1400,410)],22)
road('Bayfront Avenue',[(1400,410),(1560,50),(1580,-420),(1390,-710),(1080,-970)],22)
road('Raffles Avenue',[(1080,-970),(650,-1130),(150,-1100),(-50,-950)],20)
road('Esplanade Drive',[(-50,-950),(50,-630),(-50,-200)],18)
road('Sheares Avenue',[(1560,50),(1800,-170),(1820,-920),(1530,-1450),(650,-1450),(-1300,-1450)],22)
road('Marina Gardens Drive',[(1400,410),(1740,700),(1810,1110),(930,1130),(420,610)],15)
road('Marina Link',[(-50,1050),(470,1090),(930,1130)],14)
bay=[(130,-580),(340,-850),(780,-850),(1130,-590),(1320,-220),(1170,90),(780,310),(310,300),(50,100)]
areas.append(feature('Polygon',bay,dict(kind='water',name='Marina Bay (approximate)'), 'demo-bay'))
areas.append(feature('Polygon',[(1620,-370),(1920,-440),(1960,1120),(1840,1040),(1810,690),(1600,400)],dict(kind='park'), 'demo-gardens'))
areas.append(feature('Polygon',[(80,690),(410,700),(550,990),(50,940)],dict(kind='park'),'demo-park'))
for ix in range(len(xs)-1):
 for iz in range(len(zs)-1):
  left,right=xs[ix]+27,xs[ix+1]-27;top,bottom=zs[iz]+26,zs[iz+1]-26
  for bx in range(2):
   for bz in range(2):
    x=left+bx*(right-left)/2+random.uniform(0,8);z=top+bz*(bottom-top)/2+random.uniform(0,8)
    w=random.uniform(50,77);d=random.uniform(49,76)
    h=random.uniform(22,85) if iz<3 else random.uniform(55,205)
    if ix==0:h*=.55
    buildings.append(feature('Polygon',[(x,z),(x+w,z),(x+w,z+d),(x,z+d)],dict(height=round(h,1),estimated=True,building='yes',source='illustrative'),f'demo-building-{len(buildings)}'))
for x,z,w,d,h in [(1205,-175,58,110,168),(1260,-35,58,110,172),(1200,110,58,100,170),(1070,-630,95,90,30),(820,-1060,120,55,72),(1120,-1210,85,90,88),(1430,-1120,95,120,99),(1520,-1330,90,130,50),(1050,720,90,110,75),(1170,880,80,80,110),(630,730,90,170,90),(820,800,100,170,165)]:
 buildings.append(feature('Polygon',[(x,z),(x+w,z),(x+w,z+d),(x,z+d)],dict(height=h,estimated=True,building='yes',source='illustrative'),f'demo-building-{len(buildings)}'))
def write(path,obj):path.write_text(json.dumps(obj,separators=(',',':')))
def fc(features):return dict(type='FeatureCollection',features=features)
# Segment roads for spatial streaming and preserve their source road ID as a property.
pieces=[]
for r in roads:
 for i,(a,b) in enumerate(zip(r['geometry']['coordinates'],r['geometry']['coordinates'][1:])):
  n=max(1,math.ceil(math.dist(a,b)*111320/180))
  for j in range(n):
   pts=[[round(a[k]+(b[k]-a[k])*t/n,7) for k in range(2)] for t in [j,j+1]]
   pieces.append(dict(type='Feature',id=f"{r['id']}-{i}-{j}",properties=r['properties'],geometry=dict(type='LineString',coordinates=pts)))
chunks={}
for f in buildings+pieces:
 pts=f['geometry']['coordinates'];pts=pts[0] if f['geometry']['type']=='Polygon' else pts
 x=sum((p[0]-CENTER[0])*111292 for p in pts)/len(pts);z=sum((CENTER[1]-p[1])*111320 for p in pts)/len(pts)
 key=f'{math.floor(x/500)}_{math.floor(z/500)}'
 chunks.setdefault(key,[]).append(f)
index=[]
for key,features in chunks.items():
 write(ROOT/(key+'.geojson'),fc(features))
 pts=[]
 for f in features:pts.extend(f['geometry']['coordinates'][0] if f['geometry']['type']=='Polygon' else f['geometry']['coordinates'])
 index.append(dict(id=key,file=key+'.geojson',bbox=[min(p[0] for p in pts),min(p[1] for p in pts),max(p[0] for p in pts),max(p[1] for p in pts)]))
write(ROOT/'roads.geojson',fc(roads));write(ROOT/'areas.geojson',fc(areas))
write(ROOT/'manifest.json',dict(version=1,mode='illustrative',name='Marina Bay',center=CENTER,bounds=[103.838,1.272,103.869,1.298],spawn=ll((1430,332)),spawnTarget=ll((1560,50)),chunks=index,counts=dict(buildings=len(buildings),roadSegments=len(pieces)),source='Illustrative demo geometry. Not an OpenStreetMap extract.',estimatedHeights=True))
print(f'{len(buildings)} illustrative buildings, {len(pieces)} road segments, {len(chunks)} chunks')
