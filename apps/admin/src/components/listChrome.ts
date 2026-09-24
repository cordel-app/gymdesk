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
