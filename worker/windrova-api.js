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

/* ---------- planes: adsb.lol limits how often we may ask, so everyone shares one answer per 1° square,
   and if adsb.lol says "slow down" we keep showing the last good answer ---------- */
async function flights(req, env, ctx, la, lo) {
  const cache = caches.default, key = `https://cache.windrova/fl2/${la}/${lo}`;
  const ok = (body, age) => cors(req, new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Age': String(age) } }));
  const fresh = await cache.match(new Request(key + '/fresh'));
  if (fresh) return ok(await fresh.text(), 0);
  const stale = await cache.match(new Request(key + '/stale'));
  const busy = await cache.match(new Request(key + '/busy'));
  const load = async () => {
    await cache.put(new Request(key + '/busy'), new Response('1', { headers: { 'Cache-Control': 'public, max-age=10' } }));
    // FlyItalyADSB (free key, commercial use allowed, CC BY-SA 4.0) first; adsb.lol (ODbL) as backup
    let r = null;
    if (env.FLYITALY_KEY) r = await fetch(`https://api.flyitalyadsb.com/v2/lat/${la}/lon/${lo}/dist/460`, { headers: { 'User-Agent': UA, 'X-Api-Key': String(env.FLYITALY_KEY).trim() } }).catch(() => null);
    if (!r || !r.ok) r = await fetch(`https://api.adsb.lol/v2/lat/${la}/lon/${lo}/dist/250`, { headers: { 'User-Agent': UA } });
    if (!r.ok) {
      // told to slow down: wait a minute before asking again
      await cache.put(new Request(key + '/busy'), new Response('1', { headers: { 'Cache-Control': 'public, max-age=60' } }));
      throw new Error('upstream ' + r.status);
    }
    const body = await r.text();
    await cache.put(new Request(key + '/fresh'), new Response(body, { headers: { 'Cache-Control': 'public, max-age=20' } }));
    await cache.put(new Request(key + '/stale'), new Response(body, { headers: { 'Cache-Control': 'public, max-age=900' } }));
    return body;
  };
  if (stale) { if (!busy) ctx.waitUntil(load().catch(() => { })); return ok(await stale.text(), 1); }
  if (busy) return ok('{"ac":[]}', 2);
  try { return ok(await load(), 0); } catch (e) { return ok('{"ac":[]}', 3); }
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


/* ================= Private dashboard (/admin) — only for the owner ================= */
const CHECKS = [
  { id: 'windrova', name: 'Windrova website', url: 'https://windrova.com/' },
  { id: 'gfs', name: 'Windrova forecast data · GFS', url: 'https://windrova.com/data/latest.json', fresh: true },
  { id: 'ecmwf', name: 'Windrova forecast data · ECMWF', url: 'https://windrova.com/data/ecmwf/latest.json', fresh: true },
  { id: 'gem', name: 'Windrova forecast data · GEM', url: 'https://windrova.com/data/gem/latest.json', fresh: true },
  { id: 'met', name: 'MET Norway (place forecasts source)', url: 'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=38&lon=23' },
  { id: 'halewood', name: 'Halewood Systems website', url: 'https://halewoodsystems.com/' },
  { id: 'slipgate', name: 'Slipgate (itch.io)', url: 'https://halewood-systems.itch.io/slipgate' },
];

async function runCheck(c) {
  const t0 = Date.now();
  try {
    const r = await fetch(c.url + (c.url.includes('?') ? '&' : '?') + 'nocache=' + t0, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } });
    const ms = Date.now() - t0;
    const out = { id: c.id, name: c.name, url: c.url, code: r.status, ms, state: r.ok ? 'up' : 'down', note: r.ok ? '' : 'HTTP ' + r.status };
    if (r.ok && c.fresh) {
      const j = await r.json();
      const age = (Date.now() / 1000 - (j.runTime || 0)) / 3600;
      out.note = `model run ${j.run || '?'} · ${age.toFixed(1)} h old`;
      out.age = age;
      if (age > 18) out.state = 'down'; else if (age > 10) out.state = 'warn';
    } else if (ms > 4000 && out.state === 'up') { out.state = 'warn'; out.note = 'slow'; }
    return out;
  } catch (e) { return { id: c.id, name: c.name, url: c.url, state: 'down', ms: Date.now() - t0, note: String(e) }; }
}

async function lastWorkflow(env) {
  try {
    const h = { 'User-Agent': UA, Accept: 'application/vnd.github+json' };
    if (env.GH_TOKEN) h.Authorization = 'Bearer ' + String(env.GH_TOKEN).trim();
    const r = await fetch('https://api.github.com/repos/TpGrC/gustline/actions/workflows/forecast.yml/runs?per_page=5', { headers: h });
    if (!r.ok) return { error: 'GitHub ' + r.status };
    const j = await r.json();
    return { runs: (j.workflow_runs || []).map(x => ({ when: x.created_at, event: x.event, status: x.status, result: x.conclusion, url: x.html_url })) };
  } catch (e) { return { error: String(e) }; }
}

