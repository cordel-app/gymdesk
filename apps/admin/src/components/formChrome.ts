import React from 'react';

// #929 — the chrome a card draws around its *fields*, in one place.
//
// `listChrome.ts` does this for a list's header band, surface and row dividers
// and `headerChrome.ts` for the top header; what neither covered is the inside
// of an expanded card: its section headers, its label/value pairs, its inputs
// and its Save/Cancel pair. Every Member card file had grown its own copy of
// those — nine files declaring `card`, `subLabel`, `labelStyle`, `inputStyle`,
// `saveBtn` and `cancelBtn` with slightly different numbers in each, so one
// section's input was 13px on a 6px radius and the next one's 14px on a 4px
// radius, and a Save button was a hardcoded `#6c63ff` the Theme could not
// reach.
//
// So this module holds the values, and a page spreads them instead of restating
// them. Three of them are deliberately *not* new numbers: the control box, the
// field label and the section header are the ones the Products inline
// form already uses, because that screen is the look & feel the Member card is
// being brought in line with.
//
// Colours come from the Theme's own variables where one exists (`--gd-input-*`,
// `--gd-card-*`, and `primaryActionColors` for a primary action in `ui.tsx`),
// with the pre-token literal as the `var()` fallback for the frames before
// `applyTokens()` has run — never as a second source of truth.

import { cardSurfaceStyle } from './ui';

/** A section header inside a card — `PROFILE`, `MEMBERSHIP PLANS`. */
export const cardSectionLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
  marginBottom: 8,
};

/**
 * A heading one level below that — the sub-grouping inside a section
 * (`ACTIVE`, `INACTIVE`). Quieter than the section header above it, so the
 * hierarchy is readable without a second type size per page.
 */
export const cardSubLabelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#aaa',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 4,
};

/** The space between one section of a card and the next. */
export const cardSectionGap = 20;

/** A card's first section: spacing below it, nothing above it. */
export const cardSectionStyle: React.CSSProperties = {
  marginBottom: cardSectionGap,
};

/**
 * Every section after it (#929 §4): the same spacing, plus the hairline that
 * separates it from the section above — the card's own themed border colour, so
 * a separator inside a card and the card's own edge are one decision.
 */
export const cardSectionDividedStyle: React.CSSProperties = {
  ...cardSectionStyle,
  paddingTop: cardSectionGap,
  borderTop: '1px solid var(--gd-card-border, #e8e8ed)',
};

/** An entity's own card inside a section — a plan, a promotion, a package. */
export const innerCardStyle: React.CSSProperties = {
  ...cardSurfaceStyle,
  padding: '10px 14px',
  marginBottom: 8,
};

/**
 * The box a section-level editor opens in, inside that section. It is the card
 * surface rather than a tint of its own: the expanded body it sits on is
 * already the recessed `listExpandedStyle`, so a second grey only made the
 * editor hard to find — and a tint that is not a Theme variable goes dark-on-
 * dark the moment a gym themes its app background.
 */
export const inlineEditorStyle: React.CSSProperties = {
  ...cardSurfaceStyle,
  padding: '12px 14px',
  marginTop: 8,
};

/** That editor's own title. */
export const inlineEditorTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 8,
};

/** Secondary text: an empty section's sentence, a value's unit, a footnote. */
export const cardMutedTextStyle: React.CSSProperties = {
  color: '#888',
  fontSize: 13,
  margin: 0,
};

/** The sentence under a section header that explains what the section does. */
export const cardHintStyle: React.CSSProperties = {
  ...cardMutedTextStyle,
  margin: '0 0 12px',
};

/**
 * A `Label: Value` pair on one line — the shape an expanded card uses for an
 * entity's own read-only fields (`Start date`, `Membership fee`, `Billing
 * frequency`). The vertical `formFieldLabelStyle` + `formValueStyle` pair above
 * is the *form's* layout; this is the denser one a card reads in, and the
 * Membership Plan card has rendered it since #547.
 *
 * #924 stage 5: the Assigned Plan card had three copies of it, each with its own
 * label width and type size, so the same pair sat at 140px there and 200px on
 * the Plan card it is meant to mirror. The numbers here are the Plan card's.
 */
