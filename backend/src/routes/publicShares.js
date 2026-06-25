const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mime = require('mime-types');
const multer = require('multer');
const archiver = require('archiver');

const { pool } = require('../lib/db');
const { safeUserPath, getUserRoot, getThumbnailPath, getPreviewPath } = require('../lib/pathGuard');
const { generateThumbnail, generatePreviewImage } = require('../lib/thumbnails');

const router = express.Router();

const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(10 * 1024 * 1024 * 1024), 10);

// Helper: recursively compute directory size
async function getFolderSize(dirPath) {
  let size = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += await getFolderSize(fullPath);
      } else {
        const stat = await fs.stat(fullPath);
        size += stat.size;
      }
    }
  } catch (err) {
    console.warn(`[getFolderSize] Error reading ${dirPath}:`, err.message);
  }
  return size;
}

// Helper: verify public share JWT
function verifyPublicToken(token, alias) {
  if (!token) {
    const err = new Error('Verification token required');
    err.status = 401;
    throw err;
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.alias !== alias) {
      const err = new Error('Invalid token for this folder');
      err.status = 401;
      throw err;
    }
    return decoded;
  } catch (err) {
    const error = new Error(err.message || 'Invalid or expired token');
    error.status = 401;
    throw error;
  }
}

// Middleware: resolves public share configuration and handles password validation
async function resolvePublicShareAccess(req, res, next) {
  try {
    const { alias } = req.params;
    const shareResult = await pool.query(
      `SELECT ps.*, u.username 
       FROM public_shares ps 
       JOIN users u ON ps.owner_id = u.id 
       WHERE ps.alias = $1`,
      [alias]
    );

    if (shareResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shared folder not found' });
    }
    const share = shareResult.rows[0];

    // Check token if password exists
    if (share.password_hash) {
      const token = req.headers['x-public-share-token'] || req.query.token;
      verifyPublicToken(token, alias);
    }

    req.publicShare = share;
    next();
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ error: err.message, passwordRequired: true });
    }
    console.error('[publicShares/middleware]', err.message);
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}

// ─── GET /api/public/shares/info/:alias ───────────────────────────────────────
router.get('/info/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const result = await pool.query(
      `SELECT ps.alias, ps.access_scope, ps.size_limit_gb, ps.folder_path,
              (ps.password_hash IS NOT NULL) AS password_required,
              u.username AS owner_username
       FROM public_shares ps
       JOIN users u ON ps.owner_id = u.id
       WHERE ps.alias = $1`,
      [alias]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shared folder not found' });
    }

    const share = result.rows[0];
    const folderName = share.folder_path.split('/').pop() || share.folder_path;

    return res.json({
      alias: share.alias,
      accessScope: share.access_scope,
      sizeLimitGb: share.size_limit_gb,
      passwordRequired: share.password_required,
      ownerUsername: share.owner_username,
      folderName,
    });
  } catch (err) {
    console.error('[publicShares/info]', err.message);
    return res.status(500).json({ error: 'Failed to fetch share info' });
  }
});

