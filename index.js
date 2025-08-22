
/**
 * PlayNcash Backend (Express + Firebase Admin) for Render
 * All endpoints (except GET /) require Firebase ID token in Authorization: Bearer <token>.
 * Admin-only endpoints require custom claim { admin: true } on the user.
 */
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

// ---- Firebase Admin init ----
function initAdmin() {
  if (admin.apps.length) return;
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  if (!svc) {
    console.error('Missing FIREBASE_SERVICE_ACCOUNT env variable.');
    process.exit(1);
  }
  const cred = JSON.parse(svc);
  admin.initializeApp({ credential: admin.credential.cert(cred) });
  console.log('Firebase Admin initialized.');
}
initAdmin();

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const app = express();
app.use(express.json({ limit: '1mb' }));

// ---- CORS ----
const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',');
app.use(cors({
  origin: function (origin, cb) {
    if (!origin) return cb(null, true);
    if (allowed.includes('*')) return cb(null, true);
    if (allowed.some(p => origin.startsWith(p))) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  }
}));

// ---- Auth middleware ----
async function verifyAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // uid, claims
    return next();
  } catch (e) {
    console.error('Auth error', e);
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function requireAdmin(req, res, next) {
  if (req.user && (req.user.admin === true || (req.user.customClaims && req.user.customClaims.admin))) {
    return next();
  }
  return res.status(403).json({ error: 'Admin only' });
}

// ---- Helpers ----
async function getOrCreateWallet(uid) {
  const ref = db.collection('wallets').doc(uid);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({ coins: 0, lockedCoins: 0, createdAt: FieldValue.serverTimestamp() }, { merge: true });
    return { coins: 0, lockedCoins: 0 };
  }
  const data = snap.data() || {};
  return { coins: data.coins || 0, lockedCoins: data.lockedCoins || 0 };
}
async function addTx(uid, type, amount, meta) {
  const txRef = db.collection('transactions').doc();
  await txRef.set({ uid, type, amount, meta: meta || null, createdAt: FieldValue.serverTimestamp() });
  return txRef.id;
}
function todayKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---- Routes ----

// Health
app.get('/', (_req, res) => res.send('PlayNcash backend running'));

