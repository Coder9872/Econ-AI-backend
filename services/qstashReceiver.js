// QStash Receiver helper to verify incoming webhook/job signatures.
// Uses current and next signing keys rotated by Upstash.
// Env Vars:
//   QSTASH_CURRENT_SIGNING_KEY
//   QSTASH_NEXT_SIGNING_KEY (optional during rotation)
// Verification is only attempted if a signature header is present.

const { Receiver } = require('@upstash/qstash');

let receiver = null;
function getReceiver() {
  if (receiver) return receiver;
  const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const next = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!current) return null; // cannot build without current key
  receiver = new Receiver({ currentSigningKey: current, nextSigningKey: next });
  return receiver;
}

/**
 * Verify an incoming QStash signature if possible.
 * @param {Buffer|string} rawBody
 * @param {string} signatureHeader value of Upstash-Signature header
 * @returns {Promise<{valid:boolean,error?:string}>}
 */
async function verifyQStash(rawBody, signatureHeader) {
  const rec = getReceiver();
  if (!rec) return { valid: false, error: 'receiver_not_configured' };
  if (!signatureHeader) return { valid: false, error: 'missing_signature_header' };
  try {
    const valid = await rec.verify({ body: typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'), signature: signatureHeader });
    return { valid };
  } catch (e) {
    return { valid: false, error: e.message || 'verify_failed' };
  }
}

module.exports = { verifyQStash };
