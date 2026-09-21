'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** #613: shown but not actionable (e.g. a write action for a read-only role). */
  disabled?: boolean;
  /** Tooltip, typically the read-only hint when `disabled`. */
  title?: string;
}

/**
 * Small self-contained 3-dot (⋮) menu. Uses position:fixed for the dropdown so
 * it escapes any overflow:hidden ancestors (e.g. table with border-radius).
 */
export function ContextMenu({ items, ariaLabel }: { items: ContextMenuItem[]; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
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

  function handleTrigger() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
    setOpen((v) => !v);
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleTrigger}
        aria-label={ariaLabel ?? 'Actions'}
        aria-haspopup="menu"
        aria-expanded={open}
        style={triggerStyle}
      >
        ⋮
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          style={{ ...menuStyle, position: 'fixed', top: pos.top, right: pos.right }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              onClick={() => { if (item.disabled) return; setOpen(false); item.onClick(); }}
              style={{
                ...itemStyle,
                color: item.danger ? '#c0392b' : 'var(--gd-dropdown-text, #111827)',
                ...(item.disabled ? { opacity: 0.45, cursor: 'not-allowed' } : {}),
              }}
              onMouseEnter={(e) => { if (item.disabled) return; (e.currentTarget.style.background = 'var(--gd-dropdown-hover-bg, #f5f5f5)'); }}
              onMouseLeave={(e) => { (e.currentTarget.style.background = 'transparent'); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const triggerStyle: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, lineHeight: 1,
  color: 'var(--gd-text-muted, #6b7280)', padding: '2px 8px', borderRadius: 4,
};
const menuStyle: React.CSSProperties = {
  minWidth: 200,
  background: 'var(--gd-dropdown-bg, #ffffff)', border: '1px solid var(--gd-border, #e5e7eb)', borderRadius: 8,
  boxShadow: '0 6px 20px rgba(0,0,0,0.14)', padding: 4, zIndex: 1000,
};
const itemStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', background: 'transparent',
  border: 'none', cursor: 'pointer', fontSize: 14, padding: '9px 12px', borderRadius: 6,
};
