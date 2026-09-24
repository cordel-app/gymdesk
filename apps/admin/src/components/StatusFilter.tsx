'use client';

import React from 'react';

export interface StatusOption {
  value: string;
  label: string;
}

interface StatusFilterProps {
  value: string;               // '' = all
  onChange: (value: string) => void;
  options: StatusOption[];
  allLabel: string;
  /** #724: spread over the default look, for a page whose filter bar sets its
   *  own control height (e.g. `filterControlStyle`). Omit it and nothing moves. */
  style?: React.CSSProperties;
  id?: string;
}

export function StatusFilter({ value, onChange, options, allLabel, style, id }: StatusFilterProps) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        border: '1px solid var(--gd-input-border, #d1d5db)',
        fontSize: 14,
        background: 'var(--gd-input-bg, #ffffff)',
        cursor: 'pointer',
        ...style,
      }}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
