// Shared helpers for Pro billing: Firebase RTDB (via FIREBASE_DB_SECRET), Firebase ID-token
// verification, Stripe REST calls, and the Pro-access check. Dependency-free on purpose —
// package.json is git-ignored here, so npm packages never reach Vercel's build.
// (Files under api/_lib are not exposed as routes; Vercel skips "_"-prefixed paths.)

const FIREBASE_DB = 'https://quiz-f332f-default-rtdb.firebaseio.com';
// Public web API key (same one shipped in index.html) — only used for ID-token lookup.
const FIREBASE_WEB_API_KEY = 'AIzaSyBaD9zy6OOP-S_lmkeRPH6iIMyW4SHmkCw';
const SITE_URL = 'https://classroomamt.com';
const ALLOWED_ORIGINS = ['https://classroomamt.com', 'https://www.classroomamt.com', 'https://classroomamt.vercel.app'];

const PLANS = {
  monthly: { lookupKey: 'classroomamt_pro_monthly', amount: 500,  interval: 'month', nickname: 'Pro Monthly' },
  yearly:  { lookupKey: 'classroomamt_pro_yearly',  amount: 4000, interval: 'year',  nickname: 'Pro Yearly' },
};
// past_due keeps access while Stripe retries the card; 3-day grace covers webhook lag at renewal.
const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);
const GRACE_MS = 3 * 24 * 60 * 60 * 1000;
// Required by Stripe Managed Payments (Stripe collects/remits sales tax). SaaS — personal use.
const TAX_CODE = 'txcd_10103000';

function dbUrl(path) {
  const secret = process.env.FIREBASE_DB_SECRET || '';
  return `${FIREBASE_DB}/${path}.json${secret ? `?auth=${encodeURIComponent(secret)}` : ''}`;
}
async function dbGet(path) {
  try { const r = await fetch(dbUrl(path)); return r.ok ? await r.json() : null; } catch { return null; }
}
async function dbPatch(path, value) {
  if (!process.env.FIREBASE_DB_SECRET) throw new Error('FIREBASE_DB_SECRET not configured');
  const r = await fetch(dbUrl(path), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error(`Firebase write failed (${r.status})`);
}

// Returns { uid, email } for a valid Firebase ID token, else null.
async function verifyIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string' || idToken.length > 4096) return null;
  try {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_WEB_API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken }),
    });
    if (!r.ok) return null;
    const u = ((await r.json()).users || [])[0];
    return u && u.localId ? { uid: u.localId, email: u.email || null } : null;
  } catch { return null; }
}
async function userFromReq(req) {
  const h = req.headers.authorization || req.headers.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verifyIdToken(m[1].trim()) : null;
}

function billingIsPro(b) {
  if (!b || typeof b !== 'object') return false;
  if (b.comp === true) return true;
  if (!PRO_STATUSES.has(b.status)) return false;
  return !b.currentPeriodEnd || b.currentPeriodEnd + GRACE_MS > Date.now();
}
async function proEnforced() {
  return (await dbGet('config/proEnabled')) === true;
}
// Instructors and admins always get Pro features for free.
async function accessFor(uid) {
  const [billing, inst, sup, mas] = await Promise.all([
    dbGet(`billing/${uid}`), dbGet(`instructors/${uid}`),
    dbGet(`config/superAdmins/${uid}`), dbGet(`config/masterAdmins/${uid}`),
  ]);
  const staff = !!inst || sup === true || mas === true;
  return { pro: staff || billingIsPro(billing), staff, billing };
}

// ── Stripe REST ──────────────────────────────────────────────────────────────
function formEncode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}
async function stripe(method, path, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not configured');
  const qs = params ? formEncode(params) : '';
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && qs ? `?${qs}` : ''}`;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : qs,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || `Stripe ${r.status}`);
    err.stripeCode = data.error && data.error.code;
    throw err;
  }
  return data;
}

// Finds the plan's price by lookup key, creating the product + price on first use so no
// manual Stripe dashboard setup is needed.
async function getPriceId(planKey) {
  const plan = PLANS[planKey];
  if (!plan) throw new Error('Unknown plan');
  const found = await stripe('GET', 'prices', { 'lookup_keys[]': plan.lookupKey, active: 'true', limit: 1, 'expand[]': 'data.product' });
  if (found.data && found.data[0]) {
    const product = found.data[0].product;
    if (product && product.id && !product.tax_code) await stripe('POST', `products/${product.id}`, { tax_code: TAX_CODE });
    return found.data[0].id;
  }
  const products = await stripe('GET', 'products/search', { query: "metadata['app']:'classroomamt_pro'" }).catch(() => ({ data: [] }));
  const product = (products.data && products.data[0]) || await stripe('POST', 'products', {
    name: 'Classroom AMT Pro',
    description: 'DME Mode, Listening Mode, Auto Cycle, Starred Cards, PrimeTime, custom decks, FAA written practice exams, ACS codes, and the Measurement Simulator.',
    metadata: { app: 'classroomamt_pro' },
    tax_code: TAX_CODE,
  });
  const price = await stripe('POST', 'prices', {
    product: product.id, currency: 'usd', unit_amount: plan.amount,
    recurring: { interval: plan.interval }, lookup_key: plan.lookupKey, nickname: plan.nickname,
    transfer_lookup_key: 'true',
  });
  return price.id;
}

function subscriptionToBilling(sub) {
  const item = sub.items && sub.items.data && sub.items.data[0];
  // Newer Stripe API versions moved current_period_end onto the subscription item.
  const periodEnd = sub.current_period_end || (item && item.current_period_end) || null;
  const price = item && item.price;
  let plan = null;
  if (price && price.lookup_key === PLANS.yearly.lookupKey) plan = 'yearly';
  else if (price && price.lookup_key === PLANS.monthly.lookupKey) plan = 'monthly';
  else if (price && price.recurring) plan = price.recurring.interval === 'year' ? 'yearly' : 'monthly';
  return {
    status: sub.status,
    plan,
    currentPeriodEnd: periodEnd ? periodEnd * 1000 : null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    customerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || null,
    subscriptionId: sub.id,
    updatedAt: Date.now(),
  };
}
async function writeSubscription(uid, sub) {
  if (!uid || !/^[A-Za-z0-9_-]{1,128}$/.test(uid)) throw new Error('Bad uid on subscription');
  const b = subscriptionToBilling(sub);
  await dbPatch(`billing/${uid}`, b);
  return b;
}
// When a customer has several subscriptions, prefer the one that grants access.
function pickSubscription(subs) {
  const rank = s => (s.status === 'active' ? 4 : s.status === 'trialing' ? 3 : s.status === 'past_due' ? 2 : 0);
  return [...subs].sort((a, b) => rank(b) - rank(a) || b.created - a.created)[0] || null;
}

function siteOrigin(req) {
  const o = req.headers.origin;
  return ALLOWED_ORIGINS.includes(o) ? o : SITE_URL;
}
function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', siteOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

module.exports = {
  SITE_URL, PLANS, dbGet, dbPatch, verifyIdToken, userFromReq, billingIsPro, proEnforced, accessFor,
  stripe, getPriceId, subscriptionToBilling, writeSubscription, pickSubscription, siteOrigin, cors,
};
