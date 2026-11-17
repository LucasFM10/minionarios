// Taxa de entrega por distância: geocodifica o endereço (OpenStreetMap/Nominatim, com CEP como reserva),
// mede a distância por ruas (OSRM) e cobra R$/km arredondando para cima de 50 em 50 centavos.
// Se algo falhar, devolve fee_cents = null ("a combinar com a equipe") — nunca bloqueia o pedido.
const store = require('./db');

let fetchImpl = (...a) => fetch(...a);
const setFetch = (f) => { fetchImpl = f; };
const UA = 'minionarios-pedidos/1.0 (pre-venda EJC; contato via site)';

async function getJson(url, ms = 8000) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR', Accept: 'application/json' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}

// Região de busca: Grande João Pessoa (evita achar uma rua de mesmo nome em outra cidade).
const BOX = { w: -35.10, s: -7.35, e: -34.75, n: -6.95 };
const inBox = (r) => r && Number.isFinite(r.lat) && Number.isFinite(r.lng) && r.lat >= BOX.s && r.lat <= BOX.n && r.lng >= BOX.w && r.lng <= BOX.e;
const warn = (...a) => console.warn('[geo]', ...a);

// Nominatim pede no máximo 1 requisição por segundo: fila simples.
let chain = Promise.resolve();
let last = 0;
function nominatim(q) {
  const run = async () => {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const j = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&viewbox=${BOX.w},${BOX.n},${BOX.e},${BOX.s}&bounded=1&q=${encodeURIComponent(q)}`);
    return j && j[0] ? { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) } : null;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

// Photon (Komoot): outro buscador do OpenStreetMap, usado se o Nominatim falhar ou não achar.
async function photon(q) {
  const j = await getJson(`https://photon.komoot.io/api/?limit=1&lang=default&bbox=${BOX.w},${BOX.s},${BOX.e},${BOX.n}&q=${encodeURIComponent(q)}`);
  const c = j?.features?.[0]?.geometry?.coordinates;
  return c ? { lat: parseFloat(c[1]), lng: parseFloat(c[0]) } : null;
}

const cacheGet = (k) => store.db.prepare('SELECT lat, lng FROM geo_cache WHERE q = ?').get(k) || null;
const cacheSet = (k, lat, lng) => store.db.prepare('INSERT OR REPLACE INTO geo_cache (q, lat, lng) VALUES (?, ?, ?)').run(k, lat, lng);

async function geocodeText(q, trace = []) {
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const c = cacheGet(key);
  if (c) { trace.push(`cache: ${q}`); return c; }
  for (const [name, fn] of [['nominatim', nominatim], ['photon', photon]]) {
    try {
      const r = await fn(q);
      if (inBox(r)) { trace.push(`${name} ok: ${q}`); cacheSet(key, r.lat, r.lng); return r; }
      trace.push(`${name} não achou: ${q}`);
    } catch (e) {
      trace.push(`${name} erro (${e.message}): ${q}`);
      warn(name, 'falhou:', e.message);
    }
  }
  return null;
}

async function geocodeCep(cep, trace = []) {
  const d = String(cep || '').replace(/\D/g, '');
  if (d.length !== 8) return null;
  const key = 'cep:' + d;
  const c = cacheGet(key);
  if (c) { trace.push('cache: CEP ' + d); return c; }
  const sources = [
    ['brasilapi', `https://brasilapi.com.br/api/cep/v2/${d}`, (j) => ({ lat: parseFloat(j?.location?.coordinates?.latitude), lng: parseFloat(j?.location?.coordinates?.longitude) })],
    ['awesomeapi', `https://cep.awesomeapi.com.br/json/${d}`, (j) => ({ lat: parseFloat(j?.lat), lng: parseFloat(j?.lng) })],
  ];
  for (const [name, url, pick] of sources) {
    try {
      const r = pick(await getJson(url));
      if (inBox(r)) { trace.push(`${name} ok: CEP ${d}`); cacheSet(key, r.lat, r.lng); return r; }
      trace.push(`${name} sem coordenadas: CEP ${d}`);
    } catch (e) {
      trace.push(`${name} erro (${e.message}): CEP ${d}`);
      warn(name, 'falhou:', e.message);
    }
  }
  return null;
}

const cityOf = (s) => String(s.pickup_city || 'João Pessoa - PB').replace(/\s*-\s*PB$/i, '').trim() || 'João Pessoa';

/** "R. Fulano, 51 – Miramar" → { street: 'Rua Fulano, 51', bairro: 'Miramar' } */
function splitAddress(address, bairro) {
  let a = String(address || '').replace(/\s*[—–-]\s*CEP.*$/i, '').replace(/\s+/g, ' ').trim();
  let b = String(bairro || '').trim();
  const dash = a.split(/\s+[—–-]\s+/);
  if (dash.length > 1) { a = dash[0].trim(); if (!b) b = dash.slice(1).join(' ').trim(); }
  a = a
    .replace(/^R\.?\s+/i, 'Rua ')
    .replace(/^Av\.?\s+/i, 'Avenida ')
    .replace(/^Trav\.?\s+/i, 'Travessa ')
    .replace(/\bGov\.?\s+/i, 'Governador ')
    .replace(/\bDr\.?\s+/i, 'Doutor ')
    .replace(/\bPres\.?\s+/i, 'Presidente ');
  return { street: a, bairro: b };
}

/**
 * Do mais preciso para o menos: endereço completo → rua sem número → CEP → centro do bairro (aproximado).
 * Devolve { lat, lng, precision } ou null.
 */
async function geocodeAddress({ address, bairro, cep }, s, trace = []) {
  const city = cityOf(s), uf = 'Paraíba';
  const { street, bairro: b } = splitAddress(address, bairro);
  const noNumber = street.split(',')[0].replace(/\b\d+\w?\b/g, '').replace(/\bn[º°o]\.?\s*$/i, '').trim();
  const num = (street.match(/,\s*(\d+)/) || [])[1];
  const tries = [
    num ? [`${noNumber}, ${num}`, b, city, uf] : null,
    [noNumber, b, city, uf],
    [noNumber, city, uf],
  ].filter(Boolean).map((p) => p.filter(Boolean).join(', ')).filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of tries) {
    const r = await geocodeText(q, trace);
    if (r) return { ...r, precision: 'rua' };
  }
  const byCep = await geocodeCep(cep, trace);
  if (byCep) return { ...byCep, precision: 'cep' };
  if (b) {
    const r = await geocodeText([b, city, uf].join(', '), trace);
    if (r) return { ...r, precision: 'bairro' };
  }
  return null;
}

