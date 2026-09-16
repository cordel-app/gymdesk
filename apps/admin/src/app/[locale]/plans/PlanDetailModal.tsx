'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface BillingPolicyDetail {
  recurring_billing_interval: number;
  recurring_billing_unit: string;
  recurring_service_interval: number;
  recurring_service_unit: string;
}

interface AllowanceDetail {
  id: number;
  activity_type_name: string;
  allowance_type: 'unlimited' | 'session_count';
  session_count: number | null;
  recurrence_interval: number | null;
  recurrence_unit: string | null;
}

interface ChargeBenefitDetail {
  id: number;
  gym_charge_name: string;
  action: string;
  value: string | null;
}

interface PromotionRef {
  id: number;
  name: string;
  lifecycle_status: string;
}

interface PlanDetail {
  id: number;
  name: string;
  description: string | null;
  lifecycle_status: string;
  enrollment_status: string;
  current_price: string | null;
  amount_incl_tax: number | null;
  billing_policy: BillingPolicyDetail | null;
  allowances: AllowanceDetail[];
  charge_benefits: ChargeBenefitDetail[];
  promotions: PromotionRef[];
  promotion_count: number;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
}

// Mirrors plans/page.tsx's fmtBillingInterval so summary/detail values read identically to the expanded card.
function fmtBillingInterval(interval: number, unit: string) {
  if (interval === 1) return unit;
  return `${interval} ${unit}s`;
}

export function PlanDetailModal({ planId, planName, onClose }: {
  planId: number;
  planName: string;
  onClose: () => void;
}) {
  const t = useTranslations('plans');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const [detail, setDetail] = useState<PlanDetail | null>(null);

  useEffect(() => {
    apiFetch<PlanDetail>(`/membership-plans/${planId}`)
      .then(setDetail)
      .catch(() => {});
  }, [planId]);

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 170, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || '—'}</span>
    </div>
  );

  const summaryItem = (label: string, value: string) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <span style={{ fontSize: 14, color: '#222', fontWeight: 600 }}>{value}</span>
    </div>
  );

  const benefitCount = detail
    ? (detail.allowances?.length ?? 0) + (detail.charge_benefits?.filter((cb) => cb.action !== 'no_benefit').length ?? 0)
    : 0;
  const billingLabel = detail?.billing_policy
    ? fmtBillingInterval(detail.billing_policy.recurring_billing_interval, detail.billing_policy.recurring_billing_unit)
    : '—';
  const durationLabel = detail?.billing_policy
    ? fmtBillingInterval(detail.billing_policy.recurring_service_interval, detail.billing_policy.recurring_service_unit)
    : '—';
  const priceLabel = detail?.amount_incl_tax != null
    ? `€${detail.amount_incl_tax.toFixed(2)}`
    : detail?.current_price != null
      ? `€${parseFloat(detail.current_price).toFixed(2)}`
      : '—';

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 560, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('details_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{planName}</p>

        {!detail ? (
          <p style={{ color: '#888', fontSize: 13 }}>{t('loading')}</p>
        ) : (
          <>
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14,
              padding: '14px 16px', background: 'rgba(0,0,0,0.02)', borderRadius: 8, marginBottom: 20,
            }}>
              {summaryItem(t('details_summary_promotions'), String(detail.promotion_count))}
              {summaryItem(t('details_summary_pricing'), priceLabel)}
              {summaryItem(t('details_summary_benefits'), String(benefitCount))}
              {summaryItem(t('details_summary_duration'), durationLabel)}
              {summaryItem(t('details_summary_billing'), billingLabel)}
              {summaryItem(t('details_summary_enrollment'), tStatus(detail.enrollment_status as any))}
            </div>

            <p style={sectionLabel}>{t('details_section_general')}</p>
            {field(t('details_name'), detail.name)}
            {field(t('details_description'), detail.description)}
            {field(t('details_status'), tStatus(detail.lifecycle_status as any))}
            {field(t('details_enrollment_status'), tStatus(detail.enrollment_status as any))}
            {field(t('details_price'), priceLabel)}
            {field(t('details_duration'), durationLabel)}
            {field(t('details_billing_frequency'), billingLabel)}

            <p style={{ ...sectionLabel, marginTop: 20 }}>{t('details_section_benefits')}</p>
            {benefitCount === 0 ? (
              <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{t('details_no_benefits')}</p>
            ) : (
              <>
                {(detail.allowances ?? []).map((a) => (
                  <div key={`allowance-${a.id}`} style={benefitRowStyle}>
                    <span style={benefitNameStyle}>{a.activity_type_name}</span>
                    <span style={benefitValueStyle}>
                      {a.allowance_type === 'unlimited'
                        ? t('unlimited')
                        : `${a.session_count} / ${fmtBillingInterval(a.recurrence_interval ?? 1, a.recurrence_unit ?? 'month')}`}
                    </span>
                  </div>
                ))}
                {(detail.charge_benefits ?? []).filter((cb) => cb.action !== 'no_benefit').map((cb) => (
                  <div key={`charge-${cb.id}`} style={benefitRowStyle}>
                    <span style={benefitNameStyle}>{cb.gym_charge_name}</span>
                    <span style={benefitValueStyle}>{t(`cb_action_${cb.action}` as any)}{cb.value != null ? ` — ${cb.value}` : ''}</span>
                  </div>
                ))}
              </>
            )}

            <p style={{ ...sectionLabel, marginTop: 20 }}>{t('details_section_promotions')}</p>
            {(detail.promotions ?? []).length === 0 ? (
              <p style={{ fontSize: 13, color: '#888', margin: '4px 0 0' }}>{t('details_no_promotions')}</p>
            ) : (
              (detail.promotions ?? []).map((p) => (
                <div key={p.id} style={benefitRowStyle}>
                  <span style={benefitNameStyle}>{p.name}</span>
                  <span style={benefitValueStyle}>{tStatus(p.lifecycle_status as any)}</span>
                </div>
              ))
            )}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
              <p style={sectionLabel}>{t('details_section_audit')}</p>
              {field(t('details_created_by'), detail.created_by_name)}
              {field(t('details_created_at'), detail.created_at?.slice(0, 10))}
              {field(t('details_modified_by'), detail.modified_by_name)}
              {field(t('details_modified_at'), detail.modified_at?.slice(0, 10))}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('details_close')}</button>
        </div>
      </div>
    </div>
  );
}

const sectionLabel: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: 11,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const benefitRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0',
  borderBottom: '1px solid var(--gd-card-border, #f4f4f6)',
};

const benefitNameStyle: React.CSSProperties = {
  fontWeight: 600, fontSize: 14, color: '#222', flex: 1, minWidth: 0,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const benefitValueStyle: React.CSSProperties = {
  fontSize: 12.5, color: '#888', flexShrink: 0,
};
