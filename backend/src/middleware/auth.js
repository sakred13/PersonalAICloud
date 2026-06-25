const jwt = require('jsonwebtoken');
const { pool } = require('../lib/db');

/**
 * Express middleware that validates the JWT session cookie.
 * Attaches `req.user = { id, username }` on success and verifies approval status.
 */
async function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    
    // Validate that the user exists and is approved in the database
    const userResult = await pool.query(
      'SELECT is_approved FROM users WHERE id = $1',
      [payload.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User account not found' });
    }

    if (!userResult.rows[0].is_approved) {
      return res.status(403).json({ error: 'Your account is pending approval' });
    }

    req.user = { id: payload.userId, username: payload.username };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
  }
}

module.exports = authMiddleware;
