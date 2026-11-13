// Static Pix "copia e cola" (BR Code / EMV MPM) generator with amount.
const QRCode = require('qrcode');

function field(id, value) {
  const v = String(value);
  return id + String(v.length).padStart(2, '0') + v;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// EMV fields only accept a limited ASCII charset: strip accents and odd symbols.
function clean(s, max) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .\-]/g, '')
    .trim()
    .toUpperCase()
    .slice(0, max);
}

/**
 * @param {object} o
 * @param {string} o.key     Pix key (phone in +55 format, e-mail, CPF/CNPJ or EVP)
 * @param {string} o.name    receiver name (max 25)
 * @param {string} o.city    receiver city (max 15)
 * @param {number} [o.amountCents]
 * @param {string} [o.txid]  reference (max 25, alphanumeric), default "***"
 * @param {string} [o.message] optional description shown in some banks
 */
function buildPixPayload({ key, name, city, amountCents, txid, message }) {
  const gui = field('00', 'br.gov.bcb.pix');
  let mai = gui + field('01', String(key).trim());
  const desc = clean(message, 40);
  if (desc && (mai.length + 4 + desc.length) <= 99) mai += field('02', desc);
  const ref = (String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25)) || '***';
  let payload =
    field('00', '01') +
    field('26', mai) +
    field('52', '0000') +
    field('53', '986') +
    (amountCents ? field('54', (amountCents / 100).toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', clean(name, 25) || 'RECEBEDOR') +
    field('60', clean(city, 15) || 'BRASIL') +
    field('62', field('05', ref)) +
    '6304';
  return payload + crc16(payload);
}

async function pixQrDataUrl(payload) {
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 512 });
}
async function pixQrPng(payload) {
  return QRCode.toBuffer(payload, { errorCorrectionLevel: 'M', margin: 2, width: 512, type: 'png' });
}

module.exports = { buildPixPayload, pixQrDataUrl, pixQrPng, crc16 };
