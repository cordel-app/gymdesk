'use client';

/**
 * #1108 stage 2 §7 — the Member window's own action area: `[ Save & Pay ]`.
 *
 * It sits at the foot of the expanded Member card, **outside** the tab strip
 * (#961) and outside the Membership Plans section, because what it completes is
 * the Member's whole configured purchase and not one card's form. §6 is explicit
 * that the button is *Save & Pay* and never *Save*: it commits the configuration
 * and raises the charge that activates it.
 *
 * Presentational and decision-free, like `ReplacePlanDialog` and
 * `BillingDurationSummary` (#879): every label arrives already resolved, the
 * state it is in comes from `lib/saveAndPay.ts`, and the page owns the request,
 * the `confirm: true` resend and the reload. It declares no colour of its own —
 * `primaryBtnStyle()` for the action (#912/#954), `formChrome`'s own hint, alert
 * and inner-card values for everything else.
 *
 * It renders **nothing at all** when the Member has nothing waiting to be
 * committed, rather than an empty row with a disabled button: a control that
 * cannot work is absent (#1073's rule, one app over).
 */

import React from 'react';
import { primaryBtnStyle } from '@/components/ui';
import {
  cardHintStyle,
  cardMutedTextStyle,
  cardSectionLabelStyle,
  formActionsRowStyle,
  formErrorStyle,
  innerCardStyle,
  secondaryBtnSmall,
} from '@/components/formChrome';
import type { SaveAndPayMode, SaveAndPayPayment, SaveAndPayState } from '@/lib/saveAndPay';
import { hasOpenableCheckout } from '@/lib/saveAndPay';

interface Props {
  mode: SaveAndPayMode;
  state: SaveAndPayState | null;
  /** The section heading, already translated. */
  title: string;
  /** The sentence above the action, already translated and interpolated. */
  notice: string;
  /** The primary button's label, already translated. */
  actionLabel: string;
  /** The amount line under it, or `null` when nothing is owed. */
  amountLine: string | null;
  /** The checkout link's own label and its copy affordance's. */
  linkLabel: string;
  copyLabel: string;
  /** What the link area says while no link can be opened. */
  linkExpiredLabel: string;
  busy: boolean;
  disabled: boolean;
  disabledTitle?: string;
  error: string | null;
  onAction: () => void;
  onCopyLink: (url: string) => void;
}

export function MemberSaveAndPayActions({
  mode, state, title, notice, actionLabel, amountLine,
  linkLabel, copyLabel, linkExpiredLabel,
  busy, disabled, disabledTitle, error, onAction, onCopyLink,
}: Props) {
  if (mode === 'none') return null;
  const payment: SaveAndPayPayment | null = state?.payment ?? null;
  const openable = hasOpenableCheckout(payment);

  return (
    <div style={{ ...innerCardStyle, marginTop: 16 }}>
      <div style={cardSectionLabelStyle}>{title}</div>
      <p style={{ ...cardHintStyle, marginTop: 0 }}>{notice}</p>

      {amountLine && <p style={{ ...cardMutedTextStyle, margin: '0 0 8px' }}>{amountLine}</p>}

      {mode === 'awaiting' && (
        <p style={{ ...cardMutedTextStyle, margin: '0 0 8px' }}>
          {openable ? (
            <>
              {/* The member opens this on their own device and types their card
                  there — the admin app never sees it (#788's reason). */}
              <a
                href={payment!.checkout_url as string}
                target="_blank"
                rel="noreferrer noopener"
              >
                {linkLabel}
              </a>{' '}
              <button
                type="button"
                style={secondaryBtnSmall}
                onClick={() => onCopyLink(payment!.checkout_url as string)}
              >
                {copyLabel}
              </button>
            </>
          ) : linkExpiredLabel}
        </p>
      )}

      {error && <p style={{ ...formErrorStyle, margin: '0 0 8px' }}>{error}</p>}

      <div style={formActionsRowStyle}>
        <button
          type="button"
          onClick={onAction}
          disabled={busy || disabled}
          title={disabled ? disabledTitle : undefined}
          style={{
            ...primaryBtnStyle(),
            ...(busy || disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
          }}
        >
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
