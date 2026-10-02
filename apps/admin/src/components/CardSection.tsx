'use client';

/**
 * #924 stage 5 — one section of an expanded card: its heading, the hairline
 * above it, and an optional action beside the heading.
 *
 * The Membership Plan card and the Promotion card have each had their own
 * `SectionHeader` since #627/#816 and the Assigned Plan card had two more, so
 * four files declared the same uppercase label and the same divider with
 * slightly different numbers. The look lives in `formChrome.ts` (#929) —
 * `cardSectionStyle` / `cardSectionDividedStyle` / `cardSectionLabelStyle` — and
 * this component is only the markup.
 *
 * `first` is what decides the hairline: every section but the first is
 * separated from the one above it (#929 §4). It is a property of where the
 * section sits, which is why the card passes it rather than the section
 * deciding for itself.
 *
 * The `action` slot is deliberately a slot and nothing more: the section's
 * `Edit` button is `SectionEditButton` (#901), and whether it exists at all is
 * the card's decision — it must be *absent* outside Edit mode, not disabled
 * (#897). This component makes no permission decision and names no locale key.
 */

import React from 'react';
import {
  cardSectionDividedStyle,
  cardSectionLabelStyle,
  cardSectionStyle,
} from './formChrome';

export function CardSection({ label, action, first = false, children }: {
  label: string;
  action?: React.ReactNode;
  /** True for the card's first section, which carries no hairline above it. */
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={first ? cardSectionStyle : cardSectionDividedStyle}>
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8, ...(action ? { minHeight: 26 } : null),
        }}
      >
        <div style={cardSectionLabelStyle}>{label}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
