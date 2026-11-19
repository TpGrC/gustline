// Windrova API relay (Cloudflare Worker, free plan).
// - /met?lat=..&lon=..      MET Norway forecast, identified + cached 10 min (shared by all visitors)
// - /admin                  private dashboard (needs secret ADMIN_PASSWORD)
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


/* ================= Private dashboard (/admin) — only for the owner ================= */
const CHECKS = [
  { id: 'windrova', name: 'Windrova website', url: 'https://windrova.com/' },
  { id: 'gfs', name: 'Windrova forecast data · GFS', url: 'https://windrova.com/data/latest.json', fresh: [12, 18] },
  { id: 'ecmwf', name: 'Windrova forecast data · ECMWF', url: 'https://windrova.com/data/ecmwf/latest.json', fresh: [22, 30] },
  { id: 'gem', name: 'Windrova forecast data · GEM', url: 'https://windrova.com/data/gem/latest.json', fresh: [22, 30] },
  { id: 'met', name: 'MET Norway (place forecasts source)', url: 'https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=38&lon=23' },
  { id: 'halewood', name: 'Halewood Systems website', url: 'https://halewoodsystems.com/' },
  { id: 'slipgate', name: 'Slipgate (itch.io)', url: 'https://halewood-systems.itch.io/slipgate' },
];

async function runCheck(c) {
  const t0 = Date.now();
  try {
    const r = await fetch(c.url.includes('?') ? c.url : c.url + '?nocache=' + t0, { headers: { 'User-Agent': UA }, cf: { cacheTtl: 0 } });
    const ms = Date.now() - t0;
    const out = { id: c.id, name: c.name, url: c.url, code: r.status, ms, state: r.ok ? 'up' : 'down', note: r.ok ? '' : 'HTTP ' + r.status };
    // 429 / 403 = the site answered but limits automatic checks (itch.io does this): it's online
    if (r.status === 429 || r.status === 403) { out.state = 'up'; out.note = 'online (site limits automatic checks)'; }
    if (r.ok && c.fresh) {
      const j = await r.json();
      const age = (Date.now() / 1000 - (j.runTime || 0)) / 3600;
      out.note = `model run ${j.run || '?'} · ${age.toFixed(1)} h old`;
      out.age = age;
      if (age > c.fresh[1]) out.state = 'down'; else if (age > c.fresh[0]) out.state = 'warn';
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
  const ACC = env.CF_ACCOUNT_ID || 'e2e39f7d447e8d78abfea9d4b2d7ec83';
  if (!env.CF_API_TOKEN) return { setup: true };
  const q = `query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){
    hosts:rumPageloadEventsAdaptiveGroups(limit:20,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count sum{visits} dimensions{requestHost}}
    countries:rumPageloadEventsAdaptiveGroups(limit:10,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count dimensions{countryName}}
    pages:rumPageloadEventsAdaptiveGroups(limit:10,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count dimensions{requestHost requestPath}}
    refs:rumPageloadEventsAdaptiveGroups(limit:10,filter:{datetime_geq:$s,datetime_lt:$e},orderBy:[count_DESC]){count dimensions{refererHost}}
  }}}`;
  const ask = async (hours) => {
    const e = new Date(), s = new Date(e - hours * 3600e3);
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + String(env.CF_API_TOKEN).trim(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, variables: { a: String(ACC).trim(), s: s.toISOString(), e: e.toISOString() } }) });
    const j = await r.json();
    if (j.errors && j.errors.length) throw new Error(j.errors.map(x => x.message).join('; '));
    return j.data.viewer.accounts[0];
  };
  try { const [d1, d7] = await Promise.all([ask(24), ask(24 * 7)]); return { d1, d7 }; } catch (e) { return { error: String(e) }; }
}


