// Windrova API relay (Cloudflare Worker, free plan).
// - /met?lat=..&lon=..      MET Norway forecast, identified + cached 10 min (shared by all visitors)
// - /flights?lat=..&lon=..  live aircraft from adsb.lol (ODbL), cached 10 s
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

    return new Response('Windrova API', { status: 404 });
  },
};
