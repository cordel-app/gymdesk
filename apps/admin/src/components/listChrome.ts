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

// The three surfaces a list paints, named so #1011's responsive sheet can read
// them rather than respell them: a cell pinned over a scrolling row has to be
// exactly the white the row already is.
/** The list card's own surface. */
export const LIST_SURFACE_BACKGROUND = 'var(--gd-card-bg, #ffffff)';
/** The header band behind the column titles. */
export const LIST_HEADER_BACKGROUND = 'var(--gd-app-bg, #f0f0f0)';
/** The hairline between rows, and between a pinned cell and what scrolls under it. */
export const LIST_DIVIDER_COLOR = 'var(--gd-border, #e5e7eb)';

/** The card the list itself sits on: white, rounded, lightly raised. */
export const listSurfaceStyle: React.CSSProperties = {
  background: LIST_SURFACE_BACKGROUND,
  borderRadius: 8,
  overflow: 'hidden',
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};

/** The header band — the neutral strip the column titles sit on. */
export const listHeaderRowStyle: React.CSSProperties = {
  background: LIST_HEADER_BACKGROUND,
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
  borderTop: `1px solid ${LIST_DIVIDER_COLOR}`,
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

// ---------------------------------------------------------------------------
// #1011 — the mobile half of a list.
//
// A list row is a grid of inline-styled cells sized for a desktop window. On a
// phone the fixed cells cannot shrink, so flexbox (or a table's auto layout)
// takes the one cell that *can* — the name — to zero and overflows the rest off
// the right edge, carrying the `⋮` with it. The fix is one declaration per
// column saying what that column is on a phone, plus the CSS that reads it.
//
// Two shapes, because the lists are two shapes:
//
//   * `collapse` — the row expands (or carries `⋮ → Details`), so a secondary
//     column is *hidden* below the breakpoint and its value is one tap away.
//   * `scroll` — the row expands into nothing, so hiding a column would make it
//     unreachable on a phone rather than one tap away (#1011 `Q2 scroll`). Every
//     column stays, the block between the name and the actions scrolls inside
//     the list, and those two cells are pinned to the edges so identifying a row
//     and reaching its actions never needs a scroll.
//
// Neither shape scrolls the *page* horizontally: the scroll lives in the list's
// own wrapper. Above the breakpoint none of these rules exist, so desktop and
// tablet are exactly what they were (§4).
//
// That choice is about the *secondary* columns. How the row itself is laid out
// is the other axis, and there are two of those too: a `<table>`, whose cells a
// phone can simply hide, and the CSS grid a page builds from its own
// `LIST_COLUMNS` declaration (#637), whose tracks live on the row — hiding one
// of those cells would leave its track behind and slide every cell after it
// under the wrong title, so below the breakpoint that row becomes a flex line
// instead (`LIST_GRID_ROW_CLASS`). Both read the same per-column vocabulary.

/**
 * Mirrors `AppShell`'s own mobile breakpoint (its CSS splits at 768/769px), the
 * way `lib/sidebarCollapse.ts` mirrors it for the sidebar (#1003) — never a
 * second number.
 */
export const LIST_MOBILE_MEDIA_QUERY = '(max-width: 768px)';

/**
 * What a column is below that breakpoint.
 *
 * `name` is the row's identity — the one column that is never hidden, only
 * truncated, with its full value in the cell's `title`. `keep` is the primary
 * status beside it. `actions` is the chevron / `⋮` / button cell. Everything
 * else is `secondary`, which is the default: a column that says nothing about
 * what a column is on a phone is not a column a phone has room for.
 */
export type ListColumnMobile = 'name' | 'keep' | 'actions' | 'secondary';

/** What happens to the secondary columns of a given list. */
export type ListMobileSecondary = 'collapse' | 'scroll';

export const LIST_SCROLLER_CLASS = 'gd-list-scroller';
export const LIST_MOBILE_COLLAPSE_CLASS = 'gd-list-mobile-collapse';
export const LIST_MOBILE_SCROLL_CLASS = 'gd-list-mobile-scroll';
export const LIST_NAME_CELL_CLASS = 'gd-list-cell-name';
/** The block inside a name cell that the truncation is applied to. */
export const LIST_NAME_VALUE_CLASS = 'gd-list-name-value';
export const LIST_ACTIONS_CELL_CLASS = 'gd-list-cell-actions';
export const LIST_SECONDARY_CELL_CLASS = 'gd-list-cell-secondary';
/**
 * The row of a grid list — the header band and every collapsed row of a page
 * laid out from its own `LIST_COLUMNS` declaration (#637's shape: Products,
 * Members, Training Plans).
 *
 * Such a row cannot simply hide a cell the way a `<table>` can: the tracks are
 * declared on the row, so a hidden cell leaves its track behind and every cell
 * after it slides one column left of its own title. Below the breakpoint the
 * row therefore stops being a grid at all and becomes a flex line of the cells
 * that survive, where hiding one costs nothing.
 */
export const LIST_GRID_ROW_CLASS = 'gd-list-grid-row';
/**
 * The block a grid list pins to `LIST_MIN_WIDTH` — the sum of its tracks, which
 * is what makes the list scroll rather than squeeze a column (#637). Below the
 * breakpoint the row carries only the columns a phone has room for, so that
 * minimum is released and nothing scrolls.
 */
export const LIST_MIN_WIDTH_CLASS = 'gd-list-min-width';

/** The class a header cell and its row cells share, from the column's own declaration. */
export function listCellClass(mobile: ListColumnMobile = 'secondary'): string {
  switch (mobile) {
    case 'name': return LIST_NAME_CELL_CLASS;
    case 'actions': return LIST_ACTIONS_CELL_CLASS;
    // A kept column needs no class: it is simply not hidden.
    case 'keep': return '';
    case 'secondary': return LIST_SECONDARY_CELL_CLASS;
  }
}

/** A column of a grid list: its own key, and what it is on a phone. */
export interface ListGridColumn {
  key: string;
  mobile: ListColumnMobile;
}

/**
 * The cell class of each column of a grid list, keyed by the column's own key.
 *
 * A grid page writes its cells by hand rather than mapping over its columns, so
 * this is how a cell reaches its column's declaration: `CELL_CLASS.status` on
 * both the header cell and the row cell, never a class spelled in the page.
 */
export function listCellClasses(columns: readonly ListGridColumn[]): Record<string, string> {
  return Object.fromEntries(columns.map((c) => [c.key, listCellClass(c.mobile)]));
}

/** The class pair the list's own wrapper carries. */
export function listScrollerClass(secondary: ListMobileSecondary): string {
  const mode = secondary === 'scroll' ? LIST_MOBILE_SCROLL_CLASS : LIST_MOBILE_COLLAPSE_CLASS;
  return `${LIST_SCROLLER_CLASS} ${mode}`;
}

/**
 * The stylesheet those classes mean, rendered once by `AppShell` through
 * `ListResponsiveStyles` — a global sheet rather than a style object, because
 * every cell in these lists is inline-styled and only `!important` in a
 * stylesheet wins over an inline `display`.
 *
 * The three surfaces are read from the constants above rather than respelled, so
 * a pinned cell cannot end up a different white from the row it is part of.
 */
export const LIST_RESPONSIVE_CSS = `
@media ${LIST_MOBILE_MEDIA_QUERY} {
  /* Whatever is left over scrolls inside the list, never as a page-wide
     horizontal scroll (§3). */
  .${LIST_SCROLLER_CLASS} {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  /* The row's identity: truncated, never hidden, never squeezed to zero. */
  .${LIST_NAME_VALUE_CLASS} {
    display: block;
    max-width: 60vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .${LIST_NAME_VALUE_CLASS} > * {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* collapse — the secondary columns are read in the expanded row instead. */
  .${LIST_MOBILE_COLLAPSE_CLASS} .${LIST_SECONDARY_CELL_CLASS} {
    display: none !important;
  }

  /* A grid list's row, laid out from its own LIST_COLUMNS declaration: below
     the breakpoint it is a flex line rather than a grid, so a hidden cell takes
     its track with it instead of pushing the rest out of line. The identity
     takes whatever width is left, the actions stay at the end. */
  .${LIST_GRID_ROW_CLASS} {
    display: flex !important;
    flex-wrap: nowrap;
  }
  .${LIST_GRID_ROW_CLASS} > .${LIST_NAME_CELL_CLASS} {
    flex: 1 1 auto;
    min-width: 0;
  }
  .${LIST_GRID_ROW_CLASS} > .${LIST_ACTIONS_CELL_CLASS} {
    flex: 0 0 auto;
    margin-left: auto;
  }
  /* …so the track sum that makes it scroll on a desktop window is released. */
  .${LIST_MIN_WIDTH_CLASS} {
    min-width: 0 !important;
  }

  /* scroll — every column stays; the name and the actions are pinned to the
     edges and the block between them scrolls. */
  .${LIST_MOBILE_SCROLL_CLASS} > table {
    width: auto !important;
    min-width: 100%;
  }
  .${LIST_MOBILE_SCROLL_CLASS} .${LIST_NAME_CELL_CLASS},
  .${LIST_MOBILE_SCROLL_CLASS} .${LIST_ACTIONS_CELL_CLASS} {
    position: sticky;
    z-index: 1;
    background: ${LIST_SURFACE_BACKGROUND};
  }
  .${LIST_MOBILE_SCROLL_CLASS} thead .${LIST_NAME_CELL_CLASS},
  .${LIST_MOBILE_SCROLL_CLASS} thead .${LIST_ACTIONS_CELL_CLASS} {
    background: ${LIST_HEADER_BACKGROUND};
    z-index: 2;
  }
  .${LIST_MOBILE_SCROLL_CLASS} .${LIST_NAME_CELL_CLASS} {
    left: 0;
    box-shadow: 1px 0 0 ${LIST_DIVIDER_COLOR};
  }
  .${LIST_MOBILE_SCROLL_CLASS} .${LIST_NAME_VALUE_CLASS} {
    max-width: 40vw;
  }
  .${LIST_MOBILE_SCROLL_CLASS} .${LIST_ACTIONS_CELL_CLASS} {
    right: 0;
    /* A desktop actions column declares a width wide enough for its buttons in a
       row; pinned on a phone it takes what it needs and wraps. */
    width: auto !important;
    max-width: 40vw;
    box-shadow: -1px 0 0 ${LIST_DIVIDER_COLOR};
  }
}
`;