// ─── POST /api/public/shares/unlock/:alias ────────────────────────────────────
router.post('/unlock/:alias', async (req, res) => {
  try {
    const { alias } = req.params;
    const { password } = req.body || {};

    const shareResult = await pool.query(
      'SELECT owner_id, alias, access_scope, password_hash FROM public_shares WHERE alias = $1',
      [alias]
    );

    if (shareResult.rows.length === 0) {
      return res.status(404).json({ error: 'Shared folder not found' });
    }
    const share = shareResult.rows[0];

    if (share.password_hash) {
      if (!password) {
        return res.status(400).json({ error: 'Password is required' });
      }
      const match = await bcrypt.compare(password, share.password_hash);
      if (!match) {
        return res.status(401).json({ error: 'Incorrect password' });
      }
    }

    // Issue public share JWT
    const token = jwt.sign(
      { alias: share.alias, scope: share.access_scope, ownerId: share.owner_id },
      process.env.JWT_SECRET,
      { expiresIn: '12h' }
    );

    return res.json({ token });
  } catch (err) {
    console.error('[publicShares/unlock]', err.message);
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// ─── GET /api/public/shares/list/:alias ───────────────────────────────────────
router.get('/list/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    const subpath = (req.query.path || '').replace(/^\/+|\/+$/g, '');

    const fullRelativePath = publicShare.folder_path
      ? `${publicShare.folder_path}/${subpath}`.replace(/\/+/g, '/')
      : subpath;

    const absPath = safeUserPath(publicShare.username, fullRelativePath);
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied: path traversal attempt' });
    }

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
          const entryRelPath = subpath ? `${subpath}/${entry.name}` : entry.name;
          const userRoot = getUserRoot(publicShare.username);

          let hasThumbnail = false;
          if (!isDir && mimeType && (mimeType.startsWith('image/') || mimeType.startsWith('video/'))) {
            hasThumbnail = await fs.pathExists(getThumbnailPath(userRoot, absEntry));
          }

          return {
            name: entry.name,
            type: isDir ? 'directory' : 'file',
            size: isDir ? undefined : stat.size,
            mtime: stat.mtime,
            mimeType,
            hasThumbnail,
            path: entryRelPath,
          };
        })
    );

    files.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return res.json({ files, currentPath: subpath });
  } catch (err) {
    console.error('[publicShares/list]', err.message);
    return res.status(500).json({ error: 'Failed to list directory contents' });
  }
});

// ─── GET /api/public/shares/view/:alias ───────────────────────────────────────
router.get('/view/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    const reqPath = req.query.path;
    if (!reqPath) return res.status(400).json({ error: 'path is required' });

    const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
    const absPath = safeUserPath(publicShare.username, fullRelativePath);
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

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
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('[publicShares/view]', err.message);
    return res.status(500).json({ error: 'Failed to stream file' });
  }
});

// ─── GET /api/public/shares/thumbnail/:alias ──────────────────────────────────
router.get('/thumbnail/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    const reqPath = req.query.path;
    if (!reqPath) return res.status(400).json({ error: 'path is required' });

    const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
    const absPath = safeUserPath(publicShare.username, fullRelativePath);
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const userRoot = getUserRoot(publicShare.username);
    const thumbPath = getThumbnailPath(userRoot, absPath);

    if (!(await fs.pathExists(thumbPath))) {
      return res.status(404).json({ error: 'Thumbnail not available' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    fs.createReadStream(thumbPath).pipe(res);
  } catch (err) {
    console.error('[publicShares/thumbnail]', err.message);
    return res.status(500).json({ error: 'Failed to serve thumbnail' });
  }
});

// ─── GET /api/public/shares/preview/:alias ────────────────────────────────────
router.get('/preview/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    const reqPath = req.query.path;
    if (!reqPath) return res.status(400).json({ error: 'path is required' });

    const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
    const absPath = safeUserPath(publicShare.username, fullRelativePath);
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const userRoot = getUserRoot(publicShare.username);
    const previewPath = getPreviewPath(userRoot, absPath);

    if (!(await fs.pathExists(previewPath))) {
      return res.status(404).json({ error: 'Preview not available' });
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    fs.createReadStream(previewPath).pipe(res);
  } catch (err) {
    console.error('[publicShares/preview]', err.message);
    return res.status(500).json({ error: 'Failed to serve preview' });
  }
});

