'use client';

// #2973 stage 2 — the collapsible Summary of a cart, drawn once for My Products
// and the Home cart card. Presentation only: the review (contracted items,
// cancelled items, the initial payment and its total) is the server's and was
// read with the version, so opening the card fetches nothing.
import type { CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { MemberCollapsibleCard } from '@/components/MemberCollapsibleCard';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDateOnly } from '@/lib/gymFormat';
import { memberTheme } from '@/lib/memberChrome';
import {
  reviewFrequencyKey,
  reviewBeneficiary,
  reviewLineDiscount,
  reviewSections,
  reviewPendingDeletions,
  type MemberSetReview,
} from '@/lib/memberProducts';
import { formatPaymentAmount, prepaidPaymentKey } from '@/lib/memberPayments';

export function CartSummary({ review, defaultOpen = false }: { review: MemberSetReview; defaultOpen?: boolean }) {
  const t = useTranslations();
  const gymFmt = useGymFormatSettings();
  const { contracted, cancelled } = reviewSections(review);
  const pendingDeletions = reviewPendingDeletions(review);
  const currency = review.currency ?? 'EUR';
  const money = (n: number | null | undefined) => (n == null ? '—' : formatPaymentAmount(n, currency, gymFmt));
  const itemRow = (i: typeof contracted[number], k: string) => {
    const freqKey = reviewFrequencyKey(i.billing_frequency);
    const price = i.final_price ?? i.regular_price;
    const beneficiary = reviewBeneficiary(review, i);
    return (
      <li key={k} style={S.item}>
        <span style={i.state === 'cancelling' ? { ...S.text, textDecoration: 'line-through' } : S.text}>{i.name}</span>
        {beneficiary && <span style={S.meta}>· {'family' in beneficiary ? t('membership.summary_beneficiary_family') : beneficiary.name}</span>}
        {i.quantity != null && i.quantity > 1 && <span style={S.meta}>× {i.quantity}</span>}
        {price != null && <span style={S.meta}>· {money(price)}{freqKey ? ` / ${t(freqKey as any)}` : ''}</span>}
        {i.promotions.filter(Boolean).length > 0 && <span style={S.meta}>· {i.promotions.filter(Boolean).join(', ')}</span>}
      </li>
    );
  };
  return (
    <MemberCollapsibleCard
      title={t('membership.summary_heading')}
      summary={t('membership.summary_total_short', { amount: money(review.amount_due) })}
      defaultOpen={defaultOpen}
      bodyStyle={S.body}
    >
      <p style={S.label}>{t('membership.summary_contracted')}</p>
      {contracted.length === 0
        ? <p style={S.hint}>{t('membership.summary_none')}</p>
        : <ul style={S.list}>{contracted.map((i, n) => itemRow(i, `c-${n}`))}</ul>}
      {cancelled.length > 0 && (<>
        <p style={S.label}>{t('membership.summary_cancelled')}</p>
        <ul style={S.list}>{cancelled.map((i, n) => itemRow(i, `x-${n}`))}</ul>
      </>)}
      {pendingDeletions.length > 0 && (<>
        <p style={S.label}>{t('membership.summary_deleted')}</p>
        <ul style={S.list}>
          {pendingDeletions.map((d, n) => (
            <li key={`d-${n}`} data-pending-deletion style={{ ...S.item, color: memberTheme.statusError }}>
              <span style={{ ...S.text, color: memberTheme.statusError }}>{d.name}</span>
              <span style={{ ...S.meta, color: memberTheme.statusError, border: `1px solid ${memberTheme.statusError}`, borderRadius: 10, padding: '0 6px', fontWeight: 600 }}>{t('membership.summary_deleted_chip')}</span>
              {d.ends_on && <span style={{ ...S.meta, color: memberTheme.statusError }}>· {t('membership.summary_ends_on', { date: formatGymDateOnly(d.ends_on, gymFmt) })}</span>}
            </li>
          ))}
        </ul>
      </>)}
      <p style={S.label}>{t('membership.summary_initial_payment')}</p>
      {review.immediate_lines.length === 0
        ? <p style={S.hint}>{t('membership.summary_nothing_due')}</p>
        : (
          <ul style={S.list}>
            {review.immediate_lines.map((l, n) => {
              const discount = reviewLineDiscount(l);
              const prepaidKey = prepaidPaymentKey(l.prepaid_periods, l.prepaid_cadence);
              const sub = [
                // #2883 — a Membership Fee collecting a Pre-paid Duration says how many periods it covers.
                prepaidKey ? t(`payments.${prepaidKey}` as any, { count: l.prepaid_periods as number }) : null,
                l.regular_unit_price != null ? t('membership.summary_line_regular', { amount: money(l.regular_unit_price) }) : null,
                l.promotion_name ? t('membership.summary_line_promotion', { name: l.promotion_name }) : null,
                discount != null ? t('membership.summary_line_discount', { amount: money(discount) }) : null,
                l.tax_rate_percent != null ? t('membership.summary_line_tax', { rate: l.tax_rate_percent }) : null,
              ].filter(Boolean).join(' · ');
              return (
                <li key={`l-${n}`} style={S.line}>
                  <div style={S.row}>
                    <span style={S.text}>{l.item_name ?? '—'}{l.quantity > 1 ? ` × ${l.quantity}` : ''}</span>
                    <span style={S.amount}>{money(l.amount)}</span>
                  </div>
                  {sub && <div style={S.sub}>{sub}</div>}
                </li>
              );
            })}
          </ul>
        )}
      <div style={S.total}>
        <span style={{ ...S.text, fontWeight: 700 }}>{t('membership.summary_total')}</span>
        <span style={{ ...S.amount, fontWeight: 700 }}>{money(review.amount_due)}</span>
      </div>
    </MemberCollapsibleCard>
  );
}

const S: Record<string, CSSProperties> = {
  body: { padding: '0 16px 14px', fontSize: 13 },
  label: { margin: '10px 0 4px', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: memberTheme.textMuted },
  hint: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { padding: '5px 0', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'baseline' },
  line: { padding: '5px 0' },
  text: { fontSize: 13, color: memberTheme.text },
  meta: { fontSize: 11.5, color: memberTheme.textMuted },
  amount: { fontSize: 13, fontVariantNumeric: 'tabular-nums', color: memberTheme.text },
  sub: { fontSize: 11.5, color: memberTheme.textMuted, marginTop: 2 },
  total: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, paddingTop: 8 },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
};
