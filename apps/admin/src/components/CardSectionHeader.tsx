'use client';

import React from 'react';
import { cardSectionLabelStyle } from './formChrome';

/**
 * #963 — the one subsection header of a configuration card: its title, then its
 * contextual actions **immediately after it**.
 *
 * The Membership Plan card and the Promotion card each had their own header row,
 * and both pushed the action to the far edge with `justifyContent:
 * 'space-between'`:
 *
 * ```text
 * BILLING & DURATION                                      [ Edit ]
 * ```
 *
 * On a wide screen that is a full card's width of empty space between a section
 * and the button that edits it, so the action reads as belonging to the card
 * rather than to the section above the hairline. It now sits beside the title:
 *
 * ```text
 * BILLING & DURATION   [ Edit ]
 * ```
 *
 * Two properties are the rule rather than the implementation:
 *
 * * **The title always comes first.** It is a child of this component and not a
 *   slot, so no caller can render an action before the name of the section it
 *   acts on.
 * * **The row wraps.** The actions drop under the title at phone width instead
 *   of overflowing the card sideways, which is what `space-between` on a narrow
 *   card used to do to a two-button pair.
 *
 * It is presentational in `BillingDurationSummary`'s sense (#879): it resolves
 * no locale key, names no endpoint and decides no permission. *Whether* a
 * section carries an action at all is the card's decision — a read-only expanded
 * card passes none, because the button must be absent rather than disabled
 * outside Edit mode (#897) — and *which* action it is stays the page's, since
 * one section's is `Edit` and the same section's, while its editor is open, is
 * the Save/Cancel pair.
 *
 * The title's own look is `formChrome.ts`'s section heading (#929), not a fourth
 * spelling of 11px/700/uppercase: the only thing this module adds is the row.
 */

/** The header row: title first, actions beside it, wrapping under it if narrow. */
export const cardSectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  marginBottom: 8,
};

/**
 * The title inside that row. `cardSectionLabelStyle` carries the spacing below a
 * header that stands alone; here the row owns it, so the margin is dropped and
 * nothing else about the heading changes.
 */
export const cardSectionTitleStyle: React.CSSProperties = {
  ...cardSectionLabelStyle,
  marginBottom: 0,
};

/** The group an action — or a Save/Cancel pair — sits in. */
export const cardSectionActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 8,
};

export function CardSectionHeader({
  title,
  actions,
}: {
  title: string;
  actions?: React.ReactNode;
}) {
  return (
    <div style={cardSectionHeaderStyle}>
      <span style={cardSectionTitleStyle}>{title}</span>
      {actions ? <span style={cardSectionActionsStyle}>{actions}</span> : null}
    </div>
  );
}
