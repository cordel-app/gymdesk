'use client';

import React from 'react';
import { primaryBtnSmall, readOnlyStyle } from './ui';

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
 * gym themes it.
 *
 * Since #912 that pair is `primaryActionColors` in `ui.tsx` and this style is
 * `primaryBtnSmall()` — the Theme editor's own primary actions (`+ Assign
 * Centers…`, `Save changes`, `+ Add`) needed the same colours, and a second
 * spelling of the `var()` fallbacks is exactly the drift this component was
 * created to remove. This module therefore carries no colour literal at all.
 *
 * It carries no label and names no locale key: each page passes its own, since
 * a Plan says *Edit pricing* where a Promotion says *Edit*. It makes no
 * permission decision either — the caller owns `disabled` and `title`, exactly
 * as it owns whether the button is rendered at all (it must be absent, not
 * disabled, outside Edit mode).
 */
export const sectionEditButtonStyle: React.CSSProperties = primaryBtnSmall();

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
