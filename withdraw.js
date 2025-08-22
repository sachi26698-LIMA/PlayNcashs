const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// POST /withdraw -> create withdraw request
router.post('/', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { amount, upi, name } = req.body || {};
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
    if (!upi) return res.status(400).json({ error: 'UPI required' });
    const min = 20;
    const walletRef = db.collection('wallets').doc(uid);
    const reqRef = db.collection('withdrawRequests').doc();
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(walletRef);
      const bal = snap.exists ? (snap.data().coins || 0) : 0;
      if (bal < amount) throw new Error('Insufficient balance');
      tx.update(walletRef, { coins: bal - amount, lockedCoins: (snap.data().lockedCoins || 0) + amount });
      tx.set(reqRef, { uid, amount, upi, name: name || null, status: 'pending', createdAt: FieldValue.serverTimestamp() });
    });
    await db.collection('transactions').add({ uid, type: 'debit', amount, reason: 'withdraw_lock', createdAt: FieldValue.serverTimestamp() });
    res.json({ ok: true, id: reqRef.id });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

router.get('/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const q = await db.collection('withdrawRequests').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(50).get();
    res.json(q.docs.map(d=>({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
