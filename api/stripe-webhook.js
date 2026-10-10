// Stripe → billing/{uid}. Register in Stripe at https://classroomamt.com/api/stripe-webhook with
// events: checkout.session.completed, customer.subscription.created/updated/deleted.
const crypto = require('crypto');
const B = require('./_lib/billing');

const TOLERANCE_SEC = 300;

async function rawBody(req) {
  // Read the stream before touching req.body — the signature covers the exact bytes Stripe sent.
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  if (chunks.length) return Buffer.concat(chunks);
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return Buffer.alloc(0);
}

function verify(payload, header, secret) {
  const parts = {};
  for (const kv of String(header || '').split(',')) {
    const i = kv.indexOf('=');
    if (i > 0) (parts[kv.slice(0, i).trim()] ||= []).push(kv.slice(i + 1).trim());
  }
  const t = parts.t && parts.t[0];
  if (!t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > TOLERANCE_SEC) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.`).update(payload).digest();
  return parts.v1.some(sig => {
    const got = Buffer.from(sig, 'hex');
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: 'Webhook secret not configured' });

  const payload = await rawBody(req);
  if (!payload.length) return res.status(400).json({ error: 'Empty body' });
  if (!verify(payload, req.headers['stripe-signature'], secret)) return res.status(400).json({ error: 'Bad signature' });

  let event;
  try { event = JSON.parse(payload.toString('utf8')); } catch { return res.status(400).json({ error: 'Bad JSON' }); }
  const obj = event.data && event.data.object;

  try {
    if (event.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) {
      const uid = obj.client_reference_id || (obj.metadata && obj.metadata.uid);
      const sub = await B.stripe('GET', `subscriptions/${obj.subscription}`);
      await B.writeSubscription(uid, sub);
    } else if (/^customer\.subscription\.(created|updated|deleted)$/.test(event.type)) {
      const uid = obj.metadata && obj.metadata.uid;
      if (uid) {
        // Re-fetch so out-of-order event delivery can't overwrite newer state with older.
        const sub = event.type.endsWith('deleted') ? obj : await B.stripe('GET', `subscriptions/${obj.id}`);
        await B.writeSubscription(uid, sub);
      }
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    console.error('stripe-webhook error:', event.type, e.message);
    return res.status(500).json({ error: 'Processing failed' }); // Stripe retries
  }
};
module.exports.config = { api: { bodyParser: false } };
