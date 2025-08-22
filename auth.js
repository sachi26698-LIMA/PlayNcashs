const admin = require('firebase-admin');
module.exports = async function auth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded; // uid, claims
    next();
  } catch (e) {
    console.error('Auth error', e.message || e);
    return res.status(401).json({ error: 'Invalid token' });
  }
};
