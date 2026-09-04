'use client';

import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';

/** #341: only rendered when the actor has access to more than one gym. */
export function GymSwitcher() {
  const t = useTranslations('common');
  const { gyms, gymId, switchGym, isLinked, isSuperadmin } = useApp();

  if (gyms.length <= 1) return null;
  if (!isLinked && !isSuperadmin) return null;

  return (
    <div style={{ padding: '8px 16px', background: 'var(--gd-card-bg, #fff)', borderBottom: '1px solid var(--gd-card-border, #eee)' }}>
      <select
        value={gymId ?? ''}
        onChange={(e) => switchGym(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 6,
          border: '1px solid #ccc',
          fontSize: 14,
          background: 'inherit',
          color: 'inherit',
        }}
        aria-label={t('gym_switcher_label')}
      >
        {gyms.map((g) => (
          <option key={g.id} value={g.id}>{g.name}</option>
        ))}
      </select>
    </div>
  );
}
