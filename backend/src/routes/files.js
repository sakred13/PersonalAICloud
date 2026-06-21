const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const archiver = require('archiver');
const mime = require('mime-types');
const multer = require('multer');

const authMiddleware = require('../middleware/auth');
const { pool } = require('../lib/db');
const { safeUserPath, getUserRoot, getThumbnailPath } = require('../lib/pathGuard');
const { generateThumbnail, generatePreviewImage } = require('../lib/thumbnails');

// Internal agent service URL (container-to-container, never exposed externally)
const AGENT_URL = process.env.AGENT_URL || 'http://agent:8000';

// MIME types that need server-side conversion to JPEG before the browser can display them
const NEEDS_PREVIEW_CONVERSION = new Set([
  'image/x-adobe-dng',
  'image/x-raw',
  'image/x-nikon-nef',
  'image/x-canon-cr2',
  'image/x-canon-cr3',
  'image/x-sony-arw',
  'image/x-fuji-raf',
  'image/x-panasonic-raw',
  'image/tiff',
]);

/** Returns true if the file extension is a known RAW/DNG format */
function isRawByExtension(filePath) {
  const ext = require('path').extname(filePath).toLowerCase();
  return ['.dng', '.nef', '.cr2', '.cr3', '.arw', '.raf', '.rw2', '.orf', '.pef', '.srw'].includes(ext);
}

const router = express.Router();

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(10 * 1024 * 1024 * 1024), 10);

// ─── Shared-access resolver ───────────────────────────────────────────────────
/**
 * Resolves an absolute path for a file/folder.
 * If `ownerUsername` is provided and differs from the requesting user, verifies
 * that a valid share record exists before granting access.
 *
 * Returns { absPath, effectiveUserRoot } — the resolved absolute path and the
 * owner's storage root (needed for thumbnails).
 */
async function resolveAccessPath(req, requestedPath, ownerUsername) {
  // No owner specified → own files
  if (!ownerUsername) {
    const absPath = safeUserPath(req.user.username, requestedPath);
    return { absPath, effectiveUserRoot: getUserRoot(req.user.username) };
  }

  // Fetch owner record
  const ownerResult = await pool.query(
    'SELECT id FROM users WHERE username = $1',
    [ownerUsername]
  );
  if (ownerResult.rows.length === 0) {
    const err = new Error('Owner not found');
    err.status = 404;
    throw err;
  }
  const ownerId = ownerResult.rows[0].id;

  // Owner accessing own files through the owner= param (edge case)
  if (ownerId === req.user.id) {
    const absPath = safeUserPath(req.user.username, requestedPath);
    return { absPath, effectiveUserRoot: getUserRoot(req.user.username) };
  }

  // Verify the requesting user has a share that covers the requested path
  const sharesResult = await pool.query(
    'SELECT folder_path FROM shares WHERE owner_id = $1 AND shared_with_id = $2',
    [ownerId, req.user.id]
  );

  const normPath = (requestedPath || '').replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
  const hasAccess = sharesResult.rows.some(row => {
    const sp = row.folder_path.replace(/^\/+|\/+$/g, '');
    return normPath === sp || normPath.startsWith(sp + '/');
  });

  if (!hasAccess) {
    const err = new Error('Access denied to this path');
    err.status = 403;
    throw err;
  }

  // Build the safe absolute path in the owner's storage
  const absPath = safeUserPath(ownerUsername, requestedPath);
  return { absPath, effectiveUserRoot: getUserRoot(ownerUsername) };
}

// ─── Multer configuration (own files only) ────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const dest = safeUserPath(req.user.username, req.query.path || '');
      fs.ensureDirSync(dest);
      cb(null, dest);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeName = path
      .basename(file.originalname)
      .replace(/[^\w\s.()\-]/g, '_');
    cb(null, safeName);
  },
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

