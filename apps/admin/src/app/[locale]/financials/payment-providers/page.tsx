'use client';

import { useTranslations } from 'next-intl';

export default function PaymentProvidersPage() {
  const t = useTranslations('common');

  return (
    <div>
      <h1 style={{ margin: '0 0 12px' }}>Payment Providers</h1>
      <div style={{ marginTop: 32, padding: '32px', background: '#f9fafb', borderRadius: 12, border: '1px solid #e5e7eb', textAlign: 'center' }}>
        <p style={{ color: '#666', fontSize: 14 }}>{t('coming_soon')}</p>
      </div>
    </div>
  );
}
