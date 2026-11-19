// WhatsApp bot over Evolution API v2. 100% reativo: só responde a quem escreveu primeiro
// (nenhuma mensagem automática é enviada por iniciativa do sistema — evita banimento).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const { buildPixPayload, pixQrPng } = require('./pix');
const geo = require('./geo');
const normB = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
fs.mkdirSync(path.join(store.DATA_DIR, 'uploads', 'chat'), { recursive: true });

const cfg = () => ({
  url: (process.env.EVOLUTION_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.EVOLUTION_API_KEY || '',
  instance: process.env.EVOLUTION_INSTANCE || 'minionarios',
  // Só cria/altera a instância e o webhook na Evolution se isso estiver ligado nas variáveis.
  manage: /^(1|true|sim|yes)$/i.test(process.env.EVOLUTION_AUTO_SETUP || ''),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
});
const webhookSecret = () =>
  process.env.WEBHOOK_SECRET ||
  crypto.createHash('sha256').update('wh:' + (process.env.ADMIN_PASSWORD || 'minion') + (process.env.EVOLUTION_API_KEY || '')).digest('hex').slice(0, 32);

const isConfigured = () => !!(cfg().url && cfg().apiKey);

async function evo(method, p, body) {
  const { url, apiKey } = cfg();
  if (!url || !apiKey) throw new Error('Evolution API não configurada (EVOLUTION_URL / EVOLUTION_API_KEY).');
  const res = await fetch(url + p, {
    method,
    headers: { apikey: apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json?.response?.message || json?.message || text;
    const err = new Error(`Evolution ${method} ${p} → ${res.status}: ${JSON.stringify(msg).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const webhookUrl = () => `${cfg().publicUrl}/api/whatsapp/webhook?token=${webhookSecret()}`;
const webhookConfig = () => ({
  enabled: true,
  url: webhookUrl(),
  byEvents: false,
  base64: true,
  events: ['MESSAGES_UPSERT'],
});

// ---------- Admin helpers ----------
async function connectionState() {
  const { instance } = cfg();
  try {
    const r = await evo('GET', `/instance/connectionState/${instance}`);
    return { exists: true, state: r?.instance?.state || r?.state || 'unknown' };
  } catch (e) {
    if (e.status === 404) return { exists: false, state: 'not_created' };
    throw e;
  }
}

async function setupInstance() {
  const { instance } = cfg();
  const st = await connectionState();
  if (!st.exists) {
    await evo('POST', '/instance/create', {
      instanceName: instance,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
      rejectCall: true,
      msgCall: 'Não atendemos ligações por aqui 🙂 Mande uma mensagem!',
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      webhook: webhookConfig(),
    });
  }
  await evo('POST', `/webhook/set/${instance}`, { webhook: webhookConfig() });
  return connectionState();
}

async function getQr() {
  const { instance } = cfg();
  const num = String(process.env.WHATSAPP_NUMBER || '').replace(/\D/g, '');
  const r = await evo('GET', `/instance/connect/${instance}${num ? `?number=${num}` : ''}`);
  return { base64: r.base64 || null, pairingCode: r.pairingCode || null, code: r.code || null };
}

async function logout() {
  const { instance } = cfg();
  return evo('DELETE', `/instance/logout/${instance}`);
}

// ---------- Sending ----------
const lastBot = new Map(); // jid -> quando o bot falou por último (para não confundir o eco com resposta humana)
async function sendText(to, text) {
  lastBot.set(to, Date.now());
  const r = await evo('POST', `/message/sendText/${cfg().instance}`, { number: to, text });
  store.logMessage({ jid: to, direction: 'out', kind: 'text', body: text, wa_id: r?.key?.id || null });
  return r;
}
async function sendImage(to, pngBuffer, caption) {
  lastBot.set(to, Date.now());
  const r = await evo('POST', `/message/sendMedia/${cfg().instance}`, {
    number: to,
    mediatype: 'image',
    mimetype: 'image/png',
    caption,
    media: pngBuffer.toString('base64'),
    fileName: 'pix.png',
  });
  store.logMessage({ jid: to, direction: 'out', kind: 'image', body: caption, wa_id: r?.key?.id || null });
  return r;
}

const fmtPhone = (p) => {
  const d = String(p).replace(/^55/, '');
  return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : p;
};
const brl = (c) => 'R$ ' + (c / 100).toFixed(2).replace('.', ',');

function menuProducts() {
  return store.db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY sort, id').all();
}

function catalogText(products) {
  let cat = null;
  const lines = [];
  products.forEach((p, i) => {
    if (p.category !== cat) {
      cat = p.category;
      lines.push(`\n*${cat}*`);
    }
    lines.push(`*${i + 1}.* ${p.emoji} ${p.name} — ${brl(p.price_cents)}${p.description ? `\n      _${p.description}_` : ''}`);
  });
  return lines.join('\n').trim();
}

function bagText(bag) {
  if (!bag.length) return '_Sacola vazia_';
  const total = bag.reduce((s, l) => s + l.qty * l.unit_cents, 0);
  return bag.map((l) => `• ${l.qty}x ${l.name} — ${brl(l.qty * l.unit_cents)}`).join('\n') + `\n*Total: ${brl(total)}*`;
}

/** Parses "1", "2x3", "3 x 2", "1, 4, 4" into [{index, qty}]. Format qty x item. */
function parseItems(text) {
  const out = [];
  const cleaned = text.toLowerCase().replace(/[*_]/g, '').replace(/\s*x\s*/g, 'x');
  for (const tok of cleaned.split(/[\s,;+e]+/).filter(Boolean)) {
    let m;
    if ((m = tok.match(/^(\d{1,2})x(\d{1,2})$/))) out.push({ qty: +m[1], index: +m[2] });
    else if ((m = tok.match(/^(\d{1,2})$/))) out.push({ qty: 1, index: +m[1] });
    else return null;
  }
  return out.length ? out : null;
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function extractText(msg) {
  return (
    msg?.conversation ||
    msg?.extendedTextMessage?.text ||
    msg?.imageMessage?.caption ||
    msg?.documentMessage?.caption ||
    msg?.buttonsResponseMessage?.selectedDisplayText ||
    msg?.listResponseMessage?.title ||
    ''
  );
}

function resolvePhone(data) {
  const k = data.key || {};
  const candidates = [k.remoteJid, k.senderPn, k.remoteJidAlt, data.senderPn, k.participantPn];
  for (const c of candidates) {
    if (c && /@s\.whatsapp\.net$/.test(c)) return c.split('@')[0].split(':')[0];
  }
  return null;
}

function siteUrl(p = '') {
  return (cfg().publicUrl || '') + p;
}

/** Orders for this chat: linked by WhatsApp JID or matching phone. */
function ordersFor(jid, phone, limit = 5) {
  const byJid = store.db.prepare('SELECT id FROM orders WHERE wa_jid = ? ORDER BY id DESC LIMIT ?').all(jid, limit).map((r) => store.getOrderById(r.id));
  const byPhone = phone ? store.findOrdersByPhone(phone, limit) : [];
  const seen = new Set();
  return [...byJid, ...byPhone].filter((o) => !seen.has(o.id) && seen.add(o.id)).sort((a, b) => b.id - a.id).slice(0, limit);
}

function statusText(orders) {
  if (!orders.length) return 'Não encontrei pedidos para este número 🤔\nSe você fez o pedido com outro telefone, consulte pelo site: ' + siteUrl('/pedido');
  return (
    '*Seus pedidos:*\n\n' +
    orders
      .map(
        (o) =>
          `*Pedido #${o.number_label}* — ${brl(o.total_cents)}\n${o.items.map((l) => `${l.qty}x ${l.name}`).join(', ')}\nStatus: ${o.status_info.emoji} *${o.status_info.label}*${
            o.has_receipt ? '' : o.status === 'pedido_feito' ? '\n⚠️ Ainda sem comprovante. Envie a foto do comprovante aqui.' : ''
          }${o.delivery_mode === 'entrega' && (o.fee_extra || o.delivery_fee_cents == null) ? `\n🛵 Taxa de entrega: ${feeTxt(o)}` : ''}\nAcompanhe: ${siteUrl('/pedido?c=' + o.code)}`
      )
      .join('\n\n')
  );
}

const kmTxt = (km) => (km ? ` (≈ ${String(km).replace('.', ',')} km)` : '');
const feeTxt = (o) =>
  o.delivery_fee_cents == null
    ? 'a combinar com a equipe'
    : brl(o.delivery_fee_cents) + kmTxt(o.delivery_km) + (o.fee_extra ? (o.fee_paid ? ' — paga ✅' : ' — *pagar à parte* (a equipe combina com você)') : '');
const deliveryLine = (o) => `🛵 Entrega${o.bairro ? ' · ' + o.bairro : ''} — ${o.address}${o.address_ref ? ` (${o.address_ref})` : ''}\n      Taxa: ${feeTxt(o)}`;

const OPTIONS_TEXT = `*O que você pode fazer por aqui:*\n*2* — Acompanhar o status do pedido\n*pix* — Receber o código Pix de novo\n*4* — Falar com a equipe\n*menu* — Ver todas as opções`;

/** Customer came from the site with "pedido #012 ... Ref: abc123". */
async function confirmSiteOrder(jid, phone, number, ref, pushName) {
  const s = store.getSettings();
  const o = store.getOrderByNumber(number);
  const okRef = o && ref && o.code.slice(0, 6).toLowerCase() === ref.toLowerCase();
  const okPhone = o && phone && store.phoneKey(o.phone) === store.phoneKey(phone);
  if (!o || (!okRef && !okPhone)) {
    return sendText(jid, `Não encontrei o *pedido #${String(number).padStart(3, '0')}* 🤔\nConfira o número ou fale com a equipe por aqui mesmo.\n\n${OPTIONS_TEXT}`);
  }
  if (o.status === 'cancelado') return sendText(jid, `O *pedido #${o.number_label}* foi cancelado. Qualquer dúvida, é só responder esta mensagem.`);
  store.db.prepare('UPDATE orders SET wa_jid = ? WHERE id = ?').run(jid, o.id);
  store.saveSession(jid, 'receipt', { order_id: o.id });
  const first = (o.customer_name || pushName || '').split(' ')[0];
  const ent = o.delivery_mode === 'entrega';
  const itens = o.items.map((l) => `• ${l.qty}x ${l.name} — ${brl(l.subtotal_cents)}`).join('\n');
  const recv = ent
    ? deliveryLine(o)
    : `📍 Retirada no local${s.pickup_address ? ` — ${s.pickup_address}` : ''}`;
  await sendText(jid, `Oi${first ? ', ' + first : ''}! 💛💙 Recebemos o seu *pedido #${o.number_label}*.\n\n${itens}\n${recv}\n\n*Total: ${brl(o.total_cents)}*`);
  if (o.has_receipt || o.status !== 'pedido_feito') {
    return sendText(jid, `✅ Já temos o comprovante deste pedido. Status atual: ${o.status_info.emoji} *${o.status_info.label}*.\n\nQualquer dúvida, é só falar com a gente por este mesmo número.\n\n${OPTIONS_TEXT}`);
  }
  const payload = buildPixPayload({ key: s.pix_key, name: s.pix_name, city: s.pix_city, amountCents: o.total_cents, txid: 'MIN' + o.number_label });
  try {
    await sendImage(jid, await pixQrPng(payload), `💠 Pague *${brl(o.total_cents)}* via Pix — QR Code acima ou o código *copia e cola* da próxima mensagem.\nRecebedor: ${s.pix_name} · Chave: ${s.pix_key}`);
    await sendText(jid, payload);
  } catch (e) {
    console.error('[wa] erro ao enviar Pix:', e.message);
    await sendText(jid, `💠 Pix (chave): ${s.pix_key} · Valor: ${brl(o.total_cents)}`);
  }
  return sendText(jid, `📎 *Para confirmar o pedido, anexe aqui nesta conversa o comprovante do Pix* (foto, print ou PDF).\n\nQualquer dúvida, é só falar com a gente por este mesmo número.\n\n${OPTIONS_TEXT}`);
}

function mainMenuText(s, name) {
  return (
    `Olá${name ? ', ' + name.split(' ')[0] : ''}! 💛💙 Aqui é a equipe *${s.team_name}* — ${s.tagline}.\n\n` +
    `🍔 Pré-venda para *${s.event_date_label}* · ${s.pickup_label}\n\n` +
    `Responda com o número:\n*1* — Fazer pedido\n*2* — Acompanhar meu pedido\n*3* — Ver cardápio no site\n*4* — Falar com a equipe (dúvidas, cancelar ou alterar pedido)\n\n` +
    `_A qualquer momento, envie *menu* para voltar aqui._`
  );
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4' };
function mediaPart(msg) {
  const m = msg?.documentWithCaptionMessage?.message || msg || {};
  if (m.imageMessage) return { kind: 'image', part: m.imageMessage };
  if (m.videoMessage) return { kind: 'video', part: m.videoMessage };
  if (m.audioMessage) return { kind: 'audio', part: m.audioMessage };
  if (m.documentMessage) return { kind: 'document', part: m.documentMessage };
  if (m.stickerMessage) return { kind: 'sticker', part: m.stickerMessage };
  return { kind: 'text', part: null };
}

/** Baixa a mídia recebida e guarda em uploads/chat. Devolve { rel, mime } ou null. */
async function saveInboundMedia(data, mp) {
  let b64 = data.message?.base64 || data.base64;
  let mime = (mp.part.mimetype || '').split(';')[0] || 'application/octet-stream';
  if (!b64) {
    const r = await evo('POST', `/chat/getBase64FromMediaMessage/${cfg().instance}`, { message: { key: data.key }, convertToMp4: false });
    b64 = r.base64;
    mime = (r.mimetype || mime).split(';')[0];
  }
  if (!b64) return null;
  const buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length || buf.length > 25 * 1024 * 1024) return null;
  const rel = `chat/${Date.now()}-${crypto.randomBytes(3).toString('hex')}.${EXT[mime] || 'bin'}`;
  fs.writeFileSync(path.join(store.DATA_DIR, 'uploads', rel), buf);
  return { rel, mime, buf };
}

function saveReceipt(orderId, buf, mime) {
  const ext = mime.includes('pdf') ? 'pdf' : mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const rel = `receipts/${orderId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(store.DATA_DIR, 'uploads', rel), buf);
  return store.attachReceipt(orderId, rel, mime);
}

async function sendPix(jid, order, s) {
  const payload = buildPixPayload({
    key: s.pix_key,
    name: s.pix_name,
    city: s.pix_city,
    amountCents: order.total_cents,
    txid: 'MIN' + order.number_label,
  });
  const png = await pixQrPng(payload);
  await sendImage(
    jid,
    png,
    `*Pedido #${order.number_label}* registrado! 🎉\n\n${order.delivery_mode === 'entrega' ? bagText(order.items).replace('*Total:', '*Itens:') : bagText(order.items)}${order.delivery_mode === 'entrega' ? `\n🛵 Taxa de entrega: ${feeTxt(order)}` : ''}\n\n` +
      `💠 Pague *${brl(order.total_cents)}* via Pix (QR Code acima ou o código *copia e cola* da próxima mensagem).\n` +
      `Recebedor: ${s.pix_name} · Chave: ${s.pix_key}`
  );
  await sendText(jid, payload);
  await sendText(
    jid,
    `📎 Depois de pagar, *envie aqui a foto ou PDF do comprovante*.\n\nAcompanhe o status: ${siteUrl('/pedido?c=' + order.code)}\nOu envie *2* a qualquer momento.`
  );
}

// ---------- Inbound ----------
async function handleWebhook(body) {
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return;
  const items = Array.isArray(body.data) ? body.data : [body.data];
  for (const data of items) {
    try {
      await handleMessage(data);
    } catch (e) {
      console.error('[wa] erro ao processar mensagem:', e.message);
    }
  }
}

const IN_PROGRESS = ['ordering', 'name', 'phone', 'mode', 'address', 'address_pick', 'address_num', 'confirm'];
const HELP_RE = /\b(atendente|humano|ajuda|suporte|reclama\w*|problema|falar com (a |um |uma )?(equipe|atendente|humano|pessoa)|(cancelar|alterar|trocar|mudar) (o |meu |esse |este )?pedido)\b/;

const HELP_REPLY = `🙋 Certo! Avisei a equipe — *uma pessoa da equipe vai entrar em contato com você em breve* (pode ser por outro número).\n\nEnquanto isso, continuo por aqui:\n*2* — Acompanhar o status do pedido\n*menu* — Ver todas as opções`;
function requestHuman(jid, reason) {
  store.setHuman(jid, 'requested', reason);
  // Fora de um pedido em andamento, entra em "aguardando equipe": comandos seguem funcionando,
  // e o texto livre (a pessoa explicando o problema) só fica registrado para a equipe.
  if (!IN_PROGRESS.includes(store.getSession(jid).state)) store.saveSession(jid, 'help', {});
  return sendText(jid, HELP_REPLY);
}

/** Pedidos desta conversa/telefone que ainda esperam comprovante (mais antigo primeiro). */
function awaitingOrders(jid, phone) {
  const ids = store.db.prepare("SELECT id FROM orders WHERE wa_jid = ? AND receipt_path IS NULL AND status = 'pedido_feito'").all(jid).map((r) => r.id);
  if (phone) for (const o of store.findOrdersByPhone(phone, 10)) if (!o.has_receipt && o.status === 'pedido_feito') ids.push(o.id);
  return [...new Set(ids)].sort((a, b) => a - b).map((id) => store.getOrderById(id));
}

const RECEIPT_OK = (labels) =>
  `✅ Comprovante recebido para o${labels.length > 1 ? 's' : ''} *pedido${labels.length > 1 ? 's' : ''} ${labels.map((l) => '#' + l).join(' e ')}*!\n\nAssim que a equipe conferir o pagamento, o status muda para *Pagamento confirmado*. Qualquer dúvida, é só falar com a gente por este mesmo número.\n\n*2* — Acompanhar o status do pedido\n*4* — Falar com a equipe\n*menu* — Ver todas as opções`;

function receiptPickText(orders) {
  const opts = orders.map((o, i) => `*${i + 1}* — Pedido #${o.number_label} (${brl(o.total_cents)})`);
  const all = orders.reduce((a, o) => a + o.total_cents, 0);
  opts.push(`*${orders.length + 1}* — ${orders.length === 2 ? 'Dos dois' : 'De todos'} (${brl(all)})`);
  return `📎 Recebi o comprovante! Você tem mais de um pedido aguardando pagamento.\n\n*Esse comprovante é de qual pedido?*\n${opts.join('\n')}`;
}

/** Mensagem enviada por uma pessoa da equipe pelo celular do bot: registra e pausa o bot nessa conversa. */
function handleOwnMessage(data, jid) {
  const waId = data.key.id;
  if (store.messageSeen(waId) || !store.markSeen(waId)) return;
  if (Date.now() - (lastBot.get(jid) || 0) < 4000) return; // eco do que o próprio bot acabou de enviar
  const mp = mediaPart(data.message || {});
  const body = extractText(data.message || {}).trim();
  if (mp.kind === 'text' && !body) return;
  store.logMessage({ jid, direction: 'human', kind: mp.kind, body, wa_id: waId });
  const c = store.getChat(jid);
  if (!c || c.human_status !== 'handling') store.setHuman(jid, 'handling', 'Equipe respondeu pelo celular');
  else store.touchHuman(jid);
}

async function handleMessage(data) {
  if (!data?.key) return;
  const jid = data.key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  if (data.key.fromMe) return handleOwnMessage(data, jid);
  if (!store.markSeen(data.key.id)) return;

  const s = store.getSettings();
  const msg = data.message || {};
  const text = extractText(msg).trim();
  const t = norm(text);
  const mp = mediaPart(msg);
  const phone = resolvePhone(data);
  const accepting = s.accepting_orders === '1';

  // Guarda tudo o que o cliente mandou (inclusive mídia) para consulta no admin.
  let media = null;
  if (mp.kind !== 'text' && mp.kind !== 'sticker') {
    try { media = await saveInboundMedia(data, mp); } catch (e) { console.error('[wa] mídia não baixada:', e.message); }
  }
  store.logMessage({ jid, direction: 'in', kind: mp.kind, body: text, media_path: media?.rel || null, media_mime: media?.mime || null, wa_id: data.key.id, phone, name: data.pushName || null });

  const session = store.getSession(jid);
  const reply = (txt) => sendText(jid, txt);
  const isFile = mp.kind === 'image' || mp.kind === 'document';

  // Comprovante: anexa ao pedido que está aguardando (mesmo com o bot pausado, só que sem responder).
  const paused = store.botPaused(jid);
  if (isFile && media) {
    const waiting = awaitingOrders(jid, phone);
    if (waiting.length === 1) {
      const order = waiting[0];
      saveReceipt(order.id, media.buf, media.mime);
      if (!order.wa_jid) store.db.prepare('UPDATE orders SET wa_jid = ? WHERE id = ?').run(jid, order.id);
      if (paused) return;
      store.saveSession(jid, 'main', {});
      return reply(RECEIPT_OK([order.number_label]));
    }
    // Mais de um pedido aguardando: pergunta a qual se refere (com o bot pausado, a equipe decide pelo painel).
    if (waiting.length > 1 && !paused) {
      store.saveSession(jid, 'receipt_pick', { media_rel: media.rel, mime: media.mime, ids: waiting.map((o) => o.id) });
      return reply(receiptPickText(waiting));
    }
  }
  if (paused) return; // equipe conversando por este número: o bot só registra
  if (isFile && !media && !text) return reply('Não consegui abrir esse arquivo 😕 Pode enviar de novo? Se preferir, envie *4* para falar com a equipe.');
  if (isFile && !text) return reply('Recebi seu arquivo, mas não encontrei um pedido aguardando comprovante. Envie *menu* para começar ou *4* para falar com a equipe.');
  if (mp.kind === 'audio' || mp.kind === 'video') return reply('Por aqui eu só entendo mensagens de texto e comprovantes (foto ou PDF) 😅 Para falar com um atendente, envie *4*.');
  if (mp.kind === 'sticker' && !text) return;

  // Order coming from the site: "pedido #012 ... Ref: abc123"
  const siteM = text.match(/pedido\s*\*?\s*#\s*(\d{1,4})/i);
  if (siteM && /confirmar/i.test(text)) {
    const refM = text.match(/ref\.?\s*:?\s*([A-Za-z0-9_-]{6})/i);
    return confirmSiteOrder(jid, phone, parseInt(siteM[1], 10), refM && refM[1], data.pushName);
  }

  // Falar com a equipe (palavras-chave; o "4" é tratado em cada estado onde faz sentido)
  if (HELP_RE.test(t) && !(session.state === 'ordering' && parseItems(text))) {
    const why = /(cancelar|alterar|trocar|mudar)/.test(t) ? 'Quer cancelar/alterar um pedido' : 'Pediu para falar com a equipe';
    return requestHuman(jid, `${why}: "${text.slice(0, 120)}"`);
  }

  // Global commands
  const GREET = ['menu', 'inicio', 'voltar', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite'];
  const inProgress = IN_PROGRESS.includes(session.state);
  if (t === 'cancelar') {
    if (inProgress) {
      store.saveSession(jid, 'main', {});
      return reply('Tudo bem, cancelei o que estava em andamento.\n\n' + mainMenuText(s, data.pushName));
    }
    if (ordersFor(jid, phone).some((o) => !['cancelado', 'concluido'].includes(o.status))) return requestHuman(jid, 'Pediu para cancelar um pedido');
    store.saveSession(jid, 'main', {});
    return reply(mainMenuText(s, data.pushName));
  }
  if (GREET.includes(t)) {
    if (inProgress) {
      const bag = session.data.bag || [];
      return reply(`Você está no meio de um pedido 🛍️\n\n${bag.length ? bagText(bag) + '\n\n' : ''}Pode continuar de onde parou. Para desistir e recomeçar, envie *cancelar*. Para falar com a equipe, envie *atendente*.`);
    }
    store.saveSession(jid, 'main', {});
    return reply(mainMenuText(s, data.pushName));
  }
  if (['status', 'meu pedido', 'acompanhar', 'consultar'].includes(t) || /^status\s*#?\d+$/.test(t)) {
    return reply(statusText(ordersFor(jid, phone)));
  }

  switch (session.state) {
    case 'main': {
      if (t === '1' || t.includes('pedido') || t.includes('pedir')) return startOrdering(jid, s, accepting);
      if (t === '2') return reply(statusText(ordersFor(jid, phone)));
      if (t === '3' || t.includes('cardapio')) return reply(`📲 Cardápio completo com fotos: ${siteUrl('/')}`);
      if (t === '4') return requestHuman(jid, 'Pediu atendente pelo menu');
      return reply('Não entendi 😅 Responda *1*, *2*, *3* ou *4* (falar com a equipe).\n\n' + mainMenuText(s));
    }
    case 'help': {
      if (t === '1') return startOrdering(jid, s, accepting);
      if (t === '2') return reply(statusText(ordersFor(jid, phone)));
      if (t === '3' || t.includes('cardapio')) return reply(`📲 Cardápio completo com fotos: ${siteUrl('/')}`);
      if (t === '4') return reply('Já avisei a equipe 🙋 Logo alguém entra em contato com você. Enquanto isso: *2* status · *menu* opções.');
      if (session.data.acked) return; // só registra (a equipe vê no painel)
      store.saveSession(jid, 'help', { acked: true });
      return reply('Anotado! 📝 A equipe vai ver sua mensagem. Se quiser, envie *2* para ver o status do pedido ou *menu* para as opções.');
    }
    case 'ordering': {
      const bag = session.data.bag || [];
      const map = session.data.map || [];
      if (['0', 'finalizar', 'fechar', 'pronto', 'ok'].includes(t)) {
        if (!bag.length) return reply('Sua sacola está vazia. Envie o número de um item 🙂');
        store.saveSession(jid, 'name', { ...session.data });
        return reply(`Ótimo! Qual o *nome* para o pedido?${data.pushName ? `\n\nOu envie *1* para usar "${data.pushName}".` : ''}`);
      }
      if (t === 'limpar') {
        store.saveSession(jid, 'ordering', { ...session.data, bag: [] });
        return reply('Sacola esvaziada. Envie os números dos itens.');
      }
      if (t === 'cardapio' || t === 'itens') return reply(catalogText(map.map((id) => menuProducts().find((p) => p.id === id)).filter(Boolean)));
      const parsed = parseItems(text);
      if (!parsed) return reply('Não entendi 😅 Envie o *número do item* (ex.: *1*) ou *quantidade x número* (ex.: *2x3*).\nEnvie *0* para finalizar ou *limpar* para esvaziar a sacola.');
      const products = menuProducts();
      for (const { index, qty } of parsed) {
        const p = products.find((x) => x.id === map[index - 1]);
        if (!p || qty < 1) return reply(`O item *${index}* não existe. Escolha de 1 a ${map.length}.`);
        const line = bag.find((l) => l.product_id === p.id);
        if (line) line.qty += qty;
        else bag.push({ product_id: p.id, name: p.name, qty, unit_cents: p.price_cents });
      }
      store.saveSession(jid, 'ordering', { ...session.data, bag });
      return reply(`🛍️ *Sua sacola:*\n${bagText(bag)}\n\nQuer mais alguma coisa? Envie outro número.\nEnvie *0* para *finalizar* · *limpar* para esvaziar.`);
    }
    case 'name': {
      let name = text;
      if (t === '1' && data.pushName) name = data.pushName;
      if (!name || name.length < 2 || /^\d+$/.test(name)) return reply('Por favor, envie o *nome* para o pedido.');
      const next = { ...session.data, name: name.slice(0, 80) };
      if (!phone) {
        store.saveSession(jid, 'phone', next);
        return reply('E qual o seu *telefone com DDD*? (ex.: 83 99999-9999)');
      }
      return afterContact(jid, { ...next, phone: store.normalizePhone(phone) });
    }
    case 'phone': {
      const p = store.normalizePhone(text);
      if (p.length < 12 || p.length > 13) return reply('Telefone inválido. Envie com DDD, ex.: 83 99999-9999');
      return afterContact(jid, { ...session.data, phone: p });
    }
    case 'mode': {
      if (t === '1' || t.includes('retir')) return askConfirm(jid, { ...session.data, delivery: { mode: 'retirada' } });
      if (t === '2' || t.includes('entreg') || t.includes('casa')) {
        store.saveSession(jid, 'address', session.data);
        return reply(ASK_CEP);
      }
      return reply('Responda *1* para retirar no local ou *2* para receber em casa.');
    }
    case 'address':
    case 'address_pick': {
      if (t === '1' && session.state === 'address') return askConfirm(jid, { ...session.data, delivery: { mode: 'retirada' } });
      const opts = session.state === 'address_pick' ? session.data.opts || [] : [];
      const n = /^\d{1,2}$/.test(t) ? parseInt(t, 10) : 0;
      if (opts.length && n >= 1 && n <= opts.length) return askNumber(jid, session.data, opts[n - 1]);
      if (opts.length && t === '0') { store.saveSession(jid, 'address', { ...session.data, opts: undefined }); return reply(ASK_CEP); }
      const cepD = (text.match(/\b\d{5}-?\d{3}\b/) || [''])[0].replace(/\D/g, '');
      try {
        if (cepD) {
          const a = await geo.viaCep(cepD);
          if (!a) return reply('Não encontrei esse CEP 🤔 Confira os números ou mande o *nome da rua* que eu procuro.');
          if (!a.rua) return reply('Esse é um CEP geral da cidade. Mande o *nome da sua rua* que eu procuro.');
          if (!/jo[aã]o pessoa|cabedelo|bayeux/i.test(a.cidade)) return reply(`Esse CEP é de ${a.cidade}. Só entregamos em João Pessoa 😕 Envie outro CEP ou *1* para retirar no local.`);
          return askNumber(jid, session.data, a);
        }
        if (text.replace(/[^\p{L}]/gu, '').length < 3) return reply(ASK_CEP);
        const found = await geo.viaCepSearch(text.replace(/,.*$/, '').replace(/\d+/g, ''), 6);
        if (!found.length) return reply('Não encontrei essa rua em João Pessoa 🤔 Tente só uma parte do nome (ex.: *Golfo de Lion*) ou envie o *CEP*.');
        if (found.length === 1) return askNumber(jid, session.data, found[0]);
        store.saveSession(jid, 'address_pick', { ...session.data, opts: found });
        return reply(`Encontrei estas ruas. Qual é a sua?\n\n${found.map((a, k) => `*${k + 1}* — ${a.rua}, ${a.bairro}${a.complemento ? ` (${a.complemento})` : ''}`).join('\n')}\n\n*0* — Nenhuma delas (buscar de novo)`);
      } catch (e) {
        console.error('[wa] viacep:', e.message);
        return reply('Não consegui consultar o endereço agora 😕 Tente de novo em instantes, ou envie *1* para retirar no local.');
      }
    }
    case 'address_num': {
      const a = session.data.addr;
      if (!a) { store.saveSession(jid, 'address', session.data); return reply(ASK_CEP); }
      if (t === '0') { store.saveSession(jid, 'address', { ...session.data, addr: undefined }); return reply(ASK_CEP); }
      const m = text.match(/^\s*(s\/?n|\d+[a-z]?)\b[\s,.-]*(.*)$/i);
      if (!m) return reply(`Qual é o *número*? Ex.: *120* ou *120, apto 302* (ou *s/n*).\nEnvie *0* para trocar a rua.`);
      const num = m[1].toLowerCase().replace('sn', 's/n'), ref = m[2].trim().slice(0, 160);
      const delivery = await geo.priceDelivery({ address: `${a.rua}, ${num}`, bairro: a.bairro, cep: a.cep, ref });
      if (delivery.too_far) {
        const km = (v) => String(v).replace('.', ',');
        store.saveSession(jid, 'address', { ...session.data, addr: undefined });
        return reply(`😕 Esse endereço fica a ≈ ${km(delivery.km)} km, e só entregamos até *${km(delivery.max_km)} km*.\n\nEnvie *1* para *retirar no local* (${s.pickup_address}) ou mande outro CEP.`);
      }
      return askConfirm(jid, { ...session.data, addr: undefined, opts: undefined, delivery });
    }
    case 'confirm': {
      if (t === '1' || t === 'sim' || t === 'confirmar') {
        if (!accepting) {
          store.saveSession(jid, 'idle', {});
          return reply('A pré-venda foi encerrada 😢 Obrigado pelo interesse!');
        }
        const order = store.createOrder({
          customer_name: session.data.name,
          phone: session.data.phone,
          items: session.data.bag.map((l) => ({ product_id: l.product_id, qty: l.qty })),
          delivery: session.data.delivery,
          source: 'whatsapp',
          wa_jid: jid,
        });
        const dv = session.data.delivery;
        if (dv && dv.lat != null) { try { store.setDeliveryGeo(order.id, dv.lat, dv.lng, dv.precision); } catch (e) { console.error('[geo] ponto do pedido:', e.message); } }
        store.saveSession(jid, 'receipt', { order_id: order.id });
        try {
          return await sendPix(jid, order, s);
        } catch (e) {
          console.error('[wa] erro ao enviar Pix:', e.message);
          return reply(`Pedido *#${order.number_label}* registrado! Total ${brl(order.total_cents)}.\nPix (chave): ${s.pix_key}\nDepois envie o comprovante aqui.`);
        }
      }
      if (t === '2') {
        store.saveSession(jid, 'ordering', { ...session.data });
        return reply(`Ok! Sua sacola:\n${bagText(session.data.bag)}\n\nEnvie mais itens, *limpar* para recomeçar ou *0* para finalizar.\n\n${catalogText(menuProducts())}`);
      }
      if (t === '3') {
        store.saveSession(jid, 'idle', {});
        return reply('Pedido cancelado. Quando quiser, é só mandar *menu*. 💛');
      }
      return reply('Responda *1* para confirmar, *2* para alterar itens ou *3* para cancelar.');
    }
    case 'receipt_pick': {
      const orders = (session.data.ids || []).map((id) => store.getOrderById(id)).filter((o) => o && !o.has_receipt && o.status === 'pedido_feito');
      const n = parseInt(t, 10);
      if (!orders.length) { store.saveSession(jid, 'main', {}); return reply(mainMenuText(s, data.pushName)); }
      if (!(n >= 1 && n <= orders.length + 1) || String(n) !== t) return reply('Responda só com o número da opção 🙂\n\n' + receiptPickText(orders));
      const chosen = n === orders.length + 1 ? orders : [orders[n - 1]];
      const buf = fs.readFileSync(path.join(store.DATA_DIR, 'uploads', session.data.media_rel));
      for (const o of chosen) {
        saveReceipt(o.id, buf, session.data.mime);
        if (!o.wa_jid) store.db.prepare('UPDATE orders SET wa_jid = ? WHERE id = ?').run(jid, o.id);
      }
      store.saveSession(jid, 'main', {});
      return reply(RECEIPT_OK(chosen.map((o) => o.number_label)));
    }
    case 'receipt': {
      const order = store.getOrderById(session.data.order_id);
      if (t === '2') return reply(statusText(order ? [order] : []));
      if (t === 'pix' && order) return sendPix(jid, order, s);
      if (t === '4') return requestHuman(jid, 'Pediu atendente pelo menu');
      return reply(`Estou aguardando a *foto ou PDF do comprovante* do pedido #${order?.number_label || ''} 📎\nEnvie *pix* para receber o código de novo, *2* para ver o status, *4* para falar com a equipe ou *menu* para voltar.`);
    }
    default: {
      store.saveSession(jid, 'main', {});
      return reply(mainMenuText(s, data.pushName));
    }
  }
}

const ASK_CEP =
  '🛵 Qual é o seu *CEP*? (ex.: *58037-030*)\nSe não souber, mande o *nome da rua* que eu procuro.\n\nA taxa é calculada pela distância: *R$ 5,00 até 2 km* + R$ 1,00 por km adicional (entregamos até 9 km). Envie *1* para retirar no local.';

function askNumber(jid, data, a) {
  const addr = { cep: a.cep, rua: a.rua, bairro: a.bairro };
  store.saveSession(jid, 'address_num', { ...data, opts: undefined, addr });
  return sendText(jid, `📍 *${addr.rua}* — ${addr.bairro} (CEP ${addr.cep.replace(/^(\d{5})(\d{3})$/, '$1-$2')})\n\nAgora envie o *número* e, se quiser, o complemento/referência.\nEx.: *120, apto 302, perto da padaria*\n\n*0* — Trocar a rua`);
}

function startOrdering(jid, s, accepting) {
  if (!accepting) {
    store.saveSession(jid, 'main', {});
    return sendText(jid, 'A pré-venda está encerrada no momento 😢 Envie *2* para acompanhar um pedido já feito.');
  }
  const products = menuProducts();
  store.saveSession(jid, 'ordering', { bag: [], map: products.map((p) => p.id) });
  return sendText(
    jid,
    `🍔 *Cardápio ${s.team_name}*\n\n${catalogText(products)}\n\n` +
      `👉 Envie o *número do item* para adicionar à sacola.\nPara mais unidades: *quantidade x número* (ex.: *2x1* = 2 ${products[0]?.name || ''}).\n` +
      `Pode mandar vários de uma vez: *1, 2x3, 6*\n\nFotos: ${siteUrl('/')}`
  );
}

function afterContact(jid, data) {
  const s = store.getSettings();
  const burgers = ['combos', 'hamburguer', 'hamburgueres', 'lanches'];
  const hasBurger = data.bag.some((l) => {
    const p = store.db.prepare('SELECT category FROM products WHERE id = ?').get(l.product_id);
    return p && burgers.includes(normB(p.category));
  });
  if (s.delivery_enabled === '1' && hasBurger) {
    store.saveSession(jid, 'mode', data);
    return sendText(jid, `Como você quer receber?\n\n*1* — Retirar no local (sem taxa)${s.pickup_address ? `\n      _${s.pickup_address}_` : ''}\n*2* — Receber em casa (taxa por bairro)`);
  }
  return askConfirm(jid, { ...data, delivery: { mode: 'retirada' } });
}

function askConfirm(jid, data) {
  store.saveSession(jid, 'confirm', data);
  const s = store.getSettings();
  const d = data.delivery || { mode: 'retirada' };
  const sub = data.bag.reduce((a, l) => a + l.qty * l.unit_cents, 0);
  let recv = `📍 Retirada no local${s.pickup_address ? ` — ${s.pickup_address}` : ''}`;
  let tot = '';
  if (d.mode === 'entrega') {
    recv = `🛵 Entrega\n      ${d.address}${d.ref ? ` (${d.ref})` : ''}\n      Taxa: ${d.fee_cents == null ? 'a combinar com a equipe' : brl(d.fee_cents) + kmTxt(d.km)}`;
    tot = d.fee_cents == null ? '' : `\n*Total no Pix: ${brl(sub + d.fee_cents)}*`;
  }
  return sendText(
    jid,
    `📋 *Confira seu pedido:*\n\n${tot ? bagText(data.bag).replace('*Total:', '*Itens:') : bagText(data.bag)}${tot}\n\n👤 ${data.name}\n📞 ${fmtPhone(data.phone)}\n💠 Pagamento: Pix antecipado\n${recv}\n\n*1* — Confirmar e pagar\n*2* — Alterar itens\n*3* — Cancelar`
  );
}

module.exports = {
  handleWebhook,
  _lastBot: lastBot,
  webhookSecret,
  webhookUrl,
  isConfigured,
  connectionState,
  setupInstance,
  getQr,
  logout,
  parseItems,
  cfg,
};
