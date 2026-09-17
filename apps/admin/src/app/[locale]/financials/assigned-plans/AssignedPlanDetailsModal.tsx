'use client';

import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import type { AssignedPlanDetail } from './types';

function fmtDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : null;
}

function fmtMoney(v: string | number | null) {
  return v != null ? `€${parseFloat(String(v)).toFixed(2)}` : null;
}

export function AssignedPlanDetailsModal({ detail, onClose }: {
  detail: AssignedPlanDetail;
  onClose: () => void;
}) {
  const t = useTranslations('assigned_plans_page');
  const tStatus = useTranslations('status');

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 170, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || t('detail_unknown')}</span>
    </div>
  );

  const memberNames = detail.members.map((m) => m.name).join(', ') || detail.member_name;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{detail.plan_name ?? t('detail_unknown')}</p>

        {field(t('detail_source_plan'), detail.plan_name)}
        {field(t('detail_members'), memberNames)}
        {field(t('detail_status'), tStatus(detail.lifecycle_status as any))}
        {field(t('label_start_date'), fmtDate(detail.starts_at))}
        {field(t('label_end_date'), detail.ends_at ? fmtDate(detail.ends_at) : t('open_ended'))}
        {detail.closed_at && field(t('label_closure_date'), fmtDate(detail.closed_at))}
        {field(t('detail_effective_price'), fmtMoney(detail.final_price))}
        {detail.billing_policy && field(
          t('label_billing_frequency'),
          `${detail.billing_policy.recurring_billing_interval} / ${detail.billing_policy.recurring_billing_unit}`,
        )}
        {detail.discount_reason && field(t('label_discount_reason'), detail.discount_reason)}

        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
          <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Audit</p>
          {field(t('detail_created_by'), detail.created_by_name)}
          {field(t('detail_created_at'), fmtDate(detail.created_at))}
          {field(t('detail_modified_by'), detail.modified_by_name)}
          {field(t('detail_modified_at'), detail.modified_at ? fmtDate(detail.modified_at) : null)}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
