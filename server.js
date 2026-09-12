import 'dotenv/config';
import express from 'express';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const sessionDays = Math.max(1, Number(process.env.SESSION_DAYS || 30));
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicFile = path.join(__dirname, 'index_1789055957712.html');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined })
  : null;

function apiError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function setSessionCookie(res, token) {
  const maxAge = sessionDays * 24 * 60 * 60;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `td_session=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'td_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax');
}

function requireDatabase(req, _res, next) {
  if (!pool) return next(apiError('Database is not configured. Add DATABASE_URL before using accounts.', 503));
  next();
}

async function query(text, values = [], client = pool) {
  if (!client) throw apiError('Database is not configured. Add DATABASE_URL before using accounts.', 503);
  return client.query(text, values);
}

function publicUser(row, wallet = {}) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    wallet: {
      balance: Number(wallet.balance || 0),
      totalDeposited: Number(wallet.total_deposited || 0),
      totalSpent: Number(wallet.total_spent || 0),
      totalWon: Number(wallet.total_won || 0)
    }
  };
}

async function userWithWallet(userId, client = pool) {
  const result = await query(`
    SELECT u.id, u.username, u.email, u.role, u.created_at,
           w.balance, w.total_deposited, w.total_spent, w.total_won
    FROM users u
    JOIN wallets w ON w.user_id = u.id
    WHERE u.id = $1
  `, [userId], client);
  if (!result.rows[0]) throw apiError('Account not found.', 404);
  const row = result.rows[0];
  return publicUser(row, row);
}

async function requireUser(req, _res, next) {
  try {
    if (!pool) throw apiError('Database is not configured. Add DATABASE_URL before using accounts.', 503);
    const token = parseCookies(req.headers.cookie).td_session;
    if (!token) throw apiError('You must be signed in.', 401);
    const session = await query(`
      SELECT user_id FROM sessions
      WHERE token_hash = $1 AND expires_at > now()
    `, [hashToken(token)]);
    if (!session.rows[0]) throw apiError('Your session has expired. Sign in again.', 401);
    req.userId = session.rows[0].user_id;
    next();
  } catch (error) {
    next(error);
  }
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Paystack needs the raw request body for signature verification, so this route
// must appear before the normal JSON parser.
app.post('/api/paystack/webhook', express.raw({ type: 'application/json' }), async (req, res, next) => {
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) throw apiError('PAYSTACK_SECRET_KEY is not configured.', 503);
    const signature = req.headers['x-paystack-signature'];
    const expected = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(req.body).digest('hex');
    if (!signature || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      throw apiError('Invalid Paystack signature.', 401);
    }
    const event = JSON.parse(req.body.toString('utf8'));
    if (event.event !== 'charge.success') return res.json({ received: true });
    const reference = event.data?.reference;
    const userId = event.data?.metadata?.user_id;
    const amount = Number(event.data?.amount || 0) / 100;
    if (!reference || !userId || !amount) return res.json({ received: true });

    await withTransaction(async client => {
      const duplicate = await client.query('SELECT 1 FROM transactions WHERE reference = $1', [reference]);
      if (duplicate.rows[0]) return;
      const wallet = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!wallet.rows[0]) throw apiError('Wallet not found.', 404);
      const balance = Number(wallet.rows[0].balance) + amount;
      await client.query(`
        UPDATE wallets
        SET balance = $1, total_deposited = total_deposited + $2, updated_at = now()
        WHERE user_id = $3
      `, [balance, amount, userId]);
      await client.query(`
        INSERT INTO transactions(user_id, type, amount, balance_after, reference, metadata)
        VALUES($1, 'deposit', $2, $3, $4, $5)
      `, [userId, amount, balance, reference, JSON.stringify({ provider: 'paystack', event: event.event })]);
    });
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', async (_req, res) => {
  let database = 'not_configured';
  if (pool) {
    try {
      await pool.query('SELECT 1');
      database = 'connected';
    } catch {
      database = 'unreachable';
    }
  }
  res.json({ ok: database === 'connected', database, time: new Date().toISOString() });
});

app.post('/api/auth/register', requireDatabase, async (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const email = normalize(req.body.email);
    const password = String(req.body.password || '');
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw apiError('Username must be 3–24 letters, numbers, or underscores.');
    if (!validEmail(email)) throw apiError('Enter a valid email address.');
    if (password.length < 8) throw apiError('Password must be at least 8 characters.');
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await withTransaction(async client => {
      const user = await client.query(`
        INSERT INTO users(username, username_normalized, email, email_normalized, password_hash)
        VALUES($1, $2, $3, $4, $5)
        RETURNING id, username, email, role, created_at
      `, [username, normalize(username), email, email, passwordHash]);
      await client.query('INSERT INTO wallets(user_id) VALUES($1)', [user.rows[0].id]);
      return user.rows[0];
    });
    const token = crypto.randomBytes(32).toString('base64url');
    await query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, now() + ($3 * interval \'1 day\'))', [hashToken(token), result.id, sessionDays]);
    setSessionCookie(res, token);
    res.status(201).json({ user: await userWithWallet(result.id) });
  } catch (error) {
    if (error.code === '23505') return next(apiError('Username or email is already registered.', 409));
    next(error);
  }
});

app.post('/api/auth/login', requireDatabase, async (req, res, next) => {
  try {
    const login = normalize(req.body.login || req.body.username);
    const password = String(req.body.password || '');
    if (!login || !password) throw apiError('Enter your username/email and password.');
    const result = await query(`
      SELECT * FROM users
      WHERE username_normalized = $1 OR email_normalized = $1
      LIMIT 1
    `, [login]);
    const account = result.rows[0];
    if (!account || !(await bcrypt.compare(password, account.password_hash))) throw apiError('Incorrect username or password.', 401);
    const token = crypto.randomBytes(32).toString('base64url');
    await query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2, now() + ($3 * interval \'1 day\'))', [hashToken(token), account.id, sessionDays]);
    setSessionCookie(res, token);
    res.json({ user: await userWithWallet(account.id) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie).td_session;
    if (pool && token) await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/me', requireUser, async (req, res, next) => {
  try {
    const user = await userWithWallet(req.userId);
    const history = await query(`
      SELECT type, reference, status, amount, created_at
      FROM transactions WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 100
    `, [req.userId]);
    res.json({ user, history: history.rows });
  } catch (error) {
    next(error);
  }
});

app.get('/api/wallet', requireUser, async (req, res, next) => {
  try {
    const user = await userWithWallet(req.userId);
    const history = await query(`
      SELECT type, reference, status, amount, balance_after, metadata, created_at
      FROM transactions WHERE user_id = $1
      ORDER BY created_at DESC LIMIT 100
    `, [req.userId]);
    res.json({ wallet: user.wallet, history: history.rows });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sports-bets', requireUser, async (req, res, next) => {
  try {
    const stake = Number(req.body.stake);
    const selections = Array.isArray(req.body.selections) ? req.body.selections : [];
    const totalOdds = Number(req.body.totalOdds);
    if (!Number.isFinite(stake) || stake < 100) throw apiError('Minimum sports stake is ₦100.');
    if (!selections.length || !Number.isFinite(totalOdds) || totalOdds <= 1) throw apiError('Add valid sports selections.');
    if (selections.length > 20) throw apiError('Too many selections.');

    const result = await withTransaction(async client => {
      const wallet = await client.query('SELECT * FROM wallets WHERE user_id = $1 FOR UPDATE', [req.userId]);
      if (!wallet.rows[0]) throw apiError('Wallet not found.', 404);
      const currentBalance = Number(wallet.rows[0].balance);
      if (currentBalance < stake) throw apiError('Insufficient balance.', 409);
      const newBalance = currentBalance - stake;
      const reference = `SPORTS_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      const potentialReturn = Math.round(stake * totalOdds * 100) / 100;
      const bet = await client.query(`
        INSERT INTO sports_bets(user_id, stake, total_odds, potential_return, selections, feed_reference)
        VALUES($1, $2, $3, $4, $5, $6)
        RETURNING id, stake, total_odds, potential_return, status, created_at
      `, [req.userId, stake, totalOdds, potentialReturn, JSON.stringify(selections), req.body.feedReference || null]);
      await client.query(`
        UPDATE wallets SET balance = $1, total_spent = total_spent + $2, updated_at = now()
        WHERE user_id = $3
      `, [newBalance, stake, req.userId]);
      await client.query(`
        INSERT INTO transactions(user_id, type, amount, balance_after, reference, status, metadata)
        VALUES($1, 'sports_bet', $2, $3, $4, 'success', $5)
      `, [req.userId, -stake, newBalance, reference, JSON.stringify({ betId: bet.rows[0].id })]);
      return { bet: bet.rows[0], balance: newBalance, reference };
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/sports-bets', requireUser, async (req, res, next) => {
  try {
    const bets = await query(`
      SELECT id, stake, total_odds, potential_return, status, selections, created_at, settled_at
      FROM sports_bets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100
    `, [req.userId]);
    res.json({ bets: bets.rows });
  } catch (error) {
    next(error);
  }
});

// Serve the existing frontend from the same origin, so cookies work without CORS.
app.get('/', (_req, res) => res.sendFile(publicFile));
app.use('/assets', express.static(path.join(__dirname, 'attached_assets')));

app.use((error, _req, res, _next) => {
  const status = Number(error.status || 500);
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status >= 500 ? 'Server error.' : error.message });
});

app.listen(port, () => {
  console.log(`Tony Dynamic backend listening on http://localhost:${port}`);
  console.log(pool ? 'Database mode: configured' : 'Database mode: not configured');
});
