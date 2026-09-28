'use client';

/**
 * #879 — the compact `Label: Value` summary the Promotions card has shown for
 * its Billing & Duration section since #550, extracted so the Membership Plan
 * card renders the *same* component rather than a second look at the same
 * information. A user moving between Promotions → Billing & Duration and
 * Membership Plans → Billing & Duration should feel they are looking at one
 * component, which is the whole of the ticket.
 *
 * Deliberately presentational and entity-free: the owning page decides which
 * items exist, what an unset value reads as and how each value is formatted —
 * a Promotion omits a zero month count, a Plan spells out "Not configured"
 * (§4) — so what is shared is exactly the visual language: the label/value
 * pairing, the typography, the horizontal spacing and the responsive wrap
 * (§8/§9). It holds no state and renders no control: the section's Edit button
 * stays in the page's own section header, behind `⋮ → Edit` (#797).
 *
 * `t` is passed in already applied rather than taken from `useTranslations()`
 * here because the two pages namespace their keys differently (`promotions.*`
 * vs `plans.*`), the same reason `SellableItemBenefits` takes its labels ready.
 */

import React from 'react';

/** One `Label: Value` pair. `key` is the React list key — a field name, never
 *  the display label, which is translated. */
export interface BillingDurationItem {
  key: string;
  label: string;
  value: React.ReactNode;
}

/**
 * Drops the items a page decided not to show, so a caller can write the list
 * as one array with inline conditions (`free > 0 && { … }`) instead of
 * assembling it imperatively. Pure — exercised directly in the tests.
 */
export function billingDurationItems(
  items: (BillingDurationItem | null | undefined | false)[],
): BillingDurationItem[] {
  return items.filter((item): item is BillingDurationItem => Boolean(item));
}

/** The one place this summary's look is defined (§9). */
export const billingDurationSummaryStyle: React.CSSProperties = {
  display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap',
};

export function BillingDurationSummary({ items }: { items: BillingDurationItem[] }) {
  if (items.length === 0) return null;
  return (
    <div style={billingDurationSummaryStyle}>
      {items.map((item) => (
        <span key={item.key}><strong>{item.label}:</strong> {item.value}</span>
      ))}
    </div>
  );
}
