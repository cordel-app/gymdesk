'use client';

import { useTranslations } from 'next-intl';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import {
  PLAN_BILLING_FREQUENCY_OPTIONS,
  formatPlanDurationPeriods,
  legacyBillingFrequencyText,
  planBillingFrequencyOf,
} from './planProfile';

interface BillingPolicySummary {
  recurring_billing_interval: number;
  recurring_billing_unit: string;
}

interface PlanSummary {
  id: number;
  name: string;
  description: string | null;
  lifecycle_status: string;
  enrollment_status: 'public' | 'staff_only';
  current_price: string | null;
  billing_policy: BillingPolicySummary | null;
  // #635 stage 13: the Plan's Duration is its Billing & Duration, not the
  // retired `recurring_service_*` pair this row used to read (migration 189).
  // #892: counts of `billing_policy`'s periods, not of calendar months.
  free_periods: number | null;
  paid_periods: number | null;
  pay_beforehand_periods: number | null;
  bonus_periods: number | null;
  // #635 stage 4: the Benefits count is the three Product-keyed
  // sections, now that Charge Benefits are gone.
  session_benefits: unknown[];
  oneoff_benefits: unknown[];
  periodical_benefits: unknown[];
  promotion_count: number;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
}

// #512: read-only Details modal, following the Promotion Details modal pattern
// (see PromotionDetailModal.tsx). Independent from the row's inline expand/collapse.
export function PlanDetailModal({ plan, onClose }: {
  plan: PlanSummary;
  onClose: () => void;
}) {
  const t = useTranslations('plans');
  const tStatus = useTranslations('status');
  const unknown = t('details_unknown');

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || unknown}</span>
    </div>
  );

  // Each Billing & Duration field on its own row: the four are what the Plan
  // stores, and summing them here would be business logic in the frontend.
  // #892: each is a count of the Plan's own Billing Frequency periods, and
  // reads with that unit — the same helper the card's summary renders through.
  const duration = (label: string, value: number | null) =>
    field(label, formatPlanDurationPeriods(value, plan.billing_policy, t as any));

  const priceLabel = plan.current_price != null ? `€${parseFloat(plan.current_price).toFixed(2)}` : null;

  // #820: the same two labels the Billing frequency dropdown offers, so the
  // Details view and the card cannot name the same cadence differently. A Plan
  // configured before the rule still reads as the cadence it bills on.
  const billingFrequency = plan.billing_policy
    ? planBillingFrequencyOf(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)
    : null;
  const billingLabel = !plan.billing_policy
    ? null
    : billingFrequency
      ? t(PLAN_BILLING_FREQUENCY_OPTIONS[billingFrequency].labelKey as any)
      : legacyBillingFrequencyText(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit);
  const enrollmentLabel = tStatus(plan.enrollment_status);

  const benefitCount = (plan.session_benefits ?? []).length
    + (plan.oneoff_benefits ?? []).length
    + (plan.periodical_benefits ?? []).length;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('details_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{plan.name}</p>

        {/* Compact summary */}
        <div style={{ background: 'rgba(0,0,0,0.02)', borderRadius: 8, padding: '4px 12px', marginBottom: 16 }}>
          {field(t('details_summary_promotions'), String(plan.promotion_count))}
          {field(t('details_summary_pricing'), priceLabel)}
          {field(t('details_summary_benefits'), String(benefitCount))}
          {field(t('details_summary_billing'), billingLabel)}
          {field(t('details_summary_enrollment'), enrollmentLabel)}
        </div>

        {/* Detailed information */}
        {field(t('details_name'), plan.name)}
        {field(t('details_description'), plan.description)}
        {field(t('details_status'), tStatus(plan.lifecycle_status as any))}
        {field(t('details_enrollment_status'), enrollmentLabel)}
        {field(t('label_current_price'), priceLabel)}
        {duration(t('label_free_periods'), plan.free_periods)}
        {duration(t('label_paid_periods'), plan.paid_periods)}
        {duration(t('label_pay_beforehand_periods'), plan.pay_beforehand_periods)}
        {duration(t('label_bonus_periods'), plan.bonus_periods)}
        {field(t('details_billing_frequency'), billingLabel)}
        {field(t('details_benefits'), String(benefitCount))}
        {field(t('details_promotions'), String(plan.promotion_count))}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
          <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('details_section_audit')}</p>
          {field(t('details_created_by'), plan.created_by_name)}
          {field(t('details_created_at'), plan.created_at?.slice(0, 10))}
          {field(t('details_modified_by'), plan.modified_by_name)}
          {field(t('details_modified_at'), plan.modified_at?.slice(0, 10))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <ViewAuditLogButton entityType="membership_plan" entityId={plan.id} onNavigate={onClose} />
          <button onClick={onClose} style={btnStyle('#444')}>{t('details_close')}</button>
        </div>
      </div>
    </div>
  );
}
