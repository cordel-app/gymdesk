import React from 'react';

export const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
export const modalStyle: React.CSSProperties = { background: 'var(--gd-card-bg, #ffffff)', borderRadius: 12, padding: 32, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };

/**
 * #677 — a card's themed chrome, in one place: the Card Border color and the
 * Card Border Radius the theme configures (`--gd-card-border` /
 * `--gd-card-radius`, both written by `applyTokens`) plus the card background.
 *
 * Every card surface spreads this instead of restating a border and a radius
 * of its own, so one theme change moves all of them. A card that also carries
 * an accent border while highlighted or being edited overrides `border` on top
 * of the spread and keeps the themed radius.
 */
export const cardSurfaceStyle: React.CSSProperties = {
  // #833 §4 added Card Border Width beside the colour, so the width is themed
  // too rather than being a hardcoded 1px under a configurable colour.
  border: 'var(--gd-card-border-width, 1px) solid var(--gd-card-border, #e2e2e6)',
  borderRadius: 'var(--gd-card-radius, 8px)',
  background: 'var(--gd-card-bg, #ffffff)',
};

// bg is optional; omit it to inherit the active gym's brand color via CSS variables.
// Existing callers passing a hex string keep their exact color.
export function btnStyle(bg?: string): React.CSSProperties {
  return { background: bg ?? 'var(--brand, #6c63ff)', color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
}

/** #613: visual state for a write control that is disabled for a read-only role. */
export function readOnlyStyle(style: React.CSSProperties, disabled: boolean): React.CSSProperties {
  return disabled ? { ...style, opacity: 0.45, cursor: 'not-allowed' } : style;
}

export function btnSmall(bg?: string): React.CSSProperties {
  return { background: bg ?? 'var(--brand, #6c63ff)', color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 13 };
}

/**
 * #912 — the Admin UI's primary action colours, in one place.
 *
 * `primaryButton` / `primaryButtonText` are existing Theme settings and
 * `applyTokens` already writes `--gd-primary-btn` / `--gd-primary-btn-text`
 * from them (#901), so a primary action spreads these rather than spelling a
 * colour of its own. Dropping `btnStyle()`/`btnSmall()`'s argument is *not* the
 * same thing: their own default is `--brand`, which `applyTokens` maps to
 * `sidebarSelectedItemBackground` — a different Theme setting, and not an
 * action colour.
 *
 * The literals are the CSS `var()` fallbacks for the frames before
 * `applyTokens` has run, never a second source of truth: they are
 * `DEFAULT_TOKENS.colors.primaryButton` / `.primaryButtonText`, so nothing
 * looks different until a gym themes it. This module is the only place they
 * are spelled — `SectionEditButton` derives from `primaryBtnSmall()`.
 */
export const primaryActionColors: Pick<React.CSSProperties, 'background' | 'color'> = {
  background: 'var(--gd-primary-btn, #6c63ff)',
  color: 'var(--gd-primary-btn-text, #ffffff)',
};

/** A primary action in a page's own chrome — `btnStyle` geometry, themed colours. */
export function primaryBtnStyle(): React.CSSProperties {
  return { ...btnStyle(), ...primaryActionColors };
}

/** A primary action inside a card or a section — `btnSmall` geometry, themed colours. */
export function primaryBtnSmall(): React.CSSProperties {
  return { ...btnSmall(), ...primaryActionColors };
}
