const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

router.get('/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    if (uid !== req.user.uid && !(req.user.admin === true)) return res.status(403).json({ error: 'Forbidden' });
    const q = await db.collection('inbox').doc(uid).collection('msgs').orderBy('createdAt','desc').limit(50).get();
    res.json(q.docs.map(d=>({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
