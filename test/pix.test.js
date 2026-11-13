const test = require('node:test');
const assert = require('node:assert');
const { buildPixPayload, crc16 } = require('../src/pix');

test('crc16 matches the CCITT-FALSE reference vector', () => {
  assert.strictEqual(crc16('123456789'), '29B1');
});

test('pix payload is well formed and self-validating', () => {
  const p = buildPixPayload({ key: '+5583987889174', name: 'Tainára', city: 'João Pessoa', amountCents: 3500, txid: 'MIN012' });
  assert.match(p, /^000201/);
  assert.ok(p.includes('0014br.gov.bcb.pix0114+5583987889174'));
  assert.ok(p.includes('540535.00'));
  assert.ok(p.includes('5907TAINARA'));
  assert.ok(p.includes('6011JOAO PESSOA'));
  assert.ok(p.includes('62100506MIN012'));
  assert.strictEqual(p.slice(-4), crc16(p.slice(0, -4)));
});
