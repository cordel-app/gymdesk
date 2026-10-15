'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { memberTheme, withSafeArea } from '@/lib/memberChrome';
import { MemberUserMenu } from '@/components/MemberUserMenu';

const SECTION_TITLE_KEYS: Record<string, string> = {
  calendar: 'nav.calendar',
  training: 'nav.training',
  schedule: 'nav.bookings',
  nutrition: 'nav.nutrition',
  membership: 'nav.membership',
  profile: 'nav.profile',
  notifications: 'nav.alerts',
  goals: 'nav.goals',
  packages: 'packages.title',
};

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
  const { isLinked, unreadNotifications, theme, gymName, isSuperadmin } = useApp();

  if (pathname.includes('/sign-in') || pathname.includes('/sign-up')) return null;
  if (!isLinked) return null;

  const homePath = `/${locale}`;
  // #1638: the back arrow and the section title are one control's two faces — both call this.
  const goBack = () => router.push(homePath);
  const isHome = pathname === homePath;
  const isNotifications = pathname.startsWith(`${homePath}/notifications`);

  // #1565: the back button names the current section, not the destination.
  const segment = pathname.split('/')[2] ?? '';
  const sectionTitleKey = SECTION_TITLE_KEYS[segment] ?? null;

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
      //
      // #1294: not for a superadmin — `AdminBar` renders above this bar for them and
      // owns the inset, so adding it here too left a dead strip between the two.
      paddingTop: isSuperadmin ? 10 : withSafeArea(10, 'top'),
      paddingBottom: 10,
      paddingLeft: withSafeArea(16, 'left'),
      paddingRight: withSafeArea(16, 'right'),
      // #833 §2 — the Members App header's own colour, text colour, font and
      // separator. Each follows the Admin Header setting it inherits from
      // unless the active Theme overrides it; lib/membersAppTokens.ts writes
      // the five variables and lib/memberChrome.ts is where this app reads
      // them (#983). Before #833 the bar borrowed `--gd-sidebar-bg`, which is
      // the Admin sidebar's colour and was never the header's.
      //
      // #1601: a subsection's bar carries the page's large title beside the back arrow
      // (the pages draw no heading of their own), in the Title 1 theme settings. That
      // colour is a page-text colour, so the bar is transparent there rather than
      // painting the header background behind it; Home keeps the header colours.
      background: isHome ? memberTheme.headerBackground : 'transparent',
      color: isHome ? memberTheme.headerText : memberTheme.title1,
      fontFamily: isHome ? memberTheme.headerFont : memberTheme.title1Font,
      gap: 12,
      // #1565: no separator under a subsection header — the page starts right below it.
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <button
            onClick={goBack}
            aria-label={t('nav.back_home')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'inherit', fontFamily: 'inherit', fontSize: 24, lineHeight: 1, flexShrink: 0 }}
          >
            ←
          </button>
          {sectionTitleKey && (
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, lineHeight: 1.2, color: 'inherit', fontFamily: 'inherit', minWidth: 0, overflowWrap: 'anywhere' }}>
              <button
                onClick={goBack}
                aria-label={t('nav.back_home')}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, margin: 0, color: 'inherit', fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', lineHeight: 'inherit', textAlign: 'inherit', overflowWrap: 'anywhere' }}
              >
                {t(sectionTitleKey)}
              </button>
            </h1>
          )}
        </div>
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

        <MemberUserMenu />
      </div>
    </div>
  );
}
