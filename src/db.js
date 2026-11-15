const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'products'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'receipts'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads', 'brand'), { recursive: true });

const db = new Database(path.join(DATA_DIR, 'minionarios.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'Cardápio',
  emoji TEXT NOT NULL DEFAULT '🍔',
  image TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  items_json TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pedido_feito',
  payment_method TEXT NOT NULL DEFAULT 'pix',
  receipt_path TEXT,
  receipt_mime TEXT,
  source TEXT NOT NULL DEFAULT 'site',
  wa_jid TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_sessions (
  jid TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS geo_cache (
  q TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS wa_chats (
  jid TEXT PRIMARY KEY,
  phone TEXT,
  name TEXT,
  human_status TEXT NOT NULL DEFAULT 'none',
  human_reason TEXT,
  human_since TEXT,
  last_at TEXT,
  last_text TEXT,
  unread INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS wa_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  direction TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  body TEXT,
  media_path TEXT,
  media_mime TEXT,
  wa_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wam_jid ON wa_messages(jid, id);
CREATE INDEX IF NOT EXISTS idx_wam_waid ON wa_messages(wa_id);
CREATE TABLE IF NOT EXISTS wa_seen (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

const STATUSES = [
  { key: 'pedido_feito', label: 'Pedido feito', emoji: '📝' },
  { key: 'pagamento_confirmado', label: 'Pagamento confirmado', emoji: '💸' },
  { key: 'em_preparo', label: 'Em preparo', emoji: '👨‍🍳' },
  { key: 'saiu_para_entrega', label: 'Saiu para a entrega', emoji: '🛵' },
  { key: 'concluido', label: 'Concluído', emoji: '✅' },
];
const EXTRA_STATUSES = [{ key: 'cancelado', label: 'Cancelado', emoji: '❌' }];
const ALL_STATUSES = [...STATUSES, ...EXTRA_STATUSES];
const statusInfo = (key) => ALL_STATUSES.find((s) => s.key === key) || { key, label: key, emoji: '•' };

const DEFAULT_SETTINGS = {
  team_name: 'Minionários',
  tagline: 'Noite do Hambúrguer · EJC',
  subtitle: 'Paróquia São Pedro Pescador',
  event_date_label: 'Qui, 19 de novembro',
  pickup_label: 'Retirada ou entrega',
  pickup_address: 'R. Marieta Steimbach Silva, 51 – Miramar',
  pickup_city: 'João Pessoa - PB',
  delivery_enabled: '1',
  delivery_note: 'em João Pessoa, taxa calculada pela distância (R$ 1,00 por km)',
  delivery_per_km: '1.00',
  delivery_round: '0.50',
  delivery_min: '0',
  delivery_max_km: '25',
  pickup_lat: '',
  pickup_lng: '',
  location_note: 'O local da retirada será divulgado no Instagram @minionarios.pspp',
  instagram: 'minionarios.pspp',
  whatsapp_number: '5583988095199',
  pix_key: '+5583987889174',
  pix_name: 'Tainara Salustiano Barbosa',
  pix_city: 'JOAO PESSOA',
  accepting_orders: '1',
  notify_status_whatsapp: '0',
  require_receipt: '1',
  next_order_number: '1',
  avatar_image: '',
  cover_image: '',
  pix_qr_image: '',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// ---- migrations ----
const productCols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
if (!productCols.includes('featured')) db.exec('ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 0');
const orderCols = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
for (const [c, def] of [['delivery_mode', "TEXT NOT NULL DEFAULT 'retirada'"], ['bairro', 'TEXT'], ['address', 'TEXT'], ['address_ref', 'TEXT'], ['delivery_fee_cents', 'INTEGER'], ['subtotal_cents', 'INTEGER'], ['delivery_km', 'REAL']]) {
  if (!orderCols.includes(c)) db.exec(`ALTER TABLE orders ADD COLUMN ${c} ${def}`);
}
if (!productCols.includes('badge')) db.exec("ALTER TABLE products ADD COLUMN badge TEXT NOT NULL DEFAULT ''");
db.prepare("UPDATE settings SET value = 'Noite do Hambúrguer · EJC' WHERE key = 'tagline' AND value = 'Noite do Hambúrguer · Gincana do EJC'").run();
function getSettingRaw(k) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : null;
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

if (db.prepare('SELECT COUNT(*) AS n FROM products').get().n === 0) {
  const seed = [
    ['Papoiburg', 'Hambúrguer', 2500, 'Hambúrgueres', '🍔'],
    ['Combo Papoi Power', 'Hambúrguer + fritas', 3000, 'Combos', '🍟'],
    ['Combo Fominion', 'Hambúrguer + fritas + refri', 3500, 'Combos', '🥤'],
    ['Combo Minion Duplo', '2 hambúrgueres', 4500, 'Combos', '🍔'],
    ['Papatata', 'Batata frita', 800, 'Acompanhamentos', '🍟'],
    ['Coca-Cola', '', 500, 'Bebidas', '🥤'],
    ['Cookies', '', 500, 'Sobremesas', '🍪'],
  ];
  const ins = db.prepare('INSERT INTO products (name, description, price_cents, category, emoji, sort) VALUES (?, ?, ?, ?, ?, ?)');
  seed.forEach((p, i) => ins.run(...p, i + 1));
}

if (!getSettingRaw('migr_featured_v1')) {
  db.prepare("UPDATE products SET featured = 1, badge = 'Mais completo' WHERE name = 'Combo Fominion'").run();
  db.prepare("UPDATE products SET featured = 1, badge = 'Pra dividir' WHERE name = 'Combo Minion Duplo'").run();
  db.prepare("UPDATE products SET description = 'Lata' WHERE name = 'Coca-Cola' AND description = ''").run();
  insertSetting.run('migr_featured_v1', '1');
}

if (!getSettingRaw('migr_original_v2')) {
  const upd = db.prepare('UPDATE products SET category = ?, sort = ?, image = COALESCE(image, ?), badge = CASE WHEN ? != \'\' THEN ? ELSE badge END, featured = CASE WHEN ? THEN 1 ELSE featured END WHERE name = ?');
  [
    ['Combos', 1, '/img/fominion.webp', 'Mais completo', 1, 'Combo Fominion'],
    ['Combos', 2, '/img/papoi-power.webp', '', 0, 'Combo Papoi Power'],
    ['Combos', 3, '/img/minion-duplo.webp', 'Pra dividir', 1, 'Combo Minion Duplo'],
    ['Hambúrguer', 4, '/img/papoiburg.webp', 'O clássico', 1, 'Papoiburg'],
    ['Acompanhamento', 5, '/img/papatata.webp', '', 0, 'Papatata'],
    ['Bebida', 6, '/img/coca.webp', '', 0, 'Coca-Cola'],
    ['Sobremesa', 7, '/img/cookies.webp', '', 0, 'Cookies'],
  ].forEach(([cat, sort, img, badge, feat, name]) => upd.run(cat, sort, img, badge, badge, feat, name));
  db.prepare("UPDATE products SET description = 'Cookie com gotas de chocolate', price_cents = 800 WHERE name = 'Cookies' AND description = '' AND price_cents = 500").run();
  db.prepare("UPDATE settings SET value = 'Qui, 19 de novembro' WHERE key = 'event_date_label' AND value = 'Quinta, 19 de novembro'").run();
  db.prepare("UPDATE settings SET value = 'Retirada ou entrega' WHERE key = 'pickup_label' AND value = 'Retirada no local'").run();
  db.prepare("UPDATE settings SET value = 'Tainara Salustiano Barbosa' WHERE key = 'pix_name' AND value = 'TAINARA'").run();
  insertSetting.run('migr_original_v2', '1');
}

if (!getSettingRaw('migr_dist_v1')) {
  db.prepare("UPDATE settings SET value = 'em João Pessoa, taxa calculada pela distância (R$ 1,00 por km)' WHERE key = 'delivery_note' AND value LIKE '%taxa por bairro%'").run();
  insertSetting.run('migr_dist_v1', '1');
}

// ---------- Orders ----------
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

/** Normalises a Brazilian phone to 55 + DDD + number (digits only). */
function normalizePhone(raw) {
  let d = onlyDigits(raw);
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  // WhatsApp JIDs often omit the mobile 9th digit (55 + DDD + 8 digits): put it back.
  if (d.length === 12 && d.startsWith('55') && /[6-9]/.test(d[4])) d = d.slice(0, 4) + '9' + d.slice(4);
  return d;
}
/** Last 8 digits — robust to the presence/absence of the 9th digit and country code. */
const phoneKey = (p) => onlyDigits(p).slice(-8);

function formatNumber(n) {
  return String(n).padStart(3, '0');
}

function hydrateOrder(o) {
  if (!o) return null;
  return {
    ...o,
    number_label: formatNumber(o.number),
    items: JSON.parse(o.items_json),
    status_info: statusInfo(o.status),
    has_receipt: !!o.receipt_path,
  };
}

/**
 * Validates requested items against the current menu and returns priced lines.
 * items: [{ product_id, qty }]
 */
function priceItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('A sacola está vazia.');
  const getP = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const merged = new Map();
  for (const it of items) {
    const id = Number(it.product_id);
    const qty = Math.floor(Number(it.qty));
    if (!Number.isInteger(id) || !Number.isInteger(qty) || qty <= 0) continue;
    merged.set(id, (merged.get(id) || 0) + qty);
  }
  const lines = [];
  for (const [id, qty] of merged) {
    if (qty > 50) throw new Error('Quantidade máxima por item: 50.');
    const p = getP.get(id);
    if (!p) throw new Error('Um dos itens não está mais disponível.');
    lines.push({ product_id: p.id, name: p.name, qty, unit_cents: p.price_cents, subtotal_cents: p.price_cents * qty });
  }
  if (!lines.length) throw new Error('A sacola está vazia.');
  const total = lines.reduce((s, l) => s + l.subtotal_cents, 0);
  return { lines, total };
}

const createOrderTx = db.transaction((data) => {
  const { lines, total: subtotal } = priceItems(data.items);
  const s = getSettings();
  const delivery = data.delivery || { mode: 'retirada' };
  const fee = delivery.mode === 'entrega' ? delivery.fee_cents : 0; // null = a combinar
  const total = subtotal + (fee || 0);
  let number = parseInt(s.next_order_number, 10) || 1;
  // Skip numbers that already exist (e.g. after a manual counter change).
  const exists = db.prepare('SELECT 1 FROM orders WHERE number = ?');
  while (exists.get(number)) number++;
  setSetting('next_order_number', number + 1);
  const code = crypto.randomBytes(9).toString('base64url');
  const info = db
    .prepare(
      `INSERT INTO orders (number, code, customer_name, phone, items_json, total_cents, subtotal_cents, notes, source, wa_jid, receipt_path, receipt_mime, delivery_mode, bairro, address, address_ref, delivery_fee_cents, delivery_km)
       VALUES (@number, @code, @customer_name, @phone, @items_json, @total_cents, @subtotal_cents, @notes, @source, @wa_jid, @receipt_path, @receipt_mime, @delivery_mode, @bairro, @address, @address_ref, @delivery_fee_cents, @delivery_km)`
    )
    .run({
      number,
      code,
      customer_name: data.customer_name.trim().slice(0, 80),
      phone: normalizePhone(data.phone),
      items_json: JSON.stringify(lines),
      total_cents: total,
      subtotal_cents: subtotal,
      delivery_mode: delivery.mode === 'entrega' ? 'entrega' : 'retirada',
      bairro: delivery.mode === 'entrega' ? delivery.bairro : null,
      address: delivery.mode === 'entrega' ? String(delivery.address || '').slice(0, 160) : null,
      address_ref: delivery.mode === 'entrega' ? String(delivery.ref || '').slice(0, 160) : null,
      delivery_fee_cents: delivery.mode === 'entrega' ? fee : 0,
      delivery_km: delivery.mode === 'entrega' ? delivery.km ?? null : null,
      notes: (data.notes || '').trim().slice(0, 300),
      source: data.source || 'site',
      wa_jid: data.wa_jid || null,
      receipt_path: data.receipt_path || null,
      receipt_mime: data.receipt_mime || null,
    });
  db.prepare('INSERT INTO order_events (order_id, status) VALUES (?, ?)').run(info.lastInsertRowid, 'pedido_feito');
  return getOrderById(info.lastInsertRowid);
});

function createOrder(data) {
  if (!data.customer_name || data.customer_name.trim().length < 2) throw new Error('Informe seu nome.');
  const p = normalizePhone(data.phone);
  if (p.length < 12 || p.length > 13) throw new Error('Informe um telefone válido com DDD.');
  data.delivery = resolveDelivery(data.delivery, data.items);
  return createOrderTx(data);
}

const BURGER_CATS = ['combos', 'hamburguer', 'hamburgueres', 'lanches'];
const normCat = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
/**
 * Valida a entrega. O valor da taxa (fee_cents/km) vem SEMPRE de código do servidor (geo.priceDelivery),
 * nunca do cliente. fee_cents = null significa "a combinar com a equipe".
 */
function resolveDelivery(d, items) {
  if (!d || d.mode !== 'entrega') return { mode: 'retirada' };
  if (getSettings().delivery_enabled !== '1') throw new Error('Entrega indisponível. Escolha retirada no local.');
  const hasBurger = (items || []).some((it) => {
    const p = db.prepare('SELECT category FROM products WHERE id = ?').get(Number(it.product_id));
    return p && BURGER_CATS.includes(normCat(p.category));
  });
  if (!hasBurger) throw new Error('A entrega vale só para pedidos com pelo menos um hambúrguer ou combo.');
  if (!d.address || String(d.address).trim().length < 4) throw new Error('Digite a rua e o número.');
  const fee = Number.isInteger(d.fee_cents) && d.fee_cents >= 0 ? d.fee_cents : null;
  const addr = String(d.address).trim() + (d.cep && !/CEP/i.test(d.address) ? ` — CEP ${String(d.cep).replace(/^(\d{5})(\d{3})$/, '$1-$2')}` : '');
  return { mode: 'entrega', bairro: String(d.bairro || '').trim(), fee_cents: fee, km: Number.isFinite(d.km) ? d.km : null, address: addr, ref: String(d.ref || '').trim() };
}

const getOrderById = (id) => hydrateOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
const getOrderByCode = (code) => hydrateOrder(db.prepare('SELECT * FROM orders WHERE code = ?').get(code));
const getOrderByNumber = (n) => hydrateOrder(db.prepare('SELECT * FROM orders WHERE number = ?').get(n));

function findOrdersByPhone(phone, limit = 5) {
  const key = phoneKey(phone);
  if (key.length < 8) return [];
  return db
    .prepare("SELECT * FROM orders WHERE substr(phone, -8) = ? ORDER BY id DESC LIMIT ?")
    .all(key, limit)
    .map(hydrateOrder);
}

function listOrders({ status, q } = {}) {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const args = [];
  if (status && status !== 'all') {
    sql += ' AND status = ?';
    args.push(status);
  }
  if (q) {
    const digits = onlyDigits(q);
    sql += ' AND (customer_name LIKE ? OR CAST(number AS TEXT) = ?' + (digits ? ' OR phone LIKE ?' : '') + ')';
    args.push(`%${q}%`, String(parseInt(digits || '0', 10)));
    if (digits) args.push(`%${digits}%`);
  }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...args).map(hydrateOrder);
}

function orderEvents(orderId) {
  return db.prepare('SELECT status, created_at FROM order_events WHERE order_id = ? ORDER BY id').all(orderId);
}

function updateOrderStatus(id, status) {
  if (!ALL_STATUSES.some((s) => s.key === status)) throw new Error('Status inválido.');
  const o = getOrderById(id);
  if (!o) throw new Error('Pedido não encontrado.');
  if (o.status === status) return o;
  db.prepare("UPDATE orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(status, id);
  db.prepare('INSERT INTO order_events (order_id, status) VALUES (?, ?)').run(id, status);
  return getOrderById(id);
}

function attachReceipt(id, relPath, mime) {
  db.prepare("UPDATE orders SET receipt_path = ?, receipt_mime = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(relPath, mime, id);
  return getOrderById(id);
}

function stats() {
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all().map((r) => [r.status, r.n]));
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(total_cents),0) AS gross,
              COALESCE(SUM(CASE WHEN status NOT IN ('pedido_feito','cancelado') THEN total_cents END),0) AS confirmed
       FROM orders WHERE status != 'cancelado'`
    )
    .get();
  const products = {};
  for (const o of db.prepare("SELECT items_json FROM orders WHERE status != 'cancelado'").all()) {
    for (const l of JSON.parse(o.items_json)) {
      products[l.name] = (products[l.name] || 0) + l.qty;
    }
  }
  return { byStatus, totals, products };
}

// ---------- WhatsApp sessions ----------
function getSession(jid) {
  const r = db.prepare('SELECT * FROM wa_sessions WHERE jid = ?').get(jid);
  if (!r) return { state: 'idle', data: {} };
  // Sessions idle for more than 2h are reset.
  if (Date.now() - Date.parse(r.updated_at) > 2 * 3600 * 1000) return { state: 'idle', data: {} };
  return { state: r.state, data: JSON.parse(r.data_json) };
}
function saveSession(jid, state, data = {}) {
  db.prepare(
    `INSERT INTO wa_sessions (jid, state, data_json, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(jid) DO UPDATE SET state = excluded.state, data_json = excluded.data_json, updated_at = excluded.updated_at`
  ).run(jid, state, JSON.stringify(data));
}
/** Returns true the first time a message id is seen (dedupes webhook retries). */
function markSeen(id) {
  if (!id) return true;
  const r = db.prepare('INSERT OR IGNORE INTO wa_seen (id) VALUES (?)').run(id);
  return r.changes > 0;
}

// ---------- Conversas do WhatsApp (somente para consulta no admin) ----------
const HELP_AUTO_RESUME_MS = 8 * 3600 * 1000;

function getChat(jid) {
  const c = db.prepare('SELECT * FROM wa_chats WHERE jid = ?').get(jid);
  if (!c) return null;
  // Pausa (equipe respondendo pelo número do bot) expira sozinha após 8h sem atividade humana.
  if (c.human_status === 'handling' && c.human_since && Date.now() - Date.parse(c.human_since) > HELP_AUTO_RESUME_MS) {
    db.prepare("UPDATE wa_chats SET human_status = 'none', human_reason = NULL WHERE jid = ?").run(jid);
    c.human_status = 'none'; c.human_reason = null;
  }
  return c;
}

function logMessage({ jid, direction, kind = 'text', body = '', media_path = null, media_mime = null, wa_id = null, phone = null, name = null }) {
  const info = db.prepare('INSERT INTO wa_messages (jid, direction, kind, body, media_path, media_mime, wa_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jid, direction, kind, body, media_path, media_mime, wa_id);
  const preview = body ? String(body).replace(/\s+/g, ' ').slice(0, 90) : ({ image: '📷 Foto', audio: '🎤 Áudio', video: '🎥 Vídeo', document: '📄 Documento', sticker: 'Figurinha' }[kind] || '');
  db.prepare(`INSERT INTO wa_chats (jid, phone, name, last_at, last_text, unread) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?)
    ON CONFLICT(jid) DO UPDATE SET last_at = excluded.last_at, last_text = excluded.last_text,
      phone = COALESCE(excluded.phone, wa_chats.phone), name = COALESCE(excluded.name, wa_chats.name),
      unread = wa_chats.unread + excluded.unread`).run(jid, phone, name, preview, direction === 'in' ? 1 : 0);
  return info.lastInsertRowid;
}
const messageSeen = (waId) => !!waId && !!db.prepare('SELECT 1 FROM wa_messages WHERE wa_id = ?').get(waId);

/**
 * status: 'none' | 'requested' (cliente pediu ajuda — só sinaliza no admin, o bot continua respondendo;
 * a equipe entra em contato por outro número e marca como resolvido) | 'handling' (equipe respondendo
 * pelo número do bot — pausa o bot).
 */
function setHuman(jid, status, reason = null) {
  db.prepare(`INSERT INTO wa_chats (jid, human_status, human_reason, human_since) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(jid) DO UPDATE SET human_status = excluded.human_status, human_reason = excluded.human_reason, human_since = excluded.human_since`).run(jid, status, status === 'none' ? null : reason);
}
const touchHuman = (jid) => db.prepare("UPDATE wa_chats SET human_since = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE jid = ?").run(jid);
const botPaused = (jid) => { const c = getChat(jid); return !!c && c.human_status === 'handling'; };

function listChats() {
  const rows = db.prepare('SELECT * FROM wa_chats WHERE last_at IS NOT NULL ORDER BY last_at DESC LIMIT 200').all();
  return rows.map((c) => ({ ...getChat(c.jid), orders: db.prepare('SELECT number, status FROM orders WHERE wa_jid = ? ORDER BY id DESC LIMIT 3').all(c.jid) }));
}
const chatMessages = (jid, limit = 300) => db.prepare('SELECT * FROM (SELECT * FROM wa_messages WHERE jid = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(jid, limit);
const markChatRead = (jid) => db.prepare('UPDATE wa_chats SET unread = 0 WHERE jid = ?').run(jid);
/** Estado de atendimento por conversa, para os cartões de pedido. */
const chatStates = () => Object.fromEntries(db.prepare('SELECT jid, human_status, unread FROM wa_chats').all().map((c) => [c.jid, c]));

module.exports = {
  getChat, logMessage, messageSeen, setHuman, touchHuman, botPaused, listChats, chatMessages, markChatRead, chatStates,
  db,
  DATA_DIR,
  STATUSES,
  ALL_STATUSES,
  statusInfo,
  getSettings,
  setSetting,
  normalizePhone,
  phoneKey,
  formatNumber,
  priceItems,
  createOrder,
  resolveDelivery,
  getOrderById,
  getOrderByCode,
  getOrderByNumber,
  findOrdersByPhone,
  listOrders,
  orderEvents,
  updateOrderStatus,
  attachReceipt,
  stats,
  getSession,
  saveSession,
  markSeen,
};
