import React from 'react';

export const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
export const modalStyle: React.CSSProperties = { background: 'var(--gd-card-bg, #ffffff)', borderRadius: 12, padding: 32, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };

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
