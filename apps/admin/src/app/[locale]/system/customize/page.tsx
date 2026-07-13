'use client';

import { useTranslations } from 'next-intl';

export default function CustomizePage() {
  const t = useTranslations();

  return (
    <div>
      <h1 style={{ margin: '0 0 12px' }}>Customize</h1>
      <p style={{ margin: 0, color: '#666', fontSize: 14 }}>Configure gym settings and customization options.</p>

      <div style={{ marginTop: 32, padding: '32px', background: '#f9fafb', borderRadius: 12, border: '1px solid #e5e7eb', textAlign: 'center' }}>
        <p style={{ color: '#666', fontSize: 14 }}>Customization features coming soon...</p>
      </div>
    </div>
  );
}
