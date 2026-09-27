import React from 'react';

// #808 — the colours the top header paints itself with, in one place.
//
// `TopHeader` builds its band from two theme tokens, each with the pre-token
// fallback chain it has always had: `--gd-header-bg` over `--chrome`, and
// `--gd-header-text` over `#fff` (`lib/themeTokens.ts` sets both from a
// Theme's headerBackground/headerText).
//
// A native <select> in that band is the reason these have to be exported. The
// popup a browser opens for it is painted outside the header's element, from
// the UA's own defaults, so it inherits nothing: a control that sets only
// `color: inherit` gets the header's (white) text on the UA's (white) popup,
// which is what made the language options unreadable. An <option> therefore
// carries the header's colours itself, and reads them from here rather than
// restating them — the same reason `listChrome.ts` exists for a list page.
//
// `GymSelector` and `CenterSelector` style their own options with the
// pre-token pair (`--chrome` / `#fff`), which stays readable under every
// theme; #808 §6 scopes the change to the language selector, so they are left
// exactly as they were and adopting this pair there is a ticket of its own.

/** The header band's own background. */
export const HEADER_BG = 'var(--gd-header-bg, var(--chrome, #1a1a2e))';

/** The header band's own text colour. */
export const HEADER_TEXT = 'var(--gd-header-text, #fff)';

/**
 * An <option> of a <select> that lives in the header: the popup is not inside
 * the header, so it has to be told what the header looks like.
 */
export const headerOptionStyle: React.CSSProperties = {
  background: HEADER_BG,
  color: HEADER_TEXT,
};
