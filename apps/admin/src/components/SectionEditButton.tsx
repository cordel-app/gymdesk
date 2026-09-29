'use client';

import React from 'react';
import { readOnlyStyle } from './ui';

/**
 * #901 — the one subsection `Edit` action, shared by the Membership Plan card
 * and the Promotion card.
 *
 * Both cards are read-only when expanded and editable only behind `⋮ → Edit`
 * (#816, #897), and inside that mode each subsection carries its own `Edit`
 * button. Until this component the two pages styled that button differently —
 * Promotions a filled `btnSmall('#6c63ff')`, Plans a bare text link — so the
 * same action looked like two different affordances on two screens that are
 * otherwise deliberately identical (`BillingDurationSummary`, #879).
 *
 * The colours come from the Theme's existing **Buttons** group, `primaryButton`
 * / `primaryButtonText` (`--gd-primary-btn` / `--gd-primary-btn-text`, written
 * by `applyTokens`), rather than from a hardcoded lilac or a new Theme setting:
 * this *is* the app's primary action colour, and its default is the very
 * `#6c63ff` the two pages used to spell out, so nothing looks different until a
 * gym themes it. The literals here are the CSS `var()` fallbacks for the frames
 * before `applyTokens` has run, never a second source of truth.
 *
 * It carries no label and names no locale key: each page passes its own, since
 * a Plan says *Edit pricing* where a Promotion says *Edit*. It makes no
 * permission decision either — the caller owns `disabled` and `title`, exactly
 * as it owns whether the button is rendered at all (it must be absent, not
 * disabled, outside Edit mode).
 */
export const sectionEditButtonStyle: React.CSSProperties = {
  background: 'var(--gd-primary-btn, #6c63ff)',
  color: 'var(--gd-primary-btn-text, #ffffff)',
  border: 'none',
  borderRadius: 4,
  padding: '6px 12px',
  cursor: 'pointer',
  fontSize: 13,
};

export function SectionEditButton({
  label,
  onClick,
  disabled = false,
  title,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={readOnlyStyle(sectionEditButtonStyle, disabled)}
    >
      {label}
    </button>
  );
}
