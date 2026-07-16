'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/**
 * Small self-contained 3-dot (⋮) menu. No dropdown primitive exists in the repo,
 * so this is hand-built: a trigger button plus an absolutely-positioned option
 * list that closes on outside click or Escape.
 */
export function ContextMenu({ items, ariaLabel }: { items: ContextMenuItem[]; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel ?? 'Actions'}
        aria-haspopup="menu"
        aria-expanded={open}
        style={triggerStyle}
      >
        ⋮
      </button>
      {open && (
        <div role="menu" style={menuStyle}>
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              onClick={() => { setOpen(false); item.onClick(); }}
              style={{ ...itemStyle, color: item.danger ? '#c0392b' : '#333' }}
              onMouseEnter={(e) => { (e.currentTarget.style.background = '#f4f4f6'); }}
              onMouseLeave={(e) => { (e.currentTarget.style.background = 'transparent'); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const triggerStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, lineHeight: 1,
  color: '#666', padding: '2px 8px', borderRadius: 4,
};
const menuStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', right: 0, marginTop: 4, minWidth: 200,
  background: '#fff', border: '1px solid #e2e2e6', borderRadius: 8,
  boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 4, zIndex: 50,
};
const itemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
  border: 'none', cursor: 'pointer', fontSize: 14, padding: '9px 12px', borderRadius: 6,
};
