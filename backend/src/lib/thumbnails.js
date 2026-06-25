const path = require('path');
const fs = require('fs-extra');
const mime = require('mime-types');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

// Disable sharp cache to prevent file locking on Windows
sharp.cache(false);

const { getUserRoot, getThumbnailPath, getPreviewPath } = require('./pathGuard');

const THUMB_WIDTH = 400;

/**
 * Generate a thumbnail for a given file and save it to the thumbnail cache.
 *
 * Supports:
 *  - Images (via sharp): resized JPEG
 *  - Videos (via ffmpeg): first frame as JPEG
 *
 * @param {string} filePath   - absolute path to the source file
 * @param {string} username   - owner's username (for resolving thumbnail path)
 * @returns {string|null}     - absolute path to the thumbnail, or null if unsupported
 */
const RAW_EXTENSIONS = new Set(['.dng', '.nef', '.cr2', '.cr3', '.arw', '.raf', '.rw2', '.orf', '.pef', '.srw']);

async function generateThumbnail(filePath, username) {
  let mimeType = mime.lookup(filePath) || null;
  // mime-types often doesn't know RAW camera formats — fall back by extension
  if (!mimeType && RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    mimeType = 'image/x-raw';
  }
  if (!mimeType) return null;

  const userRoot = getUserRoot(username);
  const thumbPath = getThumbnailPath(userRoot, filePath);
  await fs.ensureDir(path.dirname(thumbPath));

  if (mimeType.startsWith('image/')) {
    await sharp(filePath)
      .resize(THUMB_WIDTH, null, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toFile(thumbPath);
    return thumbPath;
  }

  if (mimeType.startsWith('video/')) {
    return new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .on('end', () => resolve(thumbPath))
        .on('error', (err) => reject(err))
        .screenshots({
          timestamps: [0],        // First frame — works regardless of duration
          filename: path.basename(thumbPath),
          folder: path.dirname(thumbPath),
          size: `${THUMB_WIDTH}x?`, // Width x auto-height
        });
    });
  }

  return null;
}

/**
 * Generate a preview image (up to 2048px) for non-browser-native files (like DNG).
 */
async function generatePreviewImage(filePath, username) {
  const userRoot = getUserRoot(username);
  const previewPath = getPreviewPath(userRoot, filePath);
  await fs.ensureDir(path.dirname(previewPath));

  await sharp(filePath)
    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, progressive: true })
    .toFile(previewPath);
  return previewPath;
}

module.exports = { generateThumbnail, generatePreviewImage };
