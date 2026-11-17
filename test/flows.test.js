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
let routeMeters = 4210;
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
  if (u.startsWith('https://router.project-osrm.org')) return json({ routes: [{ distance: routeMeters }] });
  if (u.startsWith('https://brasilapi.com.br')) return json({});
  throw new Error('rede inesperada: ' + u);
};

const JID = '558391112222@s.whatsapp.net';
let n = 0;
const inbound = (text, extra = {}) => wa.handleWebhook({ event: 'messages.upsert', data: { key: { remoteJid: JID, fromMe: false, id: 'M' + ++n }, pushName: 'Ana Souza', message: { conversation: text }, ...extra } });
const human = (text) => wa.handleWebhook({ event: 'messages.upsert', data: { key: { remoteJid: JID, fromMe: true, id: 'H' + ++n }, message: { conversation: text } } });
const last = () => sent[sent.length - 1]?.text || '';
const countBefore = () => sent.length;

test('taxa: R$ 5,00 até 2 km, depois +R$ 1,00 por km (arredonda de 50 em 50 centavos)', () => {
  assert.strictEqual(geo.feeFor(0.4), 500);
  assert.strictEqual(geo.feeFor(2.0), 500);
  assert.strictEqual(geo.feeFor(2.3), 550);
  assert.strictEqual(geo.feeFor(3.0), 600);
  assert.strictEqual(geo.feeFor(4.21), 750);
  assert.strictEqual(geo.feeFor(9.0), 1200);
});

test('priceDelivery calcula distância por rota e taxa; sem endereço localizado vira "a combinar"', async () => {
  const ok = await geo.priceDelivery({ address: 'Rua Golfo de Lion, 120', bairro: 'Manaíra' });
  assert.strictEqual(ok.km, 4.2);
  assert.strictEqual(ok.fee_cents, 750);
  routeMeters = 9600;
  const far = await geo.priceDelivery({ address: 'Rua Golfo de Lion, 120', bairro: 'Manaíra' });
  assert.ok(far.too_far, 'acima de 9 km não entrega');
  assert.strictEqual(far.fee_cents, null);
  routeMeters = 4210;
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
  assert.match(last(), /Taxa: R\$ 7,50 \(≈ 4,2 km\)/);
  const itens = Number(last().match(/Itens: R\$ ([\d,]+)/)[1].replace(',', '.')) * 100;
  assert.match(last(), new RegExp('Total no Pix: R\\$ ' + ((itens + 750) / 100).toFixed(2).replace('.', ',')));
  await inbound('1');
  const o = store.getOrderByNumber(1);
  assert.strictEqual(o.delivery_fee_cents, 750);
  assert.strictEqual(o.total_cents, itens + 750);
});

test('endereço acima de 9 km: o bot não aceita entrega e oferece retirada', async () => {
  await inbound('menu');
  await inbound('1');
  await inbound('1');
  await inbound('0');
  await inbound('1');
  await inbound('2');
  routeMeters = 12000;
  await inbound('Rua Golfo de Lion, 900, Manaíra');
  routeMeters = 4210;
  assert.match(last(), /só entregamos até \*9 km\*/);
  assert.match(last(), /\*1\* para \*retirar no local\*/);
  await inbound('1');
  assert.match(last(), /Retirada/i);
  await inbound('3'); // cancela na confirmação
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

test('taxa "a combinar" calculada depois: fica à parte, aparece no status e pode ser marcada como paga', async () => {
  // endereço que o mapa não acha → pedido nasce "a combinar"
  const o = store.createOrder({ customer_name: 'Ana', phone: '83991112222', items: [{ product_id: 1, qty: 1 }], source: 'site',
    delivery: await geo.priceDelivery({ address: 'Rua Que Nao Existe, 5', bairro: 'Lugar Nenhum' }) });
  assert.strictEqual(o.delivery_fee_cents, null);
  const totalPago = o.total_cents;
  assert.ok(store.ordersWithoutFee().includes(o.id));
  // depois a equipe/servidor calcula a taxa
  const d = await geo.priceDelivery({ address: 'Rua Golfo de Lion, 120', bairro: 'Manaíra' });
  let x = store.setLateFee(o.id, d.fee_cents, d.km);
  assert.strictEqual(x.delivery_fee_cents, 750);
  assert.strictEqual(x.total_cents, totalPago, 'o total do Pix original não muda');
  assert.ok(x.fee_extra && x.fee_pending && !x.fee_paid);
  assert.ok(!store.ordersWithoutFee().includes(o.id));
  assert.strictEqual(store.stats().totals.fees_pending >= 750, true);
  // cliente pede status
  store.setHuman(JID, 'none'); store.saveSession(JID, 'main', {});
  await inbound('status');
  assert.match(last(), /Taxa de entrega: R\$ 7,50 \(≈ 4,2 km\) — \*pagar à parte\*/);
  x = store.setFeePaid(o.id, true);
  assert.ok(x.fee_paid && !x.fee_pending);
  await inbound('status');
  assert.match(last(), /Taxa de entrega: R\$ 7,50 \(≈ 4,2 km\) — paga ✅/);
});
