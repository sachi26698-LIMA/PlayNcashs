const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

router.post('/', async (req, res) => {
  try {
    const uid = req.user.uid;
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'code required' });
    const codeRef = db.collection('redeemCodes').doc(code);
    let amountCredited = 0;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(codeRef);
      if (!snap.exists) throw new Error('Invalid code');
      const c = snap.data();
      const now = new Date();
      if (c.expiresAt && c.expiresAt.toDate && c.expiresAt.toDate() < now) throw new Error('Code expired');
      if ((c.usesLeft || 0) <= 0) throw new Error('Code exhausted');
      const min = Number.isFinite(c.amountMin) ? c.amountMin : 1;
      const max = Number.isFinite(c.amountMax) ? c.amountMax : 10;
      const amount = min + Math.floor(Math.random()*Math.max(1, (max-min+1)));
      amountCredited = amount;
      tx.update(codeRef, { usesLeft: (c.usesLeft || 0) - 1 });
      tx.set(db.collection('wallets').doc(uid), { coins: FieldValue.increment(amount) }, { merge: true });
      await db.collection('transactions').add({ uid, type: 'credit', amount, reason: 'redeem_code', code, createdAt: FieldValue.serverTimestamp() });
    });
    res.json({ ok: true, amount: amountCredited });
  } catch (e) { console.error(e); res.status(400).json({ error: e.message }); }
});

module.exports = router;
