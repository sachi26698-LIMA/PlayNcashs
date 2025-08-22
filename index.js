const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

function initAdmin() {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT:', e);
    process.exit(1);
  }
  if (!serviceAccount.project_id) {
    console.error('FIREBASE_SERVICE_ACCOUNT missing or invalid');
    process.exit(1);
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount), storageBucket: `${serviceAccount.project_id}.appspot.com` });
  console.log('Firebase Admin initialized for project:', serviceAccount.project_id);
}

initAdmin();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

const auth = require('./middlewares/auth');

app.get('/', (req, res) => res.send('PlayNcash backend running'));

app.use('/wallet', auth, require('./routes/wallet'));
app.use('/bonus', auth, require('./routes/bonus'));
app.use('/redeem', auth, require('./routes/redeem'));
app.use('/withdraw', auth, require('./routes/withdraw'));
app.use('/leaderboard', auth, require('./routes/leaderboard'));
app.use('/tickets', auth, require('./routes/tickets'));
app.use('/inbox', auth, require('./routes/inbox'));
app.use('/admin', auth, require('./routes/admin'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('PlayNcash server listening on', PORT));