function multerUpload(req, res, next) {
  upload.array('files', 200)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large (max ${formatBytes(MAX_FILE_SIZE)})` });
    }
    if (err.status === 403) return res.status(403).json({ error: err.message });
    return res.status(500).json({ error: err.message || 'Upload error' });
  });
}

// ─── GET /api/files ───────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  try {
    const reqPath = (req.query.path || '').replace(/^\/+|\/+$/g, '');
    const owner = req.query.owner || null;

    const { absPath, effectiveUserRoot } = await resolveAccessPath(req, reqPath, owner);
    await fs.ensureDir(absPath);

    const entries = await fs.readdir(absPath, { withFileTypes: true });

    const files = await Promise.all(
      entries
        .filter(e => e.name !== '.thumbnails' && !e.name.startsWith('.'))
        .map(async (entry) => {
          const absEntry = path.join(absPath, entry.name);
          const stat = await fs.stat(absEntry);
          const isDir = entry.isDirectory();
          const mimeType = isDir ? null : (mime.lookup(entry.name) || 'application/octet-stream');

          let hasThumbnail = false;
          if (!isDir && mimeType && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
            hasThumbnail = await fs.pathExists(getThumbnailPath(effectiveUserRoot, absEntry));
          }

          const relPath = reqPath ? `${reqPath}/${entry.name}` : entry.name;

          return {
            name: entry.name,
            type: isDir ? 'directory' : 'file',
            size: isDir ? undefined : stat.size,
            mtime: stat.mtime,
            mimeType,
            hasThumbnail,
            path: relPath,
          };
        })
    );

    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return res.json({ files, currentPath: reqPath });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[files/list]', err.message);
    return res.status(500).json({ error: 'Failed to list files' });
  }
});

// ─── GET /api/files/storage-info ──────────────────────────────────────────────
router.get('/storage-info', authMiddleware, async (req, res) => {
  try {
    const stats = await fs.statfs(process.env.STORAGE_ROOT || '/storage');
    const total = Number(stats.bsize) * Number(stats.blocks);
    const free = Number(stats.bsize) * Number(stats.bavail);
    const used = total - free;
    return res.json({ total, used, free });
  } catch (err) {
    console.error('[storage-info]', err.message);
    return res.status(500).json({ error: 'Failed to retrieve storage info' });
  }
});

// ─── POST /api/files/upload (own files only) ──────────────────────────────────
router.post('/upload', authMiddleware, multerUpload, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files received' });
    }
    Promise.all(
      req.files.map(file =>
        generateThumbnail(file.path, req.user.username).catch(err =>
          console.warn(`[thumb] ${file.originalname}: ${err.message}`)
        )
      )
    );
    return res.json({
      uploaded: req.files.map(f => ({ name: f.filename, size: f.size })),
    });
  } catch (err) {
    console.error('[files/upload]', err.message);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── GET /api/files/view ──────────────────────────────────────────────────────
router.get('/view', authMiddleware, async (req, res) => {
  try {
    const reqPath = req.query.path;
    if (!reqPath) return res.status(400).json({ error: 'path is required' });
    const owner = req.query.owner || null;

    const { absPath } = await resolveAccessPath(req, reqPath, owner);
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot view a directory' });

    const mimeType = mime.lookup(absPath) || 'application/octet-stream';
    const range = req.headers.range;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', chunkSize);
      fs.createReadStream(absPath, { start, end }).pipe(res);
    } else {
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(absPath).pipe(res);
    }
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('[files/view]', err.message);
    return res.status(500).json({ error: 'Failed to stream file' });
  }
});

// ─── GET /api/files/download ──────────────────────────────────────────────────
router.get('/download', authMiddleware, async (req, res) => {
  try {
    const owner = req.query.owner || null;
    const reqPath = req.query.path;
    const reqPaths = req.query.paths;

    // Resolve which paths we are downloading
    let paths = [];
    if (reqPath) {
      paths = [reqPath];
    } else if (reqPaths) {
      paths = Array.isArray(reqPaths) ? reqPaths : [reqPaths];
    }

    if (paths.length === 0) {
      return res.status(400).json({ error: 'path or paths query is required' });
    }

    // 1. Single File direct download (fast path)
    const isSingleFile = paths.length === 1 && (await fs.stat((await resolveAccessPath(req, paths[0], owner)).absPath)).isFile();
    if (isSingleFile) {
      const { absPath } = await resolveAccessPath(req, paths[0], owner);
      const stat = await fs.stat(absPath);
      const filename = path.basename(absPath);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', 'application/octet-stream');
      return fs.createReadStream(absPath).pipe(res);
    }

    // 2. Directory or Bulk multi-file/folder download (ZIP path)
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.on('error', (err) => {
      console.error('[zip-archive-error]', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to compress files' });
      }
    });

    const firstAbs = (await resolveAccessPath(req, paths[0], owner)).absPath;
    const zipFilename = paths.length === 1
      ? `${path.basename(firstAbs)}.zip`
      : 'download.zip';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFilename)}"`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    for (const reqP of paths) {
      const { absPath } = await resolveAccessPath(req, reqP, owner);
      const stat = await fs.stat(absPath);
      const entryName = path.basename(absPath);

      if (stat.isDirectory()) {
        archive.directory(absPath, entryName);
      } else {
        archive.file(absPath, { name: entryName });
      }
    }

    await archive.finalize();
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('[files/download]', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Failed to download file' });
    }
  }
});

