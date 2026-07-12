"""Derive Manhattan shore fixes from the baked chunks (coastAt stays frozen):
 1) mn_shore_edge.json — per-150 z-band BULKHEAD edge (robust percentile, clamped to <=60m past
    coastAt), for widening the visual island plate to cover near-shore blocks.
 2) mn-piers.bin — deck slabs under buildings that reach BEYOND the bulkhead (Hudson River Park /
    Seaport piers), so they sit on decks with water still between them."""
import re, struct, json, base64
import numpy as np
D='/Users/david_lietjauw/manhattan-island/public/'
s=open(D+'index.html').read()
i=s.index('const COAST = [')+len('const COAST = '); d=0;j=i
while j<len(s):
    if s[j]=='[':d+=1
    elif s[j]==']':
        d-=1
        if d==0:j+=1;break
    j+=1
COAST=eval(s[i:j])
Zc=np.array([r[0] for r in COAST]); Wc=np.array([r[1] for r in COAST]); Ec=np.array([r[2] for r in COAST])
def coastW(z): return np.interp(z,Zc,Wc)
def coastE(z): return np.interp(z,Zc,Ec)
def read_bin(p):
    dd=open(p,'rb').read(); nv=struct.unpack_from('<I',dd,8)[0]
    sc=struct.unpack_from('<3f',dd,16); of=struct.unpack_from('<3f',dd,28)
    q=np.frombuffer(dd,dtype='<u2',count=nv*3,offset=40).astype(np.float32).reshape(nv,3)
    return q/65535*np.array(sc)+np.array(of)
def read_json(p):
    j=json.load(open(p)); nv=j['nv']
    q=np.frombuffer(base64.b64decode(j['v']),dtype='<u2',count=nv*3).astype(np.float32).reshape(nv,3)
    return q/65535*np.array(j['scale'])+np.array(j['off'])
import glob
V=[]
for p in sorted(glob.glob(D+'mn-*.bin')):
    if p.endswith('.lod.bin'): continue
    V.append(read_bin(p)[:, [0,2]])   # x,z only
try: V.append(read_json(D+'fidi.json')[:, [0,2]])
except Exception as e: print('fidi skip',e)
V=np.concatenate(V); X=V[:,0]; Z=V[:,1]
print('verts',len(X),'z',Z.min(),Z.max())

# ---- 1) bulkhead edge per 150 band (clamp widening to <=60m past coastAt) ----
BAND=150; CLAMP=70; MARG=10
zbands=np.arange(400, 21050, BAND)
edgeW=[]; edgeE=[]
for z in zbands:
    m=(Z>=z-75)&(Z<z+75)
    cw=float(coastW(z)); ce=float(coastE(z))
    if m.sum()<40: edgeW.append(cw); edgeE.append(ce); continue
    xs=X[m]
    w=np.percentile(xs,4); e=np.percentile(xs,96)
    edgeW.append(min(cw, max(cw-CLAMP, w-MARG)))   # only ever widen WEST, <=60m
    edgeE.append(max(ce, min(ce+CLAMP, e+MARG)))   # only ever widen EAST, <=60m
edgeW=np.array(edgeW); edgeE=np.array(edgeE)
def med3(a):
    o=a.copy()
    for k in range(1,len(a)-1): o[k]=np.median(a[k-1:k+2])
    return o
edgeW=med3(edgeW); edgeE=med3(edgeE)
prof=[[int(z),round(float(w),1),round(float(e),1)] for z,w,e in zip(zbands,edgeW,edgeE)]
json.dump(prof,open(D+'mn_shore_edge.json','w'))
wid=sum(1 for z,w,e in prof if coastW(z)-w>3 or e-coastE(z)>3)
print(f'edge profile: {len(prof)} bands, {wid} widened (max W {max(coastW(z)-w for z,w,e in prof):.0f}m, E {max(e-coastE(z) for z,w,e in prof):.0f}m)')

# ---- 2) pier decks: per 20m z-row, if buildings reach beyond the bulkhead, deck the strip ----
def eW(z): return np.interp(z,zbands,edgeW)
def eE(z): return np.interp(z,zbands,edgeE)
ROW=20; PIER=8
deckV=[]; deckF=[]; deckC=[]
def add_slab(x0,x1,z0,z1):
    b=len(deckV); yb,yt=0.4,1.05
    for (x,y,zz) in [(x0,yb,z0),(x1,yb,z0),(x1,yb,z1),(x0,yb,z1),(x0,yt,z0),(x1,yt,z0),(x1,yt,z1),(x0,yt,z1)]:
        deckV.append((x,y,zz)); deckC.append((110,108,104))
    for f in [(0,2,1),(0,3,2),(4,5,6),(4,6,7),(0,1,5),(0,5,4),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,0,4),(3,4,7)]:
        deckF.append((b+f[0],b+f[1],b+f[2]))
npier=0
for z in np.arange(400,8600,ROW):
    m=(Z>=z)&(Z<z+ROW)
    if m.sum()<6: continue
    xs=X[m]; wl=eW(z+ROW/2); el=eE(z+ROW/2)
    west=xs[xs<wl-PIER]
    if len(west)>=6:
        tip=np.percentile(west,5); add_slab(tip, wl, z, z+ROW); npier+=1
    east=xs[xs>el+PIER]
    if len(east)>=6:
        tip=np.percentile(east,95); add_slab(el, tip, z, z+ROW); npier+=1
print('pier deck rows',npier)
if deckV:
    Vd=np.array(deckV,np.float32); Fd=np.array(deckF,np.uint32); Cd=np.array(deckC,np.uint8)
    lo=Vd.min(0); span=Vd.max(0)-lo; span[span==0]=1; Q=np.round((Vd-lo)/span*65535).astype('<u2')
    i32=1 if len(Vd)>65535 else 0; idx=Fd.astype('<u4') if i32 else Fd.astype('<u2')
    hdr=struct.pack('<IHBBII',0x3143594E,1,i32,0,len(Vd),len(Fd))+struct.pack('<6f',*[float(v) for v in span],*[float(v) for v in lo])
    open(D+'mn-piers.bin','wb').write(hdr+Q.tobytes()+Cd.tobytes()+idx.tobytes())
    print(f'mn-piers.bin: {len(Vd)}v {len(Fd)}t {(40+len(Vd)*9+len(Fd)*(4 if i32 else 2))//1024}KB')
