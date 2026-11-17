const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const store = require('./db');
const wa = require('./whatsapp');
const geo = require('./geo');
const { buildPixPayload } = require('./pix');
const imgUrl = (i) => (!i ? null : i.startsWith('/') ? i : '/uploads/' + i);

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('s:' + ADMIN_PASSWORD).digest('hex');
if (!ADMIN_PASSWORD) console.warn('⚠️  ADMIN_PASSWORD não definido — o painel admin ficará bloqueado.');

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '15mb' }));

const UPLOADS = path.join(store.DATA_DIR, 'uploads');
const PUBLIC = path.join(__dirname, '..', 'public');

// ---------- helpers ----------
const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('base64url');
function makeToken() {
  const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
  return exp + '.' + sign(exp);
}
function validToken(tok) {
  if (!tok || !ADMIN_PASSWORD) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return good.length === sig.length && crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig));
}
function cookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}
const requireAdmin = (req, res, next) => (validToken(cookies(req).adm) ? next() : res.status(401).json({ error: 'Não autorizado' }));

// Very small in-memory rate limiter.
const buckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + req.path;
    const now = Date.now();
    const b = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (b.length >= max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um pouco.' });
    b.push(now);
    buckets.set(key, b);
    next();
  };
}
setInterval(() => buckets.clear(), 60 * 60 * 1000).unref();

const ALLOWED = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !!ALLOWED[file.mimetype]),
});
function saveUpload(file, dir, prefix) {
  const rel = `${dir}/${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${ALLOWED[file.mimetype]}`;
  fs.writeFileSync(path.join(UPLOADS, rel), file.buffer);
  return rel;
}

const publicSettings = (s) => ({
  team_name: s.team_name,
  tagline: s.tagline,
  subtitle: s.subtitle,
  event_date_label: s.event_date_label,
  pickup_label: s.pickup_label,
  location_note: s.location_note,
  pickup_address: s.pickup_address,
  pickup_city: s.pickup_city,
  delivery_enabled: s.delivery_enabled === '1',
  delivery_note: s.delivery_note,
  instagram: s.instagram,
  whatsapp_number: s.whatsapp_number,
  pix_key: s.pix_key,
  pix_name: s.pix_name,
  accepting_orders: s.accepting_orders === '1',
  require_receipt: s.require_receipt === '1',
  avatar_image: s.avatar_image ? '/uploads/' + s.avatar_image : '/img/perfil.webp',
  cover_image: s.cover_image ? '/uploads/' + s.cover_image : '/img/capa.webp',
});

const publicOrder = (o, events) => ({
  number: o.number_label,
  code: o.code,
  customer_name: o.customer_name,
  items: o.items,
  total_cents: o.total_cents,
  subtotal_cents: o.subtotal_cents ?? o.total_cents,
  delivery_mode: o.delivery_mode,
  bairro: o.bairro,
  address: o.address,
  address_ref: o.address_ref,
  delivery_fee_cents: o.delivery_fee_cents,
  delivery_km: o.delivery_km,
  fee_extra: o.fee_extra,
  fee_paid: o.fee_paid,
  status: o.status,
  status_info: o.status_info,
  has_receipt: o.has_receipt,
  wa_linked: !!o.wa_jid,
  ref: o.code.slice(0, 6),
  created_at: o.created_at,
  events: events || store.orderEvents(o.id),
});

// ---------- public API ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/menu', (req, res) => {
  const products = store.db
    .prepare('SELECT id, name, description, price_cents, category, emoji, image, featured, badge FROM products WHERE active = 1 ORDER BY sort, id')
    .all()
    .map((p) => ({ ...p, image: imgUrl(p.image) }));
  res.json({ settings: publicSettings(store.getSettings()), products, statuses: store.STATUSES });
});

