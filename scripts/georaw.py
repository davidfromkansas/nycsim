import numpy as np
from pyproj import Transformer
_t = Transformer.from_crs(2263, 4326, always_xy=True)  # SP ft -> lon/lat
GRID_ROT = np.deg2rad(29)
XSHIFT = [[0,150],[4520,300],[6760,310],[8120,328],[12200,330],[13400,420],
          [14400,520],[15100,700],[16400,950],[17700,1170],[18800,1150],
          [19900,1000],[21000,900]]
_xz = np.array([p[0] for p in XSHIFT]); _xs = np.array([p[1] for p in XSHIFT])
def geoToWorld(lat, lon):
    dE = (lon + 74.0146) * 111320 * np.cos(np.deg2rad(40.7003))
    dN = (lat - 40.7003) * 110540
    return (dE*np.cos(GRID_ROT) - dN*np.sin(GRID_ROT),
            dN*np.cos(GRID_ROT) + dE*np.sin(GRID_ROT))
def geoRaw_ll(lat, lon):
    gx, gz = geoToWorld(lat, lon)
    zs = gz*0.9877 + 354
    zc = np.clip(zs, 0, 21000)
    shift = np.interp(zc, _xz, _xs)
    return gx*0.86 + shift, zs
def sp_to_scene(X, Y):
    lon, lat = _t.transform(X, Y)
    return geoRaw_ll(lat, lon)
if __name__ == '__main__':
    import json
    R = {**json.load(open('qn_refs.json')), **json.load(open('qn_refs2.json'))}
    t2263 = Transformer.from_crs(4326, 2263, always_xy=True)
    errs = []
    for k,(lat,lon,sx,sz) in R.items():
        X,Y = t2263.transform(lon, lat)
        px, pz = sp_to_scene(X, Y)
        e = np.hypot(px-sx, pz-sz)
        errs.append(e)
    errs = np.array(errs)
    print('EXACT geoRaw replication vs %d live samples: max %.3f m  mean %.3f m' % (len(errs), errs.max(), errs.mean()))
