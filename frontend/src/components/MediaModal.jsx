import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, ChevronLeft, ChevronRight, Loader } from 'lucide-react';
import { getFileUrl, getDownloadUrl, getPreviewUrl } from '../api/client.js';
import { isDngRaw } from './fileUtils.js';

/**
 * Picasa-style media modal.
 *
 * Props:
 *  file          – currently displayed file object
 *  files         – all previewable files in the current folder (for navigation)
 *  currentIndex  – index of `file` within `files`
 *  onClose       – close callback
 *  onPrev        – go to previous file
 *  onNext        – go to next file
 */
export default function MediaModal({
  file,
  files,
  currentIndex,
  owner,
  onClose,
  onPrev,
  onNext,
}) {
  const backdropRef  = useRef(null);
  const hasMultiple  = files.length > 1;
  const isRaw       = isDngRaw(file);
  const fileUrl      = isRaw ? getPreviewUrl(file.path, owner) : getFileUrl(file.path, owner);
  const downloadUrl  = getDownloadUrl(file.path, owner);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [imgError, setImgError]   = useState(false);

  // Reset load state when file changes
  useEffect(() => { setImgLoaded(false); setImgError(false); }, [file.path]);

  /* ── Keyboard navigation ─────────────────────────────────── */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape')      onClose();
      if (e.key === 'ArrowLeft'  && hasMultiple) onPrev();
      if (e.key === 'ArrowRight' && hasMultiple) onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, onPrev, onNext, hasMultiple]);

  /* ── Lock body scroll ────────────────────────────────────── */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  /* ── Click outside to close ─────────────────────────────── */
  const handleBackdropClick = (e) => {
    if (e.target === backdropRef.current) onClose();
  };

  /* ── Media renderer ──────────────────────────────────────── */
  const renderMedia = () => {
    const mime = file.mimeType || '';

    if (mime.startsWith('image/') || isRaw) {
      return (
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', maxWidth: '100%', maxHeight: '100%' }}>
          {!imgLoaded && !imgError && (
            <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, color: 'var(--text-2)' }}>
              <Loader size={36} style={{ animation: 'spin 1s linear infinite' }} />
              {isRaw && <span style={{ fontSize: '0.85rem' }}>Converting RAW image…</span>}
            </div>
          )}
          {imgError ? (
            <div className="modal-other">
              <div className="modal-other-icon">⚠️</div>
              <h3>{file.name}</h3>
              <p style={{ color: 'var(--text-2)', marginBottom: 12 }}>Preview could not be generated.</p>
              <a href={downloadUrl} className="btn btn-primary" download style={{ marginTop: 8 }}>
                <Download size={16} />
                Download Original
              </a>
            </div>
          ) : (
            <img
              key={file.path}
              src={fileUrl}
              alt={file.name}
              onLoad={() => setImgLoaded(true)}
              onError={() => { setImgLoaded(true); setImgError(true); }}
              style={{
                maxWidth: '100%', maxHeight: '100%', objectFit: 'contain',
                borderRadius: 'var(--r)', boxShadow: 'var(--shadow-lg)',
                opacity: imgLoaded ? 1 : 0, transition: 'opacity 0.3s ease',
              }}
            />
          )}
        </div>
      );
    }

    if (mime.startsWith('video/')) {
      return (
        <video
          key={file.path}
          controls
          autoPlay
          style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 'var(--r)', boxShadow: 'var(--shadow-lg)' }}
        >
          <source src={fileUrl} type={mime} />
          Your browser does not support this video format.
        </video>
      );
    }

    if (mime.startsWith('audio/')) {
      return (
        <div className="modal-other">
          <div
            className="modal-other-icon"
            style={{ filter: 'drop-shadow(0 0 24px rgba(99,102,241,.55))' }}
          >
            🎵
          </div>
          <h3>{file.name}</h3>
          <audio key={file.path} controls style={{ width: 'min(500px, 90vw)', marginTop: 16 }}>
            <source src={fileUrl} type={mime} />
          </audio>
        </div>
      );
    }

    if (mime === 'application/pdf') {
      return (
        <iframe
          key={file.path}
          src={fileUrl}
          title={file.name}
          style={{
            width: 'min(900px, 90vw)',
            height: 'calc(100vh - 160px)',
            border: 'none',
            borderRadius: 'var(--r)',
          }}
        />
      );
    }

    /* Fallback: show file info + download button */
    return (
      <div className="modal-other">
        <div className="modal-other-icon">📎</div>
        <h3>{file.name}</h3>
        <p>{file.mimeType || 'Unknown type'}</p>
        <a href={downloadUrl} className="btn btn-primary" download style={{ marginTop: 8 }}>
          <Download size={16} />
          Download File
        </a>
      </div>
    );
  };

  const modal = (
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label={`Previewing ${file.name}`}
    >
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="modal-header">
        <span className="modal-filename" title={file.name}>{file.name}</span>
        <div className="modal-actions">
          <a
            href={downloadUrl}
            className="btn btn-secondary btn-sm"
            download
            title={`Download ${file.name}`}
            aria-label="Download"
          >
            <Download size={15} />
            <span className="hide-mobile">Download</span>
          </a>
          <button
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close preview"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      {/* ── Prev / Next arrows ─────────────────────────────── */}
      {hasMultiple && (
        <>
          <div className="modal-nav prev">
            <button
              className="modal-nav-btn"
              onClick={onPrev}
              aria-label="Previous file (←)"
            >
              <ChevronLeft size={22} />
            </button>
          </div>
          <div className="modal-nav next">
            <button
              className="modal-nav-btn"
              onClick={onNext}
              aria-label="Next file (→)"
            >
              <ChevronRight size={22} />
            </button>
          </div>
        </>
      )}

      {/* ── Media content ──────────────────────────────────── */}
      <div className="modal-content">
        {renderMedia()}
      </div>

      {/* ── Footer counter ─────────────────────────────────── */}
      {hasMultiple && (
        <div className="modal-footer">
          <span className="modal-counter">
            {currentIndex + 1} / {files.length}
          </span>
        </div>
      )}
    </div>
  );

  return createPortal(modal, document.body);
}