// ─── GET /api/public/shares/download/:alias ──────────────────────────────────
router.get('/download/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    const reqPath = req.query.path;
    const reqPaths = req.query.paths;

    let paths = [];
    if (reqPath) {
      paths = [reqPath];
    } else if (reqPaths) {
      paths = Array.isArray(reqPaths) ? reqPaths : [reqPaths];
    }

    if (paths.length === 0) {
      return res.status(400).json({ error: 'path or paths parameter is required' });
    }

    // Verify paths are inside the shared folder
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);
    const resolvedPaths = [];
    for (const p of paths) {
      const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${p}`.replace(/\/+/g, '/') : p;
      const absPath = safeUserPath(publicShare.username, fullRelativePath);
      if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
        return res.status(403).json({ error: 'Access denied' });
      }
      resolvedPaths.push(absPath);
    }

    // Single file download (fast path)
    const isSingleFile = resolvedPaths.length === 1 && (await fs.stat(resolvedPaths[0])).isFile();
    if (isSingleFile) {
      const absPath = resolvedPaths[0];
      const stat = await fs.stat(absPath);
      const filename = path.basename(absPath);
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Type', 'application/octet-stream');
      return fs.createReadStream(absPath).pipe(res);
    }

    // Zip directory / multiple files
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('[publicShares/zip-error]', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to compress files' });
      }
    });

    const zipFilename = resolvedPaths.length === 1
      ? `${path.basename(resolvedPaths[0])}.zip`
      : 'download.zip';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFilename)}"`);
    res.setHeader('Content-Type', 'application/zip');
    archive.pipe(res);

    for (const absPath of resolvedPaths) {
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
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    console.error('[publicShares/download]', err.message);
    if (!res.headersSent) {
      return res.status(500).json({ error: 'Download failed' });
    }
  }
});

// ─── Multer config for public uploads ──────────────────────────────────────────
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const { alias } = req.params;
      const subpath = (req.query.path || '').replace(/^\/+|\/+$/g, '');

      const shareResult = await pool.query(
        `SELECT ps.*, u.username FROM public_shares ps JOIN users u ON ps.owner_id = u.id WHERE ps.alias = $1`,
        [alias]
      );
      if (shareResult.rows.length === 0) return cb(new Error('Shared folder not found'));
      const share = shareResult.rows[0];

      // Enforce full access scope
      if (share.access_scope !== 'full') {
        return cb(new Error('Upload denied: folder is read-only'));
      }

      // Verify token
      if (share.password_hash) {
        const token = req.query.token || req.headers['x-public-share-token'];
        verifyPublicToken(token, alias);
      }

      // Check size limit if configured
      if (share.size_limit_gb) {
        const limitBytes = share.size_limit_gb * 1024 * 1024 * 1024;
        const baseSharedAbsPath = safeUserPath(share.username, share.folder_path);
        const currentSize = await getFolderSize(baseSharedAbsPath);
        const contentLength = parseInt(req.headers['content-length'] || '0');

        if (currentSize + contentLength > limitBytes) {
          const err = new Error('Upload rejected: Folder size limit exceeded');
          err.status = 413;
          return cb(err);
        }
      }

      const fullRelativePath = share.folder_path ? `${share.folder_path}/${subpath}`.replace(/\/+/g, '/') : subpath;
      const absPath = safeUserPath(share.username, fullRelativePath);
      const baseSharedAbsPath = safeUserPath(share.username, share.folder_path);

      if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
        return cb(new Error('Access denied'));
      }

      await fs.ensureDir(absPath);
      cb(null, absPath);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const safeName = path.basename(file.originalname).replace(/[^\w\s.()\-]/g, '_');
    cb(null, safeName);
  }
});

const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

function multerPublicUpload(req, res, next) {
  upload.array('files', 200)(req, res, (err) => {
    if (!err) return next();
    if (err.status === 413 || err.code === 'LIMIT_FILE_SIZE' || err.message.includes('limit exceeded')) {
      return res.status(413).json({ error: err.message || 'File size limit exceeded' });
    }
    return res.status(500).json({ error: err.message || 'Upload error' });
  });
}