// ---------- ViaCEP (Correios): rua e bairro oficiais ----------
const UFCITY = { uf: 'PB', city: 'Joao Pessoa' };
const viaFmt = (r) => ({ cep: String(r.cep || '').replace(/\D/g, ''), rua: r.logradouro || '', bairro: r.bairro || '', complemento: r.complemento || '', cidade: r.localidade || '' });

/** CEP → { cep, rua, bairro } ou null (inexistente). Lança erro se o serviço não responder. */
async function viaCep(cep) {
  const d = String(cep || '').replace(/\D/g, '');
  if (d.length !== 8) return null;
  const j = await getJson(`https://viacep.com.br/ws/${d}/json/`);
  return j && !j.erro ? viaFmt(j) : null;
}

/** Nome da rua → lista de ruas de João Pessoa com CEP (até `limit`). */
async function viaCepSearch(street, limit = 8) {
  const q = String(street || '').replace(/^(rua|r\.|avenida|av\.?|travessa|trav\.?)\s+/i, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 3) return [];
  const j = await getJson(`https://viacep.com.br/ws/${UFCITY.uf}/${encodeURIComponent(UFCITY.city)}/${encodeURIComponent(q)}/json/`);
  return Array.isArray(j) ? j.slice(0, limit).map(viaFmt) : [];
}

