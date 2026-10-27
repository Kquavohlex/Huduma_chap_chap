/**
 * Huduma Chap Chap — application entry point.
 * Boots Express, PostgreSQL-backed sessions, security headers,
 * the static frontend and all API routes. Listens on the hosting PORT.
 */
require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

const db = require('./src/db');
const { attachUser } = require('./src/middleware');
const authRoutes = require('./src/routes/auth');
const clientRoutes = require('./src/routes/client');
const paymentRoutes = require('./src/routes/payments');
const adminRoutes = require('./src/routes/admin');

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy — needed for secure cookies
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '100kb' }));

app.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  name: 'hcc.sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

// The signed-in user is reloaded from the DB on EVERY request — the browser
// is never trusted for identity, role or active status.
app.use(attachUser);

app.use('/api/auth', authRoutes);
app.use('/api', clientRoutes);
app.use('/api', paymentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));

app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Something went wrong on our side. Please try again.' });
});

const PORT = process.env.PORT || 3000;

db.initSchema()
  .then(() => app.listen(PORT, () => console.log(`Huduma Chap Chap listening on port ${PORT}`)))
  .catch((err) => { console.error('Failed to initialise the database:', err); process.exit(1); });
