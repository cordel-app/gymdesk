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
  border: '1px solid var(--gd-card-border, #e2e2e6)',
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
