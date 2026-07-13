'use client';

import { useTranslations } from 'next-intl';

export default function NutritionDashboard() {
  const t = useTranslations();

  return (
    <div>
      <h1 style={{ margin: '0 0 12px' }}>Nutrition Dashboard</h1>
      <p style={{ margin: 0, color: '#666', fontSize: 14 }}>Overview and metrics for nutrition management.</p>

      <div style={{ marginTop: 32, padding: '32px', background: '#f9fafb', borderRadius: 12, border: '1px solid #e5e7eb', textAlign: 'center' }}>
        <p style={{ color: '#666', fontSize: 14 }}>Dashboard content coming soon...</p>
      </div>
    </div>
  );
}
