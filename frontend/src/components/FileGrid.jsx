import { Download, Trash2, Share2, Edit2, Folder, Globe } from 'lucide-react';
import { getThumbnailUrl, getDownloadUrl } from '../api/client.js';
import { getFileIcon, formatBytes } from './fileUtils.js';
import KebabMenu from './KebabMenu.jsx';

export default function FileGrid({
  files,
  onOpen,
  onDelete,
  onShare,
  isReadOnly,
  owner,
  selectedPaths,
  onToggleSelect,
  onRename,
  isPublicShare,
  publicAlias,
  publicToken,
}) {
  return (
    <div className="file-grid" role="list">
      {files.map(file => (
        <FileCard
          key={file.path}
          file={file}
          owner={owner}
          onOpen={onOpen}
          onDelete={onDelete}
          onShare={onShare}
          isReadOnly={isReadOnly}
          selectedPaths={selectedPaths}
          onToggleSelect={onToggleSelect}
          onRename={onRename}
          isPublicShare={isPublicShare}
          publicAlias={publicAlias}
          publicToken={publicToken}
        />
      ))}
    </div>
  );
}

function FileCard({
  file,
  owner,
  onOpen,
  onDelete,
  onShare,
  isReadOnly,
  selectedPaths,
  onToggleSelect,
  onRename,
  isPublicShare,
  publicAlias,
  publicToken,
}) {
  const isDir = file.type === 'directory';
  const isSelected = selectedPaths ? selectedPaths.has(file.path) : false;

  const publicScope = file.isPublic
    ? file.publicAccessScope
    : isPublicShare
      ? (isReadOnly ? 'readonly' : 'full')
      : null;

  // Resolve public or private thumbnail/download URLs
  const thumbUrl = isPublicShare
    ? `/api/public/shares/thumbnail/${publicAlias}?path=${encodeURIComponent(file.path)}${publicToken ? `&token=${encodeURIComponent(publicToken)}` : ''}`
    : getThumbnailUrl(file.path, owner);

  const downloadUrl = isPublicShare
    ? `/api/public/shares/download/${publicAlias}?path=${encodeURIComponent(file.path)}${publicToken ? `&token=${encodeURIComponent(publicToken)}` : ''}`
    : getDownloadUrl(file.path, owner);

  // Build kebab menu items based on context
  const menuItems = [];
  if (!isReadOnly) {
    if (!isDir) {
      menuItems.push({
        label: 'Download',
        icon: <Download size={14} />,
        onClick: () => { window.location.href = downloadUrl; },
      });
    }
    if (isDir && onShare) {
      menuItems.push({
        label: 'Share',
        icon: <Share2 size={14} />,
        onClick: () => onShare(file),
      });
    }
    if (onRename) {
      menuItems.push({
        label: 'Rename',
        icon: <Edit2 size={14} />,
        onClick: () => onRename(file),
      });
    }
    if (onDelete) {
      menuItems.push({ separator: true });
      menuItems.push({
        label: 'Delete',
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: () => onDelete(file),
      });
    }
  } else if (!isDir) {
    menuItems.push({
      label: 'Download',
      icon: <Download size={14} />,
      onClick: () => { window.location.href = downloadUrl; },
    });
  }

  return (
    <article
      className={`file-card ${isSelected ? 'selected' : ''}`}
      role="listitem"
      onClick={() => onOpen(file)}
      title={file.name}
      tabIndex={0}
      onKeyDown={e => e.key === 'Enter' && onOpen(file)}
      aria-label={`${isDir ? 'Folder' : 'File'}: ${file.name}`}
    >
      {/* Selection checkbox */}
      {!isReadOnly && onToggleSelect && (
        <div className="file-card-checkbox-container" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            className={`file-card-checkbox ${isSelected ? 'checked' : ''}`}
            checked={isSelected}
            onChange={() => onToggleSelect(file.path)}
            aria-label={`Select ${file.name}`}
          />
        </div>
      )}

      {/* Thumbnail or folder icon */}
      <div className="file-card-thumb">
        {!isDir && file.hasThumbnail ? (
          <img
            src={thumbUrl}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : isDir ? (
          <div className={`folder-icon-container ${publicScope ? 'public ' + publicScope : ''}`}>
            <Folder size={48} />
            {publicScope && (
              <span className="folder-badge-globe">
                <Globe size={12} />
              </span>
            )}
          </div>
        ) : (
          <span role="img" aria-hidden>{getFileIcon(file)}</span>
        )}

        {isDir && publicScope && (
          <div className={`public-badge-card ${publicScope}`}>
            {publicScope === 'full' ? 'Full Access' : 'Read Only'}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="file-card-info">
        <p className="file-card-name">{file.name}</p>
        {!isDir && <p className="file-card-meta">{formatBytes(file.size)}</p>}
      </div>

      {/* Kebab menu — always visible on hover */}
      {menuItems.length > 0 && (
        <div
          className="file-card-kebab"
          onClick={e => e.stopPropagation()}
        >
          <KebabMenu items={menuItems} />
        </div>
      )}
    </article>
  );
}
