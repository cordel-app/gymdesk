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
import { alertTextColor, cardHintStyle, cardSubLabelStyle } from '@/components/formChrome';
import { primaryActionColors } from '@/components/ui';
import { listHeaderCellStyle, listCellStyle, LIST_DIVIDER_COLOR } from '@/components/listChrome';
import { formatGymDateOnly } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { billingFrequencyLabel, cadenceFrequencyLabel, prepaidPaymentLabel } from '@/lib/billingFrequency';
import { lineSourceLabelKey } from '@/lib/billingEventLineSource';
import type { ContractedItemLike, InitialPaymentLike } from './productsWorkflowView';
import { compactInitialPaymentLabel, contractedMembersText, discountEntries, initialPaymentLineAction, lineReducedToZero, splitContracted } from './productsWorkflowView';
import { secondaryBtnSmall } from '@/components/formChrome';

const money = (n: number) => `${n.toFixed(2)} €`;

/**
 * `compact` (#3285) is the Save & Pay confirmation's view of the same read: one row per line with
 * the item (its quantity appended when above one) and the line's final VAT-inclusive `amount`,
 * zero lines included, in the server's order; the totals below are the full view's, unchanged.
 * The Products tab's Summary keeps the full breakdown.
 */
/**
 * #3284 stage 2 — the staff per-line Waive / Revert waive. Passed only where an In Cart Initial
 * Payment is editable (the Products tab's Summary); a read-only view passes none and renders no
 * action column. The server re-prices and re-judges every request; this only asks.
 */
export interface InitialPaymentWaiveControl {
  onAction: (kind: 'waive' | 'revert', lineKey: string) => void;
  /** The line a request is in flight for; every action is disabled meanwhile. */
  busyKey: string | null;
}

