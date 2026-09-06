'use client';

import React, { useEffect, useRef, useState } from 'react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectFilterProps {
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

/**
 * Excel-like multi-select checkbox filter dropdown (#350). Values within one
 * filter are combined with OR semantics by the caller (the API applies the
 * actual OR/AND logic); this component only tracks which values are checked.
 */
export function MultiSelectFilter({ label, options, selected, onChange }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
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

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={triggerStyle(selected.length > 0)}>
        {label}
        {selected.length > 0 && <span style={countBadgeStyle}>{selected.length}</span>}
        <span style={{ fontSize: 10, marginLeft: 4 }}>▾</span>
      </button>
      {open && (
        <div style={panelStyle}>
          {options.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 13, color: '#888' }}>—</div>
          ) : (
            options.map((opt) => (
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
          {selected.length > 0 && (
            <button type="button" onClick={() => onChange([])} style={clearRowStyle}>
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const triggerStyle = (active: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', gap: 4,
  padding: '8px 12px', borderRadius: 6,
  border: `1px solid ${active ? 'var(--brand, #6c63ff)' : '#ccc'}`,
  background: '#fff', fontSize: 14, cursor: 'pointer',
  color: active ? 'var(--brand, #6c63ff)' : '#333',
});

const countBadgeStyle: React.CSSProperties = {
  background: 'var(--brand, #6c63ff)', color: '#fff', borderRadius: 10,
  padding: '1px 7px', fontSize: 11, fontWeight: 600,
};

const panelStyle: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 20,
  background: '#fff', border: '1px solid #ddd', borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: 6, minWidth: 200,
  maxHeight: 280, overflowY: 'auto',
};

const optionRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', padding: '7px 8px', borderRadius: 6,
  fontSize: 14, cursor: 'pointer', whiteSpace: 'nowrap',
};

const clearRowStyle: React.CSSProperties = {
  display: 'block', width: '100%', textAlign: 'left', marginTop: 4,
  padding: '7px 8px', borderRadius: 6, border: 'none', borderTop: '1px solid #eee',
  background: 'none', color: '#c0392b', fontSize: 13, cursor: 'pointer',
};
