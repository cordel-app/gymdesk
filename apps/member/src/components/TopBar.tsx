'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { memberTheme, withSafeArea } from '@/lib/memberChrome';
import { memberAvatarColors, memberInitials } from '@/lib/memberAvatar';

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
  const { isLinked, unreadNotifications, theme, gymName, member } = useApp();

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
      // #1073 (mobile app WP2): inside the native shell this bar is the top of
      // the screen, and it rendered *under* the status bar — the one layout
      // defect the 2026-10-04 spike reported. The inset is padding on the bar
      // itself rather than a spacer above it, so the strip under the status bar
      // is filled with the header's own themed background; `env()` resolves to
      // 0px on the web, so nothing moves there. The horizontal insets are the
      // same answer for a landscape notch.
      paddingTop: withSafeArea(10, 'top'),
      paddingBottom: 10,
      paddingLeft: withSafeArea(16, 'left'),
      paddingRight: withSafeArea(16, 'right'),
      // #833 §2 — the Members App header's own colour, text colour, font and
      // separator. Each follows the Admin Header setting it inherits from
      // unless the active Theme overrides it; lib/membersAppTokens.ts writes
      // the five variables and lib/memberChrome.ts is where this app reads
      // them (#983). Before #833 the bar borrowed `--gd-sidebar-bg`, which is
      // the Admin sidebar's colour and was never the header's.
      background: memberTheme.headerBackground,
      color: memberTheme.headerText,
      fontFamily: memberTheme.headerFont,
      borderBottom: `${memberTheme.headerSeparatorWidth} solid ${memberTheme.headerSeparatorColor}`,
    }}>
      {isHome ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {logoSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoSrc} alt={gymName ?? ''} style={{ height: 24, width: 'auto', objectFit: 'contain' }} />
          )}
          {(!logoSrc || !theme?.logo_contains_gym_name) && gymName && (
            <strong style={{ fontSize: 15, color: 'inherit' }}>{gymName}</strong>
          )}
        </div>
      ) : (
        <button
          onClick={() => router.push(homePath)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, padding: 0, color: 'inherit', fontFamily: 'inherit', fontSize: 14, fontWeight: 600 }}
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
                background: memberTheme.statusError,
              }} />
            )}
          </button>
        )}

        {!isProfile && (
          <button
            onClick={() => router.push(`${homePath}/profile`)}
            aria-label={member?.name ? `${t('nav.profile')}: ${member.name}` : t('nav.profile')}
            title={member?.name || undefined}
            style={{
              ...memberAvatarColors(member?.id ?? member?.name),
              width: 32,
              height: 32,
              flexShrink: 0,
              borderRadius: '50%',
              border: 'none',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 700,
              lineHeight: 1,
              padding: 0,
              fontFamily: 'inherit',
            }}
          >
            {memberInitials(member?.name) || '◉'}
          </button>
        )}
      </div>
    </div>
  );
}
