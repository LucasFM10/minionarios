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

// Nominatim pede no máximo 1 requisição por segundo: fila simples.
let chain = Promise.resolve();
let last = 0;
function nominatim(q) {
  const run = async () => {
    const wait = Math.max(0, last + 1100 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    const j = await getJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`);
    return j && j[0] ? { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) } : null;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

const cacheGet = (k) => store.db.prepare('SELECT lat, lng FROM geo_cache WHERE q = ?').get(k) || null;
const cacheSet = (k, lat, lng) => store.db.prepare('INSERT OR REPLACE INTO geo_cache (q, lat, lng) VALUES (?, ?, ?)').run(k, lat, lng);

async function geocodeText(q) {
  const key = q.toLowerCase().replace(/\s+/g, ' ').trim();
  const c = cacheGet(key);
  if (c) return c;
  const r = await nominatim(q);
  if (r && Number.isFinite(r.lat) && Number.isFinite(r.lng)) cacheSet(key, r.lat, r.lng);
  return r;
}

async function geocodeCep(cep) {
  const d = String(cep || '').replace(/\D/g, '');
  if (d.length !== 8) return null;
  const key = 'cep:' + d;
  const c = cacheGet(key);
  if (c) return c;
  try {
    const j = await getJson(`https://brasilapi.com.br/api/cep/v2/${d}`);
    const co = j?.location?.coordinates;
    const lat = parseFloat(co?.latitude), lng = parseFloat(co?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng)) { cacheSet(key, lat, lng); return { lat, lng }; }
  } catch {}
  return null;
}

const cityOf = (s) => String(s.pickup_city || 'João Pessoa - PB').replace(/\s*-\s*PB$/i, '').trim() || 'João Pessoa';

/** Tenta do mais preciso para o menos: endereço completo → rua sem número → CEP. */
async function geocodeAddress({ address, bairro, cep }, s) {
  const city = cityOf(s), uf = 'Paraíba, Brasil';
  const street = String(address || '').replace(/\s*[—-]\s*CEP.*$/i, '').trim();
  const noNumber = street.split(',')[0].replace(/\b\d+\b/g, '').trim();
  const tries = [
    [street, bairro, city, uf],
    [noNumber, bairro, city, uf],
  ].map((p) => p.filter(Boolean).join(', ')).filter((q, i, a) => q && a.indexOf(q) === i);
  for (const q of tries) {
    try { const r = await geocodeText(q); if (r) return r; } catch {}
  }
  return geocodeCep(cep);
}

async function getOrigin(s) {
  const lat = parseFloat(s.pickup_lat), lng = parseFloat(s.pickup_lng);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  if (!s.pickup_address) return null;
  try {
    const r = await geocodeText([s.pickup_address, cityOf(s), 'Paraíba, Brasil'].join(', '));
    if (r) { store.setSetting('pickup_lat', r.lat); store.setSetting('pickup_lng', r.lng); return r; }
  } catch {}
  return null;
}

function haversineKm(a, b) {
  const R = 6371, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function roadKm(a, b) {
  try {
    const j = await getJson(`https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false`);
    const m = j?.routes?.[0]?.distance;
    if (Number.isFinite(m)) return { km: m / 1000, approx: false };
  } catch {}
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
async function priceDelivery(d) {
  const base = { mode: 'entrega', bairro: String(d.bairro || '').trim().slice(0, 60), address: String(d.address || '').trim().slice(0, 160), ref: String(d.ref || '').trim().slice(0, 160), cep: String(d.cep || '').replace(/\D/g, '').slice(0, 8), km: null, fee_cents: null, approx: false };
  const s = store.getSettings();
  const [origin, dest] = await Promise.all([getOrigin(s), geocodeAddress(base, s)]);
  if (!origin || !dest) return base;
  const { km, approx } = await roadKm(origin, dest);
  const num = (v, d) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : d; };
  const maxKm = num(s.delivery_max_km, 9);
  base.km = Math.round(km * 10) / 10;
  base.approx = approx;
  base.max_km = maxKm;
  if (km > maxKm) base.too_far = true; // fora da área: não entregamos
  else base.fee_cents = feeFor(km, { perKm: money(s.delivery_per_km, 100), step: money(s.delivery_round, 50), min: money(s.delivery_min, 500), baseKm: num(s.delivery_base_km, 2) });
  return base;
}

module.exports = { priceDelivery, feeFor, haversineKm, setFetch, geocodeAddress };
