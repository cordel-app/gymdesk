'use client';

import { UserButton } from '@clerk/nextjs';
import { LanguagePicker } from './LanguagePicker';
import { GymSelector } from './GymSelector';
import { CenterSelector } from './CenterSelector';
import { useGym } from '@/context/GymContext';

export function TopHeader({ onMenuToggle }: { onMenuToggle?: () => void }) {
  const { isSuperadmin, activeGym, gyms, loading } = useGym();
  // Superadmins always see the selector (they can jump to any gym); regular
  // users only see it when they belong to more than one, so a single-gym
  // admin/staff/coach isn't shown a pointless dropdown.
  const showSelector = !loading && (isSuperadmin || gyms.length > 1);

  const theme = activeGym?.theme;
  const logoSrc = theme?.has_logo
    ? `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`
    : null;

  return (
    <header style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      height: 52,
      background: 'var(--gd-header-bg, var(--chrome, #1a1a2e))',
      borderBottom: 'var(--gd-header-sep-height, 1px) solid var(--gd-header-sep-color, rgba(255,255,255,0.1))',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      zIndex: 50,
      boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={onMenuToggle}
          className="hamburger-btn"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--gd-header-text, #fff)', padding: 4, display: 'none', flexDirection: 'column',
            gap: 5, alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="Toggle menu"
        >
          <span style={{ display: 'block', width: 22, height: 2, background: 'var(--gd-header-text, #fff)', borderRadius: 2 }} />
          <span style={{ display: 'block', width: 22, height: 2, background: 'var(--gd-header-text, #fff)', borderRadius: 2 }} />
          <span style={{ display: 'block', width: 22, height: 2, background: 'var(--gd-header-text, #fff)', borderRadius: 2 }} />
        </button>
        {logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt={activeGym?.name ?? 'Gymdesk'} style={{ height: 32, width: 'auto', objectFit: 'contain' }} />
        ) : (
          <strong style={{ color: 'var(--gd-header-text, #fff)', fontSize: 18 }}>
            {activeGym?.name ?? 'Gymdesk'}
          </strong>
        )}
      </div>
      <style>{`@media (max-width: 768px) { .hamburger-btn { display: flex !important; } }`}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        {showSelector && <GymSelector />}
        <CenterSelector />
        <LanguagePicker />
        <UserButton />
      </div>
    </header>
  );
}
