'use client';

/**
 * #924 stage 5 — one `Label: Value` row for an expanded card's read-only
 * fields.
 *
 * The Assigned Plan card is built from four files and three of them had grown
 * their own copy of this: the same flex row with a 140px label where the
 * Membership Plan card it is meant to mirror uses 200px, so the two cards'
 * values did not line up and neither did the card's own sections with each
 * other. The look lives in `formChrome.ts` (`cardDetailRowStyle` and its pair),
 * which is where a card's chrome is declared (#929); this component is only the
 * markup, so a page spreads nothing and restates nothing.
 *
 * Presentational and entity-free, like `BillingDurationSummary` (#879): the
 * caller decides which rows exist, how each value is formatted and what an
 * unset one reads as. It renders no control — a field a card can write is the
 * form's, behind `⋮ → Edit` (#797).
 */

import React from 'react';
import {
  cardDetailLabelStyle,
  cardDetailRowStyle,
  cardDetailValueStyle,
  formHelpTextStyle,
} from './formChrome';

export function CardDetailRow({ label, value, description }: {
  label: string;
  value: React.ReactNode;
  description?: string;
}) {
  return (
    <div>
      <div style={cardDetailRowStyle}>
        {label && <span style={cardDetailLabelStyle}>{label}</span>}
        <span style={cardDetailValueStyle}>{value}</span>
      </div>
      {description && (
        <div style={{ ...formHelpTextStyle, marginLeft: cardDetailLabelStyle.width as number + 12 }}>
          {description}
        </div>
      )}
    </div>
  );
}
