'use client';

import { useTranslations } from 'next-intl';
import { useCenter } from '@/context/CenterContext';

export function CenterSelector() {
  const t = useTranslations();
  const { centers, activeCenterId, setActiveCenterId, loading } = useCenter();

  if (loading || centers.length <= 1) return null;

  return (
    <select
      value={activeCenterId ?? ''}
      onChange={(e) => setActiveCenterId(e.target.value ? Number(e.target.value) : null)}
      style={{
        background: 'rgba(255,255,255,0.1)',
        border: '1px solid rgba(255,255,255,0.2)',
        color: '#fff',
        borderRadius: 6,
        padding: '4px 8px',
        fontSize: 13,
        cursor: 'pointer',
      }}
    >
      <option value="" style={{ background: 'var(--chrome, #1a1a2e)', color: '#fff' }}>{t('centers.all_centers')}</option>
      {centers.map((c) => (
        <option key={c.id} value={c.id} style={{ background: 'var(--chrome, #1a1a2e)', color: '#fff' }}>
          {c.name}
        </option>
      ))}
    </select>
  );
}
