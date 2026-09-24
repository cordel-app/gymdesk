'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';

/**
 * #361: replaces the old bottom tab bar. Home is reached via its own
 * greeting/tiles; every other page gets a slim bar with a way back to Home
 * and persistent entry points into Notifications and Profile (the two
 * destinations kept outside the Home navigation tiles).
 *
 * #503 stage 8: the unread badge used to sit on the Profile button, which
 * linked to /profile, not /notifications — a bell with its own dedicated
 * link is the actual "Notifications" entry point the issue asked for.
 */
export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations();
  const { isLinked, unreadNotifications, theme, gymName } = useApp();

  if (pathname.includes('/sign-in') || pathname.includes('/sign-up')) return null;
  if (!isLinked) return null;

  const homePath = `/${locale}`;
  const isHome = pathname === homePath;
  const isProfile = pathname.startsWith(`${homePath}/profile`);
  const isNotifications = pathname.startsWith(`${homePath}/notifications`);

  // #713: same resolution as the Admin header — the gym's Cloudflare copy when
  // the theme has one, the API route for a logo that is still a blob.
  const logoSrc = theme?.logo_url
    ?? (theme?.has_logo
      ? `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`
      : null);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {logoSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt={gymName ?? ''} style={{ height: 24, width: 'auto', objectFit: 'contain' }} />
          )}
          {(!logoSrc || !theme?.logo_contains_gym_name) && gymName && (
            <strong style={{ fontSize: 15, color: 'var(--gd-text, #18181b)' }}>{gymName}</strong>
          )}
        </div>
      ) : (
        <button
          onClick={() => router.push(homePath)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, color: 'var(--gd-text, #18181b)', fontSize: 14, fontWeight: 600 }}
        >
          <span style={{ fontSize: 18 }}>←</span> {t('home.dashboard_title')}
        </button>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {!isNotifications && (
          <button
            onClick={() => router.push(`${homePath}/notifications`)}
            aria-label={t('nav.alerts')}
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
            🔔
            {unreadNotifications > 0 && (
              <span style={{
                position: 'absolute', top: 0, right: 0,
                width: 8, height: 8, borderRadius: '50%',
                background: '#ef4444',
              }} />
            )}
          </button>
        )}

        {!isProfile && (
          <button
            onClick={() => router.push(`${homePath}/profile`)}
            aria-label={t('nav.profile')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 20,
              lineHeight: 1,
              padding: 4,
            }}
          >
            ◉
          </button>
        )}
      </div>
    </div>
  );
}
