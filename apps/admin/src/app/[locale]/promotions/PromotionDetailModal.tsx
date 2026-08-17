'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface PromoDetail {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  stackable: number;
  lifecycle_status: string;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
}

export function PromotionDetailModal({ promotionId, promotionName, onClose }: {
  promotionId: number;
  promotionName: string;
  onClose: () => void;
}) {
  const t = useTranslations('promotions');
  const tStatus = useTranslations('status');
  const { apiFetch } = useApiClient();
  const [detail, setDetail] = useState<PromoDetail | null>(null);

  useEffect(() => {
    apiFetch<PromoDetail>(`/promotions/${promotionId}`)
      .then(setDetail)
      .catch(() => {});
  }, [promotionId]);

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || t('detail_unknown')}</span>
    </div>
  );

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 520 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{promotionName}</p>

        {!detail ? (
          <p style={{ color: '#888', fontSize: 13 }}>{t('loading')}</p>
        ) : (
          <>
            {field(t('detail_name'), detail.name)}
            {field(t('detail_description'), detail.description)}
            {field(t('detail_starts'), detail.starts_at?.slice(0, 10))}
            {field(t('detail_ends'), detail.ends_at?.slice(0, 10))}
            {field(t('detail_lifecycle_status'), detail.lifecycle_status ? tStatus(detail.lifecycle_status as any) : null)}
            {field(t('detail_stackable'), detail.stackable ? t('yes') : t('no'))}

            {(detail.free_months != null || detail.paid_months != null || detail.bonus_months != null) && (
              <>
                {field(t('detail_free_months'), detail.free_months != null ? String(detail.free_months) : null)}
                {field(t('detail_paid_months'), detail.paid_months != null ? String(detail.paid_months) : null)}
                {field(t('detail_bonus_months'), detail.bonus_months != null ? String(detail.bonus_months) : null)}
              </>
            )}

            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '2px solid #f0f0f0' }}>
              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 600, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Audit</p>
              {field(t('detail_created_by'), detail.created_by_name)}
              {field(t('detail_created_at'), detail.created_at?.slice(0, 10))}
              {field(t('detail_modified_by'), detail.modified_by_name)}
              {field(t('detail_modified_at'), detail.modified_at?.slice(0, 10))}
              {detail.deleted_at && field(t('detail_deleted_by'), detail.deleted_by_name)}
              {detail.deleted_at && field(t('detail_deleted_at'), detail.deleted_at?.slice(0, 10))}
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
