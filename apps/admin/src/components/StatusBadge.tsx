'use client';

import React from 'react';

const COLORS: Record<string, { bg: string; fg: string }> = {
  active:       { bg: '#e6f6ec', fg: '#1e7e40' },
  inactive:     { bg: '#f0f0f0', fg: '#666666' },
  paused:       { bg: '#fff4e0', fg: '#b26a00' },
  cancelled:    { bg: '#fdeaea', fg: '#c0392b' },
  expired:      { bg: '#f3eafd', fg: '#7d3cbd' },
  draft:        { bg: '#eef2f7', fg: '#5a6b7b' },
  deleted:      { bg: '#fdeaea', fg: '#c0392b' },
  invited:      { bg: '#e8f0fe', fg: '#1a56a8' },
  not_enrolled: { bg: '#f0f0f0', fg: '#666666' },
  suspended:    { bg: '#fdeaea', fg: '#c0392b' },
  // #948 §4: an Assigned Personal Goal's progress. Each one reuses a pair already
  // in this map rather than introducing a colour — `achieved` is the green every
  // live row wears, `abandoned` the neutral grey of an inactive one, and
  // `in_progress` the blue-grey `draft` tone, so the three read apart without this
  // component growing a palette of its own.
  in_progress:  { bg: '#eef2f7', fg: '#5a6b7b' },
  achieved:     { bg: '#e6f6ec', fg: '#1e7e40' },
  abandoned:    { bg: '#f0f0f0', fg: '#666666' },
  // Payment request statuses
  pending:      { bg: '#fff4e0', fg: '#b26a00' },
  // #1108 stage 2: a membership awaiting its first payment wears the waiting tone.
  pending_payment: { bg: '#fff4e0', fg: '#b26a00' },
  completed:    { bg: '#e6f6ec', fg: '#1e7e40' },
  failed:       { bg: '#fdeaea', fg: '#c0392b' },
  // #1238: Access Rights
  granted:      { bg: '#e6f6ec', fg: '#1e7e40' },
  to_be_reviewed: { bg: '#fff4e0', fg: '#b26a00' },
  revoked:      { bg: '#fdeaea', fg: '#c0392b' },
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
