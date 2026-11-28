'use strict';
/* DigiRes – Smart Restaurant Billing & Table-Wise QR Ordering Platform (backend) */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// Load secrets from a local .env file if present (never commit it). Real environment variables always win.
let ENV_FILE = '';
for (const f of [path.join(__dirname, '.env'), path.join(process.cwd(), '.env'), path.join(__dirname, '.env.txt')]) {
  try {
    const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    ENV_FILE = path.basename(f);
    raw.split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
    break;
  } catch (e) { /* try the next location */ }
}

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const FILE = path.join(DATA_DIR, 'state.json');
const SUPPORT = 'hareshfegade@gmail.com';
const BUILD = 'DigiRes build 2026-11-28-r6';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@digires.in').trim().toLowerCase();
// Demo payments exist ONLY for local testing. They can never switch on when running on Render or with NODE_ENV=production.
const TEST_MODE = process.env.TEST_MODE === '1' && !process.env.RENDER && process.env.NODE_ENV !== 'production';
if (process.env.TEST_MODE === '1' && !TEST_MODE) console.warn('TEST_MODE is ignored on a live/production server (demo payments stay OFF).');
const DAY = 864e5;
const KEEP = 7 * DAY; // paid history, payment logs & print logs are deleted after 7 days
const ENV_RZP_ID = process.env.RAZORPAY_KEY_ID || '';
const ENV_RZP_SEC = process.env.RAZORPAY_KEY_SECRET || '';

/* ---------- helpers ---------- */
const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const r2 = n => Math.round(n * 100) / 100;
const E = (m, c = 400) => { const e = new Error(m); e.http = c; return e; };
const hash = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(String(pw), s, 32).toString('hex'); };
const check = (pw, h) => {
  if (!h) return false;
  const [s, x] = h.split(':'); const y = crypto.scryptSync(String(pw || ''), s, 32); const xb = Buffer.from(x, 'hex');
  return xb.length === y.length && crypto.timingSafeEqual(xb, y);
};
const SECRET = () => process.env.SESSION_SECRET || db.secret;
const KEYMAT = () => crypto.createHash('sha256').update(String(process.env.APP_SECRET || (db && db.secret) || '')).digest();
const enc = t => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', KEYMAT(), iv);
  const d = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return 'enc:' + Buffer.concat([iv, c.getAuthTag(), d]).toString('base64');
};
const dec = t => {
  if (!String(t).startsWith('enc:')) return t;
  try {
    const b = Buffer.from(t.slice(4), 'base64'), d = crypto.createDecipheriv('aes-256-gcm', KEYMAT(), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch (e) { return ''; }
};
const validUpi = u => /^[A-Za-z0-9._\-]{2,64}@[A-Za-z0-9]{2,32}$/.test(String(u || '').trim());
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const FEATS = ['qr', 'kds', 'whatsapp', 'printer'];

/* ---------- durable remote storage (optional, recommended on Render free) ---------- */
const R_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), R_TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REMOTE = !!(R_URL && R_TOK);
async function rcmd(cmd) {
  const r = await fetch(R_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + R_TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(j.error || 'Redis HTTP ' + r.status);
  return j.result;
}
let rTimer = null, rBusy = false, rAgain = false;
function pushRemote() { if (REMOTE) { clearTimeout(rTimer); rTimer = setTimeout(flushRemote, 300); } }
async function flushRemote() {
  if (rBusy) { rAgain = true; return; }
  rBusy = true;
  try { await rcmd(['SET', 'digires_state', JSON.stringify(db)]); } catch (e) { console.error('Redis save failed:', e.message); }
  rBusy = false; if (rAgain) { rAgain = false; pushRemote(); }
}

/* ---------- persistent store ---------- */
let db;
function save() {
  try { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, FILE); } catch (e) { console.error('Disk save failed:', e.message); }
  pushRemote();
}
async function load() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('Cannot create data folder:', e.message); }
  db = null;
  if (REMOTE) {
    try { const v = await rcmd(['GET', 'digires_state']); if (v) db = JSON.parse(v); }
    catch (e) { console.error('Cannot read Redis state - refusing to start with empty data:', e.message); process.exit(1); }
  }
  if (!db) { try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { db = null; } }
  if (db && !(db.secret && db.admin && db.admin.hash && Array.isArray(db.plans))) {
    // state file from an older/different version: keep a backup and start fresh
    try { fs.copyFileSync(FILE, FILE + '.old-' + Date.now()); } catch (e) {}
    db = null;
  }
  if (!db) {
    const pw = process.env.ADMIN_PASSWORD || '', pin = process.env.ADMIN_PIN || '';
    if (pw.length < 8 || !/^\d{4,8}$/.test(pin)) {
      console.error('\nSTOP: set ADMIN_PASSWORD (8+ characters) and ADMIN_PIN (4-8 digits) yourself.');
      console.error('Put them in the .env file next to server.js, or in your hosting Environment variables, then start again.');
      console.error('.env file found: ' + (ENV_FILE ? 'yes (' + ENV_FILE + ') but ADMIN_PASSWORD / ADMIN_PIN are missing or too short in it' : 'NO'));
      console.error('Server folder: ' + __dirname);
      try { console.error('Files here with "env" in the name: ' + (fs.readdirSync(__dirname).filter(f => /env/i.test(f)).join(', ') || '(none)')); } catch (e) {}
      console.error('The file must be named exactly .env and sit next to server.js.\n');
      process.exit(1);
    }
    db = {
      secret: uid(32),
      admin: { email: ADMIN_EMAIL, hash: hash(pw), pinHash: hash(pin), upi: '', razorKeyId: '', razorKeySecret: '' },
      plans: [
        { id: 'starter', name: 'Starter', price: 499, desc: 'QR ordering & billing for small cafés', features: { qr: true, kds: false, whatsapp: true, printer: false }, status: 'live' },
        { id: 'pro', name: 'Pro', price: 999, desc: 'Adds the live Kitchen Display', features: { qr: true, kds: true, whatsapp: true, printer: false }, status: 'live' },
        { id: 'premium', name: 'Premium', price: 1499, desc: 'Everything, incl. auto thermal printing', features: { qr: true, kds: true, whatsapp: true, printer: true }, status: 'live' }
      ],
      owners: [], bills: [], payments: [], printLogs: [], pending: [], rzOrders: {}
    };
    console.log('Admin account created: ' + ADMIN_EMAIL);
  }
  // If ADMIN_PASSWORD / ADMIN_PIN env vars are set, they always win (so changing them on Render resets the admin login)
  if (process.env.ADMIN_EMAIL) db.admin.email = ADMIN_EMAIL;
  // Env values are applied only when they CHANGE, so a password changed from the Admin panel / Forgot-PIN survives restarts.
  const FORCE_RESET = process.env.ADMIN_RESET === '1'; // emergency: re-apply ADMIN_* env values once, then remove ADMIN_RESET
  if (FORCE_RESET) console.warn('ADMIN_RESET=1: admin email/password/PIN are being reset from env. Remove ADMIN_RESET afterwards.');
  if (process.env.ADMIN_PASSWORD && (FORCE_RESET || !check(process.env.ADMIN_PASSWORD, db.admin.envPwHash))) { db.admin.hash = hash(process.env.ADMIN_PASSWORD); db.admin.envPwHash = db.admin.hash; }
  if (process.env.ADMIN_PIN && (FORCE_RESET || !check(process.env.ADMIN_PIN, db.admin.envPinHash))) { db.admin.pinHash = hash(process.env.ADMIN_PIN); db.admin.envPinHash = db.admin.pinHash; }
  ['owners', 'bills', 'payments', 'printLogs', 'pending'].forEach(k => { db[k] = db[k] || []; });
  db.rzOrders = db.rzOrders || {};
  db.credits = db.credits || [];
  if (!db.admin.feedKey) db.admin.feedKey = uid(8);
  db.owners.forEach(o => { if (!o.feedKey) o.feedKey = uid(8); });
  save();
}
function cleanup() {
  const lim = Date.now() - KEEP;
  db.bills = db.bills.filter(b => !(b.status === 'PAID' && (b.paidAt || 0) < lim));
  db.payments = db.payments.filter(p => p.ts >= lim);
  db.printLogs = db.printLogs.filter(p => p.ts >= lim);
  db.pending = db.pending.filter(p => p.ts >= lim);
  db.credits = db.credits.filter(c => c.ts >= lim);
  Object.keys(db.rzOrders).forEach(k => { if (db.rzOrders[k].ts < Date.now() - DAY) delete db.rzOrders[k]; });
  save();
}