export function InitialPaymentSection({ payment, compact = false, waive = null }: {
  payment: InitialPaymentLike | null | undefined; compact?: boolean; waive?: InitialPaymentWaiveControl | null;
}) {
  const t = useTranslations('members');
  const tFreq = useTranslations('billing_frequency');
  // #3270 — the Source column reads the Billing Event Line's own `source` (#3254), worded as the
  // Billing Event details already word it.
  const tLine = useTranslations('billing_events_page');
  const fmt = useGymFormatSettings();
  if (!payment) return null;
  if (payment.total == null) return <p style={cardHintStyle}>{t('review_error_amount')}</p>;
  if (payment.lines.length === 0) return <p style={cardHintStyle}>{t('review_nothing_due')}</p>;
  const totalsBlock = (
    <div style={totals}>
      {payment.discount_total > 0 && <>
        <TotalRow label={t('checkout_total_before_discounts')} value={money(payment.total_before_discounts)} />
        <TotalRow label={t('checkout_total_discounts')} value={`−${money(payment.discount_total)}`} />
      </>}
      <TotalRow label={t('checkout_subtotal_excl_vat')} value={money(payment.subtotal_excl_tax)} />
      <TotalRow label={t('checkout_total_vat')} value={money(payment.tax_total)} />
      <TotalRow strong label={t('checkout_total_initial_payment')} value={money(payment.total)} />
    </div>
  );
  if (compact) {
    return (
      <div data-initial-payment data-initial-payment-compact>
        <table style={compactTable}>
          <thead>
            <tr>
              <th style={th}>{t('checkout_col_item')}</th>
              <th style={thNum}>{t('checkout_col_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {payment.lines.map((l, i) => (
              <tr key={i} data-initial-payment-line>
                <td style={compactItem}>{compactInitialPaymentLabel(l)}</td>
                <td style={tdNum}>{money(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {totalsBlock}
      </div>
    );
  }
  return (
    <div data-initial-payment style={{ overflowX: 'auto' }}>
      <table style={table}>
        <thead>
          <tr>
            <th style={th}>{t('checkout_col_item')}</th>
            <th style={th}>{tLine('col_line_source')}</th>
            <th style={thNum}>{t('checkout_col_quantity')}</th>
            <th style={thNum}>{t('checkout_col_unit_price')}</th>
            <th style={thNum}>{t('checkout_col_line_total')}</th>
            <th style={th}>{t('checkout_col_discount')}</th>
            <th style={thNum}>{t('checkout_col_tax_rate')}</th>
            <th style={thNum}>{t('checkout_col_tax')}</th>
            <th style={thNum}>{t('checkout_col_amount')}</th>
            {waive && <th style={thNum} data-initial-payment-actions>{t('col_actions')}</th>}
          </tr>
        </thead>
        <tbody>
          {payment.lines.map((l, i) => {
            const action = waive ? initialPaymentLineAction(l) : null;
            const entries = discountEntries(l);
            // #2883 — a Membership Fee charge that collects a Pre-paid Duration says how many billing
            // periods its amount covers, in the plan's cadence; the quantity stays the number of fees.
            const prepaid = prepaidPaymentLabel(l.prepaid_periods, l.prepaid_cadence, tFreq as any);
            return (
              <tr key={i} data-initial-payment-line>
                <td style={td}>
                  {l.name ?? '—'}
                  {l.fee_split && (
                    // #2970 — the prorated stretch and the full prepaid periods are separate parts of
                    // this charge, each with its own dates and amount (VAT included).
                    <span data-fee-split style={{ ...cardHintStyle, margin: 0, display: 'block' }}>
                      <span data-fee-prorated style={{ display: 'block' }}>
                        {t('checkout_split_prorated', {
                          start: formatGymDateOnly(l.fee_split.prorated.start, fmt), end: formatGymDateOnly(l.fee_split.prorated.end, fmt),
                          days: l.fee_split.prorated.days, period: l.fee_split.prorated.period_days, amount: money(l.fee_split.prorated.amount),
                        })}
                      </span>
                      {l.fee_split.prepaid && (
                        <span data-fee-prepaid style={{ display: 'block' }}>
                          {t('checkout_split_prepaid', {
                            periods: l.fee_split.prepaid.periods,
                            start: formatGymDateOnly(l.fee_split.prepaid.start, fmt), end: formatGymDateOnly(l.fee_split.prepaid.end, fmt),
                            amount: money(l.fee_split.prepaid.amount),
                          })}
                        </span>
                      )}
                    </span>
                  )}
                  {l.proration && (
                    // #3165 stage 2 — the proration the first charge applied, by the Product's own calendar.
                    <span data-line-proration style={{ ...cardHintStyle, margin: 0, display: 'block' }}>
                      {t('checkout_line_prorated', { days: l.proration.days, period: l.proration.period_days })}
                    </span>
                  )}
                  {prepaid && <span data-prepaid-periods style={{ ...cardHintStyle, margin: 0, display: 'block' }}>{prepaid}</span>}
                </td>
                <td style={td} data-line-source={l.source ?? ''}>
                  {(() => { const key = lineSourceLabelKey(l.source); return key ? tLine(key) : '—'; })()}
                </td>
                <td style={tdNum}>{l.quantity}</td>
                <td style={tdNum}>{money(l.unit_price)}</td>
                <td style={tdNum} data-line-total>{money(l.line_total)}</td>
                <td style={td}>
                  {l.discount > 0 ? `−${money(l.discount)}` : (entries.length === 0 ? '—' : null)}
                  {/* #3284 — every treatment, each with its type (Benefit / Discount / Manual adjustment). */}
                  {entries.map((e, k) => (
                    <span key={k} data-line-reason={e.typeKey ?? ''} style={{ ...cardHintStyle, margin: 0, display: 'block' }}>
                      {e.key ? t(e.key as any, e.values as any) : e.text}
                      {e.typeKey ? ` · ${t(e.typeKey as any)}` : ''}
                    </span>
                  ))}
                </td>
                <td style={tdNum}>{l.tax_rate_percent != null ? `${l.tax_rate_percent}%` : '—'}</td>
                <td style={tdNum}>{money(l.tax_amount)}</td>
                <td style={tdNum}>
                  {money(l.amount)}
                  {lineReducedToZero(l) && <div style={{ ...cardHintStyle, margin: 0 }} data-line-free>{t('checkout_line_no_charge')}</div>}
                </td>
                {waive && (
                  <td style={tdNum}>
                    {action && (
                      <button
                        type="button"
                        data-line-action={action.kind}
                        style={secondaryBtnSmall}
                        disabled={!action.enabled || waive.busyKey != null}
                        title={!action.enabled ? t('checkout_waive_unavailable') : undefined}
                        onClick={() => waive.onAction(action.kind, action.lineKey)}
                      >
                        {t(action.kind === 'waive' ? 'checkout_action_waive' : 'checkout_action_revert_waive')}
                      </button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {totalsBlock}
    </div>
  );
}

/**
 * #3188 — the Summary of a cart being reviewed: one panel on the Theme's app background, the
 * Total Initial Payment large at its upper right, the full breakdown and the contracted items
 * below. The headline is `payment.total`, the very figure the breakdown's last row prints, so the
 * two cannot disagree; it re-renders with the read whenever the cart changes. The header wraps,
 * so on a narrow screen the amount drops under the title rather than covering the breakdown.
 */
export function CheckoutSummaryPanel({ payment, contracted, waive = null }: {
  payment: InitialPaymentLike | null | undefined;
  contracted: ContractedItemLike[] | null | undefined;
  /** #3284 stage 2 — the per-line Waive / Revert waive, only where the In Cart payment is editable. */
  waive?: InitialPaymentWaiveControl | null;
}) {
  const t = useTranslations('members');
  const total = payment?.total ?? null;
  return (
    <div data-checkout-summary style={panel}>
      <div style={panelHeader}>
        <div style={sectionHeading} data-summary-heading>{t('checkout_initial_payment')}</div>
        {total != null && (
          <div data-initial-payment-headline style={headline}>
            <div style={headlineLabel}>{t('checkout_total_initial_payment')}</div>
            <div style={headlineAmount}>{money(total)}</div>
          </div>
        )}
      </div>
      <InitialPaymentSection payment={payment} waive={waive} />
      <div style={{ ...sectionHeading, marginTop: 20 }} data-summary-heading>{t('checkout_contracted')}</div>
      <ContractedItemsSection items={contracted} />
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
  const gymFmt = useGymFormatSettings();
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
          <li key={n} data-contracted-kind={i.kind} {...(i.pending_deletion ? { 'data-pending-deletion': true } : {})} {...(i.pending_reactivation ? { 'data-pending-reactivation': true } : {})}
            style={i.pending_deletion ? { color: alertTextColor } : undefined}>
            <strong>{i.name}</strong>
            {i.pending_deletion && (
              <>
                {' '}<span data-deleted-chip style={{ border: `1px solid ${alertTextColor}`, borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 600 }}>{t('checkout_deleted')}</span>
                {i.pending_deletion.ends_on ? ` · ${t('checkout_ends_on', { date: formatGymDateOnly(i.pending_deletion.ends_on, gymFmt) })}` : ''}
              </>
            )}
            {i.pending_reactivation && (
              <>
                {' '}<span data-reactivated-chip style={{ border: '1px solid currentColor', borderRadius: 10, padding: '0 6px', fontSize: 11, fontWeight: 600 }}>{t('checkout_reactivated')}</span>
                {` · ${t('product_set_open_ended')}`}
              </>
            )}
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
// #3285 — two columns that fit the modal: the item takes the width and wraps by words only, the
// amount never wraps; `fixed` would squeeze the amount, so the table sizes from its content.
const compactTable: CSSProperties = { ...table, tableLayout: 'auto' };
const td: CSSProperties = { ...listCellStyle, padding: '6px 8px', fontSize: 13, borderTop: `1px solid ${LIST_DIVIDER_COLOR}` };
const tdNum: CSSProperties = { ...td, textAlign: 'right', whiteSpace: 'nowrap' };
const compactItem: CSSProperties = { ...td, width: '100%', overflowWrap: 'anywhere' };
const totals: CSSProperties = { marginTop: 8, marginLeft: 'auto', maxWidth: 360, fontSize: 13, display: 'grid', gap: 2 };
// #3188 (reopened) — the Member's expanded row is itself drawn on the Theme's app background
// (`listExpandedStyle`), so a panel painted with that same token was invisible. The panel takes
// the card surface tinted with the Theme's primary action colour, with a left rail in that colour,
// so it stands out on any theme without a colour of its own.
const SUMMARY_ACCENT = String(primaryActionColors.background);
const SUMMARY_SURFACE = 'var(--gd-card-bg, #ffffff)';
const panel: CSSProperties = {
  background: `color-mix(in srgb, ${SUMMARY_ACCENT} 7%, ${SUMMARY_SURFACE})`,
  border: `1px solid color-mix(in srgb, ${SUMMARY_ACCENT} 30%, ${SUMMARY_SURFACE})`,
  borderLeft: `4px solid ${SUMMARY_ACCENT}`, borderRadius: 8,
  padding: '14px 16px', marginTop: 8, marginBottom: 12,
};
const panelHeader: CSSProperties = {
  display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '4px 16px', marginBottom: 8,
};
const headline: CSSProperties = { marginLeft: 'auto', textAlign: 'right' };
// #3270 — the two section headings of the Summary (Initial Payment, Contracted Products & Plans):
// the Theme's own text colour at a heading's size and weight, so they read as the sections' titles
// and stay apart from the muted sub-labels and line details below them.
const sectionHeading: CSSProperties = {
  fontSize: 16, fontWeight: 700, lineHeight: 1.3, color: 'var(--gd-text, #111827)', margin: '0 0 6px',
};
const headlineLabel: CSSProperties = { ...cardSubLabelStyle, margin: 0 };
const headlineAmount: CSSProperties = { fontSize: 32, fontWeight: 800, lineHeight: 1.1, whiteSpace: 'nowrap', color: 'var(--gd-text, #111827)' };
