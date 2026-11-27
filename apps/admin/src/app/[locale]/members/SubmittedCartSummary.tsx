'use client';

// #3307 — the cart Save & Pay committed, kept in the Summary once it has left the in-flight rows
// (paid in cash or by card, settled by the provider, or activated because nothing was owed).
// Stage 2: what is shown is the server's `paid_cart` (`GET /user-memberships/member/:id/configuration`),
// which reports a paid cart for one hour after it was paid, or until a newer cart is opened — so the
// row survives a reload and disappears on its own. Nothing here submits, charges or decides a status;
// the row itself opens the purchase's detail (#3307 stage 4), whose payment section carries the
// Billing Event link (#3509: no separate View billing event or Show/Hide details buttons).

import React, { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { cardHintStyle } from '@/components/formChrome';
import { PurchaseHeading } from './PurchaseHeading';
import { SummaryPurchaseDetail } from './SummaryPurchaseDetail';
import type { PaidCart } from './membershipConfiguration';
import { retainedCartNoteKey, type SubmittedCart } from './productsWorkflowView';

export function SubmittedCartSummary({ memberId, paidCart, submitted }: {
  memberId: number | string; paidCart: PaidCart; submitted: SubmittedCart | null;
}) {
  const t = useTranslations('members');
  // #3307 stage 4 / #3509 — clicking the row (or Enter / Space on it) opens the purchase's contents
  // and Billing Event details; the detail sits outside the clickable header, so its links never toggle it.
  const [open, setOpen] = useState(false);
  const toggle = () => setOpen((v) => !v);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  };
  const noteKey = retainedCartNoteKey(submitted, paidCart);
  const ownSubmission = submitted != null && submitted.productSetId === paidCart.product_set_id;
  return (
    <div style={row} data-submitted-cart={paidCart.purchase.id}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        style={header}
        data-summary-purchase-toggle={paidCart.purchase.id}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden="true" style={chevron}>{open ? '▾' : '▸'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <PurchaseHeading purchase={paidCart.purchase} />
          {paidCart.amount != null && <span style={cardHintStyle}>{` · ${Number(paidCart.amount).toFixed(2)} €`}</span>}
          {noteKey && <div style={cardHintStyle} data-submitted-cart-note>{t(noteKey as any)}</div>}
          {ownSubmission && submitted!.checkoutUrl && (
            <div style={cardHintStyle}>{t('product_set_payment_link')}: <code>{submitted!.checkoutUrl}</code></div>
          )}
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          <SummaryPurchaseDetail memberId={memberId} purchaseId={paidCart.purchase.id} reloadKey={paidCart} />
        </div>
      )}
    </div>
  );
}

const row: CSSProperties = {
  padding: '8px 10px', margin: '6px 0 12px',
  border: '1px solid var(--gd-card-border, #e5e7eb)', borderRadius: 8,
};

const header: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' };

const chevron: CSSProperties = { color: '#888', fontSize: 11, width: 10, flexShrink: 0 };
