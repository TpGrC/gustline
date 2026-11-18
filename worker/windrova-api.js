// Windrova API relay (Cloudflare Worker, free plan).
// - /met?lat=..&lon=..      MET Norway forecast, identified + cached 10 min (shared by all visitors)
// - /flights?lat=..&lon=..  live aircraft from adsb.lol (ODbL), cached 10 s
// - /ships?s=..&w=..&n=..&e=..  live ships from aisstream.io (needs secret AISSTREAM_KEY), merged + cached 60 s
// - /health                 quick check
const ALLOW = ['https://windrova.com', 'https://www.windrova.com', 'http://127.0.0.1:8799'];
const UA = 'Windrova/2.3 (+https://windrova.com; github.com/TpGrC/gustline)';

function cors(req, res) {
  const o = req.headers.get('Origin') || '';
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', ALLOW.includes(o) ? o : 'https://windrova.com');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}

/* ---------- ships: listen to the aisstream.io live feed for a few seconds, merge with what we saw before ---------- */
async function listenAIS(key, box, ms = 8000, max = 600, dbg = null) {
  const resp = await fetch('https://stream.aisstream.io/v0/stream', { headers: { Upgrade: 'websocket' } });
  const ws = resp.webSocket;
  if (dbg) dbg.status = resp.status;
  if (!ws) throw new Error('no websocket (HTTP ' + resp.status + ')');
  const seen = new Map();
  const dec = new TextDecoder();
  const done = new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    const stop = () => { clearTimeout(timer); resolve(); };
    ws.addEventListener('message', async ev => {
      try {
        const d = ev.data;
        const txt = typeof d === 'string' ? d : dec.decode(new Uint8Array(d.arrayBuffer ? await d.arrayBuffer() : d));
        if (dbg) { dbg.events = (dbg.events || 0) + 1; if (!dbg.first) dbg.first = txt.slice(0, 160); dbg.kind = typeof d === 'string' ? 'string' : (d && d.constructor && d.constructor.name); }
        const m = JSON.parse(txt);
        const md = m.MetaData || {}, id = md.MMSI; if (!id) return;
        const o = seen.get(id) || { id };
        o.n = (md.ShipName || o.n || '').trim(); o.t = Date.now();
        const pr = m.Message && (m.Message.PositionReport || m.Message.StandardClassBPositionReport);
        if (pr) { o.la = +(+md.latitude).toFixed(4); o.lo = +(+md.longitude).toFixed(4); o.sog = pr.Sog; o.cog = pr.Cog; o.hd = pr.TrueHeading; }
        const st = m.Message && m.Message.ShipStaticData;
        if (st) { o.ty = st.Type; o.dst = (st.Destination || '').trim(); }
        seen.set(id, o);
        if (seen.size >= max) stop();
      } catch (e) { if (dbg) dbg.parseErr = String(e); }
    });
    ws.addEventListener('close', ev => { if (dbg) { dbg.closeCode = ev.code; dbg.closeReason = ev.reason; } stop(); });
    ws.addEventListener('error', ev => { if (dbg) dbg.wsErr = String(ev.message || ev); stop(); });
  });
  ws.accept();
  ws.send(JSON.stringify({ APIKey: String(key).trim(), BoundingBoxes: [box], FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ShipStaticData'] }));
  await done;
  try { ws.close(1000, 'done'); } catch (e) { }
  return seen;
}

async function ships(req, env, ctx, s, w, n, e, debug) {
  if (debug) {
    const dbg = {};
    try { const got = await listenAIS(env.AISSTREAM_KEY || '', [[s, w], [n, e]], 8000, 600, dbg); dbg.ships = got.size; } catch (err) { dbg.error = String(err); }
    dbg.hasKey = !!env.AISSTREAM_KEY;
    return cors(req, new Response(JSON.stringify(dbg), { headers: { 'Content-Type': 'application/json' } }));
  }
  if (!env.AISSTREAM_KEY) return cors(req, new Response(JSON.stringify({ error: 'no key' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
  // The free AIS feed is sparse, so each map tile keeps every ship seen in the last 90 minutes
  // and all visitors share it. Answer at once from what we have; top it up in the background.
  const cache = caches.default, key = `https://cache.windrova/ships3/${s}/${w}/${n}/${e}`;
  const KEEP = 90 * 60 * 1000;
  const load = async () => { const r = await cache.match(new Request(key + '/all')); const m = new Map(); if (r) for (const o of await r.json()) if (Date.now() - o.t < KEEP) m.set(o.id, o); return m; };
  const refresh = async () => {
    await cache.put(new Request(key + '/busy'), new Response('1', { headers: { 'Cache-Control': 'public, max-age=45' } }));
    const got = await listenAIS(env.AISSTREAM_KEY, [[s, w], [n, e]], 15000, 3000);
    const list = await load();
    for (const [id, o] of got) list.set(id, Object.assign(list.get(id) || {}, o));
    const arr = [...list.values()].filter(o => o.la != null);
    await cache.put(new Request(key + '/all'), new Response(JSON.stringify(arr), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=10800' } }));
    return arr;
  };
  const busy = await cache.match(new Request(key + '/busy'));
  let arr = [...(await load()).values()].filter(o => o.la != null);
  if (!arr.length && !busy) { try { arr = await refresh(); } catch (err) { } }
  else if (!busy) ctx.waitUntil(refresh().catch(() => { }));
  return cors(req, new Response(JSON.stringify(arr), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }));
}

async function cached(req, ctx, key, upstream, ttl, init = {}) {
  const cache = caches.default;
  const ck = new Request('https://cache.windrova/' + key);
  let res = await cache.match(ck);
  if (!res) {
    const r = await fetch(upstream, { headers: { 'User-Agent': UA, ...(init.headers || {}) } });
    if (!r.ok) return new Response(JSON.stringify({ error: r.status }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    res = new Response(r.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` } });
    ctx.waitUntil(cache.put(ck, res.clone()));
  }
  return cors(req, res);
}

const num = (v, lo, hi) => { const n = parseFloat(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(req, new Response(null, { headers: { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } }));
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    if (url.pathname === '/health') return cors(req, new Response('ok'));

    if (url.pathname === '/met') {
      const lat = num(url.searchParams.get('lat'), -90, 90), lon = num(url.searchParams.get('lon'), -180, 180);
      if (lat === null || lon === null) return new Response('bad lat/lon', { status: 400 });
      // MET Norway asks for max 4 decimals; 2 decimals (~1 km) lets nearby visitors share the cache
      const la = lat.toFixed(2), lo = lon.toFixed(2);
      return cached(req, ctx, `met/${la}/${lo}`, `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${la}&lon=${lo}`, 600);
    }

    if (url.pathname === '/flights') {
      const lat = num(url.searchParams.get('lat'), -90, 90), lon = num(url.searchParams.get('lon'), -180, 180);
      const dist = Math.min(250, Math.max(10, parseInt(url.searchParams.get('dist') || '150')));
      if (lat === null || lon === null) return new Response('bad lat/lon', { status: 400 });
      const la = lat.toFixed(1), lo = lon.toFixed(1);
      return cached(req, ctx, `fl/${la}/${lo}/${dist}`, `https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/${dist}`, 10);
    }

    if (url.pathname === '/ships') {
      const q = k => Math.round(parseFloat(url.searchParams.get(k)));
      let s = q('s'), w = q('w'), n = q('n'), e = q('e');
      if (![s, w, n, e].every(isFinite) || n <= s || e <= w || n - s > 20 || e - w > 20) return new Response('bad box (max 12x16 degrees)', { status: 400 });
      return ships(req, env, ctx, Math.max(-90, s), Math.max(-180, w), Math.min(90, n), Math.min(180, e), url.searchParams.has('debug'));
    }

    return new Response('Windrova API', { status: 404 });
  },
};
