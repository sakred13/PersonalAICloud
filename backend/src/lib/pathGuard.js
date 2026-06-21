const path = require('path');

const STORAGE_ROOT = process.env.STORAGE_ROOT || '/storage';

/**
 * Returns the absolute path to a user's storage root directory.
 */
function getUserRoot(username) {
  return path.resolve(STORAGE_ROOT, username);
}

/**
 * Resolves `requestedPath` relative to the user's storage root
 * and verifies it does NOT escape the root via path traversal.
 *
 * Throws a 403 error if the canonical path is outside the user root.
 * This is the single security checkpoint for all file operations.
 *
 * @param {string} username
 * @param {string} requestedPath  - relative path from the client (may contain `../`)
 * @returns {string}              - safe absolute path
 */
function safeUserPath(username, requestedPath = '') {
  const userRoot = getUserRoot(username);
  // path.resolve handles `.`, `..`, and multiple slashes correctly
  const target = path.resolve(userRoot, requestedPath);

  // Canonical check: target must equal userRoot or be inside it
  const isInside =
    target === userRoot ||
    target.startsWith(userRoot + path.sep);

  if (!isInside) {
    const err = new Error('Forbidden: path traversal detected');
    err.status = 403;
    throw err;
  }

  return target;
}

/**
 * Returns the thumbnail file path for a given absolute file path.
 * Thumbnails are stored in `{userRoot}/.thumbnails/{relative/path}.thumb.jpg`
 */
function getThumbnailPath(userRoot, absoluteFilePath) {
  const rel = path.relative(userRoot, absoluteFilePath);
  const thumbDir = path.join(userRoot, '.thumbnails', path.dirname(rel));
  return path.join(thumbDir, path.basename(rel) + '.thumb.jpg');
}

/**
 * Returns the preview image path for non-browser-native formats (like DNG).
 * Previews are stored in `{userRoot}/.thumbnails/{relative/path}.preview.jpg`
 */
function getPreviewPath(userRoot, absoluteFilePath) {
  const rel = path.relative(userRoot, absoluteFilePath);
  const thumbDir = path.join(userRoot, '.thumbnails', path.dirname(rel));
  return path.join(thumbDir, path.basename(rel) + '.preview.jpg');
}

module.exports = { STORAGE_ROOT, getUserRoot, safeUserPath, getThumbnailPath, getPreviewPath };
