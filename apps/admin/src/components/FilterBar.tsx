'use client';

import React from 'react';

// #724 — the labelled filter bar Assigned Plans introduced (#411), extracted so
// every list can wear it. The shape is "label above the control", the controls
// wrap on a narrow viewport instead of overflowing, and a `Clear filters`
// button sits at the end of the same row.

/** The control every filter uses: one height, one border, one type size. */
export const filterControlStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--gd-input-border, #d1d5db)',
  borderRadius: 6,
  fontSize: 13,
  background: 'var(--gd-input-bg, #ffffff)',
};

/** The label that sits above it. */
export const filterLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--gd-text-muted, #6b7280)',
  marginBottom: 4,
};

/** A secondary button sized to line up with the controls (e.g. Clear). */
export const filterButtonStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 13,
  cursor: 'pointer',
  border: '1px solid var(--gd-input-border, #d1d5db)',
  borderRadius: 6,
  background: 'var(--gd-input-bg, #ffffff)',
  alignSelf: 'flex-end',
};

/** The row the fields sit in: horizontal on desktop, wrapping below it. */
export function FilterBar({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 16, alignItems: 'flex-end' }}>
      {children}
    </div>
  );
}

/** One filter: its label, then its control. */
export function FilterField({
  label, htmlFor, children,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} style={filterLabelStyle}>{label}</label>
      {children}
    </div>
  );
}
