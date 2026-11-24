'use client';

// #3307 — the cart Save & Pay committed, kept in the Summary once it has left the in-flight rows
// (paid in cash or by card, settled by the provider, or activated because nothing was owed).
// Stage 2: what is shown is the server's `paid_cart` (`GET /user-memberships/member/:id/configuration`),
// which reports a paid cart for one hour after it was paid, or until a newer cart is opened — so the
// row survives a reload and disappears on its own. Nothing here submits, charges or decides a status;
// the only action opens the existing Billing Event details.

import React, { type CSSProperties } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { cardHintStyle, secondaryBtnSmall } from '@/components/formChrome';
import { PurchaseHeading } from './PurchaseHeading';
import type { PaidCart } from './membershipConfiguration';
import { retainedCartNoteKey, type SubmittedCart } from './productsWorkflowView';

export function SubmittedCartSummary({ paidCart, submitted }: { paidCart: PaidCart; submitted: SubmittedCart | null }) {
  const t = useTranslations('members');
  const locale = useLocale();
  const router = useRouter();
  const noteKey = retainedCartNoteKey(submitted, paidCart);
  const ownSubmission = submitted != null && submitted.productSetId === paidCart.product_set_id;
  return (
    <div style={row} data-submitted-cart={paidCart.purchase.id}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <PurchaseHeading purchase={paidCart.purchase} />
        {paidCart.amount != null && <span style={cardHintStyle}>{` · ${Number(paidCart.amount).toFixed(2)} €`}</span>}
        {noteKey && <div style={cardHintStyle} data-submitted-cart-note>{t(noteKey as any)}</div>}
        {ownSubmission && submitted!.checkoutUrl && (
          <div style={cardHintStyle}>{t('product_set_payment_link')}: <code>{submitted!.checkoutUrl}</code></div>
        )}
      </div>
      {paidCart.billing_event_id != null && (
        <button
          type="button"
          style={secondaryBtnSmall}
          data-submitted-cart-billing-event={paidCart.billing_event_id}
          onClick={() => router.push(`/${locale}/payments/billing-events?id=${Number(paidCart.billing_event_id)}`)}
        >
          {t('action_view_billing_event')}
        </button>
      )}
    </div>
  );
}

const row: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '8px 10px', margin: '6px 0 12px',
  border: '1px solid var(--gd-card-border, #e5e7eb)', borderRadius: 8, flexWrap: 'wrap',
};
