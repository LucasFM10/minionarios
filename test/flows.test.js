const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mn-flows-'));
process.env.EVOLUTION_URL = 'http://evo.test';
process.env.EVOLUTION_API_KEY = 'k';
process.env.PUBLIC_URL = 'http://site.test';

const store = require('../src/db');
const geo = require('../src/geo');
const wa = require('../src/whatsapp');

// ---- simulated network: Evolution + OpenStreetMap + OSRM ----
const sent = [];
let msgSeq = 0;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (b, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => b, text: async () => JSON.stringify(b) });
  if (u.startsWith('http://evo.test/message/')) {
    const b = JSON.parse(opts.body);
    sent.push({ to: b.number, text: b.text || b.caption || '', media: !!b.media });
    return json({ key: { id: 'BOT' + ++msgSeq } });
  }
  if (u.startsWith('https://nominatim.openstreetmap.org')) {
    const q = decodeURIComponent(u.split('q=')[1]);
    if (/marieta/i.test(q)) return json([{ lat: '-7.1000', lon: '-34.8300' }]); // retirada
    if (/golfo/i.test(q)) return json([{ lat: '-7.1300', lon: '-34.8300' }]); // ~3,3 km ao sul
    return json([]);
  }
  if (u.startsWith('https://router.project-osrm.org')) return json({ routes: [{ distance: 4210 }] });
  if (u.startsWith('https://brasilapi.com.br')) return json({});
  throw new Error('rede inesperada: ' + u);
};

const JID = '558391112222@s.whatsapp.net';
let n = 0;
const inbound = (text, extra = {}) => wa.handleWebhook({ event: 'messages.upsert', data: { key: { remoteJid: JID, fromMe: false, id: 'M' + ++n }, pushName: 'Ana Souza', message: { conversation: text }, ...extra } });
const human = (text) => wa.handleWebhook({ event: 'messages.upsert', data: { key: { remoteJid: JID, fromMe: true, id: 'H' + ++n }, message: { conversation: text } } });
const last = () => sent[sent.length - 1]?.text || '';
const countBefore = () => sent.length;

test('taxa: R$ 1,00 por km, arredondando para cima de 50 em 50 centavos', () => {
  assert.strictEqual(geo.feeFor(4.21), 450);
  assert.strictEqual(geo.feeFor(4.0), 400);
  assert.strictEqual(geo.feeFor(4.01), 450);
  assert.strictEqual(geo.feeFor(0.2), 50);
  assert.strictEqual(geo.feeFor(1.0, { min: 700 }), 700);
});

test('priceDelivery calcula distância por rota e taxa; sem endereço localizado vira "a combinar"', async () => {
  const ok = await geo.priceDelivery({ address: 'Rua Golfo de Lion, 120', bairro: 'Manaíra' });
  assert.strictEqual(ok.km, 4.2);
  assert.strictEqual(ok.fee_cents, 450);
  const bad = await geo.priceDelivery({ address: 'Rua Que Nao Existe, 1', bairro: 'Lugar Nenhum' });
  assert.strictEqual(bad.fee_cents, null);
  // o resultado do mapa fica em cache
  assert.ok(store.db.prepare('SELECT COUNT(*) n FROM geo_cache').get().n >= 2);
});

test('pedido pelo chat com entrega: endereço, taxa por km e confirmação', async () => {
  await inbound('oi');
  await inbound('1');
  await inbound('1'); // Papoiburg
  await inbound('0');
  await inbound('1'); // nome = pushName
  assert.match(last(), /Como você quer receber/);
  await inbound('2');
  assert.match(last(), /endereço completo/);
  await inbound('Rua Golfo de Lion, 120, Manaíra');
  assert.match(last(), /Taxa: R\$ 4,50 \(≈ 4,2 km\)/);
  const itens = Number(last().match(/Itens: R\$ ([\d,]+)/)[1].replace(',', '.')) * 100;
  assert.match(last(), new RegExp('Total no Pix: R\\$ ' + ((itens + 450) / 100).toFixed(2).replace('.', ',')));
  await inbound('1');
  const o = store.getOrderByNumber(1);
  assert.strictEqual(o.delivery_fee_cents, 450);
  assert.strictEqual(o.total_cents, itens + 450);
});

test('"oi" no meio de um pedido não apaga a sacola', async () => {
  await inbound('menu');
  await inbound('1');
  await inbound('2x1');
  await inbound('oi');
  assert.match(last(), /meio de um pedido/);
  assert.match(last(), /2x /);
  await inbound('cancelar');
  assert.match(last(), /cancelei o que estava em andamento/);
});