/* ---------- auth ---------- */
const sign = o => {
  const b = Buffer.from(JSON.stringify(o)).toString('base64url');
  return b + '.' + crypto.createHmac('sha256', SECRET()).update(b).digest('base64url');
};
function verifyTok(t) {
  try {
    const [b, s] = String(t).split('.');
    const e = crypto.createHmac('sha256', SECRET()).update(b).digest('base64url');
    if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null;
    const o = JSON.parse(Buffer.from(b, 'base64url').toString());
    return o.exp > Date.now() ? o : null;
  } catch (e) { return null; }
}
function who(req) {
  const t = verifyTok(req.get('x-token'));
  if (!t) return null;
  if (t.role === 'admin') return t.v === db.admin.hash.slice(-8) ? t : null;
  const o = db.owners.find(x => x.id === t.id);
  if (!o) return null;
  if (t.role === 'owner') return t.v === o.hash.slice(-8) ? t : null;
  if (t.role === 'kitchen') return t.v === o.kitchenKey ? t : null;
  return null;
}
const ownerTok = o => ({ token: sign({ role: 'owner', id: o.id, v: o.hash.slice(-8), exp: Date.now() + 30 * DAY }), role: 'owner', id: o.id });
const tries = new Map();
const limited = k => { const n = Date.now(), a = (tries.get(k) || []).filter(t => n - t < 6e5); tries.set(k, a); return a.length >= 10; };
const failed = k => { const a = tries.get(k) || []; a.push(Date.now()); tries.set(k, a); };

/* ---------- views ---------- */
const rzCreds = x => (x && x.razorKeyId && x.razorKeySecret) ? { id: x.razorKeyId, secret: dec(x.razorKeySecret) }
  : (ENV_RZP_ID && ENV_RZP_SEC ? { id: ENV_RZP_ID, secret: ENV_RZP_SEC } : null);
