'use client';

/**
 * #635 stage 1 — the Session / One-off / Period Benefit editor, shared.
 *
 * Promotions have had these three sections since #550; the ticket asks that
 * Membership Plans get sections that "behave like the existing ... Benefits in
 * Promotions". Rather than copy the markup a second time, the two render
 * helpers that were inline in `promotions/page.tsx` live here, parameterised by
 * the only two things that differ between the sections (which category's active
 * items back the picker, and whether the read-only Frequency column shows).
 *
 * Deliberately presentational: the owning page keeps the draft state, decides
 * which section is editable, and owns Save/Cancel. That is what lets the same
 * pair of helpers serve Promotions' one-section-at-a-time editing (#627) and the
 * Plans page's per-section Edit buttons without either page's state leaking in.
 *
 * `t` is passed in rather than taken from `useTranslations()` here because the
 * two pages namespace their keys differently (`promotions.*` vs `plans.*`).
 */

import React from 'react';
import { btnSmall } from '@/components/ui';

/** One saved/drafted benefit row. `gym_charge_*` is joined server-side, so an
 *  item that has since gone inactive still renders with its real name. */
export interface SellableItemBenefitRow {
  gym_charge_id: number;
  quantity: number;
  gym_charge_name: string;
  gym_charge_type: string;
  gym_charge_billing_frequency: string | null;
  gym_charge_status: string;
}

/** A Sellable Item offered by the picker. `benefit_category` is computed
 *  server-side (#550) and is the only classification source of truth. */