test('pedir atendente: avisa, sinaliza no admin e o bot continua respondendo', async () => {
  await inbound('quero falar com a equipe');
  assert.match(last(), /vai entrar em contato com você/);
  assert.strictEqual(store.getChat(JID).human_status, 'requested');
  await inbound('meu pedido veio errado');
  assert.match(last(), /Anotado/, 'texto livre não abre um pedido novo');
  const before = countBefore();
  await inbound('faltou a batata');
  assert.strictEqual(countBefore(), before, 'depois do primeiro aviso, só registra');
  assert.ok(store.chatMessages(JID).some((m) => m.direction === 'in' && m.body === 'meu pedido veio errado'), 'mensagens continuam sendo guardadas');
  await inbound('2');
  assert.match(last(), /#001/, 'status continua disponível');
  assert.strictEqual(store.getChat(JID).human_status, 'requested', 'sinal de ajuda continua até a equipe resolver');
  assert.ok(store.getChat(JID).unread >= 2);
});

test('equipe responde pelo celular: vira "atendendo" e o bot continua pausado; retomar libera', async () => {
  wa._lastBot.clear(); // simula passar alguns segundos
  await human('Oi Ana, já vamos resolver!');
  assert.strictEqual(store.getChat(JID).human_status, 'handling');
  assert.ok(store.chatMessages(JID).some((m) => m.direction === 'human'));
  const before = countBefore();
  await inbound('obrigada'); // respondendo pelo número do bot: aí sim o bot pausa
  assert.strictEqual(countBefore(), before);
  store.setHuman(JID, 'none');
  await inbound('menu');
  assert.match(last(), /Responda com o número/);
});

test('eco de mensagem do próprio bot não conta como humano', async () => {
  const id = 'ECHO1';
  await inbound('menu'); // o bot responde agora
  const c0 = store.getChat(JID).human_status;
  await wa.handleWebhook({ event: 'messages.upsert', data: { key: { remoteJid: JID, fromMe: true, id }, message: { conversation: 'texto do bot' } } });
  assert.strictEqual(store.getChat(JID).human_status, c0);
});

test('cancelar com pedido ativo vai para a equipe (humano resolve)', async () => {
  store.setHuman(JID, 'none');
  await inbound('menu');
  await inbound('cancelar');
  assert.strictEqual(store.getChat(JID).human_status, 'requested');
  assert.match(last(), /entrar em contato/);
});

test('comprovante vindo do site é anexado e a conversa é guardada com a mídia', async () => {
  store.setHuman(JID, 'none');
  const o = store.createOrder({ customer_name: 'Ana', phone: '83991112222', items: [{ product_id: 1, qty: 1 }], source: 'site' });
  await inbound(`Olá! Quero confirmar meu *pedido #${o.number_label}* da Minionários 🍔\nValor: *R$ 25,00*\nRef: ${o.code.slice(0, 6)}`);
  assert.match(sent.map((m) => m.text).join('\n'), /anexe aqui nesta conversa o comprovante/);
  await inbound('', { message: { imageMessage: { mimetype: 'image/jpeg' }, base64: Buffer.from('fake-jpg').toString('base64') } });
  // o #001 (feito pelo chat) também está aguardando: o bot pergunta de qual pedido é
  assert.match(last(), /Esse comprovante é de qual pedido\?/);
  assert.match(last(), /\*1\* — Pedido #001/);
  assert.match(last(), new RegExp(`\\*2\\* — Pedido #${o.number_label}`));
  assert.match(last(), /\*3\* — Dos dois/);
  assert.ok(!store.getOrderById(o.id).has_receipt, 'não anexa antes da resposta');
  await inbound('talvez');
  assert.match(last(), /Responda só com o número/);
  await inbound('2');
  assert.match(last(), new RegExp(`Comprovante recebido para o \\*pedido #${o.number_label}\\*`));
  assert.ok(store.getOrderById(o.id).has_receipt);
  assert.ok(!store.getOrderByNumber(1).has_receipt, 'o outro pedido continua aguardando');
  const img = store.chatMessages(JID).find((m) => m.kind === 'image' && m.direction === 'in' && m.media_path);
  assert.ok(img, 'imagem guardada na conversa');
});

test('um único Pix para vários pedidos: "dos dois" anexa o comprovante a todos', async () => {
  const a = store.createOrder({ customer_name: 'Ana', phone: '83991112222', items: [{ product_id: 1, qty: 1 }], source: 'site' });
  const img = { message: { imageMessage: { mimetype: 'image/jpeg' }, base64: Buffer.from('pix-unico').toString('base64') } };
  await inbound('', img);
  assert.match(last(), /\*3\* — Dos dois/);
  await inbound('3');
  assert.match(last(), new RegExp(`pedidos #001 e #${a.number_label}`));
  assert.ok(store.getOrderByNumber(1).has_receipt && store.getOrderById(a.id).has_receipt);
  // sem nenhum pedido pendente, não pergunta nada
  await inbound('', img);
  assert.match(last(), /não encontrei um pedido aguardando comprovante/);
});