const ownerPublic = o => ({ id: o.id, restaurant: o.restaurant, status: o.status, features: o.features, gst: o.gst, upi: o.upi, menu: o.menu, tables: o.tables, razorpay: !!rzCreds(o) });
const ownerPrivate = o => ({ ...ownerPublic(o), email: o.email, planId: o.planId, razorKeyId: o.razorKeyId, hasSecret: !!o.razorKeySecret, codes: o.codes, kitchenKey: o.kitchenKey, feedKey: o.feedKey });
const pubBill = b => ({ id: b.id, table: b.table, items: b.items, subtotal: b.subtotal, gstPct: b.gstPct, gst: b.gst, total: b.total, status: b.status, method: b.method, kitchen: b.kitchen, payClaim: b.payClaim, createdAt: b.createdAt, paidAt: b.paidAt });
const fullBill = b => ({ ...pubBill(b), code: b.code, batches: b.batches, claimUtr: b.claimUtr || '' });

const findOwner = id => { const o = db.owners.find(x => x.id === String(id)); if (!o) throw E('Restaurant not found', 404); return o; };
const liveOwner = id => {
  const o = findOwner(id);
  if (o.status !== 'live') throw E('This restaurant is currently unavailable', 403);
  if (!o.features.qr) throw E('Ordering is not enabled for this restaurant', 403);
  return o;
};
const openBill = (o, t, code) => db.bills.find(b => b.ownerId === o.id && b.table === String(t) && b.status === 'UNPAID' && String(b.code) === String(code));
const billOf = (o, id) => { const b = db.bills.find(x => x.id === String(id) && x.ownerId === o.id); if (!b) throw E('Bill not found', 404); return b; };
function retotal(b, o) {
  b.subtotal = r2(b.items.reduce((s, i) => s + i.price * i.qty, 0));
  b.gstPct = o.gst; b.gst = r2(b.subtotal * b.gstPct / 100); b.total = r2(b.subtotal + b.gst);
}
function settle(bill, o, method, ref) {
  if (bill.status === 'PAID') return;
  bill.status = 'PAID'; bill.method = method; bill.paidAt = Date.now(); bill.payClaim = '';
  const c = o.codes[bill.table];
  if (c && String(c.code) === String(bill.code)) c.active = false; // session code expires after full payment
  db.payments.push({ id: uid(4), kind: 'bill', ownerId: o.id, restaurant: o.restaurant, amount: bill.total, method, ref: ref || '', ts: Date.now() });
}
function createOwner(p, method, ref) {
  if (db.owners.some(x => x.email === p.email)) throw E('Email already registered');
  const plan = db.plans.find(x => x.id === p.planId) || db.plans[0];
  const o = {
    id: uid(4), email: p.email, hash: p.hash, pinHash: p.pinHash, restaurant: p.restaurant, planId: plan.id, status: 'live',
    features: { ...plan.features }, gst: 5, upi: '', razorKeyId: '', razorKeySecret: '', tables: 7, menu: [], codes: {},
    kitchenKey: uid(6), feedKey: uid(8), createdAt: Date.now()
  };
  db.owners.push(o); p.status = 'approved';
  if (method !== 'MANUAL') db.payments.push({ id: uid(4), kind: 'sub', ownerId: o.id, restaurant: o.restaurant, email: o.email, planName: plan.name, amount: plan.price, method, ref: ref || '', ts: Date.now() });
  return o;
}

