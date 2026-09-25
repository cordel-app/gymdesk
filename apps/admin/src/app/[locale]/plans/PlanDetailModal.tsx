'use client';

import { useTranslations } from 'next-intl';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

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
  free_months: number | null;
  paid_months: number | null;
  pay_beforehand_months: number | null;
  bonus_months: number | null;
  // #635 stage 4: the Benefits count is the three Sellable-Item-keyed
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

function fmtBillingInterval(interval: number, unit: string) {
  if (interval === 1) return unit;
  return `${interval} ${unit}s`;
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
  const months = (label: string, value: number | null) =>
    field(label, value != null ? t('months_value', { n: value }) : t('not_configured'));

  const priceLabel = plan.current_price != null ? `€${parseFloat(plan.current_price).toFixed(2)}` : null;

  const billingLabel = plan.billing_policy
    ? `Every ${fmtBillingInterval(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)}`
    : null;
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
        {months(t('label_free_months'), plan.free_months)}
        {months(t('label_paid_months'), plan.paid_months)}
        {months(t('label_pay_beforehand_months'), plan.pay_beforehand_months)}
        {months(t('label_bonus_months'), plan.bonus_months)}
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
