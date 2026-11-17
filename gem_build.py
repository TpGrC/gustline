"""Windrova: build map data from Canada's GEM global model (GDPS, 15 km).
Data: Meteorological Service of Canada (MSC) Datamart, Open Government Licence - Canada (commercial use allowed).
Uses the 00z / 12z runs (out to 240 h), regrids 0.15 deg -> our 0.5 deg grid and writes PNGs like the GFS build
to site/data/gem/<run>/ plus site/data/gem/latest.json.
"""
import os, sys, re, json, shutil, threading, datetime as dt
import numpy as np
from concurrent.futures import ThreadPoolExecutor
import gustline_server as g

BASE = 'https://dd.weather.gc.ca'
STEPS = list(range(0, 145, 3)) + list(range(150, 241, 6))
OUT = os.path.join(g.DATA, 'gem')
LOCK = threading.Lock()
# our variable -> test on the file's "<Var>_<Level>" part (lower-case)
WANT = {
    'u': lambda n: n == 'windu_agl-10m', 'v': lambda n: n == 'windv_agl-10m',
    't': lambda n: n == 'airtemp_agl-2m', 'p': lambda n: n == 'pressure_msl',
    'r': lambda n: n == 'preciprate_sfc', 'g': lambda n: n == 'windgust_agl-10m',
    'h': lambda n: n == 'relativehumidity_agl-2m', 'k': lambda n: n == 'cape_sfc',
    'n': lambda n: n == 'snowdepth_sfc',
    'c': lambda n: ('cloud' in n and ('total' in n or 'cover' in n) and ('eatm' in n or 'sfc' in n)),
    'u8': lambda n: n.startswith('windu_') and '0850' in n and 'isbl' in n, 'v8': lambda n: n.startswith('windv_') and '0850' in n and 'isbl' in n,
    't8': lambda n: n.startswith('airtemp_') and '0850' in n and 'isbl' in n,
    'u5': lambda n: n.startswith('windu_') and '0500' in n and 'isbl' in n, 'v5': lambda n: n.startswith('windv_') and '0500' in n and 'isbl' in n,
    't5': lambda n: n.startswith('airtemp_') and '0500' in n and 'isbl' in n,
    'u2': lambda n: n.startswith('windu_') and '0250' in n and 'isbl' in n, 'v2': lambda n: n.startswith('windv_') and '0250' in n and 'isbl' in n,
}


def step_dir(run, step):
    return f'{BASE}/{run[:8]}/WXO-DD/model_gdps/15km/{run[8:]}/{step:03d}/'


def listing(run, step):
    html = g.http_get(step_dir(run, step), tries=2).decode('utf8', 'ignore')
    files = sorted(set(re.findall(r'href="([^"]+\.grib2)"', html)))
    out = {}
    for f in files:
        m = re.match(r'.*_MSC_GDPS_(.+)_LatLon[0-9.]+_PT\d+H\.grib2$', f)
        if m:
            out[m.group(1).lower()] = f
    return out


def run_ready(run):
    try:
        return any(k == 'pressure_msl' for k in listing(run, 240))
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


def regrid(msg):
    """Any regular lat/lon GRIB grid -> our 0.5 deg grid (lat 90..-90, lon 0..359.5), nearest point."""
    import eccodes
    with LOCK:
        h = eccodes.codes_new_from_message(msg)
        try:
            ni, nj = eccodes.codes_get(h, 'Ni'), eccodes.codes_get(h, 'Nj')
            la0, lo0 = eccodes.codes_get(h, 'latitudeOfFirstGridPointInDegrees'), eccodes.codes_get(h, 'longitudeOfFirstGridPointInDegrees')
            dj, di = eccodes.codes_get(h, 'jDirectionIncrementInDegrees'), eccodes.codes_get(h, 'iDirectionIncrementInDegrees')
            jpos = eccodes.codes_get(h, 'jScansPositively')
            vals = eccodes.codes_get_values(h).reshape(nj, ni)
            miss = eccodes.codes_get(h, 'missingValue')
            units = eccodes.codes_get(h, 'units')
        finally:
            eccodes.codes_release(h)
    vals = np.where(vals == miss, np.nan, vals)
    lat = 90 - np.arange(g.NY) * 0.5
    lon = np.arange(g.NX) * 0.5
    jj = np.clip(np.round(((lat - la0) / dj) if jpos else ((la0 - lat) / dj)).astype(int), 0, nj - 1)
    ii = np.round(((lon - lo0) % 360) / di).astype(int) % ni
    return vals[jj][:, ii], units


def fields(run, step, names):
    out, units = {}, {}
    base = step_dir(run, step)
    for var, test in WANT.items():
        key = next((k for k in names if test(k)), None)
        if key:
            a, u = regrid(g.http_get(base + names[key], tries=3))
            out[var], units[var] = a, u
    # unit fixes to match the GFS encoding (t in K, p in Pa, r in kg m-2 s-1, n in m, c in %)
    for k in ('t', 't8', 't5'):
        if k in out and np.nanmean(out[k]) < 150:
            out[k] = out[k] + 273.15
    if 'p' in out and np.nanmean(out['p']) < 2000:
        out['p'] = out['p'] * 100
    if 'c' in out and np.nanmax(out['c']) <= 1.01:
        out['c'] = out['c'] * 100
    if 'r' in out and units.get('r', '').startswith('m s'):
        out['r'] = out['r'] * 1000.0
    return out, units


def build(run):
    out_dir = os.path.join(OUT, run)
    tmp = out_dir + '.part'
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    g.LOG('Building GEM run', run)
    names0 = listing(run, 24)
    have = set()

    def one(s):
        names = listing(run, s)
        o, units = fields(run, s, names)
        for name in WANT:
            a = o.get(name)
            img = g.encode(name, a) if a is not None else np.zeros((g.NY, g.NX), np.uint8)
            g.png_gray(os.path.join(tmp, f'{name}_{s:03d}.png'), img)
        have.update(o)
        g.LOG(f'  gem +{s:03d}h ok ({", ".join(sorted(o))})' + (f' units={units}' if s in (0, 24) else ''))

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, STEPS))
    shutil.rmtree(out_dir, ignore_errors=True)
    os.replace(tmp, out_dir)
    rt = dt.datetime.strptime(run, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
    meta = {'run': run, 'runTime': int(rt.timestamp()), 'steps': STEPS, 'nx': g.NX, 'ny': g.NY,
            'model': 'GEM 15 km', 'path': f'data/gem/{run}/', 'ranges': g.RANGES,
            'vars': sorted(v for v in WANT if v in have), 'waves': False}
    with open(os.path.join(OUT, 'latest.json'), 'w') as fh:
        json.dump(meta, fh)
    for d in os.listdir(OUT):
        p = os.path.join(OUT, d)
        if os.path.isdir(p) and d != run:
            shutil.rmtree(p, ignore_errors=True)
    g.LOG('GEM run', run, 'is live with', meta['vars'])


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        STEPS[:] = [0, 24]
    r = newest_run()
    if not r:
        sys.exit('No complete GEM run found')
    build(r)
