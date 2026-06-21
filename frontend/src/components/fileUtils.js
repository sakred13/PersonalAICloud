/**
 * Returns a single emoji / text icon for a given file entry.
 */
export function getFileIcon(file) {
  if (file.type === 'directory') return '📁';
  const m = file.mimeType || '';
  if (m.startsWith('image/'))                            return '🖼️';
  if (m.startsWith('video/'))                            return '🎬';
  if (m.startsWith('audio/'))                            return '🎵';
  if (m === 'application/pdf')                           return '📄';
  if (m.includes('zip') || m.includes('tar') || m.includes('compressed') || m.includes('7z')) return '📦';
  if (m.startsWith('text/'))                             return '📝';
  if (m.includes('word') || m.includes('document'))      return '📃';
  if (m.includes('sheet') || m.includes('excel'))        return '📊';
  if (m.includes('presentation') || m.includes('powerpoint')) return '📊';
  return '📎';
}

/** Extensions that require server-side conversion before display */
const RAW_EXTENSIONS = new Set(['.dng', '.nef', '.cr2', '.cr3', '.arw', '.raf', '.rw2', '.orf', '.pef', '.srw']);

/**
 * True if the file is a RAW/DNG camera format that needs server-side conversion.
 * These are previewed via /api/files/preview (returns JPEG) rather than /api/files/view.
 */
export function isDngRaw(file) {
  const ext = (file.name || '').lastIndexOf('.') !== -1
    ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
    : '';
  const mime = file.mimeType || '';
  return RAW_EXTENSIONS.has(ext) ||
    mime === 'image/x-adobe-dng' ||
    mime === 'image/x-raw' ||
    mime === 'image/x-nikon-nef' ||
    mime === 'image/x-canon-cr2' ||
    mime === 'image/x-canon-cr3' ||
    mime === 'image/x-sony-arw' ||
    mime === 'image/x-fuji-raf' ||
    mime === 'image/x-panasonic-raw';
}

/**
 * True if the MIME type / file name can be previewed inline in the media modal.
 */
export function isPreviewable(mimeType, fileName) {
  if (!mimeType && !fileName) return false;
  // RAW camera formats — handled via server-side JPEG conversion
  const ext = (fileName || '').lastIndexOf('.') !== -1
    ? (fileName || '').slice((fileName || '').lastIndexOf('.')).toLowerCase()
    : '';
  if (RAW_EXTENSIONS.has(ext)) return true;
  if (!mimeType) return false;
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('audio/') ||
    mimeType === 'application/pdf'
  );
}

/**
 * Human-readable file size.
 */
export function formatBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sz = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(1))} ${sz[i]}`;
}

/**
 * Short date string.
 */
export function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}
