'use client';

// #2860 — the Product Set Summary shown before Save & Pay, as two sections:
//
//   - Initial Payment: the commit charge line by line (quantity, the price of
//     one unit, the line total before discounts, the discount and what it is,
//     tax rate, tax, final amount — #2890) with the subtotal, the discounts, the tax
//     breakdown by rate and the total. Every figure is the server's
//     (`initial_payment` on `GET /product-sets/:id/review`, which restates
//     `commitCharge()`): nothing here adds anything up.
//   - Contracted Products & Plans: names, the billing period and the members
//     only. The shape it draws carries no amount.
//
// Both are presentation of one read, which the Summary re-asks whenever the
// Draft changes (`useDraftReview()`'s reload key), so they cannot drift apart.

import React, { type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { cardHintStyle, cardSubLabelStyle } from '@/components/formChrome';
import { listHeaderCellStyle, listCellStyle, LIST_DIVIDER_COLOR } from '@/components/listChrome';
import { billingFrequencyLabel, cadenceFrequencyLabel } from '@/lib/billingFrequency';
import type { ContractedItemLike, InitialPaymentLike } from './productsWorkflowView';
import { contractedMembersText, discountText, lineReducedToZero, splitContracted } from './productsWorkflowView';

const money = (n: number) => `${n.toFixed(2)} €`;

export function InitialPaymentSection({ payment }: { payment: InitialPaymentLike | null | undefined }) {
  const t = useTranslations('members');
  if (!payment) return null;
  if (payment.total == null) return <p style={cardHintStyle}>{t('review_error_amount')}</p>;
  if (payment.lines.length === 0) return <p style={cardHintStyle}>{t('review_nothing_due')}</p>;
  return (
    <div data-initial-payment style={{ overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>{t('checkout_col_item')}</th>
            <th style={thNum}>{t('checkout_col_quantity')}</th>
            <th style={thNum}>{t('checkout_col_unit_price')}</th>
            <th style={thNum}>{t('checkout_col_line_total')}</th>
            <th style={th}>{t('checkout_col_discount')}</th>
            <th style={thNum}>{t('checkout_col_tax_rate')}</th>
            <th style={thNum}>{t('checkout_col_tax')}</th>
            <th style={thNum}>{t('checkout_col_amount')}</th>
          </tr>
        </thead>
        <tbody>
          {payment.lines.map((l, i) => {
            const d = discountText(l);
            return (
              <tr key={i} data-initial-payment-line>
                <td style={td}>{l.name ?? '—'}</td>
                <td style={tdNum}>{l.quantity}</td>
                <td style={tdNum}>{money(l.unit_price)}</td>
                <td style={tdNum} data-line-total>{money(l.line_total)}</td>
                <td style={td}>
                  {l.discount > 0 ? `−${money(l.discount)}` : '—'}
                  {d && <span style={{ ...cardHintStyle, margin: 0 }}>{` (${d.key ? t(d.key as any, d.values as any) : d.text})`}</span>}
                </td>
                <td style={tdNum}>{l.tax_rate_percent != null ? `${l.tax_rate_percent}%` : '—'}</td>
                <td style={tdNum}>{money(l.tax_amount)}</td>
                <td style={tdNum}>
                  {money(l.amount)}
                  {lineReducedToZero(l) && <div style={{ ...cardHintStyle, margin: 0 }} data-line-free>{t('checkout_line_no_charge')}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={totals}>
        {payment.discount_total > 0 && <>
          <TotalRow label={t('checkout_total_before_discounts')} value={money(payment.total_before_discounts)} />
          <TotalRow label={t('checkout_total_discounts')} value={`−${money(payment.discount_total)}`} />
        </>}
        <TotalRow label={t('checkout_subtotal_excl_vat')} value={money(payment.subtotal_excl_tax)} />
        {payment.taxes.map((r) => (
          <TotalRow key={String(r.rate_percent)} label={t('checkout_tax_at_rate', { rate: r.rate_percent ?? 0, base: money(r.base) })} value={money(r.tax)} />
        ))}
        <TotalRow label={t('checkout_total_vat')} value={money(payment.tax_total)} />
        <TotalRow strong label={t('checkout_total_initial_payment')} value={money(payment.total)} />
      </div>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, fontWeight: strong ? 700 : 400 }} data-total-row>
      <span>{label}</span><span>{value}</span>
    </div>
  );
}

export function ContractedItemsSection({ items }: { items: ContractedItemLike[] | null | undefined }) {
  const t = useTranslations('members');
  const tFreq = useTranslations('billing_frequency');
  if (!items) return null;
  if (items.length === 0) return <p style={cardHintStyle}>{t('checkout_contracted_none')}</p>;
  const { recurring, oneOff } = splitContracted(items);
  const period = (i: ContractedItemLike | { billing_frequency: string | null; cadence?: null }) =>
    'cadence' in i && i.cadence
      ? cadenceFrequencyLabel(i.cadence.interval, i.cadence.unit, tFreq)
      : billingFrequencyLabel(i.billing_frequency, tFreq) ?? '—';
  const members = (list: ContractedItemLike['members']) => contractedMembersText(list) ?? t('checkout_members_family');
  const group = (label: string, list: ContractedItemLike[], attr: string) => list.length > 0 && (
    <div {...{ [attr]: true }} style={{ marginBottom: 8 }}>
      <div style={cardSubLabelStyle}>{label}</div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 14 }}>
        {list.map((i, n) => (
          <li key={n} data-contracted-kind={i.kind}>
            <strong>{i.name}</strong>
            {i.quantity != null && i.quantity > 1 ? ` × ${i.quantity}` : ''}
            {' · '}{i.period === 'one_off' ? t('checkout_one_off') : period(i)}
            {' · '}{members(i.members)}
            {i.included.length > 0 && (
              <ul style={{ margin: '2px 0 0', paddingLeft: 18, fontSize: 13 }}>
                {i.included.map((b, k) => (
                  <li key={k}>
                    {b.name}{b.quantity > 1 ? ` × ${b.quantity}` : ''}
                    {` · ${billingFrequencyLabel(b.billing_frequency, tFreq) ?? '—'}`}
                    {b.members.length > 0 ? ` · ${contractedMembersText(b.members)}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div data-contracted-items>
      {group(t('checkout_recurring'), recurring, 'data-contracted-recurring')}
      {group(t('checkout_one_off_products'), oneOff, 'data-contracted-one-off')}
    </div>
  );
}

const table: CSSProperties = { width: '100%', borderCollapse: 'collapse', fontSize: 13 };
const th: CSSProperties = { ...listHeaderCellStyle, textAlign: 'left', padding: '6px 8px', fontSize: 13 };
const thNum: CSSProperties = { ...th, textAlign: 'right' };
const td: CSSProperties = { ...listCellStyle, padding: '6px 8px', fontSize: 13, borderTop: `1px solid ${LIST_DIVIDER_COLOR}` };
const tdNum: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const totals: CSSProperties = { marginTop: 8, marginLeft: 'auto', maxWidth: 360, fontSize: 13, display: 'grid', gap: 2 };