async function traffic(env) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return { setup: true };
  const q = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
    hosts:rumPageloadEventsAdaptiveGroups(limit:20,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count sum{visits} dimensions{requestHost}}
    countries:rumPageloadEventsAdaptiveGroups(limit:10,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count dimensions{countryName}}
    pages:rumPageloadEventsAdaptiveGroups(limit:10,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count dimensions{requestHost requestPath}}
    refs:rumPageloadEventsAdaptiveGroups(limit:10,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count dimensions{refererHost}}
  }}}`;
  const ask = async (hours) => {
    const e = new Date(), s = new Date(e - hours * 3600e3);
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + String(env.CF_API_TOKEN).trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { a: String(env.CF_ACCOUNT_ID).trim(), s: s.toISOString(), e: e.toISOString() } }) });
    const j = await r.json();
    if (j.errors && j.errors.length) throw new Error(j.errors.map(x => x.message).join('; '));
    return j.data.viewer.accounts[0];
  };
  try { const [d1, d7] = await Promise.all([ask(24), ask(24 * 7)]); return { d1, d7 }; } catch (e) { return { error: String(e) }; }
}

function authOk(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = req.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  try { const [, pw] = atob(h.slice(6)).split(':'); return pw === String(env.ADMIN_PASSWORD).trim(); } catch (e) { return false; }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function adminPage(req, env) {
  if (!env.ADMIN_PASSWORD) return new Response('Set the ADMIN_PASSWORD secret first.', { status: 503 });
  if (!authOk(req, env)) return new Response('Login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Halewood dashboard"' } });
  const [checks, wf, tr] = await Promise.all([Promise.all(CHECKS.map(runCheck)), lastWorkflow(env), traffic(env)]);
  const bad = checks.filter(c => c.state !== 'up');
  const report = bad.length ? `Halewood dashboard problem report (${new Date().toISOString()}):\n` + bad.map(c => `- ${c.name}: ${c.state.toUpperCase()} ${c.note || ''} (${c.url}, HTTP ${c.code ?? '-'}, ${c.ms} ms)`).join('\n') +
    (wf.runs ? `\nLast forecast workflow runs:\n` + wf.runs.map(r => `  ${r.when} ${r.event} ${r.status}/${r.result}`).join('\n') : '') : '';
  const dot = s => s === 'up' ? '#2fd27a' : s === 'warn' ? '#ffbe3c' : '#ff5a5a';
  const rows = checks.map(c => `<tr><td><span class="d" style="background:${dot(c.state)}"></span>${esc(c.name)}</td><td>${c.state === 'up' ? 'Operational' : c.state === 'warn' ? 'Warning' : 'DOWN'}</td><td>${esc(c.note)}</td><td class="r">${c.ms} ms</td></tr>`).join('');
  const wfRows = wf.runs ? wf.runs.map(r => `<tr><td>${esc(new Date(r.when).toLocaleString('en-GB', { timeZone: 'Europe/Athens' }))}</td><td>${esc(r.event)}</td><td style="color:${r.result === 'success' ? '#2fd27a' : r.status !== 'completed' ? '#ffbe3c' : '#ff5a5a'}">${esc(r.result || r.status)}</td></tr>`).join('') : `<tr><td colspan="3">${esc(wf.error)}</td></tr>`;
  let traf;
  if (tr.setup) traf = `<p class="m">Visitor counting isn't connected yet. Add the CF_API_TOKEN and CF_ACCOUNT_ID secrets (see setup notes).</p>`;
  else if (tr.error) traf = `<p class="m">Couldn't load traffic: ${esc(tr.error)}</p>`;
  else {
    const sum = (a, host) => (a.hosts || []).filter(x => !host || x.dimensions.requestHost.replace(/^www\./, '') === host).reduce((t, x) => [t[0] + x.count, t[1] + (x.sum.visits || 0)], [0, 0]);
    const card = (label, host) => { const a = sum(tr.d1, host), b = sum(tr.d7, host); return `<div class="k"><b>${label}</b><div class="big">${b[1]}</div><div class="m">visits · 7 days</div><div class="m">${a[1]} visits · ${a[0]} page views today (24 h)</div></div>`; };
    const list = (arr, f) => (arr || []).map(x => `<tr><td>${esc(f(x.dimensions) || '(direct)')}</td><td class="r">${x.count}</td></tr>`).join('') || '<tr><td class="m">No data yet</td></tr>';
    traf = `<div class="kp">${card('All sites')}${card('windrova.com', 'windrova.com')}${card('halewoodsystems.com', 'halewoodsystems.com')}</div>
      <div class="two"><div><h3>Top pages · 7 days</h3><table>${list(tr.d7.pages, d => d.requestHost + d.requestPath)}</table></div>
      <div><h3>Countries · 7 days</h3><table>${list(tr.d7.countries, d => d.countryName)}</table></div>
      <div><h3>Where visitors came from · 7 days</h3><table>${list(tr.d7.refs, d => d.refererHost)}</table></div></div>`;
  }
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="120"><title>Halewood dashboard</title>
<style>body{margin:0;background:#07090d;color:#e9eef5;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:1100px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:24px;margin:0}h2{font-size:18px;margin:34px 0 12px}h3{font-size:14px;color:#8a97a8;margin:18px 0 8px;font-weight:600}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.m{color:#8a97a8;font-size:13px}
.sum{margin-top:18px;padding:16px 18px;border-radius:12px;font-weight:600}.ok{background:rgba(47,210,122,.12);color:#2fd27a}.bad{background:rgba(255,90,90,.12);color:#ff8080}
table{width:100%;border-collapse:collapse;background:#11161e;border:1px solid #1e2632;border-radius:12px;overflow:hidden}td{padding:11px 14px;border-bottom:1px solid #1e2632;vertical-align:top}tr:last-child td{border:0}.r{text-align:right;white-space:nowrap}
.d{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:10px}.scroll{overflow-x:auto}
.kp{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.k{background:#11161e;border:1px solid #1e2632;border-radius:12px;padding:16px}.big{font-size:34px;font-weight:800}
.two{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}
button{background:#2f7bff;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:600;font-size:15px;cursor:pointer;min-height:44px}pre{white-space:pre-wrap;background:#11161e;border:1px solid #1e2632;border-radius:12px;padding:14px;font-size:13px;color:#c9d3df}
a{color:#7fb0ff}</style></head><body><main>
<div class="top"><div><h1>Halewood dashboard</h1><div class="m">Checked ${new Date().toLocaleString('en-GB', { timeZone: 'Europe/Athens' })} (Athens) · refreshes every 2 minutes</div></div><a href="">Refresh now</a></div>
<div class="sum ${bad.length ? 'bad' : 'ok'}">${bad.length ? `⚠ ${bad.length} problem${bad.length > 1 ? 's' : ''} found` : '✓ All systems operational'}</div>
${bad.length ? `<h2>Fix it with AI</h2><p class="m">Copy this report and paste it to Claude.</p><pre id="rep">${esc(report)}</pre><button onclick="navigator.clipboard.writeText(document.getElementById('rep').textContent).then(()=>this.textContent='Copied ✓')">Copy problem report</button>` : ''}
<h2>Status</h2><div class="scroll"><table>${rows}</table></div>
<h2>Traffic</h2>${traf}
<h2>Windrova forecast updates (GitHub)</h2><div class="scroll"><table>${wfRows}</table></div>
<p class="m" style="margin-top:30px">Only you can open this page (password protected).</p>
</main></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

/* Cron: GitHub sometimes skips scheduled runs. If the forecast is getting old, start the update ourselves. */
async function watchdog(env) {
  if (!env.GH_TOKEN) return;
  try {
    const r = await fetch('https://windrova.com/data/latest.json?nocache=' + Date.now(), { headers: { 'User-Agent': UA } });
    const j = await r.json();
    const age = (Date.now() / 1000 - j.runTime) / 3600;
    if (age < 10.5) return;
    const w = await lastWorkflow(env);
    if (w.runs && w.runs.some(x => x.status !== 'completed')) return;   // one is already running
    await fetch('https://api.github.com/repos/TpGrC/gustline/actions/workflows/forecast.yml/dispatches', {
      method: 'POST', headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + String(env.GH_TOKEN).trim() },
      body: JSON.stringify({ ref: 'main' }) });
  } catch (e) { }
}

const num = (v, lo, hi) => { const n = parseFloat(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(watchdog(env)); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(req, new Response(null, { headers: { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } }));
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    if (url.pathname === '/health') return cors(req, new Response('ok'));
    if (url.pathname === '/admin') return adminPage(req, env);

    if (url.pathname === '/met') {
      const lat = num(url.searchParams.get('lat'), -90, 90), lon = num(url.searchParams.get('lon'), -180, 180);
      if (lat === null || lon === null) return new Response('bad lat/lon', { status: 400 });
      // MET Norway asks for max 4 decimals; 2 decimals (~1 km) lets nearby visitors share the cache
      const la = lat.toFixed(2), lo = lon.toFixed(2);
      return cached(req, ctx, `met/${la}/${lo}`, `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${la}&lon=${lo}`, 600);
    }

    if (url.pathname === '/flights') {
      const lat = num(url.searchParams.get('lat'), -90, 90), lon = num(url.searchParams.get('lon'), -180, 180);
      if (lat === null || lon === null) return new Response('bad lat/lon', { status: 400 });
      return flights(req, env, ctx, Math.round(lat), Math.round(lon));
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
