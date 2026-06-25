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
      'SELECT id, username FROM users WHERE id != $1 AND is_approved = TRUE ORDER BY username',
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

// ─── GET /api/shares/public?path= ─────────────────────────────────────────────
// Get public share info for a folder of mine
router.get('/public', authMiddleware, async (req, res) => {
  try {
    const { path: folderPath } = req.query;
    if (!folderPath) return res.status(400).json({ error: 'path is required' });

    // Validate path is within user storage
    safeUserPath(req.user.username, folderPath);

    const result = await pool.query(
      `SELECT id, alias, access_scope, size_limit_gb, (password_hash IS NOT NULL) AS has_password
       FROM public_shares
       WHERE owner_id = $1 AND folder_path = $2`,
      [req.user.id, folderPath]
    );

    if (result.rows.length === 0) {
      return res.json({ publicShare: null });
    }
    return res.json({ publicShare: result.rows[0] });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('[shares/get-public]', err.message);
    return res.status(500).json({ error: 'Failed to fetch public share configuration' });
  }
});

// ─── POST /api/shares/public ──────────────────────────────────────────────────
// Set/update or delete public share config for a folder.
// Body: { path, isPublic, alias, accessScope, password, sizeLimitGb }
router.post('/public', authMiddleware, async (req, res) => {
  try {
    const { path: folderPath, isPublic, alias, accessScope, password, sizeLimitGb } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: 'path is required' });

    // Validate path is within user storage
    safeUserPath(req.user.username, folderPath);

    // If deleting
    if (!isPublic) {
      await pool.query(
        'DELETE FROM public_shares WHERE owner_id = $1 AND folder_path = $2',
        [req.user.id, folderPath]
      );
      return res.json({ success: true, message: 'Public share removed' });
    }

    // If creating/updating
    if (!alias) return res.status(400).json({ error: 'Folder alias is required' });
    const trimmedAlias = alias.trim().toLowerCase();
    if (!trimmedAlias) return res.status(400).json({ error: 'Folder alias cannot be empty' });

    // Validate alias format (no slashes, typical slug format)
    const slugRegex = /^[a-z0-9-_]+$/i;
    if (!slugRegex.test(trimmedAlias)) {
      return res.status(400).json({ error: 'Alias must contain only letters, numbers, hyphens, and underscores' });
    }

    if (!['readonly', 'full'].includes(accessScope)) {
      return res.status(400).json({ error: 'Invalid access scope' });
    }

    // Check alias uniqueness (excluding current folder's public share)
    const duplicate = await pool.query(
      'SELECT id FROM public_shares WHERE alias = $1 AND NOT (owner_id = $2 AND folder_path = $3)',
      [trimmedAlias, req.user.id, folderPath]
    );
    if (duplicate.rows.length > 0) {
      return res.status(409).json({ error: 'This alias is already in use by another folder' });
    }

    let sizeLimit = null;
    if (sizeLimitGb !== undefined && sizeLimitGb !== null && sizeLimitGb !== '') {
      sizeLimit = parseFloat(sizeLimitGb);
      if (isNaN(sizeLimit) || sizeLimit <= 0) {
        return res.status(400).json({ error: 'Size limit must be a positive number' });
      }
    }

    // Verify existing record to see if we should preserve or update password
    const existing = await pool.query(
      'SELECT password_hash FROM public_shares WHERE owner_id = $1 AND folder_path = $2',
      [req.user.id, folderPath]
    );

    let passwordHash = null;
    if (existing.rows.length > 0) {
      passwordHash = existing.rows[0].password_hash;
    }

    // Full access MUST have a password
    if (accessScope === 'full') {
      if (!password && !passwordHash) {
        return res.status(400).json({ error: 'Password is required for Full Access folders' });
      }
    }

    // Hash password if a new one is provided
    if (password) {
      const bcrypt = require('bcryptjs');
      passwordHash = await bcrypt.hash(password, 12);
    } else if (password === '') {
      // User explicitly cleared the password (only valid for readonly)
      if (accessScope === 'full') {
        return res.status(400).json({ error: 'Password is required for Full Access folders' });
      }
      passwordHash = null;
    }

    // Insert or update
    await pool.query(
      `INSERT INTO public_shares (owner_id, folder_path, alias, access_scope, password_hash, size_limit_gb)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id, folder_path)
       DO UPDATE SET alias = EXCLUDED.alias,
                     access_scope = EXCLUDED.access_scope,
                     password_hash = EXCLUDED.password_hash,
                     size_limit_gb = EXCLUDED.size_limit_gb`,
      [req.user.id, folderPath, trimmedAlias, accessScope, passwordHash, sizeLimit]
    );

    return res.json({ success: true, message: 'Public share updated' });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('[shares/post-public]', err.message);
    return res.status(500).json({ error: 'Failed to save public share configuration' });
  }
});

module.exports = router;