async function earnings(env) {
  if (!env.STRIPE_KEY) return { setup: true };
  const h = { Authorization: 'Bearer ' + String(env.STRIPE_KEY).trim() };
  try {
    const since = Math.floor(Date.now() / 1000) - 30 * 86400;
    const [b, c] = await Promise.all([
      fetch('https://api.stripe.com/v1/balance', { headers: h }).then(r => r.json()),
      fetch('https://api.stripe.com/v1/charges?limit=100&created[gte]=' + since, { headers: h }).then(r => r.json()),
    ]);
    if (b.error) throw new Error(b.error.message);
    if (c.error) throw new Error(c.error.message);
    const paid = (c.data || []).filter(x => x.paid && !x.refunded);
    const eur = a => (a / 100).toLocaleString('en-GB', { style: 'currency', currency: 'EUR' });
    const sum = arr => arr.reduce((t, x) => t + x.amount, 0);
    const week = paid.filter(x => x.created > Date.now() / 1000 - 7 * 86400);
    return {
      available: eur(sum((b.available || []).filter(x => x.currency === 'eur'))),
      pending: eur(sum((b.pending || []).filter(x => x.currency === 'eur'))),
      d30: eur(sum(paid)), n30: paid.length, d7: eur(sum(week)), n7: week.length,
      last: paid.slice(0, 8).map(x => ({ when: x.created, amount: eur(x.amount), what: x.description || (x.metadata && x.metadata.product) || 'Payment' })),
    };
  } catch (e) { return { error: String(e) }; }
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
  const [checks, wf, tr, money, kl] = await Promise.all([Promise.all(CHECKS.map(runCheck)), lastWorkflow(env), traffic(env), earnings(env), kyro(env, 'list').then(r => r.json()).catch(e => ({ error: String(e) }))]);
  const bad = checks.filter(c => c.state !== 'up');
  const report = bad.length ? `Halewood dashboard problem report (${new Date().toISOString()}):\n` + bad.map(c => `- ${c.name}: ${c.state.toUpperCase()} ${c.note || ''} (${c.url}, HTTP ${c.code ?? '-'}, ${c.ms} ms)`).join('\n') +
    (wf.runs ? `\nLast forecast workflow runs:\n` + wf.runs.map(r => `  ${r.when} ${r.event} ${r.status}/${r.result}`).join('\n') : '') : '';
  const dot = s => s === 'up' ? '#2fd27a' : s === 'warn' ? '#ffbe3c' : '#ff5a5a';
  const rows = checks.map(c => `<tr><td><span class="d" style="background:${dot(c.state)}"></span>${esc(c.name)}</td><td>${c.state === 'up' ? 'Operational' : c.state === 'warn' ? 'Warning' : 'DOWN'}</td><td>${esc(c.note)}</td><td class="r">${c.ms} ms</td></tr>`).join('');
  const wfRows = wf.runs ? wf.runs.map(r => `<tr><td>${esc(new Date(r.when).toLocaleString('en-GB', { timeZone: 'Europe/Athens' }))}</td><td>${esc(r.event)}</td><td style="color:${r.result === 'success' ? '#2fd27a' : r.status !== 'completed' ? '#ffbe3c' : '#ff5a5a'}">${esc(r.result || r.status)}</td></tr>`).join('') : `<tr><td colspan="3">${esc(wf.error)}</td></tr>`;
  let traf;
  if (tr.setup) traf = `<p class="m">Visitor counting isn't connected yet (needs the CF_API_TOKEN secret).</p>`;
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
  let earn;
  if (money.setup) earn = `<p class="m">Earnings aren't connected yet (needs the STRIPE_KEY secret).</p>`;
  else if (money.error) earn = `<p class="m">Couldn't load earnings: ${esc(money.error)}</p>`;
  else earn = `<div class="kp"><div class="k"><b>Last 7 days</b><div class="big">${money.d7}</div><div class="m">${money.n7} payments</div></div>
      <div class="k"><b>Last 30 days</b><div class="big">${money.d30}</div><div class="m">${money.n30} payments</div></div>
      <div class="k"><b>Stripe balance</b><div class="big">${money.available}</div><div class="m">${money.pending} on the way</div></div></div>
      <h3>Latest payments</h3><table>${money.last.map(x => `<tr><td>${esc(new Date(x.when * 1000).toLocaleString('en-GB', { timeZone: 'Europe/Athens' }))}</td><td>${esc(x.what)}</td><td class="r">${x.amount}</td></tr>`).join('') || '<tr><td class="m">No payments yet</td></tr>'}</table>`;
  let kyroHtml;
  if (kl.error) kyroHtml = `<p class="m">Couldn't load licences: ${esc(kl.error)}</p>`;
  else {
    const L = kl.licences || [], pcs = L.reduce((t, x) => t + Object.keys(x.pcs || {}).length, 0);
    kyroHtml = `<div class="kp"><div class="k"><b>Activated keys</b><div class="big">${L.length}</div><div class="m">${pcs} PCs in total · max 3 per key</div></div><div class="k"><b>Blocked keys</b><div class="big">${(kl.blocked || []).length}</div><div class="m">blocked keys stop working on every PC</div></div></div>
      <h3>Keys</h3><div class="scroll"><table>${L.sort((a, b) => b.first - a.first).map(x => { const n = Object.keys(x.pcs || {}).length, bl = (kl.blocked || []).includes(x.serial), last = Math.max(...Object.values(x.pcs || {}).map(p => p.seen || 0), 0);
        return `<tr><td>Key #${x.serial}${bl ? ' <b style="color:#ff8080">BLOCKED</b>' : ''}</td><td>${n}/3 PCs</td><td class="m">last seen ${last ? esc(new Date(last).toLocaleDateString('en-GB')) : '-'}</td><td class="r"><a href="/admin/kyro?op=${bl ? 'unblock' : 'block'}&serial=${x.serial}">${bl ? 'Unblock' : 'Block'}</a> · <a href="/admin/kyro?op=reset&serial=${x.serial}">Reset PCs</a></td></tr>`; }).join('') || '<tr><td class="m">No activations yet</td></tr>'}</table></div>`;
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
<h2>Earnings</h2>${earn}
<h2 id="kyrofix">Kyrofix licences</h2>${kyroHtml}
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


/* ================= Kyrofix licences: online activation, max 3 PCs per key, blockable keys ================= */
// Public half of the Halewood key that signs Kyrofix licence keys (the private half never leaves the owner's PC).
const KYRO_KEY_PUB = '3264b14662072bd73bcb2d78abb98422e2e8bf855c41e439e40afbc449f4b970';
const KYRO_MAX_PCS = 3, KYRO_TOKEN_DAYS = 30, KYRO_STALE_DAYS = 45;
const hex = h => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)));
const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ED = { name: 'Ed25519' };

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = A.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}

