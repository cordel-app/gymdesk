'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
  /**
   * #969 §5: a searchable option list. Passing a placeholder renders the search
   * box pinned above the (scrolling) options; omitting it leaves the control
   * exactly as #350 built it.
   */
  searchPlaceholder?: string;
  /**
   * Extra controls at the foot of the panel, above `Clear` — #969 §6/§7's
   * `Match: Any/All` and `Role: Any/Primary/Secondary`, which qualify the
   * checked values rather than being values of their own.
   */
  footer?: React.ReactNode;
  /** Spread over the trigger, for a filter bar that sets its own control
   *  height (`filterControlStyle`). Omit it and nothing moves. */
  style?: React.CSSProperties;
  clearLabel?: string;
  emptyLabel?: string;
  id?: string;
}

/**
 * Excel-like multi-select checkbox filter dropdown (#350). Values within one
 * filter are combined with OR semantics by the caller (the API applies the
 * actual OR/AND logic); this component only tracks which values are checked —
 * and, since #969, renders the caller's own qualifiers beside them.
 */
export function MultiSelectFilter({
  label, options, selected, onChange,
  searchPlaceholder, footer, style, clearLabel = 'Clear', emptyLabel = '—', id,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  }

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return options;
    return options.filter((opt) => opt.label.toLowerCase().includes(needle)
      || opt.value.toLowerCase().includes(needle));
  }, [options, search]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button id={id} type="button" onClick={() => setOpen((o) => !o)} style={triggerStyle(selected.length > 0, style)}>
        {label}
        {selected.length > 0 && <span style={countBadgeStyle}>{selected.length}</span>}
        <span style={{ fontSize: 10, marginLeft: 4 }}>▾</span>
      </button>
      {open && (
        <div style={panelStyle}>
          {searchPlaceholder && (
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              style={searchStyle}
            />
          )}
          {/* The list is what scrolls, so a pinned search box and the footer
              stay reachable however long the catalogue is (§5). */}
          <div style={optionsStyle}>
            {shown.length === 0 ? (
              <div style={{ padding: '8px 12px', fontSize: 13, color: 'var(--gd-text-muted, #6b7280)' }}>{emptyLabel}</div>
            ) : (
              shown.map((opt) => (
                <label key={opt.value} style={optionRowStyle}>
                  <input
                    type="checkbox"
                    checked={selected.includes(opt.value)}
                    onChange={() => toggle(opt.value)}
                    style={{ marginRight: 8 }}
                  />
                  {opt.label}
                </label>
              ))
            )}
          </div>
          {footer}
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])} style={clearRowStyle}>
              {clearLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const triggerStyle = (active: boolean, override?: React.CSSProperties): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '8px 12px', borderRadius: 6,
  border: `1px solid ${active ? 'var(--brand, #6c63ff)' : 'var(--gd-input-border, #d1d5db)'}`,
  background: 'var(--gd-input-bg, #ffffff)', fontSize: 14, cursor: 'pointer',
  color: active ? 'var(--brand, #6c63ff)' : 'var(--gd-text-secondary, #374151)',
  ...override,
  // The active state is the control's own signal and must survive a caller's
  // geometry override, which is why these two come after it.
  ...(active ? { borderColor: 'var(--brand, #6c63ff)', color: 'var(--brand, #6c63ff)' } : null),
});

const countBadgeStyle: React.CSSProperties = {
  background: 'var(--brand, #6c63ff)', color: '#fff', borderRadius: 10,
  padding: '1px 7px', fontSize: 11, fontWeight: 600,
};

const panelStyle: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
  background: 'var(--gd-dropdown-bg, #ffffff)', border: '1px solid var(--gd-border, #e5e7eb)', borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 6, minWidth: 200,
  display: 'flex', flexDirection: 'column', maxHeight: 320,
};

const searchStyle: React.CSSProperties = {
  margin: '2px 2px 6px', padding: '6px 8px', fontSize: 13,
  border: '1px solid var(--gd-input-border, #d1d5db)', borderRadius: 6,
  background: 'var(--gd-input-bg, #ffffff)',
};

const optionsStyle: React.CSSProperties = {
  overflowY: 'auto',
  flex: '0 1 auto',
};

const optionRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '7px 8px', borderRadius: 6,
  fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap',
};

const clearRowStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', marginTop: 4,
  padding: '7px 8px', borderRadius: 6, border: 'none', borderTop: '1px solid var(--gd-border, #e5e7eb)',
  background: 'none', color: '#c0392b', fontSize: 13, cursor: 'pointer',
};