export const cardDetailRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  padding: '4px 0',
  fontSize: 13.5,
};

/** That pair's label: fixed width, so every value on a card lines up. */
export const cardDetailLabelStyle: React.CSSProperties = {
  width: 200,
  flexShrink: 0,
  color: '#888',
};

/** And its value. */
export const cardDetailValueStyle: React.CSSProperties = {
  color: '#222',
  flex: 1,
};

/** The label above a field, in a form and beside a read-only value alike. */
export const formFieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12.5,
  fontWeight: 600,
  color: '#555',
  marginBottom: 4,
};

/**
 * The one control box: `<input>`, `<select>` and `<textarea>` all wear it, so a
 * form's controls line up with each other and with every other screen's.
 */
export const formControlStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  border: '1px solid var(--gd-input-border, #d1d5db)',
  background: 'var(--gd-input-bg, #ffffff)',
  fontSize: 14,
};

/**
 * A read-only value in the box its input occupies.
 *
 * The transparent border and the matching horizontal padding are the point:
 * before #929 a value sat at `padding: '8px 0'` under a label whose input is
 * inset by 10px, so every value jumped sideways the moment `⋮ → Edit` opened.
 * It keeps line breaks and wraps, because free text (Notes) must not stretch
 * the card sideways.
 */
export const formValueStyle: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  border: '1px solid transparent',
  fontSize: 14,
  lineHeight: 1.4,
  color: '#222',
  minHeight: 20,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

/** A checkbox or radio and its label, on one line. */
export const formCheckboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  fontSize: 14,
  cursor: 'pointer',
};

/** The sentence under an input explaining how to fill it in. */
export const formHelpTextStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  color: '#888',
};

/** A validation message under the field it belongs to. */
export const formFieldErrorStyle: React.CSSProperties = {
  margin: '4px 0 0',
  fontSize: 12,
  color: '#c0392b',
};

/** A form-level error: the one line a failed save reports itself on. */
export const formErrorStyle: React.CSSProperties = {
  margin: '10px 0 0',
  fontSize: 13,
  color: '#c0392b',
};

/** The row a form's Cancel/Save pair sits on, separated from the fields above. */
export const formActionsRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  marginTop: 16,
  paddingTop: 14,
  borderTop: '1px solid var(--gd-card-border, #ececf0)',
};

/** The same pair inside a section-level editor: left-aligned, no rule above. */
export const inlineActionsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 10,
};

/**
 * A secondary action — Cancel, and anything that is not the form's one primary
 * action. `primaryBtnStyle()` / `primaryBtnSmall()` (`ui.tsx`, #912) are the
 * other half of the pair; these two only carry the neutral colours, at the same
 * geometry, so the two buttons of a pair are the same height.
 */
export const secondaryBtnStyle: React.CSSProperties = {
  background: 'var(--gd-input-bg, #ffffff)',
  color: '#444',
  border: '1px solid var(--gd-input-border, #d1d5db)',
  borderRadius: 6,
  padding: '9px 18px',
  cursor: 'pointer',
  fontSize: 15,
  fontWeight: 500,
};

/** The same, sized for inside a card or a section. */
export const secondaryBtnSmall: React.CSSProperties = {
  background: 'var(--gd-input-bg, #ffffff)',
  color: '#444',
  border: '1px solid var(--gd-input-border, #d1d5db)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
};

/**
 * An `+ Add …` affordance that opens a section-level editor below itself.
 *
 * #971: its hairline is the Theme's input border rather than a grey of its own,
 * so a gym that themes its controls themes this one too — the literal stays as
 * the `var()` fallback, so nothing looks different until a gym changes it.
 */
export const dashedAddBtnStyle: React.CSSProperties = {
  background: 'none',
  border: '1px dashed var(--gd-input-border, #c8c8d0)',
  borderRadius: 6,
  padding: '6px 12px',
  fontSize: 13,
  cursor: 'pointer',
  color: '#444',
  marginTop: 2,
};

/** A text link inside a card — Retry, and nothing a button should be. */
export const cardTextLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--gd-link, #6c63ff)',
  cursor: 'pointer',
  fontSize: 13,
  padding: 0,
  textDecoration: 'underline',
};