// ─── GET /api/files/thumbnail ─────────────────────────────────────────────────
router.get('/thumbnail', authMiddleware, async (req, res) => {
  try {
    const reqPath = req.query.path;
    if (!reqPath) return res.status(400).json({ error: 'path is required' });
    const owner = req.query.owner || null;

    const { absPath, effectiveUserRoot } = await resolveAccessPath(req, reqPath, owner);
    const thumbPath = getThumbnailPath(effectiveUserRoot, absPath);

    if (!(await fs.pathExists(thumbPath))) {
      // Only generate thumbnails for own files (to avoid writing into others' storage on-demand)
      if (!owner) {
        try {
          await generateThumbnail(absPath, req.user.username);
        } catch {
          return res.status(404).json({ error: 'Thumbnail not available' });
        }
      }
      if (!(await fs.pathExists(thumbPath))) {
        return res.status(404).json({ error: 'Thumbnail not available' });
      }
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('[files/thumbnail]', err.message);
    return res.status(500).json({ error: 'Failed to serve thumbnail' });
  }
});

// ─── GET /api/files/preview ──────────────────────────────────────────────────
// Serves a browser-compatible JPEG preview for RAW/DNG and other non-native image formats.
router.get('/preview', authMiddleware, async (req, res) => {
  try {
    const reqPath = req.query.path;
    if (!reqPath) return res.status(400).json({ error: 'path is required' });
    const owner = req.query.owner || null;

    const { absPath, effectiveUserRoot } = await resolveAccessPath(req, reqPath, owner);
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Cannot preview a directory' });

    const { getPreviewPath } = require('../lib/pathGuard');
    const previewPath = getPreviewPath(effectiveUserRoot, absPath);

    // Generate on-demand if not cached
    if (!(await fs.pathExists(previewPath))) {
      const ownerUsername = owner || req.user.username;
      try {
        await generatePreviewImage(absPath, ownerUsername);
      } catch (genErr) {
        console.error('[files/preview] generate error:', genErr.message);
        return res.status(422).json({ error: 'Preview could not be generated for this file' });
      }
    }

    if (!(await fs.pathExists(previewPath))) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    fs.createReadStream(previewPath).pipe(res);
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    if (err.status === 404) return res.status(404).json({ error: err.message });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('[files/preview]', err.message);
    return res.status(500).json({ error: 'Failed to generate preview' });
  }
});

// ─── GET /api/files/search ───────────────────────────────────────────────────
// Proxies authenticated search queries to the internal agent service.
// Returns results in the same shape as GET /api/files so the frontend can
// render them with the existing FileGrid component.
router.get('/search', authMiddleware, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q is required' });

    const agentRes = await fetch(
      `${AGENT_URL}/search?q=${encodeURIComponent(q)}&user_id=${req.user.id}&username=${encodeURIComponent(req.user.username)}`
    );

    if (!agentRes.ok) {
      const body = await agentRes.json().catch(() => ({}));
      return res.status(agentRes.status).json({ error: body.detail || 'Agent error' });
    }

    const data = await agentRes.json();
    return res.json(data);
  } catch (err) {
    console.error('[files/search]', err.message);
    return res.status(500).json({ error: 'Search unavailable' });
  }
});

