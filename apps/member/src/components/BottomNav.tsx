'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

// All planned tabs. A tab only renders once its feature ships (ENABLED_TABS):
// schedule -> P2.8, membership -> P1.8, training -> P5.6, profile -> member profile page.
const TABS = [
  { key: 'home', path: '', icon: '⌂' },
  { key: 'schedule', path: '/schedule', icon: '▦' },
  { key: 'membership', path: '/membership', icon: '✦' },
  { key: 'training', path: '/training', icon: '⚑' },
  { key: 'profile', path: '/profile', icon: '◉' },
] as const;

const ENABLED_TABS: ReadonlyArray<(typeof TABS)[number]['key']> = ['home', 'membership'];

export function BottomNav() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations('nav');

  // No nav chrome during the auth flow
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
      background: '#fff',
      borderTop: '1px solid #e5e5e5',
      paddingBottom: 'env(safe-area-inset-bottom)',
      zIndex: 50,
    }}>
      {tabs.map((tab) => {
        const active = isActive(tab.path);
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
              color: active ? '#18181b' : '#9a9a9a',
              fontWeight: active ? 700 : 500,
              fontSize: 12,
            }}
          >
            <span style={{ fontSize: 20, lineHeight: 1 }}>{tab.icon}</span>
            {t(tab.key)}
          </button>
        );
      })}
    </nav>
  );
}