// Estimativa da taxa de entrega (a mesma conta é refeita no servidor ao criar o pedido).
app.post('/api/delivery/quote', rateLimit(40, 10 * 60000), async (req, res) => {
  try {
    const s = store.getSettings();
    if (s.delivery_enabled !== '1') return res.status(400).json({ error: 'Entrega indisponível.' });
    const d = await geo.priceDelivery({ address: req.body.address, bairro: req.body.bairro, cep: req.body.cep });
    res.json({ km: d.km, fee_cents: d.fee_cents, approx: d.approx, too_far: !!d.too_far, max_km: d.max_km ?? null });
  } catch (e) {
    res.json({ km: null, fee_cents: null, approx: false });
  }
});

app.post('/api/orders', rateLimit(10, 10 * 60000), upload.single('receipt'), async (req, res) => {
  try {
    const s = store.getSettings();
    if (s.accepting_orders !== '1') return res.status(403).json({ error: 'A pré-venda está encerrada.' });
    let items;
    try {
      items = JSON.parse(req.body.items || '[]');
    } catch {
      return res.status(400).json({ error: 'Itens inválidos.' });
    }
    let delivery = null;
    try { delivery = JSON.parse(req.body.delivery || 'null'); } catch {}
    if (delivery && delivery.mode === 'entrega') {
      store.resolveDelivery({ ...delivery, fee_cents: 0 }, items); // valida antes de gastar uma consulta de mapa
      delivery = await geo.priceDelivery(delivery); // a taxa é sempre calculada aqui, nunca vinda do cliente
      if (delivery.too_far) return res.status(400).json({ error: `Esse endereço fica a ≈ ${String(delivery.km).replace('.', ',')} km e só entregamos até ${String(delivery.max_km).replace('.', ',')} km. Escolha a retirada no local.` });
    }
    let order = store.createOrder({
      customer_name: req.body.name || '',
      phone: req.body.phone || '',
      notes: req.body.notes || '',
      items,
      delivery,
      source: 'site',
    });
    if (req.file) {
      const rel = saveUpload(req.file, 'receipts', String(order.id));
      order = store.attachReceipt(order.id, rel, req.file.mimetype);
    }
    res.json({ order: publicOrder(order) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/orders/:code', (req, res) => {
  const o = store.getOrderByCode(req.params.code);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  res.json({ order: publicOrder(o) });
});

// Attach / replace receipt after ordering (customer only knows the code).
app.post('/api/orders/:code/receipt', rateLimit(10, 10 * 60000), upload.single('receipt'), (req, res) => {
  const o = store.getOrderByCode(req.params.code);
  if (!o) return res.status(404).json({ error: 'Pedido não encontrado.' });
  if (!req.file) return res.status(400).json({ error: 'Envie uma imagem ou PDF.' });
  const rel = saveUpload(req.file, 'receipts', String(o.id));
  res.json({ order: publicOrder(store.attachReceipt(o.id, rel, req.file.mimetype)) });
});

// Lookup by number + phone (so numbers alone can't be enumerated).
app.post('/api/orders/lookup', rateLimit(20, 10 * 60000), (req, res) => {
  const phone = store.normalizePhone(req.body.phone);
  const orders = store.findOrdersByPhone(phone, 20);
  const n = parseInt(String(req.body.number || '').replace(/\D/g, ''), 10);
  const found = n ? orders.filter((o) => o.number === n) : orders;
  if (!found.length) return res.status(404).json({ error: 'Nenhum pedido encontrado com esses dados.' });
  res.json({ orders: found.map((o) => publicOrder(o)) });
});

// ---------- WhatsApp webhook ----------
app.post(['/api/whatsapp/webhook', '/api/whatsapp/webhook/:event'], (req, res) => {
  if (req.query.token !== wa.webhookSecret()) return res.status(401).end();
  res.json({ ok: true });
  const body = req.body || {};
  if (!body.event && req.params.event) body.event = req.params.event;
  wa.handleWebhook(body).catch((e) => console.error('[wa]', e));
});

// ---------- admin API ----------
app.post('/api/admin/login', rateLimit(10, 10 * 60000), (req, res) => {
  const pw = String(req.body.password || '');
  const ok = ADMIN_PASSWORD && pw.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(ADMIN_PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Senha incorreta.' });
  res.setHeader('Set-Cookie', `adm=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}${req.secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'adm=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const chats = store.chatStates();
  const orders = store.listOrders({ status: req.query.status, q: req.query.q }).map((o) => ({ ...o, chat: o.wa_jid ? chats[o.wa_jid] || null : null }));
  res.json({ orders, stats: store.stats(), statuses: store.ALL_STATUSES, help: Object.values(chats).filter((c) => c.human_status === 'requested').length, unread: Object.values(chats).reduce((a, c) => a + (c.unread || 0), 0) });
});

app.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const o = store.getOrderById(req.params.id);
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  res.json({ order: o, events: store.orderEvents(o.id) });
});

app.patch('/api/admin/orders/:id', requireAdmin, (req, res) => {
  try {
    const before = store.getOrderById(req.params.id);
    if (!before) return res.status(404).json({ error: 'Não encontrado' });
    let o = before;
    if (req.body.status) o = store.updateOrderStatus(o.id, req.body.status);
    if (typeof req.body.notes === 'string') {
      store.db.prepare('UPDATE orders SET notes = ? WHERE id = ?').run(req.body.notes.slice(0, 300), o.id);
      o = store.getOrderById(o.id);
    }
    res.json({ order: o });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Teste do cálculo de distância (Ajustes): mostra o passo a passo das buscas no mapa.
app.post('/api/admin/delivery/test', requireAdmin, async (req, res) => {
  const trace = [];
  const s = store.getSettings();
  if (req.body.reset_origin) { store.setSetting('pickup_lat', ''); store.setSetting('pickup_lng', ''); }
  const d = await geo.priceDelivery({ address: req.body.address, bairro: req.body.bairro, cep: req.body.cep }, trace);
  const s2 = store.getSettings();
  res.json({ km: d.km, fee_cents: d.fee_cents, too_far: !!d.too_far, approx: d.approx, precision: d.precision || null, origin: s2.pickup_lat ? { lat: s2.pickup_lat, lng: s2.pickup_lng } : null, pickup_address: s.pickup_address, trace });
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const o = store.deleteOrder(req.params.id);
  if (!o) return res.status(404).json({ error: 'Não encontrado' });
  console.log(`[admin] pedido #${o.number_label} excluído (${o.customer_name}, ${o.total_cents})`);
  res.json({ ok: true });
});

// Taxa de pedidos que ficaram "a combinar": calcula pela distância (ou valor manual) e controla o pagamento à parte.
app.post('/api/admin/orders/:id/fee', requireAdmin, async (req, res) => {
  try {
    const o = store.getOrderById(req.params.id);
    if (!o || o.delivery_mode !== 'entrega') return res.status(400).json({ error: 'Pedido sem entrega.' });
    if (o.delivery_fee_cents != null && !o.fee_extra) return res.status(400).json({ error: 'A taxa deste pedido já foi paga junto com o pedido.' });
    if (req.body.fee != null && req.body.fee !== '') {
      const cents = Math.round(parseFloat(String(req.body.fee).replace(',', '.')) * 100);
      if (!Number.isFinite(cents) || cents < 0 || cents > 100000) return res.status(400).json({ error: 'Valor inválido.' });
      return res.json({ order: store.setLateFee(o.id, cents, null) });
    }
    const d = await geo.priceDelivery({ address: o.address, bairro: o.bairro });
    if (d.too_far) return res.json({ order: o, too_far: true, km: d.km, max_km: d.max_km });
    if (d.fee_cents == null) return res.status(400).json({ error: 'Não consegui localizar o endereço no mapa. Informe o valor manualmente.' });
    res.json({ order: store.setLateFee(o.id, d.fee_cents, d.km) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/admin/orders/:id/fee/paid', requireAdmin, (req, res) => {
  const o = store.getOrderById(req.params.id);
  if (!o || !o.fee_extra) return res.status(400).json({ error: 'Este pedido não tem taxa à parte.' });
  res.json({ order: store.setFeePaid(o.id, !!req.body.paid) });
});
app.get('/api/admin/orders/:id/fee/pix', requireAdmin, (req, res) => {
  const o = store.getOrderById(req.params.id);
  if (!o || !o.fee_extra || !(o.delivery_fee_cents > 0)) return res.status(400).json({ error: 'Sem taxa a cobrar.' });
  const s = store.getSettings();
  res.json({ payload: buildPixPayload({ key: s.pix_key, name: s.pix_name, city: s.pix_city, amountCents: o.delivery_fee_cents, txid: 'MIN' + o.number_label + 'TX' }) });
});

app.get('/api/admin/orders/:id/receipt', requireAdmin, (req, res) => {
  const o = store.getOrderById(req.params.id);
  if (!o || !o.receipt_path) return res.status(404).end();
  const file = path.join(UPLOADS, o.receipt_path);
  if (!file.startsWith(path.join(UPLOADS, 'receipts'))) return res.status(400).end();
  res.type(o.receipt_mime || 'application/octet-stream').sendFile(file);
});

// Manual order (e.g. balcão) created from the admin.
app.post('/api/admin/orders', requireAdmin, (req, res) => {
  try {
    const o = store.createOrder({ ...req.body, source: 'admin' });
    if (req.body.status && req.body.status !== 'pedido_feito') store.updateOrderStatus(o.id, req.body.status);
    res.json({ order: store.getOrderById(o.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/export.csv', requireAdmin, (req, res) => {
  const rows = [['numero', 'data', 'nome', 'telefone', 'itens', 'total', 'status', 'origem', 'comprovante', 'observacoes', 'recebimento', 'bairro', 'endereco', 'referencia', 'taxa']];
  for (const o of store.listOrders().reverse()) {
    rows.push([
      o.number_label,
      o.created_at,
      o.customer_name,
      o.phone,
      o.items.map((l) => `${l.qty}x ${l.name}`).join(' | '),
      (o.total_cents / 100).toFixed(2).replace('.', ','),
      o.status_info.label,
      o.source,
      o.has_receipt ? 'sim' : 'não',
      o.notes,
      o.delivery_mode === 'entrega' ? 'entrega' : 'retirada',
      o.bairro || '',
      o.address || '',
      o.address_ref || '',
      o.delivery_mode === 'entrega' ? (o.delivery_fee_cents == null ? 'a combinar' : (o.delivery_fee_cents / 100).toFixed(2).replace('.', ',')) : '',
    ]);
  }
  const csv = '﻿' + rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(';')).join('\r\n');
  res.setHeader('Content-Disposition', 'attachment; filename="pedidos-minionarios.csv"');
  res.type('text/csv').send(csv);
});

// Conversas do WhatsApp (somente leitura)
app.get('/api/admin/chats', requireAdmin, (req, res) => res.json({ chats: store.listChats() }));
app.get('/api/admin/chats/:jid', requireAdmin, (req, res) => {
  const chat = store.getChat(req.params.jid);
  if (!chat) return res.status(404).json({ error: 'Conversa não encontrada' });
  store.markChatRead(req.params.jid);
  const orders = store.db.prepare('SELECT id, number, status, total_cents FROM orders WHERE wa_jid = ? ORDER BY id DESC').all(req.params.jid);
  res.json({ chat: { ...chat, unread: 0 }, messages: store.chatMessages(req.params.jid), orders });
});
app.post('/api/admin/chats/:jid/human', requireAdmin, (req, res) => {
  const st = req.body.status;
  if (!['none', 'handling'].includes(st)) return res.status(400).json({ error: 'Status inválido' });
  store.setHuman(req.params.jid, st, st === 'handling' ? 'Equipe atendendo (painel)' : null);
  res.json({ ok: true });
});
app.get('/api/admin/media/:id', requireAdmin, (req, res) => {
  const m = store.db.prepare('SELECT media_path, media_mime FROM wa_messages WHERE id = ?').get(req.params.id);
  if (!m || !m.media_path) return res.status(404).end();
  const base = path.join(UPLOADS, 'chat');
  const file = path.join(UPLOADS, m.media_path);
  if (!file.startsWith(base)) return res.status(400).end();
  res.type(m.media_mime || 'application/octet-stream').sendFile(file);
});

// Products
app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json({
    products: store.db
      .prepare('SELECT * FROM products ORDER BY sort, id')
      .all()
      .map((p) => ({ ...p, image_url: imgUrl(p.image) })),
  });
});
function productFields(b) {
  const out = {};
  if (b.name !== undefined) out.name = String(b.name).trim().slice(0, 60);
  if (b.description !== undefined) out.description = String(b.description).trim().slice(0, 200);
  if (b.price !== undefined) out.price_cents = Math.round(parseFloat(String(b.price).replace(',', '.')) * 100);
  if (b.category !== undefined) out.category = String(b.category).trim().slice(0, 40) || 'Cardápio';
  if (b.emoji !== undefined) out.emoji = String(b.emoji).trim().slice(0, 8) || '🍔';
  if (b.active !== undefined) out.active = b.active === true || b.active === 'true' || b.active === '1' || b.active === 1 ? 1 : 0;
  if (b.sort !== undefined) out.sort = parseInt(b.sort, 10) || 0;
  if (b.featured !== undefined) out.featured = b.featured === true || b.featured === 'true' || b.featured === '1' || b.featured === 1 ? 1 : 0;
  if (b.badge !== undefined) out.badge = String(b.badge).trim().slice(0, 24);
  if (out.price_cents !== undefined && !(out.price_cents >= 0)) throw new Error('Preço inválido.');
  return out;
}
app.post('/api/admin/products', requireAdmin, upload.single('image'), (req, res) => {
  try {
    const f = productFields(req.body);
    if (!f.name || f.price_cents === undefined) throw new Error('Nome e preço são obrigatórios.');
    if (req.file) f.image = saveUpload(req.file, 'products', 'p');
    const cols = Object.keys(f);
    const info = store.db.prepare(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map((c) => '@' + c).join(',')})`).run(f);
    res.json({ id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.put('/api/admin/products/:id', requireAdmin, upload.single('image'), (req, res) => {
  try {
    const f = productFields(req.body);
    if (req.file) f.image = saveUpload(req.file, 'products', 'p');
    if (req.body.remove_image === '1') f.image = null;
    const cols = Object.keys(f);
    if (cols.length) store.db.prepare(`UPDATE products SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id`).run({ ...f, id: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete('/api/admin/products/:id', requireAdmin, (req, res) => {
  // Soft delete keeps history consistent.
  store.db.prepare('UPDATE products SET active = 0, sort = 9999 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Settings
const EDITABLE = [
  'team_name', 'tagline', 'subtitle', 'event_date_label', 'pickup_label', 'location_note', 'instagram',
  'whatsapp_number', 'pix_key', 'pix_name', 'pix_city', 'accepting_orders', 'delivery_per_km', 'delivery_round', 'delivery_min', 'delivery_base_km', 'delivery_max_km', 'pickup_lat', 'pickup_lng',
  'require_receipt', 'next_order_number', 'pickup_address', 'pickup_city', 'delivery_enabled', 'delivery_note',
];
app.get('/api/admin/settings', requireAdmin, (req, res) => {
  const s = store.getSettings();
  res.json({
    settings: { ...s, avatar_url: s.avatar_image ? '/uploads/' + s.avatar_image : '', cover_url: s.cover_image ? '/uploads/' + s.cover_image : '' },
  });
});
app.put(
  '/api/admin/settings',
  requireAdmin,
  upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'cover', maxCount: 1 }]),
  (req, res) => {
    for (const k of EDITABLE) if (req.body[k] !== undefined) store.setSetting(k, String(req.body[k]).trim());
    if (req.files?.avatar?.[0]) store.setSetting('avatar_image', saveUpload(req.files.avatar[0], 'brand', 'avatar'));
    if (req.files?.cover?.[0]) store.setSetting('cover_image', saveUpload(req.files.cover[0], 'brand', 'cover'));
    res.json({ ok: true });
  }
);

// WhatsApp admin
app.get('/api/admin/whatsapp', requireAdmin, async (req, res) => {
  const base = { configured: wa.isConfigured(), manage: wa.cfg().manage, instance: wa.cfg().instance, webhook: wa.cfg().publicUrl ? wa.webhookUrl() : null };
  if (!base.configured) return res.json(base);
  try {
    res.json({ ...base, ...(await wa.connectionState()) });
  } catch (e) {
    res.json({ ...base, error: e.message });
  }
});
// Criar instância, ler QR e desconectar só quando EVOLUTION_AUTO_SETUP=true.
const requireManage = (req, res, next) =>
  wa.cfg().manage ? next() : res.status(403).json({ error: 'Gerenciado pelas variáveis: defina EVOLUTION_AUTO_SETUP=true para usar isto.' });
app.post('/api/admin/whatsapp/setup', requireAdmin, requireManage, async (req, res) => {
  try {
    res.json(await wa.setupInstance());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.get('/api/admin/whatsapp/qr', requireAdmin, requireManage, async (req, res) => {
  try {
    res.json(await wa.getQr());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/admin/whatsapp/logout', requireAdmin, requireManage, async (req, res) => {
  try {
    res.json(await wa.logout());
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- static ----------
app.use('/uploads/products', express.static(path.join(UPLOADS, 'products'), { maxAge: '7d' }));
app.use('/uploads/brand', express.static(path.join(UPLOADS, 'brand'), { maxAge: '7d' }));
app.use(express.static(PUBLIC, { extensions: ['html'], maxAge: '5m' }));
app.get('/admin', (req, res) => res.sendFile(path.join(PUBLIC, 'admin.html')));
app.get('/pedido', (req, res) => res.sendFile(path.join(PUBLIC, 'pedido.html')));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande (máx. 10 MB).' : 'Erro interno.' });
});

// Ao iniciar, tenta calcular a taxa dos pedidos de entrega que ficaram "a combinar" (um por vez; o mapa limita a 1/s).
async function backfillFees() {
  for (const id of store.ordersWithoutFee()) {
    try {
      const o = store.getOrderById(id);
      const d = await geo.priceDelivery({ address: o.address, bairro: o.bairro });
      if (d.fee_cents != null) { store.setLateFee(id, d.fee_cents, d.km); console.log(`[taxa] pedido #${o.number_label}: ${d.km} km → ${d.fee_cents}`); }
      else if (d.too_far) console.log(`[taxa] pedido #${o.number_label}: ${d.km} km, fora da área`);
    } catch (e) { console.error('[taxa]', e.message); }
  }
}

app.listen(PORT, () => {
  console.log(`Minionários rodando na porta ${PORT}`);
  // Com EVOLUTION_AUTO_SETUP=true, cria a instância e registra o webhook (só falta ler o QR no celular).
  // Sem isso, o app não mexe na Evolution: só envia mensagens pela instância de EVOLUTION_INSTANCE.
  backfillFees();
  if (wa.isConfigured() && wa.cfg().publicUrl && wa.cfg().manage) {
    wa.setupInstance()
      .then((st) => console.log('[wa] instância pronta:', st.state))
      .catch((e) => console.error('[wa] auto-setup falhou:', e.message));
  }
});
