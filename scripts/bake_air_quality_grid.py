import argparse
import io
import math
import struct
import zipfile
from pathlib import Path

try:
    from pyproj import Transformer
except ImportError as exc:
    raise SystemExit('pyproj is required: python3 -m pip install pyproj') from exc


def read_grid(archive, folder):
    def take(name):
        return archive.read(folder + '/' + name)

    hdr = take('hdr.adf')
    bounds = struct.unpack('>4d', take('dblbnd.adf'))
    index = take('w001001x.adf')
    data = take('w001001.adf')
    cell_type, compressed = struct.unpack('>2i', hdr[16:24])
    pixel_x, pixel_y = struct.unpack('>2d', hdr[256:272])
    tiles_x, tiles_y, tile_w, _, tile_h = struct.unpack('>5i', hdr[288:308])
    if cell_type != 2 or compressed != 1:
        raise ValueError('expected an uncompressed float ArcInfo grid')
    llx, lly, urx, ury = bounds
    width = round((urx - llx) / pixel_x)
    height = round((ury - lly) / pixel_y)
    values = [[math.nan] * width for _ in range(height)]
    entries = max(0, (len(index) - 100) // 8)
    for tile in range(min(entries, tiles_x * tiles_y)):
        offset, shorts = struct.unpack('>2i', index[100 + tile * 8:108 + tile * 8])
        if shorts <= 0:
            continue
        start = offset * 2
        declared = struct.unpack('>H', data[start:start + 2])[0]
        if declared != shorts:
            raise ValueError('tile index mismatch')
        raw = data[start + 2:start + 2 + shorts * 2]
        row0 = (tile // tiles_x) * tile_h
        col0 = (tile % tiles_x) * tile_w
        count = min(len(raw) // 4, tile_w * tile_h)
        vals = struct.unpack('>' + 'f' * count, raw[:count * 4])
        for i, value in enumerate(vals):
            row = row0 + i // tile_w
            col = col0 + i % tile_w
            if row < height and col < width and value > -1e20:
                values[row][col] = value
    return values, bounds, pixel_x, pixel_y


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('zip_path')
    parser.add_argument('output')
    parser.add_argument('--folder', default='aa16_pm300m')
    parser.add_argument('--year', type=int, default=2024)
    parser.add_argument('--stride', type=int, default=2)
    args = parser.parse_args()

    with zipfile.ZipFile(args.zip_path) as archive:
        values, bounds, pixel_x, pixel_y = read_grid(archive, args.folder)
    llx, lly, urx, ury = bounds
    to_geo = Transformer.from_crs(2263, 4326, always_xy=True)
    rows = []
    for row in range(0, len(values), args.stride):
        y = ury - (row + 0.5) * pixel_y
        for col in range(0, len(values[row]), args.stride):
            value = values[row][col]
            if not math.isfinite(value):
                continue
            x = llx + (col + 0.5) * pixel_x
            lon, lat = to_geo.transform(x, y)
            if 40.45 <= lat <= 41.05 and -74.35 <= lon <= -73.55:
                rows.append((lat, lon, value))
    payload = io.BytesIO()
    payload.write(b'AQG1')
    payload.write(struct.pack('<HHI', args.year, args.stride * 300, len(rows)))
    for row in rows:
        payload.write(struct.pack('<3f', *row))
    Path(args.output).write_bytes(payload.getvalue())
    print(f'wrote {args.output}: {len(rows)} cells, {len(payload.getvalue())} bytes, baseline year {args.year}')


if __name__ == '__main__':
    main()
