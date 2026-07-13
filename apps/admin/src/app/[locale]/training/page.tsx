'use client';

import { useTranslations } from 'next-intl';

export default function TrainingDashboard() {
  const t = useTranslations();

  return (
    <div>
      <h1 style={{ margin: '0 0 12px' }}>Training Dashboard</h1>
      <p style={{ margin: 0, color: '#666', fontSize: 14 }}>Overview and metrics for training programs and exercises.</p>

      <div style={{ marginTop: 32, padding: '32px', background: '#f9fafb', borderRadius: 12, border: '1px solid #e5e7eb', textAlign: 'center' }}>
        <p style={{ color: '#666', fontSize: 14 }}>Dashboard content coming soon...</p>
      </div>
    </div>
  );
}
