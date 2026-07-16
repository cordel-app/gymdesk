'use client';

import React from 'react';

const COLORS: Record<string, { bg: string; fg: string }> = {
  active:    { bg: '#e6f6ec', fg: '#1e7e40' },
  inactive:  { bg: '#f0f0f0', fg: '#666666' },
  paused:    { bg: '#fff4e0', fg: '#b26a00' },
  cancelled: { bg: '#fdeaea', fg: '#c0392b' },
  expired:   { bg: '#f3eafd', fg: '#7d3cbd' },
  draft:     { bg: '#eef2f7', fg: '#5a6b7b' },
  deleted:   { bg: '#fdeaea', fg: '#c0392b' },
};

const DEFAULT = { bg: '#f0f0f0', fg: '#666666' };

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const c = COLORS[status] ?? DEFAULT;
  return (
    <span style={{
      background: c.bg,
      color: c.fg,
      borderRadius: 999,
      padding: '3px 10px',
      fontSize: 13,
      fontWeight: 600,
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}
