// WhatsApp bot over Evolution API v2. Purely reactive: it only answers messages
// it receives (optional status notifications can be enabled in the admin).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./db');
const { buildPixPayload, pixQrPng } = require('./pix');
const { BAIRROS, findBairro, norm: normB } = require('./bairros');

const cfg = () => ({
  url: (process.env.EVOLUTION_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.EVOLUTION_API_KEY || '',
  instance: process.env.EVOLUTION_INSTANCE || 'minionarios',
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
  const r = await evo('GET', `/instance/connect/${instance}`);
  return { base64: r.base64 || null, pairingCode: r.pairingCode || null, code: r.code || null };
}

async function logout() {
  const { instance } = cfg();
  return evo('DELETE', `/instance/logout/${instance}`);
}

// ---------- Sending ----------
async function sendText(to, text) {
  return evo('POST', `/message/sendText/${cfg().instance}`, { number: to, text });
}
async function sendImage(to, pngBuffer, caption) {
  return evo('POST', `/message/sendMedia/${cfg().instance}`, {
    number: to,
    mediatype: 'image',
    mimetype: 'image/png',
    caption,
    media: pngBuffer.toString('base64'),
    fileName: 'pix.png',
  });
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

function statusText(orders) {
  if (!orders.length) return 'Não encontrei pedidos para este número 🤔\nSe você fez o pedido com outro telefone, consulte pelo site: ' + siteUrl('/pedido');
  return (
    '*Seus pedidos:*\n\n' +
    orders
      .map(
        (o) =>
          `*Pedido #${o.number_label}* — ${brl(o.total_cents)}\n${o.items.map((l) => `${l.qty}x ${l.name}`).join(', ')}\nStatus: ${o.status_info.emoji} *${o.status_info.label}*${
            o.has_receipt ? '' : o.status === 'pedido_feito' ? '\n⚠️ Ainda sem comprovante. Envie a foto do comprovante aqui.' : ''
          }\nAcompanhe: ${siteUrl('/pedido?c=' + o.code)}`
      )
      .join('\n\n')
  );
}

function mainMenuText(s, name) {
  return (
    `Olá${name ? ', ' + name.split(' ')[0] : ''}! 💛💙 Aqui é a equipe *${s.team_name}* — ${s.tagline}.\n\n` +
    `🍔 Pré-venda para *${s.event_date_label}* · ${s.pickup_label}\n\n` +
    `Responda com o número:\n*1* — Fazer pedido\n*2* — Acompanhar meu pedido\n*3* — Ver cardápio no site\n\n` +
    `_A qualquer momento, envie *menu* para voltar aqui._`
  );
}

async function downloadMedia(data) {
  let b64 = data.message?.base64 || data.base64;
  let mime = data.message?.imageMessage?.mimetype || data.message?.documentMessage?.mimetype || 'image/jpeg';
  if (!b64) {
    const r = await evo('POST', `/chat/getBase64FromMediaMessage/${cfg().instance}`, {
      message: { key: data.key },
      convertToMp4: false,
    });
    b64 = r.base64;
    mime = r.mimetype || mime;
  }
  if (!b64) throw new Error('mídia sem conteúdo');
  return { buf: Buffer.from(b64.replace(/^data:[^,]+,/, ''), 'base64'), mime };
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
    `*Pedido #${order.number_label}* registrado! 🎉\n\n${order.delivery_mode === 'entrega' ? bagText(order.items).replace('*Total:', '*Itens:') : bagText(order.items)}${order.delivery_mode === 'entrega' ? `\n🛵 Entrega (${order.bairro}): ${order.delivery_fee_cents == null ? 'taxa a combinar' : brl(order.delivery_fee_cents)}` : ''}\n\n` +
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

async function handleMessage(data) {
  if (!data?.key || data.key.fromMe) return;
  const jid = data.key.remoteJid || '';
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  if (!store.markSeen(data.key.id)) return;

  const s = store.getSettings();
  const msg = data.message || {};
  const text = extractText(msg).trim();
  const t = norm(text);
  const hasMedia = !!(msg.imageMessage || msg.documentMessage || msg.documentWithCaptionMessage);
  const phone = resolvePhone(data);
  const session = store.getSession(jid);
  const reply = (txt) => sendText(jid, txt);
  const accepting = s.accepting_orders === '1';

  // Receipt: in "receipt" state, or any media while the latest order has none.
  if (hasMedia) {
    let order = session.state === 'receipt' && session.data.order_id ? store.getOrderById(session.data.order_id) : null;
    if (!order) {
      const recent = store.db.prepare("SELECT id FROM orders WHERE wa_jid = ? AND receipt_path IS NULL AND status = 'pedido_feito' ORDER BY id DESC LIMIT 1").get(jid);
      if (recent) order = store.getOrderById(recent.id);
    }
    if (!order && phone) order = store.findOrdersByPhone(phone, 5).find((o) => !o.has_receipt && o.status === 'pedido_feito') || null;
    if (order) {
      const m = msg.documentWithCaptionMessage ? { ...data, message: { ...msg, ...msg.documentWithCaptionMessage.message } } : data;
      const { buf, mime } = await downloadMedia(m);
      saveReceipt(order.id, buf, mime);
      store.saveSession(jid, 'idle', {});
      return reply(
        `✅ Comprovante recebido para o *pedido #${order.number_label}*!\n\nAssim que a equipe conferir o pagamento, o status muda para *Pagamento confirmado*. Envie *2* para acompanhar.`
      );
    }
    if (!text) return reply('Recebi seu arquivo, mas não encontrei um pedido aguardando comprovante. Envie *menu* para começar.');
  }

  // Global commands
  if (['menu', 'inicio', 'voltar', 'oi', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'cancelar'].includes(t)) {
    store.saveSession(jid, 'main', {});
    return reply((t === 'cancelar' ? 'Tudo bem, cancelei o que estava em andamento.\n\n' : '') + mainMenuText(s, data.pushName));
  }
  if (['status', 'meu pedido', 'acompanhar', 'consultar'].includes(t) || /^status\s*#?\d+$/.test(t)) {
    return reply(statusText(phone ? store.findOrdersByPhone(phone, 5) : store.listOrders().filter((o) => o.wa_jid === jid).slice(0, 5)));
  }

  switch (session.state) {
    case 'main': {
      if (t === '1' || t.includes('pedido') || t.includes('pedir')) return startOrdering(jid, s, accepting);
      if (t === '2') return reply(statusText(phone ? store.findOrdersByPhone(phone, 5) : []));
      if (t === '3' || t.includes('cardapio')) return reply(`📲 Cardápio completo com fotos: ${siteUrl('/')}`);
      return reply('Não entendi 😅 Responda *1*, *2* ou *3*.\n\n' + mainMenuText(s));
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
      if (!name || name.length < 2 || /^\d+$/.test(name)) return reply('Por favor, envie o *nome* de quem vai retirar o pedido.');
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
        store.saveSession(jid, 'bairro', session.data);
        return reply('🛵 Qual o seu *bairro* em João Pessoa? (ex.: Manaíra)');
      }
      return reply('Responda *1* para retirar no local ou *2* para receber em casa.');
    }
    case 'bairro': {
      const cands = session.data.cands || [];
      let b = /^\d+$/.test(t) && cands[+t - 1] ? findBairro(cands[+t - 1]) : findBairro(text);
      if (!b) {
        const q = normB(text);
        const found = q.length >= 3 ? BAIRROS.filter((x) => normB(x.n).includes(q)) : [];
        if (found.length === 1) b = found[0];
        else if (found.length > 1) {
          store.saveSession(jid, 'bairro', { ...session.data, cands: found.slice(0, 9).map((x) => x.n) });
          return reply('Qual desses?\n' + found.slice(0, 9).map((x, i) => `*${i + 1}* — ${x.n}`).join('\n'));
        } else return reply('Não encontrei esse bairro 🤔 Envie o nome do bairro (ex.: *Tambaú*, *Bancários*) ou *1* para voltar e retirar no local.');
      }
      store.saveSession(jid, 'address', { ...session.data, cands: undefined, bairro: b.n });
      return reply(`${b.fee == null ? `📍 *${b.n}* fica a mais de 5 km — a taxa de entrega é combinada com a equipe.` : `📍 Taxa de entrega para *${b.n}*: *${brl(b.fee)}*.`}\n\nAgora envie *rua, número* e um ponto de referência.`);
    }
    case 'address': {
      if (text.length < 4) return reply('Envie a *rua e o número* (e um ponto de referência, se quiser).');
      return askConfirm(jid, { ...session.data, delivery: { mode: 'entrega', bairro: session.data.bairro, address: text.slice(0, 160) } });
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
    case 'receipt': {
      const order = store.getOrderById(session.data.order_id);
      if (t === '2') return reply(statusText(order ? [order] : []));
      if (t === 'pix' && order) return sendPix(jid, order, s);
      return reply(`Estou aguardando a *foto ou PDF do comprovante* do pedido #${order?.number_label || ''} 📎\nEnvie *pix* para receber o código de novo, *2* para ver o status ou *menu* para voltar.`);
    }
    default: {
      store.saveSession(jid, 'main', {});
      return reply(mainMenuText(s, data.pushName));
    }
  }
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
    const b = findBairro(d.bairro);
    recv = `🛵 Entrega · ${d.bairro}\n      ${d.address}\n      Taxa: ${b && b.fee != null ? brl(b.fee) : 'a combinar'}`;
    tot = `\n*Total no Pix: ${brl(sub + (b && b.fee ? b.fee : 0))}*`;
  }
  return sendText(
    jid,
    `📋 *Confira seu pedido:*\n\n${tot ? bagText(data.bag).replace('*Total:', '*Itens:') : bagText(data.bag)}${tot}\n\n👤 ${data.name}\n📞 ${fmtPhone(data.phone)}\n💠 Pagamento: Pix antecipado\n${recv}\n\n*1* — Confirmar e pagar\n*2* — Alterar itens\n*3* — Cancelar`
  );
}

// ---------- Outbound notification (optional) ----------
async function notifyStatus(order) {
  const s = store.getSettings();
  if (s.notify_status_whatsapp !== '1' || !isConfigured()) return;
  const to = order.wa_jid || order.phone;
  if (!to) return;
  const msgs = {
    pagamento_confirmado: `💸 Pagamento do *pedido #${order.number_label}* confirmado! Obrigado 💛💙`,
    em_preparo: `👨‍🍳 Seu *pedido #${order.number_label}* está em preparo!`,
    saiu_para_entrega: `🛵 Seu *pedido #${order.number_label}* saiu para a entrega / está pronto para retirada!`,
    concluido: `✅ *Pedido #${order.number_label}* concluído. Bom apetite e obrigado por ajudar na arrecadação! 🙏`,
    cancelado: `❌ O *pedido #${order.number_label}* foi cancelado. Em caso de dúvida, responda esta mensagem.`,
  };
  if (!msgs[order.status]) return;
  try {
    await sendText(to, msgs[order.status] + `\n\nAcompanhe: ${siteUrl('/pedido?c=' + order.code)}`);
  } catch (e) {
    console.error('[wa] falha ao notificar:', e.message);
  }
}

module.exports = {
  handleWebhook,
  webhookSecret,
  webhookUrl,
  isConfigured,
  connectionState,
  setupInstance,
  getQr,
  logout,
  notifyStatus,
  parseItems,
  cfg,
};
