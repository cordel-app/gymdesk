'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';

/**
 * #361: replaces the old bottom tab bar. Home is reached via its own
 * greeting/tiles; every other page gets a slim bar with a way back to Home
 * and a persistent entry point into Profile (the one destination kept
 * outside the Home navigation tiles).
 */
export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations();
  const { isLinked, unreadNotifications } = useApp();

  if (pathname.includes('/sign-in') || pathname.includes('/sign-up')) return null;
  if (!isLinked) return null;

  const homePath = `/${locale}`;
  const isHome = pathname === homePath;
  const isProfile = pathname.startsWith(`${homePath}/profile`);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '10px 16px',
      background: 'var(--gd-sidebar-bg, #fff)',
      borderBottom: 'var(--gd-header-sep-height, 1px) solid var(--gd-header-sep-color, #e5e5e5)',
    }}>
      {isHome ? (
        <span />
      ) : (
        <button
          onClick={() => router.push(homePath)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, color: 'var(--gd-text, #18181b)', fontSize: 14, fontWeight: 600 }}
        >
          <span style={{ fontSize: 18 }}>←</span> {t('home.dashboard_title')}
        </button>
      )}

      {!isProfile && (
        <button
          onClick={() => router.push(`${homePath}/profile`)}
          aria-label={t('nav.profile')}
          style={{
            position: 'relative',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 20,
            lineHeight: 1,
            padding: 4,
          }}
        >
          ◉
          {isHome && unreadNotifications > 0 && (
            <span style={{
              position: 'absolute', top: 0, right: 0,
              width: 8, height: 8, borderRadius: '50%',
              background: '#ef4444',
            }} />
          )}
        </button>
      )}
    </div>
  );
}
