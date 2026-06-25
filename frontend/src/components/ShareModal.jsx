import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Share2, X, Check, Users, Globe, Lock, Copy, Key, HardDrive } from 'lucide-react';
import { api, sharesApi } from '../api/client.js';

export default function ShareModal({ folder, onClose, onSaved }) {
  const [activeTab, setActiveTab] = useState('users'); // 'users' | 'public'
  
  // -- Specific users state
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [loading, setLoading] = useState(true);
  
  // -- Public link state
  const [isPublic, setIsPublic] = useState(false);
  const [alias, setAlias] = useState('');
  const [accessScope, setAccessScope] = useState('readonly');
  const [password, setPassword] = useState('');
  const [sizeLimitGb, setSizeLimitGb] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [copied, setCopied] = useState(false);

  // Load users, specific shares, and public shares on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');

    Promise.all([
      api.get('/shares/users'),
      api.get(`/shares?path=${encodeURIComponent(folder.path)}`),
      sharesApi.getPublic(folder.path),
    ])
      .then(([usersData, sharesData, publicData]) => {
        if (cancelled) return;
        setUsers(usersData.users);
        setSelected(new Set(sharesData.shares.map(s => s.shared_with_id)));
        
        if (publicData && publicData.publicShare) {
          const { alias, access_scope, size_limit_gb, has_password } = publicData.publicShare;
          setIsPublic(true);
          setAlias(alias);
          setAccessScope(access_scope);
          setSizeLimitGb(size_limit_gb || '');
          setHasPassword(has_password);
        } else {
          // Preset default alias
          const slug = (folder.name || '')
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .substring(0, 32);
          const randomSuffix = Math.random().toString(36).substring(2, 7);
          setAlias(`${slug}-${randomSuffix}`);
          setIsPublic(false);
          setAccessScope('readonly');
          setSizeLimitGb('');
          setHasPassword(false);
        }
      })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [folder.path, folder.name]);

  const toggleUser = (uid) =>
    setSelected(prev => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });

  const handleSave = async () => {
    setSaving(true);
    setError('');

    // Validation
    if (isPublic) {
      if (!alias.trim()) {
        setError('Folder alias is required when public sharing is enabled.');
        setSaving(false);
        return;
      }
      if (accessScope === 'full' && !password && !hasPassword) {
        setError('A password is required for Full Access public sharing.');
        setSaving(false);
        return;
      }
    }

    try {
      // 1. Save specific users share list
      await api.post('/shares', {
        path: folder.path,
        userIds: [...selected],
      });

      // 2. Save public sharing configuration
      let passVal = undefined;
      if (clearPassword) {
        passVal = '';
      } else if (password) {
        passVal = password;
      }

      await sharesApi.savePublic({
        path: folder.path,
        isPublic,
        alias: alias.trim(),
        accessScope,
        password: passVal,
        sizeLimitGb: sizeLimitGb === '' ? null : parseFloat(sizeLimitGb)
      });

      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = () => {
    const url = `${window.location.origin}/${alias.trim()}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
  const publicShareUrl = `${window.location.origin}/${alias.trim()}`;

  const modal = (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-modal-title"
    >
      <div className="dialog share-dialog" style={{ width: 'min(460px, 95vw)', padding: '24px 28px' }}>
        {/* Header */}
        <div className="share-dialog-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div className="share-dialog-title-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Share2 size={20} style={{ color: 'var(--accent)', flexShrink: 0 }} />
            <h2 id="share-modal-title" className="dialog-title" style={{ margin: 0, fontSize: 18 }}>
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

        {error && <div className="alert alert-error" style={{ padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>{error}</div>}

        {/* Tab switcher */}
        <div className="dialog-tabs">
          <button
            className={`dialog-tab ${activeTab === 'users' ? 'active' : ''}`}
            onClick={() => setActiveTab('users')}
          >
            <Users size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Users
          </button>
          <button
            className={`dialog-tab ${activeTab === 'public' ? 'active' : ''}`}
            onClick={() => setActiveTab('public')}
            id="public-share-tab"
          >
            <Globe size={14} style={{ marginRight: 6, verticalAlign: 'middle' }} />
            Public Link
          </button>
        </div>

        <div className="dialog-body">
          {/* Tab 1: User selection */}
          {activeTab === 'users' && (
            <div>
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

              <div className="share-user-list" role="group" aria-label="Users to share with" style={{ maxHeight: 220, overflowY: 'auto' }}>
                {loading ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
                    <div className="spinner" />
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="share-empty" style={{ padding: '32px 0', textColor: 'var(--text-secondary)', textAlign: 'center' }}>
                    <Users size={32} style={{ opacity: .3, margin: '0 auto 8px' }} />
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
                        style={{ display: 'flex', alignItems: 'center', padding: '8px 10px', borderRadius: 'var(--r-sm)', marginBottom: 4, cursor: 'pointer', background: checked ? 'rgba(255,255,255,0.02)' : 'transparent' }}
                      >
                        <div className="share-user-avatar" aria-hidden style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-grad)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold', fontSize: 12, marginRight: 10 }}>
                          {user.username[0].toUpperCase()}
                        </div>
                        <span className="share-user-name" style={{ flex: 1, fontSize: 13 }}>{user.username}</span>
                        <div className={`share-checkbox${checked ? ' checked' : ''}`} aria-hidden style={{ width: 18, height: 18, border: '1px solid var(--border)', borderRadius: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: checked ? 'var(--accent)' : 'transparent' }}>
                          {checked && <Check size={12} strokeWidth={3} color="white" />}
                        </div>
                        <input
                          id={`share-user-${user.id}`}
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleUser(user.id)}
                          style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}
                        />
                      </label>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* Tab 2: Public sharing config */}
          {activeTab === 'public' && (
            <div style={{ animation: 'fadeIn 0.2s ease' }}>
              <label className="share-user-item" htmlFor="public-share-toggle" style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderRadius: 'var(--r)', background: 'rgba(255,255,255,0.03)', cursor: 'pointer', marginBottom: 16 }}>
                <Globe size={18} style={{ color: isPublic ? 'var(--accent)' : 'var(--text-secondary)', marginRight: 10 }} />
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>Enable Public Sharing</p>
                  <p style={{ fontSize: 11, color: 'var(--text-secondary)', margin: 0 }}>Anyone with the link can access</p>
                </div>
                <input
                  id="public-share-toggle"
                  type="checkbox"
                  checked={isPublic}
                  onChange={e => setIsPublic(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: 'var(--accent)', cursor: 'pointer' }}
                />
              </label>

              {isPublic && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {/* Access scope */}
                  <div>
                    <span className="form-label" style={{ marginBottom: 6 }}>Access Scope</span>
                    <div style={{ display: 'flex', gap: 12 }}>
                      <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${accessScope === 'readonly' ? 'var(--success)' : 'var(--border)'}`, borderRadius: 'var(--r-sm)', cursor: 'pointer', fontSize: 12 }}>
                        <input
                          type="radio"
                          name="accessScope"
                          checked={accessScope === 'readonly'}
                          onChange={() => setAccessScope('readonly')}
                          style={{ accentColor: 'var(--success)' }}
                        />
                        <div>
                          <strong style={{ color: 'var(--success)' }}>Read Only</strong>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>View & Download</div>
                        </div>
                      </label>
                      <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${accessScope === 'full' ? 'var(--warning)' : 'var(--border)'}`, borderRadius: 'var(--r-sm)', cursor: 'pointer', fontSize: 12 }}>
                        <input
                          id="scope-full-radio"
                          type="radio"
                          name="accessScope"
                          checked={accessScope === 'full'}
                          onChange={() => setAccessScope('full')}
                          style={{ accentColor: 'var(--warning)' }}
                        />
                        <div>
                          <strong style={{ color: 'var(--warning)' }}>Full Access</strong>
                          <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Upload, Delete, Rename</div>
                        </div>
                      </label>
                    </div>
                  </div>

                  {/* Alias input */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" htmlFor="public-alias-input">Folder Alias</label>
                    <input
                      id="public-alias-input"
                      type="text"
                      className="form-input"
                      placeholder="folder-alias"
                      value={alias}
                      onChange={e => setAlias(e.target.value)}
                      style={{ fontSize: 13, padding: '10px 12px' }}
                    />
                    <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>
                      Your link: <span style={{ fontFamily: 'monospace', color: 'var(--accent)' }}>/{alias.trim()}</span>
                    </p>
                  </div>

                  {/* Password field */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" htmlFor="public-password-input" style={{ display: 'flex', justifycontent: 'space-between' }}>
                      <span>Password {accessScope === 'full' ? <span style={{ color: 'var(--error)' }}>*</span> : <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>(Optional)</span>}</span>
                      {hasPassword && (
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 11, color: 'var(--warning)' }}>
                          <input
                            type="checkbox"
                            checked={clearPassword}
                            onChange={e => {
                              setClearPassword(e.target.checked);
                              if (e.target.checked) setPassword('');
                            }}
                            disabled={accessScope === 'full'}
                          />
                          Remove Password
                        </label>
                      )}
                    </label>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <input
                        id="public-password-input"
                        type="password"
                        className="form-input"
                        placeholder={hasPassword && !clearPassword ? "•••••••• (unchanged)" : "Enter password"}
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        disabled={clearPassword}
                        style={{ fontSize: 13, padding: '10px 12px' }}
                      />
                      <Lock size={14} style={{ position: 'absolute', right: 12, opacity: 0.3 }} />
                    </div>
                  </div>

                  {/* Size limit (GB) */}
                  <div className="form-group" style={{ marginBottom: 0 }}>
                    <label className="form-label" htmlFor="public-limit-input" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <HardDrive size={13} />
                      Size Limit (GB)
                    </label>
                    <input
                      id="public-limit-input"
                      type="number"
                      min="1"
                      step="0.1"
                      className="form-input"
                      placeholder="e.g. 5 (Leave empty for no limit)"
                      value={sizeLimitGb}
                      onChange={e => setSizeLimitGb(e.target.value)}
                      style={{ fontSize: 13, padding: '10px 12px' }}
                    />
                    <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                      Prevents uploads when folder contents exceed this limit.
                    </p>
                  </div>

                  {/* Copy Link Section (if saved / has alias) */}
                  {alias.trim() && (
                    <div className="public-link-card">
                      <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-secondary)' }}>Share link:</span>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <div className="public-link-text" style={{ flex: 1 }}>{publicShareUrl}</div>
                        <button
                          type="button"
                          className="btn btn-secondary btn-icon"
                          onClick={handleCopy}
                          title="Copy to clipboard"
                          style={{ height: 32, width: 32 }}
                        >
                          {copied ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Copy size={14} />}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="share-dialog-footer" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <span className="share-count" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {activeTab === 'users'
              ? (sharedCount === 0 ? 'Not shared' : `Shared with ${sharedCount} user${sharedCount !== 1 ? 's' : ''}`)
              : (isPublic ? `Public: ${accessScope === 'full' ? 'Full Access' : 'Read Only'}` : 'Public link disabled')}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
            <button
              id="save-share-btn"
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={saving || loading}
            >
              {saving && <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2, marginRight: 6 }} />}
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