export interface SellableItemOption {
  id: number;
  name: string;
  type: string;
  billing_frequency: string | null;
  status: string;
  benefit_category: 'session' | 'oneoff' | 'periodical';
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

type SetDraft = (fn: (prev: SellableItemBenefitRow[]) => SellableItemBenefitRow[]) => void;

/**
 * A row's own saved item is always offered, even after it drops out of the
 * active-only `categoryItems` — otherwise editing an unrelated section would
 * silently swap a deactivated item for another one (#550).
 */
export function benefitRowOptions(categoryItems: SellableItemOption[], row: SellableItemBenefitRow) {
  const opts = categoryItems.map((c) => ({ id: c.id, name: c.name, inactive: false }));
  if (!opts.some((o) => o.id === row.gym_charge_id)) {
    opts.unshift({ id: row.gym_charge_id, name: row.gym_charge_name, inactive: true });
  }
  return opts;
}

/** Appends the first category item not already in the draft. No-ops when every item is taken. */
export function addBenefitRow(setDraft: SetDraft, categoryItems: SellableItemOption[], draft: SellableItemBenefitRow[]) {
  const next = categoryItems.find((c) => !draft.some((d) => d.gym_charge_id === c.id));
  if (!next) return;
  setDraft((prev) => [
    ...prev,
    {
      gym_charge_id: next.id, quantity: 1, gym_charge_name: next.name,
      gym_charge_type: next.type, gym_charge_billing_frequency: next.billing_frequency,
      gym_charge_status: next.status,
    },
  ]);
}

/** Patches one draft row, re-deriving the joined item fields when the item itself changes. */
export function updateBenefitRow(
  setDraft: SetDraft,
  categoryItems: SellableItemOption[],
  idx: number,
  patch: Partial<SellableItemBenefitRow>,
) {
  setDraft((prev) => prev.map((r, i) => {
    if (i !== idx) return r;
    const next = { ...r, ...patch };
    if (patch.gym_charge_id != null) {
      const item = categoryItems.find((c) => c.id === patch.gym_charge_id);
      if (item) {
        next.gym_charge_name = item.name;
        next.gym_charge_type = item.type;
        next.gym_charge_billing_frequency = item.billing_frequency;
        next.gym_charge_status = item.status;
      }
    }
    return next;
  }));
}

/** Replace-all payload both the Promotion and the Plan benefit endpoints take. */
export const toBenefitItems = (draft: SellableItemBenefitRow[]) =>
  draft.map((b) => ({ gym_charge_id: b.gym_charge_id, quantity: b.quantity }));

const colHeaderSt: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const inlineSelectSt: React.CSSProperties = {
  padding: '5px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 12, background: '#fff',
};
const thSt: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px 4px 0', fontSize: 11, fontWeight: 600,
  color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
const tdSt: React.CSSProperties = { padding: '4px 8px 4px 0', fontSize: 13 };
const hintSt: React.CSSProperties = { margin: 0, fontSize: 13, color: '#888' };

/** The editable grid: item picker + quantity (+ the item's own, read-only frequency). */
export function SellableItemBenefitEditor({
  t, addKey, draft, setDraft, categoryItems, showFrequency,
}: {
  t: Translate;
  addKey: string;
  draft: SellableItemBenefitRow[];
  setDraft: SetDraft;
  categoryItems: SellableItemOption[];
  showFrequency: boolean;
}) {
  const hasMoreToAdd = categoryItems.some((c) => !draft.some((d) => d.gym_charge_id === c.id));
  return (
    <>
      {draft.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: showFrequency ? '1.3fr 80px 100px 28px' : '1.3fr 80px 28px',
            gap: '3px 8px', alignItems: 'center', marginBottom: 8,
          }}
        >
          <span style={colHeaderSt}>{t('col_sellable_item')}</span>
          <span style={colHeaderSt}>{t('col_quantity')}</span>
          {showFrequency && <span style={colHeaderSt}>{t('col_frequency')}</span>}
          <span />
          {draft.map((row, idx) => (
            <div key={row.gym_charge_id} style={{ display: 'contents' }}>
              <select
                value={row.gym_charge_id}
                onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { gym_charge_id: parseInt(e.target.value, 10) })}
                style={inlineSelectSt}
              >
                {benefitRowOptions(categoryItems, row).map((o) => (
                  <option key={o.id} value={o.id}>{o.inactive ? `${o.name} ${t('inactive_item_tag')}` : o.name}</option>
                ))}
              </select>
              <input
                type="number" min="1" value={row.quantity}
                onChange={(e) => updateBenefitRow(setDraft, categoryItems, idx, { quantity: parseInt(e.target.value, 10) || 1 })}
                style={{ ...inlineSelectSt, width: '100%' }}
              />
              {showFrequency && (
                <span style={{ fontSize: 13, color: '#666' }}>
                  {row.gym_charge_billing_frequency ? t(`frequency_${row.gym_charge_billing_frequency}`) : '—'}
                </span>
              )}
              <button
                onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', fontSize: 14, padding: 0 }}
              >✕</button>
            </div>
          ))}
        </div>
      )}
      {hasMoreToAdd && (
        <button onClick={() => addBenefitRow(setDraft, categoryItems, draft)} style={btnSmall('#6c63ff')}>{t(addKey)}</button>
      )}
    </>
  );
}

/** Read-only counterpart — what a section shows until its own Edit button is pressed. */
export function SellableItemBenefitView({
  t, emptyKey, rows, showFrequency,
}: {
  t: Translate;
  emptyKey: string;
  rows: SellableItemBenefitRow[];
  showFrequency: boolean;
}) {
  if (rows.length === 0) return <p style={hintSt}>{t(emptyKey)}</p>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr>
          <th style={thSt}>{t('col_sellable_item')}</th>
          <th style={thSt}>{t('col_quantity')}</th>
          {showFrequency && <th style={thSt}>{t('col_frequency')}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.gym_charge_id}>
            <td style={tdSt}>{r.gym_charge_name}{r.gym_charge_status !== 'active' && ` ${t('inactive_item_tag')}`}</td>
            <td style={tdSt}>{r.quantity}</td>
            {showFrequency && (
              <td style={tdSt}>{r.gym_charge_billing_frequency ? t(`frequency_${r.gym_charge_billing_frequency}`) : '—'}</td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
