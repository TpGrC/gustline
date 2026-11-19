// Builds SEO pages: site/weather/<slug>/index.html for the 5,000 biggest cities, plus site/weather/index.html and sitemap.
// Run: node tools/build_city_pages.js
const fs = require('fs'), path = require('path');
const SITE = path.join(__dirname, '..', 'site'), OUT = path.join(SITE, 'weather');
const cities = JSON.parse(fs.readFileSync(path.join(__dirname, 'top5000.json'), 'utf8')); // [lat,lon,name,ascii,cc,pop,tz]
const country = new Intl.DisplayNames(['en'], { type: 'region' });
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'place';
const used = new Set();
const list = cities.map(([lat, lon, name, ascii, cc, pop, tz], i) => {
  let s = slugify(ascii || name) + '-' + cc.toLowerCase(); if (used.has(s)) s += '-' + i; used.add(s);
  return { lat, lon, name, cc, pop, tz, slug: s, cn: (() => { try { return country.of(cc); } catch (e) { return cc; } })() };
});
const near = (c, n) => list.filter(o => o !== c).map(o => [o, (o.lat - c.lat) ** 2 + ((o.lon - c.lon) * Math.cos(c.lat * Math.PI / 180)) ** 2]).sort((a, b) => a[1] - b[1]).slice(0, n).map(x => x[0]);
const css = `:root{color-scheme:dark}body{margin:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0d1117;color:#e9eef3}
a{color:#4da3ff}header{display:flex;align-items:center;gap:10px;padding:14px 18px;border-bottom:1px solid rgba(255,255,255,.08)}header a{display:flex;align-items:center;gap:8px;color:#fff;text-decoration:none;font-weight:800}
main{max-width:760px;margin:0 auto;padding:22px 18px 40px}h1{font-size:28px;margin:6px 0 4px;letter-spacing:-.02em}.sub{color:#93a0ad;margin:0 0 18px}
.cta{display:inline-flex;align-items:center;gap:8px;background:linear-gradient(135deg,#4da3ff,#2f6df0);color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px;margin:6px 0 20px}
.now{display:flex;gap:16px;align-items:center;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;margin-bottom:14px}.now .big{font-size:44px;font-weight:800}.now .ic{font-size:44px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}.d{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px;text-align:center;font-size:13px}.d .ic{font-size:24px}.d b{font-size:15px}.mn{color:#93a0ad}.r{color:#7db8ff;font-size:12px}
h2{font-size:17px;margin:26px 0 10px}.near{display:flex;flex-wrap:wrap;gap:8px}.near a{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08);border-radius:999px;padding:6px 12px;text-decoration:none;color:#e9eef3;font-size:13px}
footer{color:#7d8894;font-size:12px;text-align:center;padding:24px 18px}p{line-height:1.6;color:#c9d4df}`;
const script = c => `<script>
(function(){const E={clearsky:'☀️',fair:'🌤️',partlycloudy:'⛅',cloudy:'☁️',fog:'🌫️',rain:'🌧️',lightrain:'🌦️',heavyrain:'🌧️',rainshowers:'🌦️',lightrainshowers:'🌦️',heavyrainshowers:'🌧️',snow:'🌨️',lightsnow:'🌨️',heavysnow:'❄️',snowshowers:'🌨️',sleet:'🌨️',thunder:'⛈️'};
const ic=s=>{if(!s)return'⛅';s=s.replace(/_(day|night|polartwilight)$/,'');if(s.includes('thunder'))return E.thunder;return E[s]||E[s.replace(/^(light|heavy)/,'')]||'⛅';};
const tz=${JSON.stringify(c.tz)},day=d=>new Intl.DateTimeFormat('en',{weekday:'short',timeZone:tz}).format(d),key=d=>new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(d);
fetch('https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${c.lat}&lon=${c.lon}').then(r=>r.json()).then(j=>{const ts=j.properties.timeseries,n=ts[0],d=n.data.instant.details,s=(n.data.next_1_hours||n.data.next_6_hours||{summary:{}}).summary.symbol_code;
document.getElementById('now').innerHTML='<div class="ic">'+ic(s)+'</div><div><div class="big">'+Math.round(d.air_temperature)+'°C</div><div>Wind '+Math.round(d.wind_speed*3.6)+' km/h · Humidity '+Math.round(d.relative_humidity)+'% · '+Math.round(d.air_pressure_at_sea_level)+' hPa</div></div>';
const by={};for(const x of ts){const t=new Date(x.time),k=key(t);(by[k]=by[k]||{t,T:[],p:0,s:null});by[k].T.push(x.data.instant.details.air_temperature);const nx=x.data.next_1_hours||x.data.next_6_hours;if(nx){by[k].p+=x.data.next_1_hours?nx.details.precipitation_amount||0:0;if(!x.data.next_1_hours)by[k].p+=(nx.details.precipitation_amount||0)/4;const h=+new Intl.DateTimeFormat('en',{hour:'numeric',hour12:false,timeZone:tz}).format(t);if(!by[k].s||Math.abs(h-13)<by[k].dh){by[k].s=nx.summary.symbol_code;by[k].dh=Math.abs(h-13);}}}
document.getElementById('days').innerHTML=Object.values(by).slice(0,7).map(o=>'<div class="d"><div>'+day(o.t)+'</div><div class="ic">'+ic(o.s)+'</div><b>'+Math.round(Math.max(...o.T))+'°</b> <span class="mn">'+Math.round(Math.min(...o.T))+'°</span><div class="r">'+(o.p>=0.1?o.p.toFixed(1)+' mm':'&nbsp;')+'</div></div>').join('');}).catch(()=>{document.getElementById('now').textContent='Open the live map for the full forecast.';});})();
</script>`;
const page = c => {
  const title = `${c.name} weather — live wind, rain & 10-day forecast | Windrova`;
  const desc = `Weather in ${c.name}, ${c.cn}: live wind map, rain, temperature, waves and a 10-day forecast from ECMWF and GFS. Free on Windrova.`;
  const url = `https://windrova.com/weather/${c.slug}/`, live = `/#${c.lat.toFixed(2)},${c.lon.toFixed(2)},8,wind`;
  const nb = near(c, 12);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="https://windrova.com/og-image.png"><meta property="og:url" content="${url}"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" href="/logo.svg" type="image/svg+xml"><meta name="theme-color" content="#0d1117">
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, url, about: { '@type': 'City', name: c.name, containedInPlace: { '@type': 'Country', name: c.cn }, geo: { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lon } }, publisher: { '@type': 'Organization', name: 'Halewood Systems' } })}</script>
<style>${css}</style></head><body>
<header><a href="/"><img src="/logo.svg" width="28" height="28" alt="">Windrova</a></header>
<main><h1>Weather in ${esc(c.name)}</h1><p class="sub">${esc(c.cn)} · ${c.lat.toFixed(2)}°, ${c.lon.toFixed(2)}°</p>
<a class="cta" href="${live}">🌬️ Open the live wind map for ${esc(c.name)}</a>
<div class="now" id="now">Loading the forecast…</div><div class="grid" id="days"></div>
<h2>About the weather map for ${esc(c.name)}</h2>
<p>Windrova shows live animated wind, gusts, rain, temperature, clouds, pressure, thunderstorms and sea waves for ${esc(c.name)} and the rest of ${esc(c.cn)}, with a 10-day forecast from the ECMWF and GFS weather models, live satellite pictures, tropical storm tracking and the best times for the beach, sailing, kitesurf, hiking and cycling. It is free, fast and works on phones and computers.</p>
<h2>Weather near ${esc(c.name)}</h2><div class="near">${nb.map(o => `<a href="/weather/${o.slug}/">${esc(o.name)}</a>`).join('')}</div>
</main><footer>Windrova by Halewood Systems · Forecast data: MET Norway (CC BY 4.0) · <a href="/weather/">All cities</a> · <a href="/privacy.html">Privacy</a></footer>
${script(c)}<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "1ae1639f8474498a89536545d9edbd7e"}'></script></body></html>`;
};
fs.rmSync(OUT, { recursive: true, force: true });
for (const c of list) { const d = path.join(OUT, c.slug); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'index.html'), page(c)); }
// index page grouped by country
const byC = {}; for (const c of list) (byC[c.cn] = byC[c.cn] || []).push(c);
const idx = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weather for 5,000 cities worldwide | Windrova</title>
<meta name="description" content="Live wind, rain, temperature and 10-day forecasts for 5,000 cities around the world."><link rel="canonical" href="https://windrova.com/weather/"><link rel="icon" href="/logo.svg" type="image/svg+xml"><style>${css}</style></head><body>
<header><a href="/"><img src="/logo.svg" width="28" height="28" alt="">Windrova</a></header><main><h1>Weather worldwide</h1><p class="sub">Live maps and forecasts for 5,000 cities.</p>
${Object.keys(byC).sort().map(k => `<h2>${esc(k)}</h2><div class="near">${byC[k].map(o => `<a href="/weather/${o.slug}/">${esc(o.name)}</a>`).join('')}</div>`).join('')}
</main><footer>Windrova by Halewood Systems</footer><script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "1ae1639f8474498a89536545d9edbd7e"}'></script></body></html>`;
fs.writeFileSync(path.join(OUT, 'index.html'), idx);
// sitemap
const urls = ['https://windrova.com/', 'https://windrova.com/weather/', ...list.map(c => `https://windrova.com/weather/${c.slug}/`)];
fs.writeFileSync(path.join(SITE, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u, i) => `  <url><loc>${u}</loc><changefreq>${i < 2 ? 'hourly' : 'daily'}</changefreq><priority>${i === 0 ? '1.0' : i === 1 ? '0.8' : '0.6'}</priority></url>`).join('\n')}\n  <url><loc>https://windrova.com/privacy.html</loc><changefreq>yearly</changefreq><priority>0.2</priority></url>\n</urlset>\n`);
console.log('pages', list.length, 'countries', Object.keys(byC).length);
