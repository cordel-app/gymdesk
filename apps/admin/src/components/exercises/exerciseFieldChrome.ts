import type React from 'react';
import { cardSectionLabelStyle, formValueStyle } from '@/components/formChrome';

/**
 * The chrome the Exercise form draws around its fields — in one place, so the
 * **Edit** view and the **read-only** expanded view are laid out by the same
 * values (#965 §15).
 *
 * `ExerciseEditor` declared all of these privately, and #965 adds a second
 * renderer of the same five sections: the moment two components carry their own
 * copy of a label size or a grid, "the read-only view looks like Edit" becomes
 * something a reviewer has to check by eye. So both import from here.
 *
 * These are deliberately the **editor's existing numbers**, not new ones: the
 * Edit view is unchanged by #965 (its AC says so), and the read-only view is what
 * moves to meet it. The one value that comes from `formChrome.ts` instead is the
 * read-only box itself — `formValueStyle` already carries #929's rule that a
 * value must wear its input's padding, so a field does not jump sideways when
 * `⋮ → Edit` opens.
 */

/**
 * A section heading inside the form — `GENERAL`, `CONFIGURATION`, `MEDIA`. The
 * type comes from `formChrome.ts`; the margin is the editor's, because these
 * headings sit on a `<p>` rather than in a `CardSection`.
 */
export const exerciseSectionLabelStyle: React.CSSProperties = {
  ...cardSectionLabelStyle,
  marginTop: 0,
  marginBottom: 10,
  letterSpacing: '0.06em',
};

/** The label above one field. */
export const exerciseFieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#888',
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

/**
 * A read-only value in the box its `<input>` occupies (#929's `formValueStyle`),
 * with the editor's own `marginBottom: 12` so a column of values keeps the same
 * rhythm as the column of inputs it replaces.
 */
export const exerciseFieldValueStyle: React.CSSProperties = {
  ...formValueStyle,
  padding: '8px 0',
  marginBottom: 12,
};

/** Every section after the first: the editor's own hairline and spacing. */
export const exerciseSubSectionStyle: React.CSSProperties = {
  paddingTop: 16,
  marginTop: 16,
  borderTop: '1px solid var(--gd-card-border, #eee)',
};

/** The two-column field grid GENERAL and CONFIGURATION are laid out on. */
export const exerciseFieldGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0 16px',
};

/** A field that takes the whole width of that grid (Name, Description, Notes). */
export const exerciseFieldWideStyle: React.CSSProperties = { gridColumn: '1 / -1' };

/**
 * The Allowed Result Types grid (#805 §7): columns that reflow with the card
 * width, one comfortable click target per option in the editor — and the same
 * columns, unclickable, in the read-only view.
 */
export const exerciseResultTypeGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: '4px 16px',
};

/** One option on that grid. */
export const exerciseOptionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  padding: '4px 0',
};

/** Image and Video side by side while both fit, stacked below that (#805 §10/§18). */
export const exerciseMediaGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 24,
  alignItems: 'start',
};
