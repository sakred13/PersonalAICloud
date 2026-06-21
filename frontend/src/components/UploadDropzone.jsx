import { Upload } from 'lucide-react';

/**
 * Full-screen drag-over overlay. Activated by setting `active={true}`.
 */
export default function UploadDropzone({ active }) {
  return (
    <div className={`dropzone-overlay ${active ? 'active' : ''}`} aria-hidden={!active}>
      <div className="dropzone-inner">
        <Upload
          size={68}
          style={{ margin: '0 auto', color: 'var(--accent)', filter: 'drop-shadow(0 0 16px rgba(99,102,241,.5))' }}
        />
        <h2>Drop files here</h2>
        <p>Release to upload to the current folder</p>
      </div>
    </div>
  );
}
