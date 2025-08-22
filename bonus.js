const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// POST /bonus/daily
router.post('/daily', async (req, res) => {
  try {
    const uid = req.user.uid;
    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();
    const last = userSnap.exists && userSnap.data().lastBonusAt ? userSnap.data().lastBonusAt.toDate() : null;
    const now = new Date();
    if (last && (now - last) < 24*60*60*1000) {
      const waitMs = 24*60*60*1000 - (now - last);
      return res.status(429).json({ error: 'Cooldown', waitMs });
    }
    const amount = 3 + Math.floor(Math.random()*3);
    const walletRef = db.collection('wallets').doc(uid);
    await db.runTransaction(async (tx) => {
      tx.set(userRef, { lastBonusAt: FieldValue.serverTimestamp() }, { merge: true });
      tx.set(walletRef, { coins: FieldValue.increment(amount) }, { merge: true });
      await db.collection('transactions').add({ uid, type: 'credit', amount, reason: 'daily_bonus', createdAt: FieldValue.serverTimestamp() });
    });
    return res.json({ ok: true, amount });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
