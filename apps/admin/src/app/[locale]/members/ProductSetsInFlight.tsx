'use client';

// #1325 PR 3b — the Member's ProductSet versions still in flight: a plan saved
// and awaiting its first payment, or a Draft not yet committed.
//
// They have no assignment until activation (that is what the projection writes),
// so the MEMBERSHIP PLANS section lists them here and acts on them only through
// `/product-sets`; every transition is the server's. Nothing here prices, decides
// whether something is owed or confirms a replacement.
//
// #3307 stage 4 — a version awaiting payment offers no payment action here (the
// payment link and cash payment were removed by the owner's request): its row shows
// the 24-hour expiry by the server's clock and opens the purchase's detail.
//
// #3307 stage 5 — and it keeps the In Cart Summary's detail (Initial Payment and Contracted
// Products & Plans, from the same review read), with only the status changed and no Waive /
// Revert waive: a version awaiting payment is not edited.

import React, { useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { cardHintStyle, formErrorStyle } from '@/components/formChrome';
import type { ProductSetRow } from './membershipConfiguration';
import { WAIVE_REFUSAL_KEYS, inFlightSetTitle, type ReviewSummary } from './productsWorkflowView';
import { CheckoutSummaryPanel } from './CheckoutSummarySections';
import { PurchaseHeading, type CartExpiry } from './PurchaseHeading';
import { CartExpiryIndicator } from './CartExpiryIndicator';
import { SummaryPurchaseDetail, SummaryPurchaseDetailToggle } from './SummaryPurchaseDetail';
import { useSetReview } from './MemberProductsWorkflow';

interface Props {
  /** #3307 stage 4 — whose purchases the awaiting-payment row's detail reads. */
  memberId: number | string;
  productSets: ProductSetRow[];
  canWrite: boolean;
  /**
   * #2860 — the Draft's review: the Summary draws its Initial Payment and its
   * Contracted Products & Plans (replacing #1660's diff list and #2446's items
   * and financial summary).
   */
  review?: ReviewSummary | null;
  /** Re-reads the Member's configuration after an action. */
  onChanged: () => void;
  /** #3378 — the cart's countdown, shown in the In Cart version's header beside its status. */
  cartExpiry?: CartExpiry | null;
}

export function ProductSetsInFlight({ memberId, productSets, canWrite, review = null, onChanged, cartExpiry = null }: Props) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  // #3307 stage 4 — which awaiting-payment row has its purchase detail open.
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [waiveBusy, setWaiveBusy] = useState<string | null>(null);

  const inFlight = productSets.filter((p) => p.status === 'in_cart' || p.status === 'pending_payment');
  if (inFlight.length === 0) return null;

  // #3284 stage 2 — Waive / Revert waive one Initial Payment line; the server re-prices, and the
  // page re-reads the configuration (and with it the review) afterwards.
  function waiveControl(setId: number) {
    if (!canWrite) return null;
    return {
      busyKey: waiveBusy,
      onAction: async (kind: 'waive' | 'revert', lineKey: string) => {
        setWaiveBusy(lineKey);
        setError(null);
        try {
          await apiFetch(`/product-sets/${setId}/initial-payment/${kind === 'waive' ? 'waive' : 'revert-waive'}`, {
            method: 'POST', body: JSON.stringify({ line_key: lineKey }),
          });
          onChanged();
        } catch (err: any) {
          const code = err?.body?.error;
          setError(typeof code === 'string' && WAIVE_ERROR_KEYS[code] ? t(WAIVE_ERROR_KEYS[code] as any) : (apiErrorMessage(err) ?? t('error_generic')));
        } finally {
          setWaiveBusy(null);
        }
      },
    };
  }

  return (
    <div style={{ marginBottom: 12 }}>
      {inFlight.map((ps) => (
        <div key={ps.id} style={row} data-product-set-id={ps.id}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {ps.purchase ? (
              // #3270 — a version that belongs to a purchase is identified by the purchase's name, with
              // its status as a separate badge; never by the plan, which the cart may change.
              <>
                <PurchaseHeading
                  purchase={ps.purchase}
                  statusOverride={ps.expired ? { status: 'expired', label: t('product_set_status_expired') } : null}
                  expiry={ps.status === 'in_cart' ? cartExpiry : null}
                />
                {ps.amount_due != null && <span style={cardHintStyle}>{` · ${ps.amount_due.toFixed(2)} €`}</span>}
                {ps.status === 'pending_payment' && !ps.expired && ps.payment_expires_in_seconds != null && (
                  <>{' '}<CartExpiryIndicator seconds={ps.payment_expires_in_seconds} onExpire={onChanged} labelKey="payment_expires_in" /></>
                )}
              </>
            ) : (
              <>
                <strong>{inFlightSetTitle(ps, ps.status === 'in_cart' ? review : null) ?? t('product_set_no_plan')}</strong>
                <span style={cardHintStyle}>
                  {' · '}
                  {ps.expired
                    ? t('product_set_status_expired')
                    : t(ps.status === 'pending_payment' ? 'product_set_status_pending_payment' : 'product_set_status_in_cart')}
                  {ps.amount_due != null ? ` · ${ps.amount_due.toFixed(2)} €` : ''}
                </span>
                {ps.status === 'in_cart' && !ps.expired && cartExpiry && (
                  <>{' '}<CartExpiryIndicator seconds={cartExpiry.seconds} onExpire={cartExpiry.onExpire} /></>
                )}
                {ps.status === 'pending_payment' && !ps.expired && ps.payment_expires_in_seconds != null && (
                  <>{' '}<CartExpiryIndicator seconds={ps.payment_expires_in_seconds} onExpire={onChanged} labelKey="payment_expires_in" /></>
                )}
              </>
            )}
            {ps.status === 'in_cart' && review && (
              <CheckoutSummaryPanel payment={review.initial_payment} contracted={review.contracted_items} waive={waiveControl(ps.id)} />
            )}
            {ps.status === 'pending_payment' && !ps.expired && <PendingSetSummary setId={ps.id} reloadKey={ps} />}
          </div>
          {ps.status === 'pending_payment' && ps.purchase && (
            <SummaryPurchaseDetailToggle
              purchaseId={ps.purchase.id}
              open={openId === ps.id}
              onToggle={() => setOpenId((cur) => (cur === ps.id ? null : ps.id))}
            />
          )}
          {ps.status === 'pending_payment' && ps.purchase && openId === ps.id && (
            <div style={{ flexBasis: '100%' }}>
              <SummaryPurchaseDetail memberId={memberId} purchaseId={ps.purchase.id} reloadKey={ps} />
            </div>
          )}
        </div>
      ))}
      {error && <p style={{ ...formErrorStyle, margin: '6px 0 0' }}>{error}</p>}
    </div>
  );
}

/** #3307 stage 5 — the Summary of a version awaiting payment: the In Cart panel, read-only. */
function PendingSetSummary({ setId, reloadKey }: { setId: number; reloadKey: unknown }) {
  const review = useSetReview(setId, reloadKey);
  if (!review) return null;
  return <CheckoutSummaryPanel payment={review.initial_payment} contracted={review.contracted_items} waive={null} />;
}

/** #3284 stage 2 — the waive refusals the screen words itself (one map, `productsWorkflowView.ts`); anything else is the server's message. */
const WAIVE_ERROR_KEYS = WAIVE_REFUSAL_KEYS;

const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', margin: '6px 0',
  border: '1px solid var(--gd-card-border, #e5e7eb)', borderRadius: 8, flexWrap: 'wrap',
};