// ─── POST /api/public/shares/upload/:alias ────────────────────────────────────
router.post('/upload/:alias', resolvePublicShareAccess, multerPublicUpload, async (req, res) => {
  try {
    const { publicShare } = req;
    if (publicShare.access_scope !== 'full') {
      return res.status(403).json({ error: 'Upload denied: read-only folder' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files received' });
    }

    // Trigger thumbnails generation in the background
    Promise.all(
      req.files.map(file =>
        generateThumbnail(file.path, publicShare.username).catch(err =>
          console.warn(`[public-thumb] ${file.originalname}: ${err.message}`)
        )
      )
    );

    return res.json({
      uploaded: req.files.map(f => ({ name: f.filename, size: f.size })),
    });
  } catch (err) {
    console.error('[publicShares/upload]', err.message);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// ─── POST /api/public/shares/mkdir/:alias ─────────────────────────────────────
router.post('/mkdir/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    if (publicShare.access_scope !== 'full') {
      return res.status(403).json({ error: 'Access denied: read-only' });
    }

    const { path: reqPath } = req.body || {};
    if (!reqPath) return res.status(400).json({ error: 'path is required' });

    const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
    const absPath = safeUserPath(publicShare.username, fullRelativePath);
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await fs.ensureDir(absPath);
    return res.json({ success: true });
  } catch (err) {
    console.error('[publicShares/mkdir]', err.message);
    return res.status(500).json({ error: 'Failed to create folder' });
  }
});

// ─── DELETE /api/public/shares/delete/:alias ──────────────────────────────────
router.delete('/delete/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    if (publicShare.access_scope !== 'full') {
      return res.status(403).json({ error: 'Access denied: read-only' });
    }

    const { paths } = req.body || {};
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    for (const reqPath of paths) {
      const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
      const absPath = safeUserPath(publicShare.username, fullRelativePath);

      if (absPath !== baseSharedAbsPath && !absPath.startsWith(baseSharedAbsPath + path.sep)) {
        continue; // skip out-of-bounds deletions
      }

      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) continue;

      if (stat.isFile()) {
        const userRoot = getUserRoot(publicShare.username);
        await fs.remove(getThumbnailPath(userRoot, absPath)).catch(() => {});
      }

      // Cleanup folders recursively
      if (stat.isDirectory()) {
        await pool.query(
          'DELETE FROM shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
          [publicShare.owner_id, fullRelativePath, `${fullRelativePath}/%`]
        ).catch(() => {});
        await pool.query(
          'DELETE FROM public_shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
          [publicShare.owner_id, fullRelativePath, `${fullRelativePath}/%`]
        ).catch(() => {});
      }

      await fs.remove(absPath);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[publicShares/delete]', err.message);
    return res.status(500).json({ error: 'Failed to delete files' });
  }
});

