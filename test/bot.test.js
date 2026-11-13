const test = require('node:test');
const assert = require('node:assert');
process.env.DATA_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'mn-'));
const { parseItems } = require('../src/whatsapp');
const store = require('../src/db');

test('parseItems understands item and qty x item', () => {
  assert.deepStrictEqual(parseItems('1'), [{ qty: 1, index: 1 }]);
  assert.deepStrictEqual(parseItems('2x3'), [{ qty: 2, index: 3 }]);
  assert.deepStrictEqual(parseItems('1, 2 x 3 e 6'), [{ qty: 1, index: 1 }, { qty: 2, index: 3 }, { qty: 1, index: 6 }]);
  assert.strictEqual(parseItems('quero um'), null);
});

test('orders get sequential 3-digit numbers and phone lookup ignores 9th digit', () => {
  const a = store.createOrder({ customer_name: 'Ana', phone: '(83) 98809-5199', items: [{ product_id: 1, qty: 2 }] });
  const b = store.createOrder({ customer_name: 'Bia', phone: '83988095199', items: [{ product_id: 3, qty: 1 }] });
  assert.strictEqual(a.number_label, '001');
  assert.strictEqual(b.number_label, '002');
  assert.strictEqual(a.total_cents, 5000);
  assert.strictEqual(a.phone, '5583988095199');
  assert.strictEqual(store.findOrdersByPhone('558388095199').length, 2);
  const c = store.updateOrderStatus(a.id, 'pagamento_confirmado');
  assert.strictEqual(c.status_info.label, 'Pagamento confirmado');
  assert.throws(() => store.createOrder({ customer_name: 'X', phone: '1', items: [] }));
});
