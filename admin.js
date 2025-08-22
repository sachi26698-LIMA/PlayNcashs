const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

function requireAdmin(req, res, next) {
  if (req.user && (req.user.admin === true || (req.user.customClaims && req.user.customClaims.admin))) return next();
  return res.status(403).json({ error: 'Admin only' });
}

// Approve withdraw
router.post('/approveWithdraw', requireAdmin, async (req, res) => {
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
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Reject withdraw
router.post('/rejectWithdraw', requireAdmin, async (req, res) => {
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
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

// Create redeem code (admin)
router.post('/createRedeem', requireAdmin, async (req, res) => {
  try {
    const { code, amountMin, amountMax, usesLeft, expiresAt } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });
    const doc = { amountMin: amountMin || 1, amountMax: amountMax || 10, usesLeft: usesLeft || 1, createdAt: FieldValue.serverTimestamp() };
    if (expiresAt) doc.expiresAt = new Date(expiresAt);
    await db.collection('redeemCodes').doc(code).set(doc);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
