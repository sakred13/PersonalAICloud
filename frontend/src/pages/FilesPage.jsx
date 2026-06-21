import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cloud, LogOut, Grid, List, Upload,
  FolderPlus, Menu, X, Home, Share2, Users, ChevronRight, Search,
  Copy, Move, Trash2, Download
} from 'lucide-react';
import { api, sharesApi, uploadFiles, searchFiles, getDownloadUrl } from '../api/client.js';
import { useAuth } from '../App.jsx';
import { isPreviewable, formatBytes } from '../components/fileUtils.js';
import FileGrid from '../components/FileGrid.jsx';
import FileList from '../components/FileList.jsx';
import MediaModal from '../components/MediaModal.jsx';
import Breadcrumb from '../components/Breadcrumb.jsx';
import UploadDropzone from '../components/UploadDropzone.jsx';
import ShareModal from '../components/ShareModal.jsx';
import FolderPicker from '../components/FolderPicker.jsx';

// ── Toast hook ────────────────────────────────────────────────────────────────
function useToast() {
  const [toasts, setToasts] = useState([]);
  const show = useCallback((message, type = 'info') => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, message, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3200);
  }, []);
  return { toasts, show };
}

// ── SharedFolderCard ─────────────────────────────────────────────────────────
function SharedFolderCard({ share, onOpen }) {
  const folderName = share.folder_path.split('/').pop() || share.folder_path;
  return (
    <div
      className="shared-folder-card"
      onClick={() => onOpen(share)}
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpen(share)}
      role="button"
      aria-label={`Open shared folder ${folderName} from ${share.owner_username}`}
    >
      <div className="shared-folder-icon" aria-hidden>📁</div>
      <div className="shared-folder-info">
        <p className="shared-folder-name" title={folderName}>{folderName}</p>
        <p className="shared-folder-owner">
          <span className="shared-owner-avatar">{share.owner_username[0].toUpperCase()}</span>
          {share.owner_username}
        </p>
      </div>
    </div>
  );
}

