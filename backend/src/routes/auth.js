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
      'INSERT INTO users (username, email, password_hash, is_approved) VALUES ($1, $2, $3, FALSE) RETURNING id, username, email, created_at',
      [username, email, passwordHash]
    );
    const user = result.rows[0];

    // Create isolated storage folder for this user
    await fs.ensureDir(getUserRoot(username));

    return res.status(201).json({
      success: true,
      message: 'Registration successful. Account pending approval.',
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
      'SELECT id, username, password_hash, is_approved FROM users WHERE username = $1',
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

    if (!user.is_approved) {
      return res.status(403).json({ error: 'Your account is pending approval' });
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

// ─── GET /api/auth/pending ───────────────────────────────────────────────────
router.get('/pending', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, created_at FROM users WHERE is_approved = FALSE ORDER BY created_at DESC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('[pending]', err.message);
    return res.status(500).json({ error: 'Failed to retrieve pending users' });
  }
});

// ─── POST /api/auth/approve/:id ────────────────────────────────────────────────
router.post('/approve/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE users SET is_approved = TRUE WHERE id = $1 RETURNING id, username, email',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json({ success: true, message: 'User approved successfully', user: result.rows[0] });
  } catch (err) {
    console.error('[approve]', err.message);
    return res.status(500).json({ error: 'Failed to approve user' });
  }
});

// ─── POST /api/auth/reject/:id ─────────────────────────────────────────────────
router.post('/reject/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;

    // Retrieve username first to remove the disk folder
    const userResult = await pool.query('SELECT username FROM users WHERE id = $1', [id]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const username = userResult.rows[0].username;

    // Delete user from db (cascades to shares, file_tags, agent_chats, public_shares)
    await pool.query('DELETE FROM users WHERE id = $1', [id]);

    // Clean up storage disk recursively
    const userRoot = getUserRoot(username);
    if (await fs.pathExists(userRoot)) {
      await fs.remove(userRoot);
    }

    return res.json({ success: true, message: 'User rejected and storage cleaned up' });
  } catch (err) {
    console.error('[reject]', err.message);
    return res.status(500).json({ error: 'Failed to reject user' });
  }
});

module.exports = router;

