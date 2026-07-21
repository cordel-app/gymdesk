'use client';

import { useTranslations } from 'next-intl';
import { overlayStyle, modalStyle, btnStyle } from '@/components/ui';

interface Promo {
  id: number;
  name: string;
  created_at: string;
  created_by_name?: string | null;
}

export function PromotionDetailModal({ promotion, onClose }: { promotion: Promo; onClose: () => void }) {
  const t = useTranslations('promotions');

  const field = (label: string, value: string | null | undefined) => (
    <div style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ width: 140, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: '#333' }}>{value || t('detail_unknown')}</span>
    </div>
  );

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div
        style={{ ...modalStyle, width: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{promotion.name}</p>

        <div>
          {field(t('detail_created_by'), promotion.created_by_name)}
          {field(t('detail_created_at'), promotion.created_at ? promotion.created_at.slice(0, 10) : null)}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('close')}</button>
        </div>
      </div>
    </div>
  );
}