// ─── POST /api/public/shares/rename/:alias ────────────────────────────────────
router.post('/rename/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    if (publicShare.access_scope !== 'full') {
      return res.status(403).json({ error: 'Access denied: read-only' });
    }

    const { path: reqPath, newName } = req.body || {};
    if (!reqPath || !newName) {
      return res.status(400).json({ error: 'path and newName are required' });
    }

    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.includes('/') || trimmedName.includes('\\')) {
      return res.status(400).json({ error: 'Invalid name' });
    }

    const fullRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
    const srcAbs = safeUserPath(publicShare.username, fullRelativePath);
    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);

    if (srcAbs !== baseSharedAbsPath && !srcAbs.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const parentDir = path.dirname(reqPath);
    const destRelPath = parentDir === '.' ? trimmedName : `${parentDir}/${trimmedName}`;
    const fullDestRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${destRelPath}`.replace(/\/+/g, '/') : destRelPath;
    const destAbs = safeUserPath(publicShare.username, fullDestRelativePath);

    if (srcAbs === destAbs) {
      return res.status(400).json({ error: 'New name must be different' });
    }

    const stat = await fs.stat(srcAbs).catch(() => null);
    if (!stat) {
      return res.status(404).json({ error: 'File or folder does not exist' });
    }

    await fs.move(srcAbs, destAbs);

    // If it's a file, rename thumbnail
    if (stat.isFile()) {
      const userRoot = getUserRoot(publicShare.username);
      const srcThumb = getThumbnailPath(userRoot, srcAbs);
      const destThumb = getThumbnailPath(userRoot, destAbs);
      if (await fs.pathExists(srcThumb)) {
        await fs.ensureDir(path.dirname(destThumb));
        await fs.move(srcThumb, destThumb).catch(() => {});
      }
      
      // Update file tags for this file
      await pool.query(
        'UPDATE file_tags SET file_path = $1 WHERE user_id = $2 AND file_path = $3',
        [fullDestRelativePath, publicShare.owner_id, fullRelativePath]
      ).catch(() => {});
    }

    // If it's a directory, update shares and recursive tags
    if (stat.isDirectory()) {
      const oldPrefix = fullRelativePath;
      const newPrefix = fullDestRelativePath;

      // Update folder shares
      const shares = await pool.query(
        'SELECT id, folder_path FROM shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
        [publicShare.owner_id, oldPrefix, `${oldPrefix}/%`]
      );
      for (const row of shares.rows) {
        const newPath = row.folder_path === oldPrefix
          ? newPrefix
          : newPrefix + row.folder_path.slice(oldPrefix.length);
        await pool.query('UPDATE shares SET folder_path = $1 WHERE id = $2', [newPath, row.id]);
      }

      // Update public shares
      const publicShares = await pool.query(
        'SELECT id, folder_path FROM public_shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
        [publicShare.owner_id, oldPrefix, `${oldPrefix}/%`]
      );
      for (const row of publicShares.rows) {
        const newPath = row.folder_path === oldPrefix
          ? newPrefix
          : newPrefix + row.folder_path.slice(oldPrefix.length);
        await pool.query('UPDATE public_shares SET folder_path = $1 WHERE id = $2', [newPath, row.id]);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[publicShares/rename]', err.message);
    return res.status(500).json({ error: 'Rename failed' });
  }
});

// ─── POST /api/public/shares/copy/:alias ──────────────────────────────────────
router.post('/copy/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    if (publicShare.access_scope !== 'full') {
      return res.status(403).json({ error: 'Access denied: read-only' });
    }

    const { paths, targetDir } = req.body || {};
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);
    const targetBase = targetDir || '';

    // Verify target directory is within public share
    const targetBaseRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${targetBase}`.replace(/\/+/g, '/') : targetBase;
    const targetBaseAbs = safeUserPath(publicShare.username, targetBaseRelativePath);
    if (targetBaseAbs !== baseSharedAbsPath && !targetBaseAbs.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied: Target folder outside shared root' });
    }

    // Check size limit if configured
    if (publicShare.size_limit_gb) {
      const limitBytes = publicShare.size_limit_gb * 1024 * 1024 * 1024;
      const currentSize = await getFolderSize(baseSharedAbsPath);
      let incomingSize = 0;
      for (const p of paths) {
        const rel = publicShare.folder_path ? `${publicShare.folder_path}/${p}`.replace(/\/+/g, '/') : p;
        const abs = safeUserPath(publicShare.username, rel);
        const stat = await fs.stat(abs).catch(() => null);
        if (stat) incomingSize += stat.size;
      }

      if (currentSize + incomingSize > limitBytes) {
        return res.status(413).json({ error: 'Copy rejected: size limit exceeded' });
      }
    }

    for (const reqPath of paths) {
      const srcRel = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
      const srcAbs = safeUserPath(publicShare.username, srcRel);
      if (srcAbs !== baseSharedAbsPath && !srcAbs.startsWith(baseSharedAbsPath + path.sep)) {
        continue;
      }

      const filename = path.basename(srcAbs);
      const destRel = targetBase ? `${targetBase}/${filename}` : filename;
      const fullDestRel = publicShare.folder_path ? `${publicShare.folder_path}/${destRel}`.replace(/\/+/g, '/') : destRel;
      const destAbs = safeUserPath(publicShare.username, fullDestRel);

      if (srcAbs === destAbs) {
        return res.status(400).json({ error: `Source and destination are the same: ${filename}` });
      }

      await fs.copy(srcAbs, destAbs);
      
      const stat = await fs.stat(destAbs).catch(() => null);
      if (stat && stat.isFile()) {
        generateThumbnail(destAbs, publicShare.username).catch(() => {});
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[publicShares/copy]', err.message);
    return res.status(500).json({ error: err.message || 'Copy failed' });
  }
});

