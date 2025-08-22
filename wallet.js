const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// GET /wallet/:uid  -> get wallet (uid param) or /wallet (self)
router.get('/:uid?', async (req, res) => {
  try {
    const uid = req.params.uid || req.user.uid;
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const ref = db.collection('wallets').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return res.json({ coins: 0, lockedCoins: 0 });
    return res.json(snap.data());
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /wallet/credit  { uid?, amount, reason }
router.post('/credit', async (req, res) => {
  try {
    const { uid = req.user.uid, amount, reason } = req.body;
    if (!amount || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Admin only to credit others' });
    const ref = db.collection('wallets').doc(uid);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) tx.set(ref, { coins: 0, lockedCoins: 0 });
      tx.update(ref, { coins: FieldValue.increment(amount) });
    });
    await db.collection('transactions').add({ uid, type: 'credit', amount, reason: reason || null, createdAt: FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// POST /wallet/debit { uid?, amount, reason }
router.post('/debit', async (req, res) => {
  try {
    const { uid = req.user.uid, amount, reason } = req.body;
    if (!amount || typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Admin only to debit others' });
    const ref = db.collection('wallets').doc(uid);
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const curr = s.exists ? (s.data().coins || 0) : 0;
      if (curr < amount) throw new Error('Insufficient balance');
      tx.update(ref, { coins: curr - amount });
    });
    await db.collection('transactions').add({ uid, type: 'debit', amount, reason: reason || null, createdAt: FieldValue.serverTimestamp() });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

module.exports = router;
