'use client';

import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';

/** #59: only rendered once a member is assigned to more than one center — invisible for the common single-center case. */
export function CenterSwitcher() {
  const t = useTranslations();
  const { centers, activeCenterId, setActiveCenterId, isLinked } = useApp();

  if (!isLinked || centers.length <= 1) return null;

  return (
    <div style={{ padding: '8px 16px', background: '#fff', borderBottom: '1px solid #eee' }}>
      <select
        value={activeCenterId ?? ''}
        onChange={(e) => setActiveCenterId(Number(e.target.value))}
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid #ccc',
          fontSize: 14,
        }}
        aria-label={t('common.center_switcher_label')}
      >
        {centers.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
    </div>
  );
}
