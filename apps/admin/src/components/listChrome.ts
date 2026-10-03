import React from 'react';

// #724 — the chrome a list draws around its rows, in one place.
//
// Assigned Plans renders through `DataTable`, so its surface, header band and
// row dividers were locked inside that component's private style constants. A
// card list (Training Plans) that has to look like the same screen cannot reuse
// a `<table>`, but it can reuse these: `DataTable` builds its own `<table>`,
// `<th>` and `<td>` styles from them, so the two lists cannot drift apart.

/** The horizontal inset every header cell and every row cell shares. */
export const LIST_PADDING_X = 16;

/** The card the list itself sits on: white, rounded, lightly raised. */
export const listSurfaceStyle: React.CSSProperties = {
  background: 'var(--gd-card-bg, #ffffff)',
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};

/** The header band — the neutral strip the column titles sit on. */
export const listHeaderRowStyle: React.CSSProperties = {
  background: 'var(--gd-app-bg, #f0f0f0)',
  textAlign: 'left',
};

/** A column title's own box: `<th>`'s padding and type. */
export const listHeaderCellStyle: React.CSSProperties = {
  padding: `12px ${LIST_PADDING_X}px`,
  fontWeight: 600,
  fontSize: 15,
};

/** A value's box: the `<td>` half of the same pair, so columns line up. */
export const listCellStyle: React.CSSProperties = {
  padding: `12px ${LIST_PADDING_X}px`,
  fontSize: 15,
};

/** What separates a row from the header band and from the row above it. */
export const listRowDividerStyle: React.CSSProperties = {
  borderTop: '1px solid var(--gd-border, #e5e7eb)',
};

/** The recessed surface an expanded row's content sits on. */
export const listExpandedStyle: React.CSSProperties = {
  background: 'var(--gd-app-bg, #f5f5f5)',
  ...listRowDividerStyle,
};

/**
 * A metadata pill inside a row's name cell — `System`, `Mandatory`.
 *
 * Smaller and quieter than `StatusBadge`, which carries a row's *state* in its
 * own column; these sit on the name itself and only say what kind of row it is.
 * #894 added the second one, so the three pages that draw them (Products,
 * Taxes, Professional Services) read the look from here rather than each
 * restating it — a fourth badge in a fourth page cannot drift from the rest.
 */
export const listNameBadgeStyle: React.CSSProperties = {
  marginLeft: 6,
  fontSize: 11,
  fontWeight: 500,
  color: '#888',
  background: '#f0f0f0',
  borderRadius: 4,
  padding: '1px 5px',
  verticalAlign: 'middle',
};

/**
 * The same pill, in the accent colour a row's *attention-worthy* metadata gets
 * — `Mandatory`.
 *
 * #913: the neutral pill above says "this is what kind of row it is" quietly,
 * which is right for `System` but left `Mandatory` reading as part of the row's
 * chrome. This one changes the two colours and nothing else — it spreads the
 * neutral style, so the sizing, type, padding and radius are the same object's
 * and cannot drift from it — so the hierarchy inside a name cell is visible at
 * a glance without a second pill shape. Amber on a light amber field, which is
 * ~8:1 against its own background and distinct from both the row surface and
 * the grey `System` pill beside it.
 */
export const listNameBadgeAccentStyle: React.CSSProperties = {
  ...listNameBadgeStyle,
  color: '#92400e',
  background: '#fde68a',
};
