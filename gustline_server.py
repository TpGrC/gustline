"""Gustline data server.
Downloads the NOAA GFS 0.5-degree global forecast every 6 hours, turns each
weather variable into a small greyscale PNG grid, and serves the website
(site/ folder) plus that data on http://127.0.0.1:8765.
"""
import os, sys, json, time, zlib, struct, shutil, threading, datetime as dt
import urllib.request, urllib.error, traceback
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import numpy as np
import eccodes

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, 'site')
DATA = os.path.join(SITE, 'data')
PORT = 8765
STEPS = list(range(0, 121, 3)) + list(range(126, 241, 6))   # 3-hourly to day 5, 6-hourly to day 10
NX, NY = 720, 361                         # 0.5 degree global grid
FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p50.pl'
QUERY = ('var_UGRD=on&var_VGRD=on&var_TMP=on&var_PRMSL=on&var_TCDC=on&var_PRATE=on&var_GUST=on'
         '&var_RH=on&var_CAPE=on&var_SNOD=on'
         '&lev_10_m_above_ground=on&lev_2_m_above_ground=on&lev_mean_sea_level=on'
         '&lev_entire_atmosphere=on&lev_surface=on')
# our name -> GRIB shortName
WANT = {'u': '10u', 'v': '10v', 't': '2t', 'p': 'prmsl', 'c': 'tcc', 'r': 'prate', 'g': 'gust',
        'h': '2r', 'k': 'cape', 'n': 'sde'}
RANGES = {'u': (-50, 50), 'v': (-50, 50), 't': (-60, 50), 'p': (950, 1060), 'c': (0, 100), 'g': (0, 60),
          'h': (0, 100), 'k': (0, 4000)}
LOG = lambda *a: print(time.strftime('%H:%M:%S'), *a, flush=True)
state = {'busy': False, 'status': 'starting'}


def png_gray(path, img):
    h, w = img.shape
    raw = b''.join(b'\x00' + img[i].tobytes() for i in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(data)


def http_get(url, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Gustline/1.0 (personal weather map)'})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:
            LOG('  retry', k + 1, 'after error:', e)
            time.sleep(5 * (k + 1))
    raise RuntimeError('download failed: ' + url)


def url_for(run, step, query=QUERY):
    d, h = run[:8], run[8:]
    return f'{FILTER}?dir=%2Fgfs.{d}%2F{h}%2Fatmos&file=gfs.t{h}z.pgrb2full.0p50.f{step:03d}&{query}'


def run_ready(run):
    try:
        b = http_get(url_for(run, STEPS[-1], 'var_PRMSL=on&lev_mean_sea_level=on'), tries=1)
        return b[:4] == b'GRIB'
    except Exception:
        return False


def newest_run():
    now = dt.datetime.now(dt.timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 6)
    for k in range(0, 5):
        r = (base - dt.timedelta(hours=6 * k)).strftime('%Y%m%d%H')
        if run_ready(r):
            return r
    return None


def decode(blob):
    """Split a GRIB2 file into messages in memory and pick the fields we need."""
    out = {}
    pos = 0
    while True:
        pos = blob.find(b'GRIB', pos)
        if pos < 0:
            break
        length = struct.unpack('>Q', blob[pos + 8:pos + 16])[0]
        msg = blob[pos:pos + length]
        pos += length
        h = eccodes.codes_new_from_message(msg)
        try:
            sn = eccodes.codes_get(h, 'shortName')
            for name, want in WANT.items():
                if name in out or sn != want:
                    continue
                ni, nj = eccodes.codes_get(h, 'Ni'), eccodes.codes_get(h, 'Nj')
                vals = eccodes.codes_get_values(h).reshape(nj, ni)
                if eccodes.codes_get(h, 'jScansPositively'):
                    vals = vals[::-1]
                out[name] = vals
        finally:
            eccodes.codes_release(h)
    return out


def encode(name, a):
    if name == 't':
        a = a - 273.15
    elif name == 'p':
        a = a / 100.0
    elif name == 'r':
        mmh = np.clip(a * 3600.0, 0, 64)
        return np.round(np.sqrt(mmh) / 8.0 * 255).astype(np.uint8)
    elif name == 'n':
        m = np.where(a > 1000, 0, a)
        m = np.clip(m, 0, 4)
        return np.round(np.sqrt(m) / 2.0 * 255).astype(np.uint8)
    lo, hi = RANGES[name]
    return np.round((np.clip(a, lo, hi) - lo) / (hi - lo) * 255).astype(np.uint8)


def build(run):
    state['busy'] = True
    out_dir = os.path.join(DATA, run)
    tmp_dir = out_dir + '.part'
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir)
    LOG('Building GFS run', run)
    for i, s in enumerate(STEPS):
        state['status'] = f'downloading {run} step {i + 1}/{len(STEPS)}'
        f = decode(http_get(url_for(run, s)))
        for name in WANT:
            arr = f.get(name)
            img = encode(name, arr) if arr is not None else np.zeros((NY, NX), np.uint8)
            if img.shape != (NY, NX):
                raise RuntimeError(f'unexpected grid {img.shape}')
            png_gray(os.path.join(tmp_dir, f'{name}_{s:03d}.png'), img)
        LOG(f'  step f{s:03d} ok ({", ".join(sorted(f))})')
        time.sleep(0.7)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.replace(tmp_dir, out_dir)
    run_time = dt.datetime.strptime(run, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
    meta = {'run': run, 'runTime': int(run_time.timestamp()), 'steps': STEPS, 'nx': NX, 'ny': NY,
            'model': 'GFS 0.5°', 'path': f'data/{run}/', 'ranges': RANGES, 'rain': 'sqrt8', 'snow': 'sqrt2',
            'vars': sorted(WANT)}
    tmpm = os.path.join(DATA, 'latest.json.tmp')
    with open(tmpm, 'w') as fh:
        json.dump(meta, fh)
    os.replace(tmpm, os.path.join(DATA, 'latest.json'))
    for d in os.listdir(DATA):
        p = os.path.join(DATA, d)
        if os.path.isdir(p) and d != run:
            shutil.rmtree(p, ignore_errors=True)
    LOG('Run', run, 'is live')
    state['busy'] = False


def current_run():
    try:
        with open(os.path.join(DATA, 'latest.json')) as fh:
            return json.load(fh)['run']
    except Exception:
        return None


def has_all_vars():
    try:
        with open(os.path.join(DATA, 'latest.json')) as fh:
            m = json.load(fh)
        return sorted(m.get('vars', [])) == sorted(WANT) and m.get('steps') == STEPS
    except Exception:
        return False


def updater():
    while True:
        try:
            r = newest_run()
            if r and (r != current_run() or not has_all_vars()):
                build(r)
            state['status'] = 'live ' + str(current_run())
        except Exception:
            state['busy'] = False
            state['status'] = 'error, retrying soon'
            traceback.print_exc()
        time.sleep(20 * 60)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=SITE, **k)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        p = self.path.split('?')[0]
        if p.endswith('.png'):
            self.send_header('Cache-Control', 'public, max-age=86400')
        else:
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, *a):
        pass


if __name__ == '__main__' and '--build-once' in sys.argv:
    os.makedirs(DATA, exist_ok=True)
    r = newest_run()
    if not r:
        sys.exit('No complete GFS run found')
    build(r)
    sys.exit(0)

if __name__ == '__main__':
    os.makedirs(DATA, exist_ok=True)
    threading.Thread(target=updater, daemon=True).start()
    LOG(f'Gustline serving {SITE} on http://127.0.0.1:{PORT}')
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
