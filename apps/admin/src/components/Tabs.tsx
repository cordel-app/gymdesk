'use client';

import React, { useRef } from 'react';

/**
 * The admin app's tab strip — one component, for every screen that has tabs.
 *
 * #947 introduced it as the Nutrition Library's `LibraryTabs`; #961 needed the
 * same strip inside the Member card and promoted it here rather than drawing a
 * second one, so the app has one tab look and one set of tab semantics. A
 * consumer supplies *what* the tabs are and how to translate them; this module
 * owns only how they look and how they behave.
 *
 * Three of its properties are the rule rather than the implementation:
 *
 * * **It resolves no label.** Each page hands in a `label` resolver so the
 *   words come from that page's own namespace (#901), which is what lets the
 *   two libraries and the Member card share one strip.
 * * **It declares no colour of its own.** Every value is a Theme variable with
 *   a literal only as the `var()` fallback for the frames before
 *   `applyTokens()` has run, and the active tab follows the navigation accent
 *   (#912) instead of a hue picked here.
 * * **It scrolls rather than wraps.** At phone width the strip scrolls
 *   horizontally and each tab keeps its label on one line, so a long label
 *   never breaks the layout or the card's grid (#961 "Responsive behaviour").
 *
 * Keyboard support is the `tablist` pattern: ← → move between tabs, Home/End
 * jump to the ends, and the arrow keys move the selection as they move focus.
 */
export interface TabDescriptor<Id extends string> {
  id: Id;
  /** Resolved through `label`, never spelled in this module. */
  labelKey: string;
}

export function Tabs<Id extends string>({ tabs, active, onChange, label, ariaLabel }: {
  tabs: readonly TabDescriptor<Id>[];
  active: Id;
  onChange: (tab: Id) => void;
  label: (key: string) => string;
  ariaLabel?: string;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  function focusTab(index: number) {
    const buttons = stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[index]?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(tabs[next].id);
    focusTab(next);
  }

  return (
    <div role="tablist" aria-label={ariaLabel} ref={stripRef} style={tabStripStyle}>
      {tabs.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, index)}
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
  // A strip too wide for the screen scrolls; it never wraps into a second row
  // that would push the card's content down (#961).
  overflowX: 'auto',
  flexWrap: 'nowrap',
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
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const activeTabStyle: React.CSSProperties = {
  color: 'var(--gd-text, #111827)',
  fontWeight: 600,
  // Follows the navigation's own accent rather than a colour of its own, so a
  // Theme's palette reaches it (#912).
  borderBottomColor: 'var(--brand, #4b45c6)',
};
