'use client';

import React from 'react';
import { LIBRARY_TABS, LibraryTabId } from './goalProfile';

/**
 * #947 §1/§2/§6 — the Nutrition Library's three tabs: Foods, Personal Goals,
 * Nutrition Goals.
 *
 * One component for both libraries (a gym's and Cordel's Base one), so the pair
 * cannot offer different tabs or a different order — which tabs exist is
 * `LIBRARY_TABS` in `goalProfile.ts`, never this JSX. Switching tabs changes the
 * content and the available actions in place; it is deliberately not a route, so
 * the page's own state (a gym's active gym, a list already loaded) survives.
 *
 * The labels stay the page's: it is handed a `label` resolver so each library
 * translates in its own namespace, the way every other shared component here
 * does (#901).
 */
export function LibraryTabs({ active, onChange, label }: {
  active: LibraryTabId;
  onChange: (tab: LibraryTabId) => void;
  label: (key: string) => string;
}) {
  return (
    <div role="tablist" style={tabStripStyle}>
      {LIBRARY_TABS.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            style={selected ? { ...tabStyle, ...activeTabStyle } : tabStyle}
          >
            {label(tab.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

const tabStripStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  marginBottom: 20,
  borderBottom: '1px solid var(--card-border, #e5e7eb)',
};

const tabStyle: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  // The 2px transparent bottom border is what keeps the selected tab from
  // shifting its neighbours by two pixels when it gains its underline.
  borderBottom: '2px solid transparent',
  padding: '8px 14px',
  marginBottom: -1,
  fontSize: 14,
  fontWeight: 500,
  color: 'var(--text-muted, #6b7280)',
  cursor: 'pointer',
};

const activeTabStyle: React.CSSProperties = {
  color: 'var(--gd-text, #111827)',
  fontWeight: 600,
  // Follows the navigation's own accent rather than a colour of its own, so a
  // Theme's palette reaches it (#912).
  borderBottomColor: 'var(--brand, #4b45c6)',
};
