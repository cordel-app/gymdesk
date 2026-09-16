'use client';

import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface BillingPolicySummary {
  recurring_billing_interval: number;
  recurring_billing_unit: string;
  recurring_service_interval: number;
  recurring_service_unit: string;
}

interface PlanSummary {
  id: number;
  name: string;
  description: string | null;
  lifecycle_status: string;
  enrollment_status: 'public' | 'staff_only';
  current_price: string | null;
  billing_policy: BillingPolicySummary | null;
  charge_benefits: unknown[];
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

  const priceLabel = plan.current_price != null ? `€${parseFloat(plan.current_price).toFixed(2)}` : null;
  const durationLabel = plan.billing_policy
    ? fmtBillingInterval(plan.billing_policy.recurring_service_interval, plan.billing_policy.recurring_service_unit)
    : null;
  const billingLabel = plan.billing_policy
    ? `Every ${fmtBillingInterval(plan.billing_policy.recurring_billing_interval, plan.billing_policy.recurring_billing_unit)}`
    : null;
  const enrollmentLabel = tStatus(plan.enrollment_status);

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('details_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{plan.name}</p>

        {/* Compact summary */}
        <div style={{ background: 'rgba(0,0,0,0.02)', borderRadius: 8, padding: '4px 12px', marginBottom: 16 }}>
          {field(t('details_summary_promotions'), String(plan.promotion_count))}
          {field(t('details_summary_pricing'), priceLabel)}
          {field(t('details_summary_benefits'), String((plan.charge_benefits ?? []).length))}
          {field(t('details_summary_duration'), durationLabel)}
          {field(t('details_summary_billing'), billingLabel)}
          {field(t('details_summary_enrollment'), enrollmentLabel)}
        </div>

        {/* Detailed information */}
        {field(t('details_name'), plan.name)}
        {field(t('details_description'), plan.description)}
        {field(t('details_status'), tStatus(plan.lifecycle_status as any))}
        {field(t('details_enrollment_status'), enrollmentLabel)}
        {field(t('label_current_price'), priceLabel)}
        {field(t('details_duration'), durationLabel)}
        {field(t('details_billing_frequency'), billingLabel)}
        {field(t('details_benefits'), String((plan.charge_benefits ?? []).length))}
        {field(t('details_promotions'), String(plan.promotion_count))}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
          <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('details_section_audit')}</p>
          {field(t('details_created_by'), plan.created_by_name)}
          {field(t('details_created_at'), plan.created_at?.slice(0, 10))}
          {field(t('details_modified_by'), plan.modified_by_name)}
          {field(t('details_modified_at'), plan.modified_at?.slice(0, 10))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('details_close')}</button>
        </div>
      </div>
    </div>
  );
}