// Bootstrap user
app.post('/createUser', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { name, phone, email } = req.body || {};
    await db.collection('users').doc(uid).set(
      { name: name || null, phone: phone || null, email: email || null, createdAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    await db.collection('wallets').doc(uid).set(
      { coins: FieldValue.increment(0), lockedCoins: FieldValue.increment(0), createdAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    return res.json({ ok: true });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

// Wallet
app.get('/wallet/:uid', verifyAuth, async (req, res) => {
  try {
    if (req.params.uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const wallet = await getOrCreateWallet(req.params.uid);
    return res.json(wallet);
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

app.post('/wallet/credit', verifyAuth, async (req, res) => {
  try {
    const { uid, amount, reason } = req.body || {};
    if (!uid || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'uid and positive amount required' });
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Admin only to credit others' });
    const ref = db.collection('wallets').doc(uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) tx.set(ref, { coins: 0, lockedCoins: 0, createdAt: FieldValue.serverTimestamp() });
      tx.update(ref, { coins: FieldValue.increment(amount) });
    });
    await addTx(uid, 'credit', amount, { reason: reason || 'manual' });
    return res.json({ ok: true });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

app.post('/wallet/debit', verifyAuth, async (req, res) => {
  try {
    const { uid, amount, reason } = req.body || {};
    if (!uid || !Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'uid and positive amount required' });
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Admin only to debit others' });
    const ref = db.collection('wallets').doc(uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const curr = snap.exists ? (snap.data().coins || 0) : 0;
      if (curr < amount) throw new Error('Insufficient balance');
      tx.update(ref, { coins: curr - amount });
    });
    await addTx(uid, 'debit', amount, { reason: reason || 'manual' });
    return res.json({ ok: true });
  } catch (e) { console.error(e); return res.status(400).json({ error: e.message }); }
});

// Daily bonus (24h cooldown, +3..5 coins)
app.post('/bonus/daily', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const data = userSnap.exists ? userSnap.data() : {};
    const last = data?.lastBonusAt?.toDate?.() || null;
    const now = new Date();
    if (last && now - last < 24*60*60*1000) {
      const waitMs = 24*60*60*1000 - (now - last);
      return res.status(429).json({ error: 'Cooldown', waitMs });
    }
    const amount = 3 + Math.floor(Math.random() * 3);
    const walletRef = db.collection('wallets').doc(uid);
    await db.runTransaction(async (tx) => {
      tx.set(userRef, { lastBonusAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(walletRef, { coins: FieldValue.increment(amount) }, { merge: true });
    });
    await addTx(uid, 'credit', amount, { reason: 'daily_bonus' });
    return res.json({ ok: true, amount });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

// Redeem code
app.post('/redeem', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });
    const codeRef = db.collection('redeemCodes').doc(code);
    const walletRef = db.collection('wallets').doc(uid);
    let amountCredited = 0;

    await db.runTransaction(async (tx) => {
      const cSnap = await tx.get(codeRef);
      if (!cSnap.exists) throw new Error('Invalid code');
      const c = cSnap.data();
      const now = new Date();
      if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < now) throw new Error('Code expired');
      if ((c.usesLeft || 0) <= 0) throw new Error('Code exhausted');
      const min = Number.isFinite(c.amountMin) ? c.amountMin : 1;
      const max = Number.isFinite(c.amountMax) ? c.amountMax : 10;
      const amount = min + Math.floor(Math.random() * Math.max(1, (max - min + 1)));
      amountCredited = amount;
      tx.update(codeRef, { usesLeft: (c.usesLeft || 0) - 1 });
      tx.set(walletRef, { coins: FieldValue.increment(amount) }, { merge: true });
    });
    await addTx(uid, 'credit', amountCredited, { reason: 'redeem_code', code });
    return res.json({ ok: true, amount: amountCredited });
  } catch (e) { console.error(e); return res.status(400).json({ error: e.message }); }
});

// Withdraw
app.post('/withdraw', verifyAuth, async (req, res) => {
  try {
    const uid = req.user.uid;
    const { amount, upi, name } = req.body || {};
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!upi) return res.status(400).json({ error: 'UPI required' });
    const min = 20;
    if (amount < min) return res.status(400).json({ error: `Min withdraw ${min}` });

    const walletRef = db.collection('wallets').doc(uid);
    const reqRef = db.collection('withdrawRequests').doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(walletRef);
      const bal = snap.exists ? (snap.data().coins || 0) : 0;
      const locked = snap.exists ? (snap.data().lockedCoins || 0) : 0;
      if (bal < amount) throw new Error('Insufficient balance');
      tx.update(walletRef, { coins: bal - amount, lockedCoins: locked + amount });
      tx.set(reqRef, { uid, amount, upi, name: name || null, status: 'pending', createdAt: FieldValue.serverTimestamp() });
    });
    await addTx(uid, 'debit', amount, { reason: 'withdraw_lock' });
    return res.json({ ok: true, id: reqRef.id });
  } catch (e) { console.error(e); return res.status(400).json({ error: e.message }); }
});

app.get('/withdraw/:uid', verifyAuth, async (req, res) => {
  try {
    if (req.params.uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const q = await db.collection('withdrawRequests').where('uid', '==', req.params.uid).orderBy('createdAt', 'desc').limit(50).get();
    return res.json(q.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

// Admin: approve / reject withdraw
app.post('/admin/approveWithdraw', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { requestId, txnNote } = req.body || {};
    if (!requestId) return res.status(400).json({ error: 'requestId required' });
    const reqRef = db.collection('withdrawRequests').doc(requestId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists) throw new Error('Request not found');
      const r = snap.data();
      if (r.status !== 'pending') throw new Error('Already processed');
      const walletRef = db.collection('wallets').doc(r.uid);
      const wSnap = await tx.get(walletRef);
      const locked = wSnap.exists ? (wSnap.data().lockedCoins || 0) : 0;
      if (locked < r.amount) throw new Error('Locked amount mismatch');
      tx.update(walletRef, { lockedCoins: locked - r.amount });
      tx.update(reqRef, { status: 'paid', notes: txnNote || null, paidAt: FieldValue.serverTimestamp() });
      const inboxRef = db.collection('inbox').doc(r.uid).collection('msgs').doc();
      tx.set(inboxRef, { title: 'Payout Successful', body: `₹${r.amount} sent.`, createdAt: FieldValue.serverTimestamp(), read: false });
    });
    return res.json({ ok: true });
  } catch (e) { console.error(e); return res.status(400).json({ error: e.message }); }
});

app.post('/admin/rejectWithdraw', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { requestId, reason } = req.body || {};
    if (!requestId) return res.status(400).json({ error: 'requestId required' });
    const reqRef = db.collection('withdrawRequests').doc(requestId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(reqRef);
      if (!snap.exists) throw new Error('Request not found');
      const r = snap.data();
      if (r.status !== 'pending') throw new Error('Already processed');
      const walletRef = db.collection('wallets').doc(r.uid);
      const wSnap = await tx.get(walletRef);
      const coins = wSnap.exists ? (wSnap.data().coins || 0) : 0;
      const locked = wSnap.exists ? (wSnap.data().lockedCoins || 0) : 0;
      tx.update(walletRef, { coins: coins + r.amount, lockedCoins: Math.max(0, locked - r.amount) });
      tx.update(reqRef, { status: 'rejected', notes: reason || null, rejectedAt: FieldValue.serverTimestamp() });
      const inboxRef = db.collection('inbox').doc(r.uid).collection('msgs').doc();
      tx.set(inboxRef, { title: 'Payout Rejected', body: reason || 'Contact support', createdAt: FieldValue.serverTimestamp(), read: false });
    });
    return res.json({ ok: true });
  } catch (e) { console.error(e); return res.status(400).json({ error: e.message }); }
});

