import { Download, Trash2, Share2, Edit2 } from 'lucide-react';
import { getThumbnailUrl, getDownloadUrl } from '../api/client.js';
import { getFileIcon, formatBytes } from './fileUtils.js';
import KebabMenu from './KebabMenu.jsx';

export default function FileGrid({ files, onOpen, onDelete, onShare, isReadOnly, owner, selectedPaths, onToggleSelect, onRename }) {
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
        />
      ))}
    </div>
  );
}

function FileCard({ file, owner, onOpen, onDelete, onShare, isReadOnly, selectedPaths, onToggleSelect, onRename }) {
  const isDir = file.type === 'directory';
  const isSelected = selectedPaths ? selectedPaths.has(file.path) : false;

  // Build kebab menu items based on context
  const menuItems = [];
  if (!isReadOnly) {
    if (!isDir) {
      menuItems.push({
        label: 'Download',
        icon: <Download size={14} />,
        onClick: () => { window.location.href = getDownloadUrl(file.path, owner); },
      });
    }
    if (isDir) {
      menuItems.push({
        label: 'Share',
        icon: <Share2 size={14} />,
        onClick: () => onShare(file),
      });
    }
    menuItems.push({
      label: 'Rename',
      icon: <Edit2 size={14} />,
      onClick: () => onRename(file),
    });
    menuItems.push({ separator: true });
    menuItems.push({
      label: 'Delete',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: () => onDelete(file),
    });
  } else if (!isDir) {
    menuItems.push({
      label: 'Download',
      icon: <Download size={14} />,
      onClick: () => { window.location.href = getDownloadUrl(file.path, owner); },
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

      {/* Thumbnail or icon */}
      <div className="file-card-thumb">
        {!isDir && file.hasThumbnail ? (
          <img
            src={getThumbnailUrl(file.path, owner)}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span role="img" aria-hidden>{getFileIcon(file)}</span>
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

