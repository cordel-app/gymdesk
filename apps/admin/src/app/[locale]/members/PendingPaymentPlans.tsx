'use client';

// #2742 — Membership Plans awaiting their first payment that no assignment row
// represents yet (a plan a member chose in the Members App), listed in the
// Member card's Active category with a `Pending Payment` badge.
//
// Presentation only: which versions are listed is `pendingPaymentPlanSets()`
// (membershipPlansView.ts), the label is the version's own stored status, and
// paying or cancelling stays in the Summary's `/product-sets` workflow. It is not
// an Assigned Plan row (#1051's table): the version has no assignment until the
// payment activates it, and then it is one of the table's rows instead.

import React from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { listCellStyle, listRowDividerStyle, listSurfaceStyle } from '@/components/listChrome';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateOnly } from '@/lib/gymFormat';
import type { ProductSetRow } from './membershipConfiguration';

export function PendingPaymentPlans({ sets, spaced }: { sets: ProductSetRow[]; spaced: boolean }) {
  const t = useTranslations('members');
  const tStatus = useTranslations('status');
  const gymFmt = useGymFormatSettings();
  if (sets.length === 0) return null;
  return (
    <div style={{ ...listSurfaceStyle, marginBottom: spaced ? 8 : 0 }} data-pending-payment-plans>
      {sets.map((ps, i) => (
        <div
          key={ps.id}
          data-product-set-id={ps.id}
          style={{
            ...listCellStyle, ...(i > 0 ? listRowDividerStyle : {}),
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}
        >
          <strong style={{ flex: 1, minWidth: 0 }}>{ps.plan_name ?? t('product_set_no_plan')}</strong>
          {ps.starts_at && <span>{formatGymDateOnly(ps.starts_at, gymFmt)}</span>}
          {ps.amount_due != null && <span>{formatGymAmount(ps.amount_due, gymFmt)}</span>}
          <StatusBadge status="pending_payment" label={tStatus('pending_payment' as never)} />
        </div>
      ))}
    </div>
  );
}
