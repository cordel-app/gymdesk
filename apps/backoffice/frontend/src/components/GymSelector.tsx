'use client';

import { useGym } from '@/context/GymContext';

export function GymSelector() {
  const { gyms, activeGymId, setActiveGymId, loading } = useGym();

  if (loading || gyms.length === 0) return null;

  return (
    <select
      value={activeGymId ?? ''}
      onChange={(e) => setActiveGymId(e.target.value)}
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
      {gyms.map((g) => (
        <option key={g.id} value={g.id} style={{ background: '#1a1a2e', color: '#fff' }}>
          {g.name}
        </option>
      ))}
    </select>
  );
}
