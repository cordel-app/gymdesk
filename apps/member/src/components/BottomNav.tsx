'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';

const TABS = [
  { key: 'home', path: '', icon: '⌂' },
  { key: 'schedule', path: '/schedule', icon: '▦' },
  { key: 'membership', path: '/membership', icon: '✦' },
  { key: 'packages', path: '/packages', icon: '◈' },
  { key: 'training', path: '/training', icon: '⚑' },
  { key: 'notifications', path: '/notifications', icon: '🔔' },
  { key: 'profile', path: '/profile', icon: '◉' },
] as const;

const ENABLED_TABS: ReadonlyArray<(typeof TABS)[number]['key']> = ['home', 'schedule', 'membership', 'packages', 'training', 'notifications', 'profile'];

export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('nav');
  const { unreadNotifications } = useApp();

  if (pathname.includes('/sign-in') || pathname.includes('/sign-up')) return null;

  const tabs = TABS.filter((tab) => ENABLED_TABS.includes(tab.key));

  const isActive = (path: string) => {
    const target = `/${locale}${path}`;
    return path === '' ? pathname === target : pathname.startsWith(target);
  };

  return (
    <nav style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      display: 'flex',
      background: 'var(--gd-sidebar-bg, #fff)',
      borderTop: 'var(--gd-header-sep-height, 1px) solid var(--gd-header-sep-color, #e5e5e5)',
      paddingBottom: 'env(safe-area-inset-bottom)',
      zIndex: 50,
    }}>
      {tabs.map((tab) => {
        const active = isActive(tab.path);
        const showBadge = tab.key === 'notifications' && unreadNotifications > 0;
        return (
          <button
            key={tab.key}
            onClick={() => router.push(`/${locale}${tab.path}`)}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 2,
              padding: '10px 0 8px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: active ? 'var(--gd-sidebar-selected-bg, #18181b)' : 'var(--gd-sidebar-text, #9a9a9a)',
              fontWeight: active ? 700 : 500,
              fontSize: 12,
            }}
          >
            <span style={{ position: 'relative', fontSize: 20, lineHeight: 1 }}>
              {tab.icon}
              {showBadge && (
                <span style={{
                  position: 'absolute', top: -4, right: -6,
                  background: '#ef4444', color: '#fff',
                  borderRadius: 999, fontSize: 9, fontWeight: 700,
                  padding: '1px 4px', minWidth: 14, textAlign: 'center',
                  lineHeight: '14px',
                }}>
                  {unreadNotifications > 9 ? '9+' : unreadNotifications}
                </span>
              )}
            </span>
            {t(tab.key)}
          </button>
        );
      })}
    </nav>
  );
}