/* ---------- UTR auto-verification (matches customer UTR with real bank-credit records) ---------- */
function parseSms(text) {
  const t = String(text || '');
  if (/debited|withdrawn/i.test(t) && !/credited|received/i.test(t)) return null; // ignore outgoing money
  const utr = (t.match(/(?<!\d)\d{12}(?!\d)/) || [])[0];
  if (!utr) return null;
  let m = t.match(/(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) m = t.replace(utr, ' ').match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  const amount = m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
  return amount > 0 ? { utr, amount } : null;
}
function addCredit(scope, utr, amount) {
  if (db.credits.some(c => c.ownerId === scope && c.utr === utr)) return false;
  db.credits.push({ id: uid(4), ownerId: scope, utr, amount: r2(amount), ts: Date.now(), used: '' });
  return true;
}
function reconcile(scope) {
  let n = 0;
  for (const c of db.credits) {
    if (c.ownerId !== scope || c.used) continue;
    if (scope === 'admin') {
      const p = db.pending.find(x => x.status === 'claimed' && x.utr === c.utr);
      const pl = p && db.plans.find(x => x.id === p.planId);
      if (p && pl && c.amount >= pl.price - 0.001) { try { createOwner(p, 'UPI', c.utr); c.used = p.id; n++; } catch (e) { /* e.g. email already exists */ } }
    } else {
      const o = db.owners.find(x => x.id === scope); if (!o) continue;
      const bill = db.bills.find(x => x.ownerId === o.id && x.status === 'UNPAID' && x.claimUtr === c.utr);
      if (bill && c.amount >= bill.total - 0.001) { settle(bill, o, 'UPI', c.utr); c.used = bill.id; n++; }
    }
  }
  return n;
}
function ingest(scope, text) {
  const t = String(text || '').slice(0, 5000);
  const utrs = t.match(/(?<!\d)\d{12}(?!\d)/g) || [];
  const chunks = utrs.length <= 1 ? [t] : t.split(/\n+/);
  let added = 0;
  for (const ch of chunks) { const p = parseSms(ch); if (p && addCredit(scope, p.utr, p.amount)) added++; }
  return { added, matched: reconcile(scope) };
}
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const FORCE_HTTPS = process.env.FORCE_HTTPS === '1';
app.use((req, res, next) => {
  if (FORCE_HTTPS && !req.secure && req.path !== '/healthz') return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' });
  if (FORCE_HTTPS) res.set('Strict-Transport-Security', 'max-age=15552000');
  if (String(req.path).startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '200kb' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/healthz', (req, res) => res.send('ok - ' + BUILD));

app.get('/api/config', (req, res) => res.json({ razorpay: !!(ENV_RZP_ID && ENV_RZP_SEC), keyId: ENV_RZP_ID, support: SUPPORT, build: BUILD }));

app.get('/api/state', (req, res) => {
  const me = who(req), q = req.query;
  const base = {
    now: Date.now(), support: SUPPORT, testMode: TEST_MODE,
    plans: db.plans.filter(p => p.status === 'live').map(({ id, name, price, desc, features }) => ({ id, name, price, desc, features })),
    pay: { upi: db.admin.upi, razorpay: !!rzCreds(db.admin) }
  };
  if (me && me.role === 'admin') {
    return res.json({
      ...base, role: 'admin', plans: db.plans,
      storage: REMOTE ? 'redis' : (process.env.DATA_DIR ? 'disk' : ((process.env.RENDER || process.env.NODE_ENV === 'production') ? 'ephemeral' : 'local')),
      owners: db.owners.map(o => ({ id: o.id, email: o.email, restaurant: o.restaurant, planId: o.planId, status: o.status, features: o.features, createdAt: o.createdAt })),
      credits: db.credits.filter(c => c.ownerId === 'admin').slice(-30).reverse(),
      admin: { feedKey: db.admin.feedKey, email: db.admin.email, upi: db.admin.upi, razorKeyId: db.admin.razorKeyId, hasSecret: !!db.admin.razorKeySecret },
      payments: db.payments.filter(p => p.kind === 'sub').sort((a, b) => b.ts - a.ts).slice(0, 100),
      pending: db.pending.filter(p => p.status === 'claimed').map(({ id, restaurant, email, planId, utr, ts }) => ({ id, restaurant, email, planId, utr, ts }))
    });
  }
  if (me && me.role === 'owner') {
    const o = findOwner(me.id);
    return res.json({ ...base, role: 'owner', owner: ownerPrivate(o), credits: db.credits.filter(c => c.ownerId === o.id).slice(-30).reverse(), bills: db.bills.filter(b => b.ownerId === o.id).map(fullBill) });
  }
  if (me && me.role === 'kitchen') {
    const o = findOwner(me.id);
    return res.json({ ...base, role: 'kitchen', owner: ownerPublic(o), bills: db.bills.filter(b => b.ownerId === o.id && b.status === 'UNPAID').map(fullBill) });
  }
  if (q.owner) {
    const o = db.owners.find(x => x.id === String(q.owner));
    if (!o) return res.status(404).json({ error: 'Invalid QR code' });
    const b = q.bill ? db.bills.find(x => x.id === String(q.bill) && x.ownerId === o.id) : null;
    return res.json({ ...base, role: 'customer', owner: ownerPublic(o), bill: b ? pubBill(b) : null });
  }
  res.json(base);
});

/* ---------- actions (POST /api/state) ---------- */
const needOwner = me => {
  if (!me || me.role !== 'owner') throw E('Please log in', 401);
  const o = findOwner(me.id);
  if (o.status !== 'live') throw E('Subscription stopped. Contact support.', 403);
  return o;
};
const needKitchen = me => {
  if (!me || (me.role !== 'kitchen' && me.role !== 'owner')) throw E('Not allowed', 401);
  const o = findOwner(me.id);
  if (o.status !== 'live') throw E('Subscription stopped', 403);
  if (!o.features.kds) throw E('Kitchen Display is not enabled', 403);
  return o;
};
const needAdmin = me => { if (!me || me.role !== 'admin') throw E('Admin only', 401); };

function act(b, me, ip) {
  const A = b.action;
  /* --- customer (public) --- */
  if (A === 'verifyCode') {
    const o = liveOwner(b.owner), t = String(b.table), c = o.codes[t], k = (ip || '') + ':vc:' + o.id + ':' + t;
    if (limited(k)) throw E('Too many wrong codes. Please wait a few minutes.', 429);
    if (!(c && c.active && String(c.code) === String(b.code || '').trim())) { failed(k); throw E('Invalid or expired session code', 403); }
    const bill = openBill(o, t, c.code);
    return { billId: bill ? bill.id : null };
  }
  if (A === 'placeOrder') {
    const o = liveOwner(b.owner), t = String(b.table), c = o.codes[t], k = (ip || '') + ':vc:' + o.id + ':' + t;
    if (limited(k)) throw E('Too many wrong codes. Please wait a few minutes.', 429);
    if (!(c && c.active && String(c.code) === String(b.code || '').trim())) { failed(k); throw E('Session code is invalid or expired. Ask the staff for a new code.', 403); }
    const lines = Array.isArray(b.items) ? b.items.slice(0, 60) : [];
    if (!lines.length) throw E('Your cart is empty');
    const batch = { id: uid(4), ts: Date.now(), items: [], printed: false };
    const add = [];
    for (const l of lines) {
      const d = o.menu.find(m => m.id === l.id); if (!d) continue;
      const size = l.size === 'Half' ? 'Half' : 'Full';
      const price = size === 'Half' ? d.half : d.full;
      const qty = Math.min(50, Math.max(1, parseInt(l.qty, 10) || 0));
      if (!price || !qty) continue;
      batch.items.push({ name: d.name, size, qty }); add.push({ id: d.id, name: d.name, size, price, qty });
    }
    if (!batch.items.length) throw E('No valid items in cart');
    let bill = openBill(o, t, c.code);
    if (!bill) {
      bill = { id: uid(8), ownerId: o.id, table: t, code: c.code, items: [], batches: [], kitchen: 'New', status: 'UNPAID', payClaim: '', method: '', createdAt: Date.now() };
      db.bills.push(bill);
    }
    add.forEach(a => { const ex = bill.items.find(i => i.id === a.id && i.size === a.size); if (ex) ex.qty += a.qty; else bill.items.push(a); });
    bill.batches.push(batch); bill.kitchen = 'New'; bill.payClaim = ''; bill.claimUtr = '';
    retotal(bill, o);
    return { billId: bill.id };
  }
  if (A === 'claimPay') {
    const o = findOwner(b.owner), bill = billOf(o, b.billId);
    if (bill.status === 'PAID') return { matched: true };
    if (b.method === 'UPI') {
      const utr = String(b.utr || '').trim();
      if (!/^\d{12}$/.test(utr)) throw E('Enter the 12-digit UPI transaction ID (UTR) from your payment app');
      const k = (ip || '') + ':utr:' + o.id;
      if (limited(k)) throw E('Too many attempts. Please wait a few minutes.', 429);
      if (db.bills.some(x => x.ownerId === o.id && x.id !== bill.id && x.claimUtr === utr)) { failed(k); throw E('This UTR is already used for another bill'); }
      bill.claimUtr = utr; bill.payClaim = 'UPI';
      reconcile(o.id);
      return { matched: bill.status === 'PAID' };
    }
    bill.payClaim = 'CASH'; return {};
  }
  /* --- owner --- */
  if (A === 'setTables') {
    const o = needOwner(me), n = parseInt(b.tables, 10);
    if (!(n >= 1 && n <= 100)) throw E('Tables must be between 1 and 100');
    o.tables = n; return {};
  }
  if (A === 'saveSettings') {
    const o = needOwner(me);
    const name = String(b.restaurant || '').trim(); if (name.length < 2 || name.length > 60) throw E('Restaurant name must be 2-60 characters');
    const gst = Number(b.gst); if (!(gst >= 0 && gst <= 40)) throw E('GST % must be between 0 and 40');
    const upi = String(b.upi || '').trim(); if (upi && !validUpi(upi)) throw E('Invalid UPI ID (example: name@bank)');
    o.restaurant = name; o.gst = gst; o.upi = upi; o.razorKeyId = String(b.razorKeyId || '').trim().slice(0, 60);
    if (b.razorKeySecret && String(b.razorKeySecret).trim()) o.razorKeySecret = enc(String(b.razorKeySecret).trim().slice(0, 80));
    db.bills.filter(x => x.ownerId === o.id && x.status === 'UNPAID').forEach(x => retotal(x, o));
    return {};
  }
  if (A === 'addDish') {
    const o = needOwner(me), name = String(b.name || '').trim().slice(0, 60);
    const half = r2(Number(b.half) || 0), full = r2(Number(b.full) || 0);
    if (!name) throw E('Dish name is required');
    if (half < 0 || full < 0 || (!half && !full)) throw E('Enter a Half and/or Full price');
    if (o.menu.length >= 300) throw E('Menu limit reached');
    o.menu.push({ id: uid(3), name, half, full }); return {};
  }
  if (A === 'delDish') { const o = needOwner(me); o.menu = o.menu.filter(m => m.id !== b.id); return {}; }
  if (A === 'setCode') {
    const o = needOwner(me), t = String(parseInt(b.table, 10));
    if (!(+t >= 1 && +t <= o.tables)) throw E('Invalid table');
    let code = String(b.code || '').trim();
    if (!code) code = String(1000 + crypto.randomInt(9000));
    if (!/^[A-Za-z0-9]{3,12}$/.test(code)) throw E('Code must be 3-12 letters/numbers');
    const open = db.bills.find(x => x.ownerId === o.id && x.table === t && x.status === 'UNPAID');
    if (open && String(open.code) !== code) throw E('Table ' + t + ' has an unpaid bill. Collect payment first.');
    o.codes[t] = { code, active: true }; return {};
  }
  if (A === 'markPaid') {
    const o = needOwner(me), bill = billOf(o, b.billId);
    const m = { CASH: 'CASH', UPI: 'UPI' }[b.method]; if (!m) throw E('Invalid method');
    settle(bill, o, m, ''); return {};
  }
  /* --- owner or kitchen --- */
  if (A === 'kitchenStatus') {
    const o = needKitchen(me), bill = billOf(o, b.billId);
    if (!['Preparing', 'Ready'].includes(b.status)) throw E('Invalid status');
    bill.kitchen = b.status; return {};
  }
  if (A === 'kotPrinted') {
    const o = needKitchen(me), bill = billOf(o, b.billId), bt = bill.batches.find(x => x.id === b.batchId);
    if (bt) bt.printed = true; return {};
  }
  if (A === 'printLog') {
    if (!me || (me.role !== 'owner' && me.role !== 'kitchen')) throw E('Not allowed', 401);
    db.printLogs.push({ id: uid(4), ownerId: me.id, table: String(b.table || ''), type: b.type === 'RECEIPT' ? 'RECEIPT' : 'KOT', ts: Date.now() }); return {};
  }
  if (A === 'addCredits') {
    const scope = (me && me.role === 'admin') ? 'admin' : needOwner(me).id;
    return ingest(scope, b.text);
  }
  /* --- admin --- */
  needAdmin(me);
  if (A === 'addPlan') {
    const name = String(b.name || '').trim().slice(0, 40), price = Number(b.price);
    if (!name || !(price > 0)) throw E('Plan name and a price above 0 are required');
    const f = {}; FEATS.forEach(k => { f[k] = !!(b.features && b.features[k]); });
    db.plans.push({ id: uid(3), name, price, desc: String(b.desc || '').slice(0, 120), features: f, status: 'live' }); return {};
  }
  if (A === 'togglePlan') { const p = db.plans.find(x => x.id === b.id); if (p) p.status = p.status === 'live' ? 'hidden' : 'live'; return {}; }
  if (A === 'delPlan') { db.plans = db.plans.filter(x => x.id !== b.id); return {}; }
  if (A === 'ownerStatus') {
    const o = findOwner(b.id); if (!['live', 'stopped'].includes(b.status)) throw E('Invalid status');
    o.status = b.status; return {};
  }
  if (A === 'ownerPlan') {
    const o = findOwner(b.id), p = db.plans.find(x => x.id === b.planId); if (!p) throw E('Plan not found', 404);
    o.planId = p.id; o.features = { ...p.features }; return {};
  }
  if (A === 'ownerFeature') {
    const o = findOwner(b.id); if (!FEATS.includes(b.key)) throw E('Invalid feature');
    o.features[b.key] = !!b.value; return {};
  }
  if (A === 'delOwner') {
    const o = findOwner(b.id);
    db.owners = db.owners.filter(x => x.id !== o.id); db.bills = db.bills.filter(x => x.ownerId !== o.id); return {};
  }
  if (A === 'adminSettings') {
    const upi = String(b.upi || '').trim(); if (upi && !validUpi(upi)) throw E('Invalid UPI ID (example: name@bank)');
    db.admin.upi = upi; db.admin.razorKeyId = String(b.razorKeyId || '').trim().slice(0, 60);
    if (b.razorKeySecret && String(b.razorKeySecret).trim()) db.admin.razorKeySecret = enc(String(b.razorKeySecret).trim().slice(0, 80));
    return {};
  }
  if (A === 'adminPassword') {
    if (!check(b.current, db.admin.hash)) throw E('Current password is wrong', 403);
    if (b.newPassword) { if (String(b.newPassword).length < 8) throw E('New password needs 8+ characters'); db.admin.hash = hash(b.newPassword); }
    if (b.newPin) { if (!/^\d{4,8}$/.test(String(b.newPin))) throw E('PIN must be 4-8 digits'); db.admin.pinHash = hash(b.newPin); }
    return { relogin: !!b.newPassword };
  }
  if (A === 'ownerPassword') {
    const o = findOwner(b.id);
    if (String(b.password || '').length < 6) throw E('Password needs 6+ characters');
    o.hash = hash(b.password); return {};
  }
  if (A === 'addOwner') {
    const email = String(b.email || '').trim().toLowerCase(), name = String(b.restaurant || '').trim();
    if (name.length < 2 || name.length > 60) throw E('Enter the restaurant name');
    if (!validEmail(email)) throw E('Enter a valid email');
    if (String(b.password || '').length < 6) throw E('Password needs 6+ characters');
    if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw E('Recovery PIN must be 4-6 digits');
    const plan = db.plans.find(x => x.id === b.planId); if (!plan) throw E('Choose a plan');
    createOwner({ restaurant: name, email, hash: hash(b.password), pinHash: hash(b.pin), planId: plan.id }, 'MANUAL', '');
    return {};
  }
  if (A === 'confirmSignup') {
    const p = db.pending.find(x => x.id === b.id && x.status === 'claimed'); if (!p) throw E('Signup not found', 404);
    createOwner(p, 'UPI', p.utr); return {};
  }
  if (A === 'rejectSignup') { const p = db.pending.find(x => x.id === b.id); if (p) p.status = 'rejected'; return {}; }
  throw E('Unknown action');
}

app.post('/api/state', (req, res) => {
  try {
    const r = act(req.body || {}, who(req), req.ip);
    save(); res.json({ ok: true, ...r });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

/* ---------- auth ---------- */
app.post('/api/auth/admin-login', (req, res) => {
  const b = req.body || {}, k = req.ip + ':admin';
  if (limited(k)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const okE = String(b.email || '').trim().toLowerCase() === db.admin.email, okP = check(b.password, db.admin.hash);
  if (!okE || !okP) { failed(k); return res.status(401).json({ error: 'Invalid credentials' }); }
  res.json({ token: sign({ role: 'admin', id: 'admin', v: db.admin.hash.slice(-8), exp: Date.now() + 7 * DAY }), role: 'admin', id: 'admin' });
});
app.post('/api/auth/admin-forgot', (req, res) => {
  const b = req.body || {}, k = req.ip + ':adminpin';
  if (limited(k)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (!check(b.pin, db.admin.pinHash)) { failed(k); return res.status(401).json({ error: 'Wrong recovery PIN' }); }
  if (String(b.newPassword || '').length < 8) return res.status(400).json({ error: 'New password needs 8+ characters' });
  db.admin.hash = hash(b.newPassword); save(); res.json({ ok: true });
});
app.post('/api/auth/owner-login', (req, res) => {
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), k = req.ip + ':' + email;
  if (limited(k)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const o = db.owners.find(x => x.email === email);
  if (!o || !check(b.password, o.hash)) {
    if (!o) {
      const pd = db.pending.find(x => x.email === email && ['claimed', 'awaiting', 'rejected'].includes(x.status) && check(b.password, x.hash));
      if (pd) return res.status(403).json({ error: pd.status === 'claimed' ? 'Aapka UPI payment admin confirm kar raha hai. Approval ke baad login chalega, support se baat karo.' : pd.status === 'rejected' ? 'Aapka payment confirm nahi hua. Support se baat karo.' : 'Subscription payment poora nahi hua. "New Subscribe" mein payment complete karo.' });
    }
    failed(k); return res.status(401).json({ error: 'Invalid email or password' });
  }
  res.json(ownerTok(o));
});
app.post('/api/auth/owner-forgot', (req, res) => {
  const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), k = req.ip + ':f:' + email;
  if (limited(k)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const o = db.owners.find(x => x.email === email);
  if (!o || !check(b.pin, o.pinHash)) { failed(k); return res.status(401).json({ error: 'Email or Recovery PIN is wrong' }); }
  if (String(b.newPassword || '').length < 6) return res.status(400).json({ error: 'New password needs 6+ characters' });
  o.hash = hash(b.newPassword); save(); res.json({ ok: true });
});
app.post('/api/auth/kitchen', (req, res) => {
  const b = req.body || {}, o = db.owners.find(x => x.id === String(b.owner));
  if (!o || !b.key || o.kitchenKey !== String(b.key)) return res.status(401).json({ error: 'Invalid kitchen link' });
  res.json({ token: sign({ role: 'kitchen', id: o.id, v: o.kitchenKey, exp: Date.now() + 30 * DAY }), role: 'kitchen', id: o.id });
});

/* ---------- owner sign-up (account created only after payment) ---------- */
app.post('/api/signup/start', (req, res) => {
  try {
    const sk = req.ip + ':signup'; if (limited(sk)) throw E('Too many attempts. Try again later.', 429); failed(sk);
    const b = req.body || {}, email = String(b.email || '').trim().toLowerCase(), name = String(b.restaurant || '').trim();
    if (name.length < 2 || name.length > 60) throw E('Enter your restaurant name');
    if (!validEmail(email)) throw E('Enter a valid email');
    if (String(b.password || '').length < 6) throw E('Password needs 6+ characters');
    if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw E('Recovery PIN must be 4-6 digits');
    const plan = db.plans.find(x => x.id === b.planId && x.status === 'live'); if (!plan) throw E('Choose a plan');
    if (db.owners.some(o => o.email === email)) throw E('This email is already registered. Please log in.');
    if (db.pending.some(p => p.email === email && p.status === 'claimed')) throw E('Is email ka UPI payment admin confirmation ke liye pending hai. Thoda wait karo ya support se baat karo.');
    db.pending = db.pending.filter(p => !(p.email === email && p.status !== 'claimed'));
    const p = { id: uid(8), restaurant: name, email, hash: hash(b.password), pinHash: hash(b.pin), planId: plan.id, status: 'awaiting', utr: '', ts: Date.now() };
    db.pending.push(p); save(); res.json({ pendingId: p.id });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
app.post('/api/signup/claim-upi', (req, res) => {
  const b = req.body || {}, p = db.pending.find(x => x.id === b.pendingId && x.status === 'awaiting');
  if (!p) return res.status(404).json({ error: 'Signup not found' });
  const utr = String(b.utr || '').trim();
  if (!/^\d{12}$/.test(utr)) return res.status(400).json({ error: 'Enter the 12-digit UPI transaction ID (UTR)' });
  if (!validUpi(db.admin.upi)) return res.status(503).json({ error: 'UPI payment is not available' });
  const k = req.ip + ':claimutr';
  if (limited(k)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  if (db.pending.some(x => x.id !== p.id && x.utr === utr)) { failed(k); return res.status(400).json({ error: 'This UTR is already used' }); }
  p.status = 'claimed'; p.utr = utr;
  reconcile('admin'); save();
  if (p.status === 'approved') { const o = db.owners.find(x => x.email === p.email); return res.json({ ok: true, matched: true, ...ownerTok(o) }); }
  res.json({ ok: true, matched: false });
});
app.post('/api/utr-feed', (req, res) => {
  try {
    const b = req.body || {}, k = req.ip + ':feed';
    if (limited(k)) throw E('Too many attempts', 429);
    const scope = String(b.owner || ''), holder = scope === 'admin' ? db.admin : db.owners.find(x => x.id === scope);
    const key = b.key || req.get('x-feed-key') || '';
    if (!holder || !holder.feedKey || !safeEq(key, holder.feedKey)) { failed(k); throw E('Invalid key', 401); }
    const r = ingest(scope, b.text || (b.utr + ' ' + b.amount));
    save(); res.json({ ok: true, ...r });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
app.get('/api/signup/status', (req, res) => {
  const p = db.pending.find(x => x.id === String(req.query.id));
  res.json({ status: p ? p.status : 'unknown' });
});

/* ---------- Razorpay ---------- */
async function rzOrder(creds, amount, receipt) {
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + Buffer.from(creds.id + ':' + creds.secret).toString('base64') },
    body: JSON.stringify({ amount: Math.round(amount * 100), currency: 'INR', receipt: receipt.slice(0, 40) })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw E((j.error && j.error.description) || 'Razorpay error', 502);
  return j;
}
app.post('/api/create-razorpay-order', async (req, res) => {
  try {
    const b = req.body || {}; let creds, amount, meta;
    if (b.type === 'subscription') {
      const p = db.pending.find(x => x.id === b.pendingId && (x.status === 'awaiting' || x.status === 'claimed'));
      if (!p) throw E('Signup session not found', 404);
      const pl = db.plans.find(x => x.id === p.planId); if (!pl) throw E('Plan not found', 404);
      creds = rzCreds(db.admin); amount = pl.price; meta = { type: 'sub', scope: 'admin', pendingId: p.id };
    } else if (b.type === 'bill') {
      const o = findOwner(b.owner); if (o.status !== 'live') throw E('Restaurant unavailable', 403);
      const bill = billOf(o, b.billId); if (bill.status === 'PAID') throw E('This bill is already paid');
      creds = rzCreds(o); amount = bill.total; meta = { type: 'bill', scope: 'owner', ownerId: o.id, billId: bill.id };
    } else throw E('Bad request');
    if (!creds) throw E('Razorpay is not configured', 503);
    const ord = await rzOrder(creds, amount, meta.type + '_' + uid(4));
    db.rzOrders[ord.id] = { ...meta, amount, ts: Date.now() }; save();
    res.json({ orderId: ord.id, amount: ord.amount, keyId: creds.id });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
app.post('/api/verify-razorpay-payment', (req, res) => {
  try {
    const b = req.body || {}, m = db.rzOrders[b.razorpay_order_id];
    if (!m) throw E('Unknown or already processed order', 404);
    const creds = m.scope === 'admin' ? rzCreds(db.admin) : rzCreds(findOwner(m.ownerId));
    if (!creds) throw E('Razorpay is not configured', 503);
    const exp = crypto.createHmac('sha256', creds.secret).update(b.razorpay_order_id + '|' + b.razorpay_payment_id).digest('hex');
    const got = String(b.razorpay_signature || '');
    if (got.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(exp))) throw E('Payment verification failed. Bill stays UNPAID.');
    if (m.type === 'bill') {
      const o = findOwner(m.ownerId), bill = billOf(o, m.billId);
      if (m.amount < bill.total) throw E('Bill changed after payment started. Contact the restaurant with payment id ' + b.razorpay_payment_id);
      settle(bill, o, 'RAZORPAY', b.razorpay_payment_id);
      delete db.rzOrders[b.razorpay_order_id]; save();
      return res.json({ ok: true });
    }
    const p = db.pending.find(x => x.id === m.pendingId && (x.status === 'awaiting' || x.status === 'claimed'));
    if (!p) throw E('Signup session expired. Contact support.', 404);
    const o = createOwner(p, 'RAZORPAY', b.razorpay_payment_id);
    delete db.rzOrders[b.razorpay_order_id]; save();
    res.json({ ok: true, ...ownerTok(o) });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});

/* ---------- TEST MODE only (env TEST_MODE=1): demo payments ---------- */
app.post('/api/test/pay-signup', (req, res) => {
  if (!TEST_MODE) return res.status(404).json({ error: 'Not available' });
  try {
    const p = db.pending.find(x => x.id === (req.body || {}).pendingId && (x.status === 'awaiting' || x.status === 'claimed'));
    if (!p) throw E('Signup not found', 404);
    const o = createOwner(p, 'TEST', 'test'); save(); res.json({ ok: true, ...ownerTok(o) });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});
app.post('/api/test/pay-bill', (req, res) => {
  if (!TEST_MODE) return res.status(404).json({ error: 'Not available' });
  try {
    const b = req.body || {}, o = findOwner(b.owner), bill = billOf(o, b.billId);
    settle(bill, o, 'TEST', 'test'); save(); res.json({ ok: true });
  } catch (e) { res.status(e.http || 500).json({ error: e.message }); }
});

app.use((err, req, res, next) => res.status(400).json({ error: 'Bad request' }));

process.on('SIGTERM', async () => {
  try { if (REMOTE && db) await rcmd(['SET', 'digires_state', JSON.stringify(db)]); } catch (e) {}
  process.exit(0);
});
function lanUrls() {
  const os = require('os');
  Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).forEach(i => console.log('  Phone (same WiFi): http://' + i.address + ':' + PORT));
  console.log('  ' + BUILD + ' | open http://localhost:' + PORT + '/healthz to confirm this is the server you are talking to');
  console.log('  Config: .env ' + (ENV_FILE ? 'found (' + ENV_FILE + ')' : 'not found') + ' | admin email: ' + db.admin.email);
  if (process.env.NODE_ENV !== 'production' && !process.env.RENDER) console.log('  Admin login -> email: ' + db.admin.email + ' | ADMIN_PASSWORD from env: ' + (process.env.ADMIN_PASSWORD ? process.env.ADMIN_PASSWORD.length + ' characters' : 'not set'));
  if (TEST_MODE) console.log('  TEST_MODE is ON: demo payments enabled');
}
(async () => {
  await load(); cleanup();
  setInterval(cleanup, 60 * 60 * 1000);
  app.listen(PORT, () => { console.log('DigiRes running on http://localhost:' + PORT + ' | storage: ' + (REMOTE ? 'Upstash Redis' : process.env.DATA_DIR ? 'disk ' + DATA_DIR : 'TEMPORARY (set DATA_DIR disk or Upstash!)')); lanUrls(); });
})();
