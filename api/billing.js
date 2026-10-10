// Pro subscription actions for a signed-in user (Authorization: Bearer <Firebase ID token>):
//   { action:'checkout', plan:'monthly'|'yearly' } → { url } of a Stripe Checkout page
//   { action:'portal' }                           → { url } of the Stripe customer portal
//   { action:'sync', sessionId? }                 → re-reads the subscription from Stripe into billing/{uid}
const B = require('./_lib/billing');

async function portalUrl(customer, returnUrl) {
  try {
    return (await B.stripe('POST', 'billing_portal/sessions', { customer, return_url: returnUrl })).url;
  } catch (e) {
    // First use in a Stripe account: no portal configuration exists yet → create a default one.
    if (!/configuration/i.test(e.message)) throw e;
    const cfg = await B.stripe('POST', 'billing_portal/configurations', {
      business_profile: { headline: 'Manage your Classroom AMT Pro subscription', privacy_policy_url: `${B.SITE_URL}/privacy.html`, terms_of_service_url: `${B.SITE_URL}/terms.html` },
      features: {
        invoice_history: { enabled: 'true' },
        payment_method_update: { enabled: 'true' },
        customer_update: { enabled: 'true', allowed_updates: ['email'] },
        subscription_cancel: { enabled: 'true', mode: 'at_period_end' },
      },
    });
    return (await B.stripe('POST', 'billing_portal/sessions', { customer, return_url: returnUrl, configuration: cfg.id })).url;
  }
}

module.exports = async function handler(req, res) {
  B.cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await B.userFromReq(req);
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  const { action, plan, sessionId } = req.body || {};
  const origin = B.siteOrigin(req);

  try {
    const billing = (await B.dbGet(`billing/${user.uid}`)) || {};

    if (action === 'checkout') {
      if (!B.PLANS[plan]) return res.status(400).json({ error: 'Choose monthly or yearly.' });
      if (B.billingIsPro(billing) && billing.subscriptionId && !billing.comp) {
        return res.status(409).json({ error: 'You already have Pro. Use “Manage subscription” to change plans.' });
      }
      const price = await B.getPriceId(plan);
      const session = await B.stripe('POST', 'checkout/sessions', {
        mode: 'subscription',
        line_items: [{ price, quantity: 1 }],
        client_reference_id: user.uid,
        ...(billing.customerId ? { customer: billing.customerId } : (user.email ? { customer_email: user.email } : {})),
        subscription_data: { metadata: { uid: user.uid } },
        metadata: { uid: user.uid },
        allow_promotion_codes: 'true',
        custom_text: { submit: { message: `By subscribing you agree to the Terms of Service (${B.SITE_URL}/terms.html) and Privacy Policy (${B.SITE_URL}/privacy.html). Pro renews automatically until you cancel; cancel anytime from your profile.` } },
        success_url: `${origin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/?billing=cancel`,
      });
      return res.status(200).json({ url: session.url });
    }

    if (action === 'portal') {
      if (!billing.customerId) return res.status(400).json({ error: 'No subscription found for this account.' });
      return res.status(200).json({ url: await portalUrl(billing.customerId, `${origin}/`) });
    }

    if (action === 'sync') {
      let customer = billing.customerId || null;
      if (sessionId) {
        if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return res.status(400).json({ error: 'Bad session' });
        const s = await B.stripe('GET', `checkout/sessions/${sessionId}`);
        if (s.client_reference_id !== user.uid) return res.status(403).json({ error: 'That checkout belongs to another account.' });
        customer = s.customer || customer;
      }
      if (!customer) return res.status(200).json({ pro: B.billingIsPro(billing) });
      const subs = await B.stripe('GET', 'subscriptions', { customer, status: 'all', limit: 10 });
      const sub = B.pickSubscription(subs.data || []);
      if (!sub) return res.status(200).json({ pro: B.billingIsPro(billing) });
      const b = await B.writeSubscription(user.uid, sub);
      return res.status(200).json({ pro: B.billingIsPro({ ...billing, ...b }) });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('billing error:', action, e.message);
    return res.status(502).json({ error: 'Billing is temporarily unavailable. Please try again in a minute.' });
  }
};
