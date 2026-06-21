import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Share2, X, Check, Users } from 'lucide-react';
import { api } from '../api/client.js';

/**
 * Modal for sharing a folder with other registered users.
 *
 * Props:
 *  folder   – file object { name, path }
 *  onClose  – close callback
 *  onSaved  – called after a successful save
 */
export default function ShareModal({ folder, onClose, onSaved }) {
  const [users,      setUsers]      = useState([]);
  const [selected,   setSelected]   = useState(new Set());
  const [loading,    setLoading]    = useState(true);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState('');
  const [search,     setSearch]     = useState('');

  // Load user list + existing shares on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get('/shares/users'),
      api.get(`/shares?path=${encodeURIComponent(folder.path)}`),
    ])
      .then(([usersData, sharesData]) => {
        if (cancelled) return;
        setUsers(usersData.users);
        setSelected(new Set(sharesData.shares.map(s => s.shared_with_id)));
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [folder.path]);

  const toggle = (uid) =>
    setSelected(prev => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });

  const handleSave = async () => {
    setSaving(true);
    setError('');
    try {
      await api.post('/shares', {
        path: folder.path,
        userIds: [...selected],
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // Keyboard: Escape to close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const filtered = users.filter(u =>
    u.username.toLowerCase().includes(search.toLowerCase())
  );
  const sharedCount = selected.size;

  const modal = (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      <div className="dialog share-dialog">
        {/* Header */}
        <div className="share-dialog-header">
          <div className="share-dialog-title-row">
            <Share2 size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <h2 id="share-modal-title" className="dialog-title" style={{ margin: 0 }}>
              Share "{folder.name}"
            </h2>
          </div>
          <button
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {/* Search */}
        {users.length > 5 && (
          <div className="form-group" style={{ marginBottom: 12 }}>
            <input
              type="search"
              className="form-input"
              placeholder="Search users…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
            />
          </div>
        )}

        {/* User list */}
        <div className="share-user-list" role="group" aria-label="Users to share with">
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <div className="spinner" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="share-empty">
              <Users size={36} style={{ opacity: .3, margin: '0 auto 10px' }} />
              {users.length === 0
                ? 'No other users registered yet'
                : 'No users match your search'}
            </div>
          ) : (
            filtered.map(user => {
              const checked = selected.has(user.id);
              return (
                <label
                  key={user.id}
                  className={`share-user-item${checked ? ' selected' : ''}`}
                  htmlFor={`share-user-${user.id}`}
                >
                  <div className="share-user-avatar" aria-hidden>
                    {user.username[0].toUpperCase()}
                  </div>
                  <span className="share-user-name">{user.username}</span>
                  <div className={`share-checkbox${checked ? ' checked' : ''}`} aria-hidden>
                    {checked && <Check size={12} strokeWidth={3} />}
                  </div>
                  <input
                    id={`share-user-${user.id}`}
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(user.id)}
                    style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                  />
                </label>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="share-dialog-footer">
          <span className="share-count">
            {sharedCount === 0 ? 'Not shared' : `Shared with ${sharedCount} user${sharedCount !== 1 ? 's' : ''}`}
          </span>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving || loading}
            >
              {saving && <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
