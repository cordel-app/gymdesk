'use client';

import { UserButton } from '@clerk/nextjs';
import { LanguagePicker } from './LanguagePicker';
import { GymSelector } from './GymSelector';
import { useGym } from '@/context/GymContext';

export function TopHeader() {
  const { isSuperadmin, activeGym, loading } = useGym();

  return (
    <header style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: 52,
      background: '#1a1a2e',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      zIndex: 50,
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }}>
      <strong style={{ color: '#fff', fontSize: 18 }}>Gymdesk</strong>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {!loading && isSuperadmin && <GymSelector />}
        {!loading && !isSuperadmin && activeGym && (
          <span style={{
            color: 'rgba(255,255,255,0.8)',
            fontSize: 13,
            background: 'rgba(255,255,255,0.1)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: 6,
            padding: '4px 10px',
          }}>
            {activeGym.name}
          </span>
        )}
        <LanguagePicker />
        <UserButton />
      </div>
    </header>
  );
}
