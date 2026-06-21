import { useEffect, useRef, useState } from 'react';
import { MoreVertical } from 'lucide-react';

/**
 * Reusable three-dot kebab menu.
 *
 * items: Array<{
 *   label: string,
 *   icon?: ReactNode,
 *   onClick: () => void,
 *   danger?: boolean,
 *   separator?: boolean,  // renders a divider instead of a button
 * }>
 */
export default function KebabMenu({ items, onOpen }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (!open && onOpen) onOpen();
    setOpen(o => !o);
  };

  return (
    <div ref={ref} className="kebab-wrap" onClick={e => e.stopPropagation()}>
      <button
        className="kebab-btn"
        onClick={toggle}
        aria-label="More options"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <MoreVertical size={15} />
      </button>

      {open && (
        <div className="kebab-menu" role="menu">
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="kebab-sep" role="separator" />
            ) : (
              <button
                key={i}
                role="menuitem"
                className={`kebab-item${item.danger ? ' danger' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick();
                }}
              >
                {item.icon && <span className="kebab-item-icon" aria-hidden>{item.icon}</span>}
                {item.label}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
