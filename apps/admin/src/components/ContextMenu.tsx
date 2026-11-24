'use client';

import React, { useEffect, useRef, useState } from 'react';
import { alertTextColor } from './formChrome';

/**
 * #3347: the three actions every menu places by convention — Edit first,
 * Delete penultimate, Details last. Every other item leaves `kind` unset and
 * keeps its relative order between them.
 */
export type ContextMenuItemKind = 'edit' | 'delete' | 'details';

export interface ContextMenuItem {
  label: string;
  /** #3347: which standard action this is; the menu orders by it. */
  kind?: ContextMenuItemKind;
  onClick: () => void;
  danger?: boolean;
  /** #613: shown but not actionable (e.g. a write action for a read-only role). */
  disabled?: boolean;
  /** Tooltip, typically the read-only hint when `disabled`. */
  title?: string;
}

const KIND_RANK: Record<ContextMenuItemKind | 'other', number> = {
  edit: 0, other: 1, delete: 2, details: 3,
};

/**
 * #3347: the one ordering rule for every ⋮ menu — Edit, the other actions in
 * the order the page declared them, Delete, Details. Stable, so items of one
 * rank keep their declared order. Visibility and `disabled` stay the caller's.
 */
export function orderContextMenuItems<T extends Pick<ContextMenuItem, 'kind'>>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      KIND_RANK[a.item.kind ?? 'other'] - KIND_RANK[b.item.kind ?? 'other'] || a.index - b.index)
    .map(({ item }) => item);
}

/**
 * Small self-contained 3-dot (⋮) menu. Uses position:fixed for the dropdown so
 * it escapes any overflow:hidden ancestors (e.g. table with border-radius).
 */
export function ContextMenu({ items, ariaLabel, onOpen }: {
  items: ContextMenuItem[];
  ariaLabel?: string;
  /** Called each time the menu opens — e.g. to re-read state the items depend on (#2680). */
  onOpen?: () => void;
}) {
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
      onOpen?.();
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
          {orderContextMenuItems(items).map((item, i) => (
            <button
              key={i}
              role="menuitem"
              disabled={item.disabled}
              aria-disabled={item.disabled || undefined}
              title={item.title}
              onClick={() => { if (item.disabled) return; setOpen(false); item.onClick(); }}
              style={{
                ...itemStyle,
                color: item.danger ? alertTextColor : 'var(--gd-dropdown-text, #111827)',
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
