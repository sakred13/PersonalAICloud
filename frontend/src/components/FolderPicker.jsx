import { useState, useEffect } from 'react';
import { Folder, ChevronRight, X, Home } from 'lucide-react';
import { api } from '../api/client.js';

export default function FolderPicker({ onClose, onSelect, actionName = 'Select' }) {
  const [currentPath, setCurrentPath] = useState('');
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api.get(`/files?path=${encodeURIComponent(currentPath)}`)
      .then(res => {
        if (!active) return;
        const dirEntries = (res.files || []).filter(f => f.type === 'directory');
        setFolders(dirEntries);
      })
      .catch(err => {
        if (!active) return;
        setError(err.message || 'Failed to load folders');
      })
      .finally(() => {
        if (!active) return;
        setLoading(false);
      });

    return () => { active = false; };
  }, [currentPath]);

  const handleFolderClick = (path) => {
    setCurrentPath(path);
  };

  const getBreadcrumbs = () => {
    const segments = currentPath.split('/').filter(Boolean);
    return (
      <div className="picker-breadcrumbs" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
        <button 
          className="btn btn-ghost btn-sm"
          style={{ padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 4 }}
          onClick={() => setCurrentPath('')}
        >
          <Home size={14} /> Root
        </button>
        {segments.map((seg, idx) => {
          const pathUpTo = segments.slice(0, idx + 1).join('/');
          return (
            <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <ChevronRight size={12} style={{ opacity: 0.5 }} />
              <button 
                className="btn btn-ghost btn-sm"
                style={{ padding: '4px 6px' }}
                onClick={() => setCurrentPath(pathUpTo)}
              >
                {seg}
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="dialog-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="dialog" onClick={e => e.stopPropagation()} style={{ width: '440px', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 className="dialog-title" style={{ margin: 0 }}>{actionName} Destination</h2>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {getBreadcrumbs()}

        {error && <div className="alert alert-error">{error}</div>}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: '200px', maxHeight: '350px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: 8, marginBottom: 16 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <div className="spinner" />
            </div>
          ) : folders.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)', fontSize: 13 }}>
              No subfolders in this directory.
            </div>
          ) : (
            folders.map(f => (
              <button
                key={f.path}
                className="btn btn-ghost"
                style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '10px 12px', justifyContent: 'flex-start', borderRadius: 'var(--r-sm)', color: 'var(--text-primary)' }}
                onClick={() => handleFolderClick(f.path)}
              >
                <Folder size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{f.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="dialog-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button 
            className="btn btn-primary" 
            onClick={() => onSelect(currentPath)}
          >
            {actionName} here
          </button>
        </div>
      </div>
    </div>
  );
}
