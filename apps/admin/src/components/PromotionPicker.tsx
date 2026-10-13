'use client';

// #1539 — the one Promotion checkbox list: individual checkboxes, a description
// generated from the configuration, and the stacking rule applied to the whole
// selection (`lib/promotionSelection.ts`). It decides nothing the server does
// not re-decide.

import React from 'react';
import { useTranslations } from 'next-intl';
import { cardHintStyle } from '@/components/formChrome';
import { promotionBlock } from '@/lib/promotionSelection';

export interface PickerPromotion {
  id: number;
  name: string;
  stackable: boolean;
  /** Already resolved text of the benefit, or null to show the name alone. */
  description: string | null;
}

export function PromotionPicker({
  promotions, selectedIds, onToggle, disabled = false, emptyText,
}: {
  promotions: PickerPromotion[];
  selectedIds: number[];
  onToggle: (id: number) => void;
  disabled?: boolean;
  emptyText: string;
}) {
  const t = useTranslations('members');
  if (promotions.length === 0) return <p style={cardHintStyle}>{emptyText}</p>;
  return (
    <div role="group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {promotions.map((p) => {
        const checked = selectedIds.includes(p.id);
        const block = promotionBlock(p, promotions, selectedIds);
        const off = block !== null;
        const reason = block ? t(`promo_block_${block}` as any) : undefined;
        return (
          <label
            key={p.id}
            title={reason}
            data-promotion-id={p.id}
            style={{
              display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14,
              opacity: off ? 0.5 : 1, cursor: off || disabled ? 'not-allowed' : 'pointer',
              fontWeight: checked ? 600 : 400,
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled || off}
              onChange={() => onToggle(p.id)}
            />
            <span>
              {p.name}
              {p.description ? ` – ${p.description}` : ''}
              {!p.stackable ? ` · ${t('add_product_not_stackable')}` : ''}
              {off && <span style={{ display: 'block', fontSize: 12, fontWeight: 400 }}>{reason}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}