// Inbox
app.get('/inbox/:uid', verifyAuth, async (req, res) => {
  try {
    if (req.params.uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const q = await db.collection('inbox').doc(req.params.uid).collection('msgs').orderBy('createdAt', 'desc').limit(50).get();
    return res.json(q.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

app.post('/inbox/send', verifyAuth, requireAdmin, async (req, res) => {
  try {
    const { uid, title, body } = req.body || {};
    if (!uid || !title) return res.status(400).json({ error: 'uid and title required' });
    const inboxRef = db.collection('inbox').doc(uid).collection('msgs').doc();
    await inboxRef.set({ title, body: body || '', createdAt: FieldValue.serverTimestamp(), read: false });
    return res.json({ ok: true });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

// Tickets
app.post('/ticket', verifyAuth, async (req, res) => {
  try {
    const { category, text, images } = req.body || {};
    const tRef = db.collection('tickets').doc();
    await tRef.set({ uid: req.user.uid, category: category || 'other', text: text || '', images: images || [], status: 'open', createdAt: FieldValue.serverTimestamp() });
    return res.json({ ok: true, id: tRef.id });
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

app.get('/ticket/:uid', verifyAuth, async (req, res) => {
  try {
    if (req.params.uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const q = await db.collection('tickets').where('uid', '==', req.params.uid).orderBy('createdAt', 'desc').limit(50).get();
    return res.json(q.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

// Leaderboards
app.get('/leaderboard/daily', async (_req, res) => {
  try {
    const key = todayKey();
    const q = await db.collection('leaderboardDaily').doc(key).collection('users').orderBy('score', 'desc').limit(10).get();
    return res.json(q.docs.map(d => ({ uid: d.id, ...d.data() })));
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

app.get('/leaderboard/weekly', async (_req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 7*24*60*60*1000);
    const q = await db.collection('leaderboardWeekly').where('createdAt', '>=', start).orderBy('createdAt', 'desc').limit(100).get();
    return res.json(q.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); return res.status(500).json({ error: e.message }); }
});

// Start
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('PlayNcash server listening on', PORT));
