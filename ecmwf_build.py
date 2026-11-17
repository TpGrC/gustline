"""Windrova: build map data from the ECMWF IFS open-data forecast (CC BY 4.0).

Uses the 00z / 12z runs (they go out to 240 h), downloads only the fields we need
with HTTP byte ranges, and writes the same greyscale PNG grids as the GFS build to
site/data/ecmwf/<run>/ plus site/data/ecmwf/latest.json.
"""
import os, sys, json, shutil, threading, datetime as dt
import numpy as np
from concurrent.futures import ThreadPoolExecutor
import gustline_server as g

BASES = ['https://data.ecmwf.int/forecasts', 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com']
STEPS = list(range(0, 145, 3)) + list(range(150, 241, 6))
OUT = os.path.join(g.DATA, 'ecmwf')
LOCK = threading.Lock()          # the GRIB decoder is not thread-safe; downloads still run in parallel
ATMOS = ['10u', '10v', '2t', '2d', 'msl', 'tcc', '10fg', 'tprate', 'mucape', 'sd', 'rsn']
WAVE = ['swh', 'mwd', 'pp1d']
VARS = ['u', 'v', 't', 'h', 'p', 'c', 'g', 'r', 'k', 'n', 'w', 'wd', 'wp', 'u8', 'v8', 't8', 'u5', 'v5', 't5', 'u2', 'v2']
UPPER = {('u', '850'): 'u8', ('v', '850'): 'v8', ('t', '850'): 't8', ('u', '500'): 'u5', ('v', '500'): 'v5', ('t', '500'): 't5',
         ('u', '250'): 'u2', ('v', '250'): 'v2'}


def url(base, run, step, stream):
    d, h = run[:8], run[8:]
    kind = 'oper' if stream == 'oper' else 'wave'
    return f'{base}/{d}/{h}z/ifs/0p25/{kind}/{run}0000-{step}h-{kind}-fc'


def get_index(run, step, stream):
    last = None
    for b in BASES:
        try:
            txt = g.http_get(url(b, run, step, stream) + '.index', tries=2).decode()
            return b, [json.loads(l) for l in txt.splitlines() if l.strip()]
        except Exception as e:
            last = e
    raise RuntimeError(f'no index for {run} +{step}h {stream}: {last}')


def run_ready(run):
    try:
        _, idx = get_index(run, 240, 'oper')
        return any(r.get('param') == 'msl' for r in idx)
    except Exception:
        return False


def newest_run():
    now = dt.datetime.now(dt.timezone.utc)
    base = now.replace(minute=0, second=0, microsecond=0, hour=0 if now.hour < 12 else 12)
    for k in range(4):
        r = (base - dt.timedelta(hours=12 * k)).strftime('%Y%m%d%H')
        if run_ready(r):
            return r
    return None


def to_half_degree(h, msg):
    """ECMWF grid is 0.25 deg, lon -180..179.75 -> our 0.5 deg grid starting at lon 0."""
    import eccodes
    with LOCK:
        return _to_half_degree(msg, eccodes)


def _to_half_degree(msg, eccodes):
    a = g.grib_values(msg)
    hh = eccodes.codes_new_from_message(msg)
    try:
        lon0 = eccodes.codes_get(hh, 'longitudeOfFirstGridPointInDegrees')
    finally:
        eccodes.codes_release(hh)
    if lon0 > 90:            # stored as 180..
        lon0 -= 360
    shift = int(round(-lon0 / 0.25))   # columns until lon 0
    a = np.roll(a, -shift, axis=1)
    return a[::2, ::2]


def fetch(run, step, stream, params):
    base, idx = get_index(run, step, stream)
    u = url(base, run, step, stream) + '.grib2'
    out = {}
    for r in idx:
        p = r.get('param')
        key = None
        if r.get('levtype', 'sfc') == 'sfc' and p in params:
            key = p
        elif stream == 'oper' and r.get('levtype') == 'pl':
            key = UPPER.get((p, str(r.get('levelist'))))
        if key and key not in out:
            start = int(r['_offset']); end = start + int(r['_length']) - 1
            out[key] = to_half_degree(None, g.http_range(u, start, end))
    return out


def fields(run, step):
    f = fetch(run, step, 'oper', ATMOS)
    try:
        f.update(fetch(run, step, 'wave', WAVE))
    except Exception as e:
        g.LOG(f'  ecmwf +{step}h waves unavailable ({e})')
    o = {}
    if '10u' in f: o['u'] = f['10u']
    if '10v' in f: o['v'] = f['10v']
    if '2t' in f: o['t'] = f['2t']
    if 'msl' in f: o['p'] = f['msl']
    if 'tcc' in f: o['c'] = f['tcc'] * 100.0
    if '10fg' in f: o['g'] = f['10fg']
    if 'tprate' in f: o['r'] = f['tprate']                  # kg m-2 s-1 = mm/s
    if 'mucape' in f: o['k'] = f['mucape']
    if '2t' in f and '2d' in f:
        t, d = f['2t'] - 273.15, f['2d'] - 273.15
        o['h'] = 100 * np.exp(17.625 * d / (243.04 + d)) / np.exp(17.625 * t / (243.04 + t))
    if 'sd' in f:
        rho = np.where(np.nan_to_num(f.get('rsn', 300.0)) > 50, np.nan_to_num(f.get('rsn', 300.0)), 300.0)
        o['n'] = np.nan_to_num(f['sd']) * 1000.0 / rho      # m of water -> m of snow
    if 'swh' in f: o['w'] = f['swh']
    if 'mwd' in f: o['wd'] = f['mwd']
    if 'pp1d' in f: o['wp'] = f['pp1d']
    for k in UPPER.values():
        if k in f: o[k] = f[k]
    return o


def build(run):
    out_dir = os.path.join(OUT, run)
    tmp = out_dir + '.part'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    g.LOG('Building ECMWF run', run)
    have = set()

    def one(s):
        o = fields(run, s)
        for name in VARS:
            a = o.get(name)
            img = g.encode(name, a) if a is not None else np.zeros((g.NY, g.NX), np.uint8)
            if img.shape != (g.NY, g.NX):
                raise RuntimeError(f'unexpected grid {name} {img.shape}')
            g.png_gray(os.path.join(tmp, f'{name}_{s:03d}.png'), img)
        have.update(o)
        g.LOG(f'  ecmwf +{s:03d}h ok ({", ".join(sorted(o))})')

    with ThreadPoolExecutor(4) as ex:
        list(ex.map(one, STEPS))
    shutil.rmtree(out_dir, ignore_errors=True)
    os.replace(tmp, out_dir)
    rt = dt.datetime.strptime(run, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
    meta = {'run': run, 'runTime': int(rt.timestamp()), 'steps': STEPS, 'nx': g.NX, 'ny': g.NY,
            'model': 'ECMWF IFS', 'path': f'data/ecmwf/{run}/', 'ranges': g.RANGES,
            'vars': sorted(v for v in VARS if v in have), 'waves': 'w' in have}
    with open(os.path.join(OUT, 'latest.json'), 'w') as fh:
        json.dump(meta, fh)
    for d in os.listdir(OUT):
        p = os.path.join(OUT, d)
        if os.path.isdir(p) and d != run:
            shutil.rmtree(p, ignore_errors=True)
    g.LOG('ECMWF run', run, 'is live with', meta['vars'])


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1] == '--test':          # quick local check: 2 steps
        STEPS[:] = [0, 24]
    r = newest_run()
    if not r:
        sys.exit('No complete ECMWF run found')
    build(r)
