const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs-extra');

const { pool } = require('../lib/db');
const { getUserRoot } = require('../lib/pathGuard');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

/** Username rules: 3-32 chars, letters/numbers/underscore/hyphen */
const USERNAME_REGEX = /^[a-zA-Z0-9_-]{3,32}$/;

/**
 * Cookie options.
 * `Secure` flag is controlled by COOKIE_SECURE env var (default: false).
 * Set COOKIE_SECURE=true only when the app is served over HTTPS.
 * When accessed over plain HTTP (e.g. Tailscale IP, LAN), keep it false
 * or the browser will silently drop the cookie on every request.
 */
function getCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 6 * 60 * 60 * 1000, // 6 hours in ms
    secure: process.env.COOKIE_SECURE === 'true',
  };
}

function issueToken(res, userId, username) {
  const token = jwt.sign(
    { userId, username },
    process.env.JWT_SECRET,
    { expiresIn: '6h' }
  );
  res.cookie('token', token, getCookieOptions());
}

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }
    if (!USERNAME_REGEX.test(username)) {
      return res.status(400).json({
        error: 'Username must be 3–32 characters: letters, numbers, underscores, or hyphens',
      });
    }
    const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check username uniqueness
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Username is already taken' });
    }

    // Check email uniqueness
    const existingEmail = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'Email is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email, created_at',
      [username, email, passwordHash]
    );
    const user = result.rows[0];

    // Create isolated storage folder for this user
    await fs.ensureDir(getUserRoot(username));

    issueToken(res, user.id, user.username);

    return res.status(201).json({
      user: { id: user.id, username: user.username, email: user.email, createdAt: user.created_at },
    });
  } catch (err) {
    console.error('[register]', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const result = await pool.query(
      'SELECT id, username, password_hash FROM users WHERE username = $1',
      [username]
    );

    // Generic message prevents username enumeration
    const GENERIC_ERROR = 'Invalid username or password';

    if (result.rows.length === 0) {
      // Constant-time dummy compare to avoid timing attacks
      await bcrypt.compare(password, '$2a$12$invalidhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    issueToken(res, user.id, user.username);

    return res.json({ user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error('[login]', err.message);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/auth/logout ────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', getCookieOptions());
  return res.json({ success: true });
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const u = result.rows[0];
    return res.json({ user: { id: u.id, username: u.username, email: u.email, createdAt: u.created_at } });
  } catch (err) {
    console.error('[me]', err.message);
    return res.status(500).json({ error: 'Failed to retrieve user info' });
  }
});

// ─── GET /api/auth/check-username ─────────────────────────────────────────────
// Used for real-time availability check during registration
router.get('/check-username', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.json({ available: false });
  if (!USERNAME_REGEX.test(username)) {
    return res.json({ available: false, error: 'Invalid format' });
  }
  const result = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  return res.json({ available: result.rows.length === 0 });
});

module.exports = router;
