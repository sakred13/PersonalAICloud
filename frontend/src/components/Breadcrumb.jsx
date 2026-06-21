import { Home, ChevronRight } from 'lucide-react';

/**
 * @param {string[]} segments  - folder names in the current path
 * @param {(idx: number) => void} onNavigate  - idx=-1 means root
 */
export default function Breadcrumb({ segments, onNavigate }) {
  return (
    <nav className="breadcrumb" aria-label="Current path">
      <div className="breadcrumb-item">
        <button
          className="breadcrumb-btn"
          onClick={() => onNavigate(-1)}
          title="My Files (home)"
          aria-label="Go to root"
        >
          <Home size={15} />
        </button>
      </div>

      {segments.map((seg, i) => (
        <div key={i} className="breadcrumb-item">
          <span className="breadcrumb-sep" aria-hidden>
            <ChevronRight size={13} />
          </span>
          <button
            className="breadcrumb-btn"
            onClick={() => onNavigate(i)}
            title={seg}
          >
            {seg}
          </button>
        </div>
      ))}
    </nav>
  );
}
