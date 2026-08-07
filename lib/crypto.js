// AES-256-GCM field-level encryption for sensitive JSON blobs (transaction
// detail, card labels, Robinhood history - see db.js's cards_enc/
// transactions_enc/history_enc columns for what this is used on and why
// account totals themselves are deliberately NOT encrypted).
//
// DATA_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set as a Railway
// env var (generated once, same way SESSION_SECRET/INVITE_CODE were). If
// this key is ever lost, every value encrypted with it is permanently
// unrecoverable - there is no recovery path by design, since a recoverable
// key would defeat the point.

const crypto = require('crypto');

const KEY = process.env.DATA_ENCRYPTION_KEY ? Buffer.from(process.env.DATA_ENCRYPTION_KEY, 'base64') : null;
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV, the recommended size for GCM

function encryptJSON(value) {
  if (!KEY) throw new Error('DATA_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv:authTag:ciphertext, each base64 - self-contained so decryptJSON needs
  // nothing but the key and this one stored string.
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptJSON(stored) {
  if (!KEY) throw new Error('DATA_ENCRYPTION_KEY is not configured');
  const [ivB64, authTagB64, dataB64] = stored.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const encrypted = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

module.exports = { encryptJSON, decryptJSON, encryptionConfigured: !!KEY };