async function readKey(key) {
  let s = String(key || '').trim().toUpperCase();
  if (s.startsWith('KYRO')) s = s.slice(4);
  s = s.replace(/[^A-Z2-7]/g, '');
  const raw = b32decode(s);
  if (raw.length !== 72) return null;
  const payload = raw.slice(0, 8), sig = raw.slice(8);
  const pub = await crypto.subtle.importKey('raw', hex(KYRO_KEY_PUB), ED, false, ['verify']);
  const msg = new Uint8Array([...new TextEncoder().encode('KYROFIX'), ...payload]);
  if (!(await crypto.subtle.verify(ED, pub, sig, msg))) return null;
  const dv = new DataView(payload.buffer, payload.byteOffset, 8);
  const expDays = dv.getUint16(2), serial = dv.getUint32(4);
  const expires = expDays ? Date.UTC(2026, 0, 1) + expDays * 864e5 : 0;
  return { serial, expires };
}

export class Licenses {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async signer() {
    let k = await this.ctx.storage.get('signer');
    if (!k) {
      const kp = await crypto.subtle.generateKey(ED, true, ['sign', 'verify']);
      k = { priv: toHex(await crypto.subtle.exportKey('pkcs8', kp.privateKey)), pub: toHex(await crypto.subtle.exportKey('raw', kp.publicKey)) };
      await this.ctx.storage.put('signer', k);
    }
    return k;
  }
  async fetch(req) {
    const url = new URL(req.url), op = url.pathname.split('/').pop();
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'Content-Type': 'application/json' } });
    if (op === 'pubkey') return json({ pub: (await this.signer()).pub });
    if (op === 'list') {
      const all = await this.ctx.storage.list({ prefix: 'lic:' });
      const blocked = (await this.ctx.storage.get('blocked')) || [];
      return json({ blocked, licences: [...all.values()] });
    }
    if (op === 'block' || op === 'unblock') {
      const s = Number(body.serial); let b = (await this.ctx.storage.get('blocked')) || [];
      b = b.filter(x => x !== s); if (op === 'block') b.push(s);
      await this.ctx.storage.put('blocked', b); return json({ ok: true, blocked: b });
    }
    if (op === 'reset') { await this.ctx.storage.delete('lic:' + Number(body.serial)); return json({ ok: true }); }
    // activate / deactivate need a real Halewood-signed key
    const k = await readKey(body.key);
    const mid = String(body.mid || '').replace(/[^a-f0-9]/g, '').slice(0, 64);
    if (!k || mid.length < 16) return json({ ok: false, reason: 'bad' });
    if (k.expires && k.expires < Date.now()) return json({ ok: false, reason: 'expired', expires: new Date(k.expires).toISOString().slice(0, 10) });
    if (((await this.ctx.storage.get('blocked')) || []).includes(k.serial)) return json({ ok: false, reason: 'blocked' });
    const id = 'lic:' + k.serial, now = Date.now();
    const rec = (await this.ctx.storage.get(id)) || { serial: k.serial, first: now, pcs: {} };
    if (op === 'deactivate') { delete rec.pcs[mid]; await this.ctx.storage.put(id, rec); return json({ ok: true }); }
    if (!rec.pcs[mid]) {
      const ids = Object.keys(rec.pcs);
      if (ids.length >= KYRO_MAX_PCS) {
        // a PC not seen for 45 days (old or reinstalled Windows) frees its place automatically
        const old = ids.sort((a, b) => rec.pcs[a].seen - rec.pcs[b].seen)[0];
        if (now - rec.pcs[old].seen > KYRO_STALE_DAYS * 864e5) delete rec.pcs[old];
        else return json({ ok: false, reason: 'limit', max: KYRO_MAX_PCS });
      }
      rec.pcs[mid] = { first: now };
    }
    rec.pcs[mid].seen = now; rec.pcs[mid].ver = String(body.ver || '').slice(0, 12);
    await this.ctx.storage.put(id, rec);
    // short-lived token for this PC only; the app renews it online every few weeks
    const exp = Math.min(now + KYRO_TOKEN_DAYS * 864e5, k.expires || Infinity);
    const payload = new TextEncoder().encode(JSON.stringify({ s: k.serial, m: mid, e: Math.floor(exp / 1000), k: k.expires ? Math.floor(k.expires / 1000) : 0 }));
    const sg = await this.signer();
    const priv = await crypto.subtle.importKey('pkcs8', hex(sg.priv), ED, false, ['sign']);
    const sig = await crypto.subtle.sign(ED, priv, new Uint8Array([...new TextEncoder().encode('KYROTOKEN'), ...payload]));
    return json({ ok: true, token: b64u(payload) + '.' + b64u(sig), serial: k.serial, expires: k.expires ? new Date(k.expires).toISOString().slice(0, 10) : null, pcs: Object.keys(rec.pcs).length, max: KYRO_MAX_PCS });
  }
}

function kyro(env, op, body) {
  const stub = env.LICENSES.get(env.LICENSES.idFromName('main'));
  return stub.fetch('https://do/' + op, body ? { method: 'POST', body: JSON.stringify(body) } : {});
}

const num = (v, lo, hi) => { const n = parseFloat(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(watchdog(env)); },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return cors(req, new Response(null, { headers: { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' } }));
    if (url.pathname === '/kyro/activate' || url.pathname === '/kyro/deactivate') {
      if (req.method !== 'POST') return new Response('POST only', { status: 405 });
      const body = await req.json().catch(() => ({}));
      const r = await kyro(env, url.pathname.split('/').pop(), body);
      return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/kyro/pubkey') return kyro(env, 'pubkey');
    if (url.pathname === '/admin/kyro') {
      if (!authOk(req, env)) return new Response('Login required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Halewood dashboard"' } });
      const op = url.searchParams.get('op'), serial = url.searchParams.get('serial');
      if (op && serial) { await kyro(env, op, { serial }); return Response.redirect(new URL('/admin#kyrofix', req.url).toString(), 302); }
      return kyro(env, 'list');
    }
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

    return new Response('Windrova API', { status: 404 });
  },
};
