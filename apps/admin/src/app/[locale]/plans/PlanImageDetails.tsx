'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import { BILLING_FREQUENCY_NAMESPACE, billingFrequencyLabel } from '@/lib/billingFrequency';
import { isMandatoryBenefitRow, type ProductBenefitRow } from '@/lib/benefitEditing';
import {
  PLAN_BILLING_FREQUENCY_OPTIONS,
  formatPlanDurationPeriods,
  legacyBillingFrequencyText,
  planBillingFrequencyOf,
} from './planProfile';

export interface PlanImageDetailsPlan {
  description: string | null;
  current_price: string | null;
  amount_incl_tax: number | null;
  billing_policy: { recurring_billing_interval: number; recurring_billing_unit: string; auto_renew?: boolean | number } | null;
  free_periods: number | null;
  paid_periods: number | null;
  pay_beforehand_periods: number | null;
  bonus_periods: number | null;
  oneoff_benefits: ProductBenefitRow[];
  session_benefits: ProductBenefitRow[];
  periodical_benefits: ProductBenefitRow[];
}

const sectionTitle: React.CSSProperties = {
  margin: '20px 0 6px', fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em',
};
const rowStyle: React.CSSProperties = { display: 'flex', gap: 12, padding: '6px 0', borderBottom: '1px solid #f5f5f5', fontSize: 14 };

/**
 * #2408 — what the plan image viewer shows under the image (after the
 * description): pricing, billing and the included Products by benefit category.
 * Presentational: it reads the plan row the page already holds and computes
 * nothing (the price and the treatments are the server's, #817/#916).
 */
export function PlanImageDetails({ plan }: { plan: PlanImageDetailsPlan }) {
  const t = useTranslations('plans');
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const price = plan.amount_incl_tax != null
    ? `€${plan.amount_incl_tax.toFixed(2)}`
    : plan.current_price != null ? `€${parseFloat(plan.current_price).toFixed(2)}` : null;
  const bp = plan.billing_policy;
  const freq = bp ? planBillingFrequencyOf(bp.recurring_billing_interval, bp.recurring_billing_unit) : null;
  const freqLabel = !bp ? null : freq
    ? tFreq(PLAN_BILLING_FREQUENCY_OPTIONS[freq].labelKey as any)
    : legacyBillingFrequencyText(bp.recurring_billing_interval, bp.recurring_billing_unit);
  const durations: [string, number | null][] = [
    [t('label_free_periods'), plan.free_periods],
    [t('label_pay_beforehand_periods'), plan.pay_beforehand_periods],
    [t('label_paid_periods'), plan.paid_periods],
    [t('label_bonus_periods'), plan.bonus_periods],
  ];
  // Only what is applicable: a duration the plan never configured is left out.
  const shownDurations = durations.filter(([, v]) => v != null && v > 0);
  const all = [...plan.oneoff_benefits, ...plan.session_benefits, ...plan.periodical_benefits];
  const waived = all.filter((r) => r.action === 'waive');
  const kv = (label: string, value: string) => (
    <div style={rowStyle} key={label}>
      <span style={{ width: 170, flexShrink: 0, color: '#888' }}>{label}</span>
      <span style={{ color: '#333' }}>{value}</span>
    </div>
  );
  const sections: [string, ProductBenefitRow[]][] = [
    [t('section_oneoff_benefits'), plan.oneoff_benefits],
    [t('section_session_benefits'), plan.session_benefits],
    [t('section_plan_period_benefits'), plan.periodical_benefits],
  ];
  const treatment = (r: ProductBenefitRow) => {
    if (!r.action || r.action === 'no_benefit') return null;
    const base = t(`item_action_${r.action}` as any);
    return r.value != null && r.value !== '' && r.action === 'percentage_discount' ? `${base} ${r.value}%` : base;
  };
  return (
    <div>
      <div style={sectionTitle}>{t('viewer_section_pricing')}</div>
      {kv(t('label_current_price'), price ? `${price}${plan.amount_incl_tax != null ? ` (${t('tax_included_suffix')})` : ''}` : '—')}

      <div style={sectionTitle}>{t('viewer_section_billing')}</div>
      {freqLabel && kv(t('details_billing_frequency'), freqLabel)}
      {shownDurations.map(([label, v]) => kv(label, formatPlanDurationPeriods(v, bp, t as any)))}
      {bp && bp.auto_renew != null && kv(t('label_auto_renew'), t(bp.auto_renew ? 'viewer_yes' : 'viewer_no'))}
      {waived.length > 0 && kv(t('viewer_waived_benefits'), waived.map((r) => r.product_name).join(', '))}

      <div style={sectionTitle}>{t('viewer_section_products')}</div>
      {all.length === 0 && <p style={{ margin: 0, fontSize: 14, color: '#888' }}>{t('viewer_no_products')}</p>}
      {sections.map(([title, rows]) => rows.length === 0 ? null : (
        <div key={title} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600, margin: '8px 0 2px' }}>{title}</div>
          {rows.map((r) => {
            const mandatory = r.mandatory !== undefined ? r.mandatory : isMandatoryBenefitRow(r);
            const parts = [
              `${t('col_quantity')}: ${r.quantity}`,
              r.frequency ? null : billingFrequencyLabel(r.product_billing_frequency, tFreq as any),
              treatment(r),
            ].filter(Boolean);
            return (
              <div key={`${r.product_id}-${title}`} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0 }}>{r.product_name}</span>
                <span style={{ color: '#666', fontSize: 13 }}>{parts.join(' · ')}</span>
                <span style={{ fontSize: 12, color: mandatory ? '#333' : '#888', fontWeight: 600 }}>
                  {mandatory ? t('mandatory_item_tag') : t('viewer_optional_tag')}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
