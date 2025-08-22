const express = require('express');
const admin = require('firebase-admin');
const router = express.Router();
const db = admin.firestore();

router.get('/daily', async (req, res) => {
  try {
    const key = new Date().toISOString().slice(0,10);
    const q = await db.collection('leaderboardDaily').doc(key).collection('users').orderBy('score','desc').limit(10).get();
    res.json(q.docs.map(d=>({ uid: d.id, ...d.data() })));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

router.get('/weekly', async (req, res) => {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 7*24*60*60*1000);
    const q = await db.collection('leaderboardWeekly').where('createdAt','>=', start).orderBy('createdAt','desc').limit(100).get();
    res.json(q.docs.map(d=>({ id: d.id, ...d.data() })));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

module.exports = router;