// ─── DELETE /api/files (own files only) ───────────────────────────────────────
router.delete('/', authMiddleware, async (req, res) => {
  try {
    const { path: singlePath, paths: bulkPaths } = req.body || {};
    const pathsToDelete = bulkPaths || (singlePath ? [singlePath] : null) || (req.query.path ? [req.query.path] : null);

    if (!pathsToDelete || !Array.isArray(pathsToDelete) || pathsToDelete.length === 0) {
      return res.status(400).json({ error: 'path or paths parameter is required' });
    }

    const { pool: db } = require('../lib/db');
    const userRoot = getUserRoot(req.user.username);

    for (const reqPath of pathsToDelete) {
      const absPath = safeUserPath(req.user.username, reqPath);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) continue;

      if (stat.isFile()) {
        await fs.remove(getThumbnailPath(userRoot, absPath)).catch(() => {});
      }

      if (stat.isDirectory()) {
        await db.query(
          'DELETE FROM shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
          [req.user.id, reqPath, `${reqPath}/%`]
        ).catch(() => {});
      }

      await fs.remove(absPath);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[files/delete]', err.message);
    return res.status(500).json({ error: 'Failed to delete' });
  }
});

// ─── POST /api/files/copy (own files only) ───────────────────────────────────
router.post('/copy', authMiddleware, async (req, res) => {
  try {
    const { paths, targetDir } = req.body || {};
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }
    const targetBase = targetDir || '';
    
    for (const reqPath of paths) {
      const srcAbs = safeUserPath(req.user.username, reqPath);
      const filename = path.basename(srcAbs);
      const destRel = targetBase ? `${targetBase}/${filename}` : filename;
      const destAbs = safeUserPath(req.user.username, destRel);

      if (srcAbs === destAbs) {
        return res.status(400).json({ error: `Source and destination are the same: ${filename}` });
      }

      await fs.copy(srcAbs, destAbs);
      
      const stat = await fs.stat(destAbs).catch(() => null);
      if (stat && stat.isFile()) {
        generateThumbnail(destAbs, req.user.username).catch(() => {});
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[files/copy]', err.message);
    return res.status(500).json({ error: err.message || 'Copy failed' });
  }
});

// ─── POST /api/files/move (own files only) ───────────────────────────────────
router.post('/move', authMiddleware, async (req, res) => {
  try {
    const { pool: db } = require('../lib/db');
    const { paths, targetDir } = req.body || {};
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }
    const targetBase = targetDir || '';

    for (const reqPath of paths) {
      const srcAbs = safeUserPath(req.user.username, reqPath);
      const filename = path.basename(srcAbs);
      const destRel = targetBase ? `${targetBase}/${filename}` : filename;
      const destAbs = safeUserPath(req.user.username, destRel);

      if (srcAbs === destAbs) {
        return res.status(400).json({ error: `Source and destination are the same: ${filename}` });
      }

      const stat = await fs.stat(srcAbs).catch(() => null);
      if (!stat) continue;
      
      await fs.move(srcAbs, destAbs);

      if (stat.isFile()) {
        const userRoot = getUserRoot(req.user.username);
        const srcThumb = getThumbnailPath(userRoot, srcAbs);
        const destThumb = getThumbnailPath(userRoot, destAbs);
        if (await fs.pathExists(srcThumb)) {
          await fs.ensureDir(path.dirname(destThumb));
          await fs.move(srcThumb, destThumb).catch(() => {});
        }
      }

      if (stat.isDirectory()) {
        const oldPrefix = reqPath;
        const newPrefix = destRel;
        
        const shares = await db.query(
          'SELECT id, folder_path FROM shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
          [req.user.id, oldPrefix, `${oldPrefix}/%`]
        );
        for (const row of shares.rows) {
          const newPath = row.folder_path === oldPrefix 
            ? newPrefix 
            : newPrefix + row.folder_path.slice(oldPrefix.length);
          await db.query(
            'UPDATE shares SET folder_path = $1 WHERE id = $2',
            [newPath, row.id]
          );
        }
      }
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[files/move]', err.message);
    return res.status(500).json({ error: err.message || 'Move failed' });
  }
});

// ─── POST /api/files/rename (own files only) ─────────────────────────────────
router.post('/rename', authMiddleware, async (req, res) => {
  try {
    const { pool: db } = require('../lib/db');
    const { path: reqPath, newName } = req.body || {};
    
    if (!reqPath || !newName) {
      return res.status(400).json({ error: 'path and newName are required' });
    }

    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.includes('/') || trimmedName.includes('\\')) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    const srcAbs = safeUserPath(req.user.username, reqPath);
    const parentDir = path.dirname(reqPath);
    const destRel = parentDir === '.' ? trimmedName : `${parentDir}/${trimmedName}`;
    const destAbs = safeUserPath(req.user.username, destRel);

    if (srcAbs === destAbs) {
      return res.status(400).json({ error: 'New name must be different from current name' });
    }

    const stat = await fs.stat(srcAbs).catch(() => null);
    if (!stat) {
      return res.status(404).json({ error: 'File or folder does not exist' });
    }

    await fs.move(srcAbs, destAbs);

    // If it's a file, rename thumbnail if it exists
    if (stat.isFile()) {
      const userRoot = getUserRoot(req.user.username);
      const srcThumb = getThumbnailPath(userRoot, srcAbs);
      const destThumb = getThumbnailPath(userRoot, destAbs);
      if (await fs.pathExists(srcThumb)) {
        await fs.ensureDir(path.dirname(destThumb));
        await fs.move(srcThumb, destThumb).catch(() => {});
      }
      
      // Update file tags for this file
      await db.query(
        'UPDATE file_tags SET file_path = $1 WHERE user_id = $2 AND file_path = $3',
        [destRel, req.user.id, reqPath]
      );
    }

    // If it's a directory, update shares and recursive tags
    if (stat.isDirectory()) {
      const oldPrefix = reqPath;
      const newPrefix = destRel;

      // Update folder shares
      const shares = await db.query(
        'SELECT id, folder_path FROM shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
        [req.user.id, oldPrefix, `${oldPrefix}/%`]
      );
      for (const row of shares.rows) {
        const newPath = row.folder_path === oldPrefix
          ? newPrefix
          : newPrefix + row.folder_path.slice(oldPrefix.length);
        await db.query(
          'UPDATE shares SET folder_path = $1 WHERE id = $2',
          [newPath, row.id]
        );
      }

      // Update file tags recursively
      await db.query(
        "UPDATE file_tags SET file_path = $1 || substring(file_path from $2) WHERE user_id = $3 AND (file_path = $4 OR file_path LIKE $5)",
        [newPrefix, oldPrefix.length + 1, req.user.id, oldPrefix, `${oldPrefix}/%`]
      );
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[files/rename]', err.message);
    return res.status(500).json({ error: err.message || 'Rename failed' });
  }
});

// ─── POST /api/files/mkdir (own files only) ───────────────────────────────────
router.post('/mkdir', authMiddleware, async (req, res) => {
  try {
    const { path: reqPath } = req.body || {};
    if (!reqPath) return res.status(400).json({ error: 'path is required' });

    const absPath = safeUserPath(req.user.username, reqPath);
    await fs.ensureDir(absPath);
    return res.json({ success: true });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ error: err.message });
    console.error('[files/mkdir]', err.message);
    return res.status(500).json({ error: 'Failed to create folder' });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}

module.exports = router;
