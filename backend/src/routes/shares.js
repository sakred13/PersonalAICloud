const express = require('express');
const { pool } = require('../lib/db');
const { safeUserPath } = require('../lib/pathGuard');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// ─── GET /api/shares/users ────────────────────────────────────────────────────
// All registered users except the current user (for share modal)
router.get('/users', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username FROM users WHERE id != $1 ORDER BY username',
      [req.user.id]
    );
    return res.json({ users: result.rows });
  } catch (err) {
    console.error('[shares/users]', err.message);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ─── GET /api/shares/with-me ──────────────────────────────────────────────────
// All folders shared with the current user
router.get('/with-me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.id, s.folder_path, s.created_at,
              u.username AS owner_username, u.id AS owner_id
       FROM shares s
       JOIN users u ON s.owner_id = u.id
       WHERE s.shared_with_id = $1
       ORDER BY u.username, s.folder_path`,
      [req.user.id]
    );
    return res.json({ shares: result.rows });
  } catch (err) {
    console.error('[shares/with-me]', err.message);
    return res.status(500).json({ error: 'Failed to fetch shares' });
  }
});

// ─── GET /api/shares?path= ────────────────────────────────────────────────────
// Who can currently access a given folder of mine
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { path: folderPath } = req.query;
    if (!folderPath) return res.status(400).json({ error: 'path is required' });

    const result = await pool.query(
      `SELECT s.id, s.shared_with_id, u.username AS shared_with_username
       FROM shares s
       JOIN users u ON s.shared_with_id = u.id
       WHERE s.owner_id = $1 AND s.folder_path = $2
       ORDER BY u.username`,
      [req.user.id, folderPath]
    );
    return res.json({ shares: result.rows });
  } catch (err) {
    console.error('[shares/get]', err.message);
    return res.status(500).json({ error: 'Failed to fetch shares' });
  }
});

// ─── POST /api/shares ─────────────────────────────────────────────────────────
// Set (replace) shares for a folder. Body: { path, userIds: [number] }
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { path: folderPath, userIds } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: 'path is required' });
    if (!Array.isArray(userIds))
      return res.status(400).json({ error: 'userIds must be an array' });

    // Validate the folder is within the current user's storage
    safeUserPath(req.user.username, folderPath);

    // Get existing share records
    const existing = await pool.query(
      'SELECT id, shared_with_id FROM shares WHERE owner_id = $1 AND folder_path = $2',
      [req.user.id, folderPath]
    );
    const existingMap = new Map(existing.rows.map(r => [r.shared_with_id, r.id]));
    const newIds = new Set(userIds.map(Number).filter(id => id !== req.user.id));

    // Add new shares
    for (const uid of newIds) {
      if (!existingMap.has(uid)) {
        await pool.query(
          `INSERT INTO shares (owner_id, folder_path, shared_with_id)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [req.user.id, folderPath, uid]
        );
      }
    }

    // Remove revoked shares
    for (const [uid, shareId] of existingMap) {
      if (!newIds.has(uid)) {
        await pool.query('DELETE FROM shares WHERE id = $1', [shareId]);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('[shares/post]', err.message);
    return res.status(500).json({ error: 'Failed to update shares' });
  }
});

module.exports = router;
