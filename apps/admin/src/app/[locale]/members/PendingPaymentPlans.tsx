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
//
// #2747 stage 2: the same rows list such a version once it was cancelled
// (`status="cancelled"`, under Past), dated by the day it was cancelled.
//
// #2966 stage 8: an added cart plan's row lists the Promotions applied to it
// (`addedPlanPromotionNames()`), as the list's accent badges.
//
// #2966 stage 10: an in-cart row offers Edit beside Remove, which opens that plan's
// configuration editor under the row (`renderEditor`, the caller's); one at a time.

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { StatusBadge } from '@/components/StatusBadge';
import { listCellStyle, listNameBadgeAccentStyle, listRowDividerStyle, listSurfaceStyle } from '@/components/listChrome';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateOnly } from '@/lib/gymFormat';
import { secondaryBtnSmall } from '@/components/formChrome';
import type { ProductSetRow } from './membershipConfiguration';
import { addedPlanPromotionNames } from './membershipPlansView';

export function PendingPaymentPlans({ sets, spaced, status = 'pending_payment', onRemove, renderEditor }: {
  sets: ProductSetRow[];
  spaced: boolean;
  status?: 'pending_payment' | 'cancelled' | 'in_cart';
  /** #2966 stage 5 — offered on an in-cart row only; the caller owns the request. */
  onRemove?: (row: ProductSetRow) => void;
  /** #2966 stage 10 — the editor drawn under an in-cart row whose Edit is open; absent offers no Edit. */
  renderEditor?: (row: ProductSetRow) => React.ReactNode;
}) {
  const t = useTranslations('members');
  const tStatus = useTranslations('status');
  const gymFmt = useGymFormatSettings();
  const [editingId, setEditingId] = useState<number | null>(null);
  if (sets.length === 0) return null;
  return (
    <div
      style={{ ...listSurfaceStyle, marginBottom: spaced ? 8 : 0 }}
      {...(status === 'cancelled' ? { 'data-cancelled-plan-sets': true } : status === 'in_cart' ? { 'data-added-cart-plans': true } : { 'data-pending-payment-plans': true })}
    >
      {sets.map((ps, i) => (
        <React.Fragment key={ps.id}>
        <div
          data-product-set-id={ps.id}
          style={{
            ...listCellStyle, ...(i > 0 ? listRowDividerStyle : {}),
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{ps.plan_name ?? t('product_set_no_plan')}</strong>
            {status === 'in_cart' && addedPlanPromotionNames(ps).length > 0 && (
              // #2966 stage 8: the Promotions applied to a plan added to the cart.
              <div data-added-plan-promotions style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {addedPlanPromotionNames(ps).map((name, j) => (
                  <span key={j} style={listNameBadgeAccentStyle} title={t('added_plan_promotion_title', { name })}>{name}</span>
                ))}
              </div>
            )}
          </div>
          {status === 'cancelled'
            ? ps.cancelled_at && <span>{formatGymDateOnly(ps.cancelled_at, gymFmt)}</span>
            : ps.starts_at && <span>{formatGymDateOnly(ps.starts_at, gymFmt)}</span>}
          {ps.amount_due != null && <span>{formatGymAmount(ps.amount_due, gymFmt)}</span>}
          <StatusBadge status={status} label={tStatus(status as never)} />
          {status === 'in_cart' && renderEditor && (
            <button
              type="button" style={secondaryBtnSmall} aria-expanded={editingId === ps.id}
              onClick={() => setEditingId(editingId === ps.id ? null : ps.id)}
            >
              {editingId === ps.id ? t('added_plan_edit_done') : t('added_plan_edit')}
            </button>
          )}
          {status === 'in_cart' && onRemove && (
            <button type="button" style={secondaryBtnSmall} onClick={() => onRemove(ps)}>{t('added_plan_remove')}</button>
          )}
        </div>
        {status === 'in_cart' && renderEditor && editingId === ps.id && (
          <div style={{ ...listCellStyle, ...listRowDividerStyle }}>{renderEditor(ps)}</div>
        )}
        </React.Fragment>
      ))}
    </div>
  );
}