async function getOrigin(s, trace = []) {
  const lat = parseFloat(s.pickup_lat), lng = parseFloat(s.pickup_lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (!s.pickup_address) { trace.push('sem endereço de retirada'); return null; }
  const r = await geocodeAddress({ address: s.pickup_address }, s, trace);
  if (r) {
    store.setSetting('pickup_lat', r.lat.toFixed(6)); store.setSetting('pickup_lng', r.lng.toFixed(6));
    console.log(`[geo] ponto de retirada localizado (${r.precision}): ${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}`);
    return r;
  }
  warn('não consegui localizar o ponto de retirada:', s.pickup_address);
  return null;
}

function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function roadKm(a, b, trace = []) {
  try {
    const j = await getJson(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`);
    const m = j?.routes?.[0]?.distance;
    if (Number.isFinite(m)) { trace.push(`rota (OSRM): ${(m / 1000).toFixed(2)} km`); return { km: m / 1000, approx: false }; }
    trace.push('OSRM sem rota');
  } catch (e) {
    trace.push(`OSRM erro (${e.message})`);
    warn('OSRM falhou:', e.message);
  }
  trace.push('usando linha reta + 30%');
  return { km: haversineKm(a, b) * 1.3, approx: true }; // sem rota: linha reta + 30%
}

const money = (v, d) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) : d; };

/**
 * km → centavos. `min` cobre os primeiros `baseKm`; cada km além disso soma `perKm`.
 * Valores em centavos; arredonda sempre para cima no múltiplo de `step`.
 * Ex. (padrão): 1,5 km → R$ 5,00 · 4,2 km → 5 + 2,2 = R$ 7,20 → R$ 7,50 · 9 km → R$ 12,00.
 */
function feeFor(km, { perKm = 100, step = 50, min = 500, baseKm = 2 } = {}) {
  const raw = min + Math.max(0, km - baseKm) * perKm;
  return step > 0 ? Math.ceil(raw / step - 1e-9) * step : Math.round(raw);
}

/** Recebe os dados do cliente e devolve o objeto de entrega JÁ precificado (só o servidor chama isto). */
async function priceDelivery(d, trace = []) {
  const base = { mode: 'entrega', bairro: String(d.bairro || '').trim().slice(0, 60), address: String(d.address || '').trim().slice(0, 160), ref: String(d.ref || '').trim().slice(0, 160), cep: String(d.cep || '').replace(/\D/g, '').slice(0, 8), km: null, fee_cents: null, approx: false };
  const s = store.getSettings();
  const origin = await getOrigin(s, trace);
  const dest = origin ? await geocodeAddress(base, s, trace) : null;
  if (!origin || !dest) {
    warn(`taxa não calculada (${!origin ? 'ponto de retirada' : 'endereço do cliente'} não localizado):`, base.address, '|', base.bairro, '|', base.cep, '\n  ' + trace.join('\n  '));
    return base;
  }
  base.precision = dest.precision;
  const { km, approx } = await roadKm(origin, dest, trace);
  const num = (v, d) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : d; };
  const maxKm = num(s.delivery_max_km, 9);
  base.km = Math.round(km * 10) / 10;
  base.approx = approx || dest.precision === 'bairro';
  base.max_km = maxKm;
  if (km > maxKm) base.too_far = true; // fora da área: não entregamos
  else base.fee_cents = feeFor(km, { perKm: money(s.delivery_per_km, 100), step: money(s.delivery_round, 50), min: money(s.delivery_min, 500), baseKm: num(s.delivery_base_km, 2) });
  return base;
}

module.exports = { viaCep, viaCepSearch, priceDelivery, feeFor, haversineKm, setFetch, geocodeAddress, getOrigin, splitAddress };
