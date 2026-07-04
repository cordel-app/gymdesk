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
}

export function StatusFilter({ value, onChange, options, allLabel }: StatusFilterProps) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '8px 12px',
        borderRadius: 6,
        border: '1px solid #ccc',
        fontSize: 14,
        background: '#fff',
        cursor: 'pointer',
      }}
    >
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}