// ── FilesPage ─────────────────────────────────────────────────────────────────
export default function FilesPage() {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const { toasts, show: showToast } = useToast();

  // ── My-files state ─────────────────────────────────────────────────────────
  const [currentPath, setCurrentPath] = useState('');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [folderName, setFolderName] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [shareTarget, setShareTarget] = useState(null);
  const [selectedPaths, setSelectedPaths] = useState(new Set());
  const [pickerAction, setPickerAction] = useState(null); // 'Copy' | 'Move' | null
  const [renameTarget, setRenameTarget] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  // ── Shared-with-me state ───────────────────────────────────────────────────
  const [viewSection, setViewSection] = useState('my-files'); // 'my-files' | 'shared'
  const [sharedFolders, setSharedFolders] = useState([]);
  const [sharedOwner, setSharedOwner] = useState(null);
  const [sharedBase, setSharedBase] = useState('');
  const [storageInfo, setStorageInfo] = useState(null);

  // ── Search state ───────────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchResults, setSearchResults] = useState(null); // null = not in search mode
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState('');

  const fileInputRef = useRef(null);
  const dragCount = useRef(0);
  const searchRef = useRef(null);

  // Previewable files for modal navigation (regular browsing)
  const mediaFiles = files.filter(f => f.type === 'file' && isPreviewable(f.mimeType, f.name));
  // Modal navigation pool: search results when searching, regular list otherwise
  const modalPool = searchResults
    ? searchResults.filter(f => f.type === 'file' && isPreviewable(f.mimeType, f.name))
    : mediaFiles;

  // ── Shared folders ─────────────────────────────────────────────────────────
  const fetchSharedFolders = useCallback(async () => {
    try {
      const data = await sharesApi.getWithMe();
      setSharedFolders(data.shares);
    } catch { /* silent */ }
  }, []);

  const fetchStorageInfo = useCallback(async () => {
    try {
      const data = await api.get('/files/storage-info');
      setStorageInfo(data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    fetchSharedFolders();
    fetchStorageInfo();
  }, [fetchSharedFolders, fetchStorageInfo]);

  // ── Fetch directory listing ────────────────────────────────────────────────
  const fetchFiles = useCallback(async () => {
    setLoading(true);
    setFetchError('');
    try {
      const ownerParam = sharedOwner ? `&owner=${encodeURIComponent(sharedOwner)}` : '';
      const data = await api.get(`/files?path=${encodeURIComponent(currentPath)}${ownerParam}`);
      setFiles(data.files);
    } catch (err) {
      setFetchError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentPath, sharedOwner]);

  useEffect(() => {
    if (viewSection === 'my-files' || (viewSection === 'shared' && sharedOwner)) {
      fetchFiles();
    }
  }, [fetchFiles, viewSection, sharedOwner]);

  // ── Search ─────────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async (q) => {
    const query = q.trim();
    if (!query) return;
    setSearchQuery(query);
    setSearchLoading(true);
    setSearchError('');
    setSearchResults(null);
    try {
      const data = await searchFiles(query);
      setSearchResults(data.results || []);
    } catch (err) {
      setSearchError(err.message || 'Search failed');
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchInput('');
    setSearchResults(null);
    setSearchError('');
  }, []);

  // ── Navigation ─────────────────────────────────────────────────────────────
  const goToMyFiles = () => {
    setViewSection('my-files');
    setSharedOwner(null);
    setSharedBase('');
    setCurrentPath('');
    setSidebarOpen(false);
    clearSearch();
  };

  const goToShared = () => {
    setViewSection('shared');
    setSharedOwner(null);
    setSharedBase('');
    setCurrentPath('');
    setFiles([]);
    setSidebarOpen(false);
    clearSearch();
    fetchSharedFolders();
  };

  const openSharedFolder = (share) => {
    setSharedOwner(share.owner_username);
    setSharedBase(share.folder_path);
    setCurrentPath(share.folder_path);
  };

  // ── Open file or folder ────────────────────────────────────────────────────
  const handleOpen = (file) => {
    if (file.type === 'directory') {
      setCurrentPath(file.path);
      clearSearch();
      return;
    }
    if (isPreviewable(file.mimeType, file.name)) {
      const pool = searchResults
        ? searchResults.filter(f => f.type === 'file' && isPreviewable(f.mimeType, f.name))
        : mediaFiles;
      const idx = pool.findIndex(f => f.path === file.path);
      setSelectedIdx(Math.max(0, idx));
      setSelectedFile(file);
    } else {
      window.open(
        `/api/files/download?path=${encodeURIComponent(file.path)}${sharedOwner ? `&owner=${encodeURIComponent(sharedOwner)}` : ''}`,
        '_blank'
      );
    }
  };

  // ── Modal navigation ───────────────────────────────────────────────────────
  const goPrev = () => {
    const idx = (selectedIdx - 1 + modalPool.length) % modalPool.length;
    setSelectedIdx(idx); setSelectedFile(modalPool[idx]);
  };
  const goNext = () => {
    const idx = (selectedIdx + 1) % modalPool.length;
    setSelectedIdx(idx); setSelectedFile(modalPool[idx]);
  };

  // ── Drag & drop ────────────────────────────────────────────────────────────
  const onDragEnter = (e) => { e.preventDefault(); if (dragCount.current++ === 0) setIsDragging(true); };
  const onDragLeave = (e) => { e.preventDefault(); if (--dragCount.current === 0) setIsDragging(false); };
  const onDragOver = (e) => e.preventDefault();
  const onDrop = (e) => {
    e.preventDefault(); dragCount.current = 0; setIsDragging(false);
    if (viewSection === 'shared') return;
    const dropped = Array.from(e.dataTransfer.files);
    if (dropped.length) handleUpload(dropped);
  };

  // ── Upload ─────────────────────────────────────────────────────────────────
  const handleUpload = async (filesToUpload) => {
    const baseId = Date.now();
    const items = filesToUpload.map((f, i) => ({
      id: baseId + i, name: f.name, progress: 0, done: false, error: false,
    }));
    setUploads(u => [...u, ...items]);

    let successCount = 0;
    for (let i = 0; i < filesToUpload.length; i++) {
      const uid = baseId + i;
      try {
        await uploadFiles([filesToUpload[i]], currentPath, (pct) => {
          setUploads(u => u.map(x => x.id === uid ? { ...x, progress: pct } : x));
        });
        setUploads(u => u.map(x => x.id === uid ? { ...x, progress: 100, done: true } : x));
        successCount++;
      } catch (err) {
        setUploads(u => u.map(x => x.id === uid ? { ...x, done: true, error: true } : x));
        showToast(`Upload failed: ${filesToUpload[i].name}`, 'error');
      }
    }
    if (successCount > 0) {
      showToast(
        successCount === 1 ? `"${filesToUpload[0].name}" uploaded` : `${successCount} files uploaded`,
        'success'
      );
    }
    setTimeout(() => { setUploads(u => u.filter(x => !x.done)); fetchFiles(); fetchStorageInfo(); }, 1600);
  };

  // ── Delete ─────────────────────────────────────────────────────────────────
  const handleDelete = async (file) => {
    if (!window.confirm(`Delete "${file.name}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/files?path=${encodeURIComponent(file.path)}`);
      showToast(`Deleted "${file.name}"`, 'success');
      if (selectedFile?.path === file.path) setSelectedFile(null);
      fetchFiles();
      fetchStorageInfo();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ── Multi-select callbacks & Bulk operations ──────────────────────────────────
  const handleToggleSelect = useCallback((path) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
  }, []);

  // Clear selections when path, view section, or search results change
  useEffect(() => {
    clearSelection();
  }, [currentPath, viewSection, searchResults, clearSelection]);

  const handleBulkDelete = async () => {
    if (selectedPaths.size === 0) return;
    if (!window.confirm(`Delete ${selectedPaths.size} selected item(s)? This cannot be undone.`)) return;
    try {
      await api.delete('/files', { paths: Array.from(selectedPaths) });
      showToast(`Deleted ${selectedPaths.size} item(s)`, 'success');
      clearSelection();
      fetchFiles();
      fetchStorageInfo();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  const handleBulkDownload = () => {
    if (selectedPaths.size === 0) return;
    const pathsArray = Array.from(selectedPaths);
    const allItems = searchResults !== null ? searchResults : files;
    const selectedItems = allItems.filter(f => selectedPaths.has(f.path));

    if (selectedItems.length === 1 && selectedItems[0].type !== 'directory') {
      window.location.href = getDownloadUrl(selectedItems[0].path, sharedOwner);
    } else {
      const params = pathsArray.map(p => `paths=${encodeURIComponent(p)}`).join('&');
      const o = sharedOwner ? `&owner=${encodeURIComponent(sharedOwner)}` : '';
      window.location.href = `/api/files/download?${params}${o}`;
    }
  };

  const handleFolderPickerSelect = async (targetDir) => {
    const action = pickerAction;
    const endpoint = action === 'Copy' ? '/files/copy' : '/files/move';
    try {
      await api.post(endpoint, {
        paths: Array.from(selectedPaths),
        targetDir
      });
      showToast(`${action} completed successfully`, 'success');
      clearSelection();
      setPickerAction(null);
      fetchFiles();
      fetchStorageInfo();
    } catch (err) {
      showToast(err.message || `${action} failed`, 'error');
    }
  };

  const handleRenameInit = (file) => {
    setRenameTarget(file);
    setRenameValue(file.name);
  };

  const handleRenameSubmit = async () => {
    const newName = renameValue.trim();
    if (!newName || !renameTarget) return;
    try {
      await api.post('/files/rename', {
        path: renameTarget.path,
        newName
      });
      showToast(`Renamed successfully`, 'success');
      setRenameTarget(null);
      setRenameValue('');
      fetchFiles();
    } catch (err) {
      showToast(err.message || 'Rename failed', 'error');
    }
  };

  // ── Create folder ──────────────────────────────────────────────────────────
  const handleCreateFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    const folderPath = currentPath ? `${currentPath}/${name}` : name;
    try {
      await api.post('/files/mkdir', { path: folderPath });
      showToast(`Folder "${name}" created`, 'success');
      setShowNewFolder(false); setFolderName('');
      fetchFiles();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    await api.post('/auth/logout').catch(() => { });
    setUser(null);
    navigate('/login', { replace: true });
  };

  // ── Breadcrumb segments ────────────────────────────────────────────────────
  const mySegments = currentPath ? currentPath.split('/').filter(Boolean) : [];

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div
      className="app-layout"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-hidden />
      )}

      {/* ── Sidebar ────────────────────────────────────────────────────────── */}
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Navigation">
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="sidebar-logo-icon">
              <Cloud size={18} color="white" strokeWidth={2.2} />
            </div>
            <span className="sidebar-logo-name">PersonalCloud</span>
          </div>
        </div>

        <div className="sidebar-user">
          <div className="sidebar-avatar" aria-hidden>
            {user?.username?.[0]?.toUpperCase()}
          </div>
          <p className="sidebar-username">{user?.username}</p>
          <p className="sidebar-label">Personal Storage</p>
        </div>

        <nav className="sidebar-nav">
          <p className="sidebar-section-title">Storage</p>

          <button
            className={`sidebar-nav-item ${viewSection === 'my-files' ? 'active' : ''}`}
            onClick={goToMyFiles}
          >
            <Home size={17} />
            My Files
          </button>

          <button
            className={`sidebar-nav-item ${viewSection === 'shared' ? 'active' : ''}`}
            onClick={goToShared}
            id="shared-with-me-nav"
          >
            <Users size={17} />
            Shared with me
            {sharedFolders.length > 0 && (
              <span className="shared-badge">{sharedFolders.length}</span>
            )}
          </button>

          {storageInfo && (
            <div className="sidebar-storage">
              <p className="sidebar-section-title" style={{ marginTop: 24, paddingLeft: 0 }}>Storage Usage</p>
              <div className="progress-bar" style={{ height: 6, margin: '8px 0' }}>
                <div
                  className="progress-bar-fill"
                  style={{
                    width: `${Math.min(100, (storageInfo.used / storageInfo.total) * 100)}%`,
                    background: (storageInfo.used / storageInfo.total) > 0.9 ? 'var(--error)' : 'var(--accent-grad)',
                  }}
                />
              </div>
              <p className="sidebar-storage-text" style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {formatBytes(storageInfo.used)} of {formatBytes(storageInfo.total)} used
              </p>
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <button
            className="sidebar-nav-item"
            onClick={handleLogout}
            id="logout-btn"
            style={{ width: '100%' }}
          >
            <LogOut size={17} />
            Sign Out
          </button>
        </div>
      </aside>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <div className="main-content">
        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="btn btn-ghost btn-icon menu-toggle"
              onClick={() => setSidebarOpen(o => !o)}
              aria-label="Toggle sidebar"
              aria-expanded={sidebarOpen}
            >
              {sidebarOpen ? <X size={20} /> : <Menu size={20} />}
            </button>

            {/* Breadcrumb — hidden while search is active */}
            {!searchResults && viewSection === 'my-files' && (
              <Breadcrumb
                segments={mySegments}
                onNavigate={(idx) =>
                  setCurrentPath(idx < 0 ? '' : mySegments.slice(0, idx + 1).join('/'))
                }
              />
            )}
            {!searchResults && viewSection === 'shared' && (
              <SharedBreadcrumb
                ownerUsername={sharedOwner}
                currentPath={currentPath}
                basePath={sharedBase}
                onGoSharedRoot={goToShared}
                onNavigate={(path) => setCurrentPath(path)}
              />
            )}
            {searchResults !== null && (
              <span className="search-active-label">
                Results for &ldquo;{searchQuery}&rdquo;
              </span>
            )}
          </div>

          {/* Right-side actions — hidden in shared mode */}
          {viewSection === 'my-files' && (
            <div className="topbar-right">
              {/* ── Search bar ──────────────────────────────────────────────── */}
              <form
                className="search-bar"
                role="search"
                onSubmit={e => { e.preventDefault(); handleSearch(searchInput); }}
              >
                <Search size={15} className="search-bar-icon" aria-hidden />
                <input
                  id="search-input"
                  ref={searchRef}
                  type="search"
                  className="search-bar-input"
                  placeholder="Search files"
                  value={searchInput}
                  onChange={e => {
                    setSearchInput(e.target.value);
                    if (!e.target.value) clearSearch();
                  }}
                  aria-label="Search files by tag"
                />
                {searchInput && (
                  <button
                    type="button"
                    className="search-bar-clear"
                    onClick={clearSearch}
                    aria-label="Clear search"
                  >
                    <X size={13} />
                  </button>
                )}
              </form>

              <button
                id="new-folder-btn"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowNewFolder(true)}
              >
                <FolderPlus size={15} />
                <span className="hide-mobile">New Folder</span>
              </button>
              <button
                id="upload-btn"
                className="btn btn-primary btn-sm"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload size={15} />
                <span className="hide-mobile">Upload</span>
              </button>
              <div className="view-toggle" role="group" aria-label="View mode">
                <button className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => setViewMode('grid')} title="Grid" aria-pressed={viewMode === 'grid'}>
                  <Grid size={15} />
                </button>
                <button className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
                  onClick={() => setViewMode('list')} title="List" aria-pressed={viewMode === 'list'}>
                  <List size={15} />
                </button>
              </div>
            </div>
          )}

          {viewSection === 'shared' && sharedOwner && (
            <div className="topbar-right">
              <div className="shared-read-only-badge">
                <Share2 size={13} /> Read only
              </div>
              <div className="view-toggle" role="group" aria-label="View mode">
                <button className={`view-toggle-btn ${viewMode === 'grid' ? 'active' : ''}`}
                  onClick={() => setViewMode('grid')} title="Grid" aria-pressed={viewMode === 'grid'}>
                  <Grid size={15} />
                </button>
                <button className={`view-toggle-btn ${viewMode === 'list' ? 'active' : ''}`}
                  onClick={() => setViewMode('list')} title="List" aria-pressed={viewMode === 'list'}>
                  <List size={15} />
                </button>
              </div>
            </div>
          )}
        </header>

        {/* Files area */}
        <main className="files-area" id="files-area">

          {/* Master Select Bar */}
          {viewSection === 'my-files' && (searchResults !== null ? searchResults.length > 0 : files.length > 0) && (
            <div className="master-select-bar">
              <input
                type="checkbox"
                id="master-select-checkbox"
                className="master-select-checkbox"
                checked={
                  (searchResults !== null ? searchResults : files).length > 0 &&
                  (searchResults !== null ? searchResults : files).every(f => selectedPaths.has(f.path))
                }
                onChange={() => {
                  const items = searchResults !== null ? searchResults : files;
                  const allSel = items.length > 0 && items.every(f => selectedPaths.has(f.path));
                  if (allSel) {
                    setSelectedPaths(new Set());
                  } else {
                    setSelectedPaths(new Set(items.map(f => f.path)));
                  }
                }}
              />
              <label htmlFor="master-select-checkbox" style={{ cursor: 'pointer', userSelect: 'none' }}>
                Select All
              </label>
            </div>
          )}

          {/* ── Search results view ────────────────────────────────────────── */}
          {searchResults !== null && viewSection === 'my-files' ? (
            searchLoading ? (
              <div className="files-empty"><div className="spinner" /></div>
            ) : searchError ? (
              <div className="files-empty">
                <Search size={48} style={{ opacity: .15 }} />
                <div>
                  <p className="files-empty-title">Search error</p>
                  <p className="files-empty-text">{searchError}</p>
                </div>
              </div>
            ) : searchResults.length === 0 ? (
              <div className="files-empty">
                <Search size={72} aria-hidden style={{ opacity: .15 }} />
                <div>
                  <p className="files-empty-title">No results for &ldquo;{searchQuery}&rdquo;</p>
                  <p className="files-empty-text">
                    Images are tagged nightly. Try again after the next batch run,
                    or check that your images have been processed.
                  </p>
                </div>
              </div>
            ) : (
              <div>
                <p className="search-results-meta">
                  {searchResults.length} result{searchResults.length !== 1 ? 's' : ''} for &ldquo;{searchQuery}&rdquo;
                </p>
                <FileGrid
                  files={searchResults}
                  owner={null}
                  isReadOnly={false}
                  onOpen={handleOpen}
                  onDelete={handleDelete}
                  onShare={setShareTarget}
                  selectedPaths={selectedPaths}
                  onToggleSelect={handleToggleSelect}
                  onRename={handleRenameInit}
                />
              </div>
            )
          ) : (
            /* ── Normal browser / shared view ────────────────────────────── */
            viewSection === 'shared' && !sharedOwner ? (
              sharedFolders.length === 0 ? (
                <div className="files-empty">
                  <Share2 size={72} aria-hidden style={{ opacity: .15 }} />
                  <div>
                    <p className="files-empty-title">Nothing shared with you yet</p>
                    <p className="files-empty-text">When someone shares a folder with you, it will appear here.</p>
                  </div>
                </div>
              ) : (
                <div>
                  <p style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 16 }}>
                    {sharedFolders.length} folder{sharedFolders.length !== 1 ? 's' : ''} shared with you
                  </p>
                  <div className="shared-folders-grid">
                    {sharedFolders.map(share => (
                      <SharedFolderCard
                        key={share.id}
                        share={share}
                        onOpen={openSharedFolder}
                      />
                    ))}
                  </div>
                </div>
              )
            ) : loading ? (
              <div className="files-empty"><div className="spinner" /></div>
            ) : fetchError ? (
              <div className="files-empty">
                <p style={{ color: 'var(--error)', marginBottom: 12 }}>{fetchError}</p>
                <button className="btn btn-secondary btn-sm" onClick={fetchFiles}>Retry</button>
              </div>
            ) : files.length === 0 ? (
              <div className="files-empty">
                <Cloud size={72} aria-hidden />
                <div>
                  <p className="files-empty-title">This folder is empty</p>
                  {viewSection === 'my-files' && (
                    <p className="files-empty-text">Drag files here or click <strong>Upload</strong></p>
                  )}
                </div>
              </div>
            ) : viewMode === 'grid' ? (
              <FileGrid
                files={files}
                owner={sharedOwner}
                isReadOnly={viewSection === 'shared'}
                onOpen={handleOpen}
                onDelete={handleDelete}
                onShare={setShareTarget}
                selectedPaths={selectedPaths}
                onToggleSelect={handleToggleSelect}
                onRename={handleRenameInit}
              />
            ) : (
              <FileList
                files={files}
                owner={sharedOwner}
                isReadOnly={viewSection === 'shared'}
                onOpen={handleOpen}
                onDelete={handleDelete}
                onShare={setShareTarget}
                selectedPaths={selectedPaths}
                onToggleSelect={handleToggleSelect}
                onRename={handleRenameInit}
              />
            )
          )}
        </main>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        aria-hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files);
          if (picked.length) handleUpload(picked);
          e.target.value = '';
        }}
      />

      <UploadDropzone active={isDragging && viewSection === 'my-files'} />

      {/* Upload progress */}
      {uploads.length > 0 && (
        <div className="upload-progress-wrap" aria-live="polite">
          {uploads.length > 5 ? (
            <div className="upload-progress-item">
              <p className="upload-progress-name">
                Uploading {uploads.filter(u => u.done).length < uploads.length ? uploads.filter(u => u.done).length + 1 : uploads.length}/{uploads.length} files
              </p>
              <div className="progress-bar">
                <div className="progress-bar-fill" style={{
                  width: `${Math.round(uploads.reduce((acc, u) => acc + u.progress, 0) / uploads.length)}%`,
                  background: uploads.some(u => u.error) ? 'var(--error)' : undefined,
                }} />
              </div>
              <p className="upload-progress-pct">
                {uploads.every(u => u.done) && uploads.some(u => u.error)
                  ? 'Failed'
                  : uploads.every(u => u.done)
                    ? '✓ Done'
                    : `${Math.round(uploads.reduce((acc, u) => acc + u.progress, 0) / uploads.length)}%`}
              </p>
            </div>
          ) : (
            uploads.map(u => (
              <div key={u.id} className="upload-progress-item">
                <p className="upload-progress-name">{u.name}</p>
                <div className="progress-bar">
                  <div className="progress-bar-fill" style={{
                    width: `${u.progress}%`,
                    background: u.error ? 'var(--error)' : undefined,
                  }} />
                </div>
                <p className="upload-progress-pct">
                  {u.error ? 'Failed' : u.done ? '✓ Done' : `${u.progress}%`}
                </p>
              </div>
            ))
          )}
        </div>
      )}

      {/* Media modal */}
      {selectedFile && (
        <MediaModal
          file={selectedFile}
          files={modalPool}
          currentIndex={selectedIdx}
          owner={sharedOwner}
          onClose={() => setSelectedFile(null)}
          onPrev={goPrev}
          onNext={goNext}
        />
      )}

      {/* New-folder dialog */}
      {showNewFolder && (
        <div
          className="dialog-backdrop"
          onClick={e => e.target === e.currentTarget && setShowNewFolder(false)}
          role="dialog" aria-modal="true" aria-labelledby="new-folder-title"
        >
          <div className="dialog">
            <h2 className="dialog-title" id="new-folder-title">New Folder</h2>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="folder-name-input">Folder name</label>
              <input
                id="folder-name-input"
                type="text"
                className="form-input"
                placeholder="e.g. Photos"
                value={folderName}
                onChange={e => setFolderName(e.target.value)}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreateFolder();
                  if (e.key === 'Escape') setShowNewFolder(false);
                }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => { setShowNewFolder(false); setFolderName(''); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreateFolder} disabled={!folderName.trim()}>Create</button>
            </div>
          </div>
        </div>
      )}

      {/* Share modal */}
      {shareTarget && (
        <ShareModal
          folder={shareTarget}
          onClose={() => setShareTarget(null)}
          onSaved={() => showToast(`"${shareTarget.name}" sharing updated`, 'success')}
        />
      )}

      {/* Toasts */}
      <div className="toast-wrap" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`} role="status">{t.message}</div>
        ))}
      </div>

      {/* Bulk actions floating bar */}
      {selectedPaths.size > 0 && (
        <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
          <span className="bulk-action-count">{selectedPaths.size} selected</span>
          <div className="bulk-actions-group">
            <button className="btn btn-secondary btn-sm" onClick={handleBulkDownload} title="Download Selected">
              <Download size={14} /> Download
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPickerAction('Copy')} title="Copy Selected">
              <Copy size={14} /> Copy
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPickerAction('Move')} title="Move Selected">
              <Move size={14} /> Move
            </button>
            <button className="btn btn-secondary btn-sm danger" onClick={handleBulkDelete} title="Delete Selected">
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </div>
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <div
          className="dialog-backdrop"
          onClick={e => e.target === e.currentTarget && setRenameTarget(null)}
          role="dialog" aria-modal="true" aria-labelledby="rename-title"
        >
          <div className="dialog">
            <h2 className="dialog-title" id="rename-title">Rename</h2>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label className="form-label" htmlFor="rename-input">New name</label>
              <input
                id="rename-input"
                type="text"
                className="form-input"
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleRenameSubmit();
                  if (e.key === 'Escape') setRenameTarget(null);
                }}
              />
            </div>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={() => { setRenameTarget(null); setRenameValue(''); }}>Cancel</button>
              <button className="btn btn-primary" onClick={handleRenameSubmit} disabled={!renameValue.trim() || renameValue.trim() === renameTarget.name}>Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* Folder picker dialog */}
      {pickerAction && (
        <FolderPicker
          actionName={pickerAction}
          onClose={() => setPickerAction(null)}
          onSelect={handleFolderPickerSelect}
        />
      )}
    </div>
  );
}

// ── SharedBreadcrumb ──────────────────────────────────────────────────────────
function SharedBreadcrumb({ ownerUsername, currentPath, basePath, onGoSharedRoot, onNavigate }) {
  if (!ownerUsername) {
    return (
      <nav className="breadcrumb">
        <div className="breadcrumb-item">
          <button className="breadcrumb-btn" onClick={onGoSharedRoot}>
            <Users size={15} /> Shared with me
          </button>
        </div>
      </nav>
    );
  }

  const relPath = currentPath.startsWith(basePath)
    ? currentPath.slice(basePath.length).replace(/^\//, '')
    : '';
  const relSegments = relPath ? relPath.split('/').filter(Boolean) : [];

  return (
    <nav className="breadcrumb">
      <div className="breadcrumb-item">
        <button className="breadcrumb-btn" onClick={onGoSharedRoot}>
          <Users size={15} /> Shared
        </button>
      </div>
      <div className="breadcrumb-item">
        <span className="breadcrumb-sep"><ChevronRight size={13} /></span>
        <button className="breadcrumb-btn" onClick={() => onNavigate(basePath)}>
          {ownerUsername}
        </button>
      </div>
      {relSegments.map((seg, i) => (
        <div key={i} className="breadcrumb-item">
          <span className="breadcrumb-sep"><ChevronRight size={13} /></span>
          <button
            className="breadcrumb-btn"
            onClick={() => {
              const p = basePath + '/' + relSegments.slice(0, i + 1).join('/');
              onNavigate(p);
            }}
          >
            {seg}
          </button>
        </div>
      ))}
    </nav>
  );
}