// ─── POST /api/public/shares/move/:alias ──────────────────────────────────────
router.post('/move/:alias', resolvePublicShareAccess, async (req, res) => {
  try {
    const { publicShare } = req;
    if (publicShare.access_scope !== 'full') {
      return res.status(403).json({ error: 'Access denied: read-only' });
    }

    const { paths, targetDir } = req.body || {};
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    const baseSharedAbsPath = safeUserPath(publicShare.username, publicShare.folder_path);
    const targetBase = targetDir || '';

    // Verify target directory is within public share
    const targetBaseRelativePath = publicShare.folder_path ? `${publicShare.folder_path}/${targetBase}`.replace(/\/+/g, '/') : targetBase;
    const targetBaseAbs = safeUserPath(publicShare.username, targetBaseRelativePath);
    if (targetBaseAbs !== baseSharedAbsPath && !targetBaseAbs.startsWith(baseSharedAbsPath + path.sep)) {
      return res.status(403).json({ error: 'Access denied: Target folder outside shared root' });
    }

    for (const reqPath of paths) {
      const srcRel = publicShare.folder_path ? `${publicShare.folder_path}/${reqPath}`.replace(/\/+/g, '/') : reqPath;
      const srcAbs = safeUserPath(publicShare.username, srcRel);
      if (srcAbs !== baseSharedAbsPath && !srcAbs.startsWith(baseSharedAbsPath + path.sep)) {
        continue;
      }

      const filename = path.basename(srcAbs);
      const destRel = targetBase ? `${targetBase}/${filename}` : filename;
      const fullDestRel = publicShare.folder_path ? `${publicShare.folder_path}/${destRel}`.replace(/\/+/g, '/') : destRel;
      const destAbs = safeUserPath(publicShare.username, fullDestRel);

      if (srcAbs === destAbs) {
        return res.status(400).json({ error: `Source and destination are the same: ${filename}` });
      }

      const stat = await fs.stat(srcAbs).catch(() => null);
      if (!stat) continue;
      
      await fs.move(srcAbs, destAbs);

      if (stat.isFile()) {
        const userRoot = getUserRoot(publicShare.username);
        const srcThumb = getThumbnailPath(userRoot, srcAbs);
        const destThumb = getThumbnailPath(userRoot, destAbs);
        if (await fs.pathExists(srcThumb)) {
          await fs.ensureDir(path.dirname(destThumb));
          await fs.move(srcThumb, destThumb).catch(() => {});
        }
      }

      if (stat.isDirectory()) {
        const oldPrefix = srcRel;
        const newPrefix = fullDestRel;
        
        // Update folder shares
        const shares = await pool.query(
          'SELECT id, folder_path FROM shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
          [publicShare.owner_id, oldPrefix, `${oldPrefix}/%`]
        );
        for (const row of shares.rows) {
          const newPath = row.folder_path === oldPrefix 
            ? newPrefix 
            : newPrefix + row.folder_path.slice(oldPrefix.length);
          await pool.query('UPDATE shares SET folder_path = $1 WHERE id = $2', [newPath, row.id]);
        }

        // Update public shares
        const publicShares = await pool.query(
          'SELECT id, folder_path FROM public_shares WHERE owner_id = $1 AND (folder_path = $2 OR folder_path LIKE $3)',
          [publicShare.owner_id, oldPrefix, `${oldPrefix}/%`]
        );
        for (const row of publicShares.rows) {
          const newPath = row.folder_path === oldPrefix 
            ? newPrefix 
            : newPrefix + row.folder_path.slice(oldPrefix.length);
          await pool.query('UPDATE public_shares SET folder_path = $1 WHERE id = $2', [newPath, row.id]);
        }
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('[publicShares/move]', err.message);
    return res.status(500).json({ error: err.message || 'Move failed' });
  }
});

module.exports = router;
