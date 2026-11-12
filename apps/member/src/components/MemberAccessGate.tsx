'use client';

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { accessRevokedMessageKey } from '@/lib/memberAccessRevoked';
import { memberTheme, primaryButtonStyle, sectionCardStyle } from '@/lib/memberChrome';
import { LogoutConfirmDialog } from './LogoutConfirmDialog';

/**
 * #2681 — what a member whose Access Rights are `revoked` sees instead of any
 * page. The API is what refuses them (every request answers `403
 * member_access_revoked`); this only replaces the page with the explanation,
 * worded in the member's profile language (`MemberLocalePreference` moves the
 * route onto it first) and naming their gym. Log out is the app's one logout
 * (#1282), which while impersonating leaves the member and keeps the
 * superadmin signed in.
 */
export function MemberAccessGate({ children }: { children: ReactNode }) {
  const { accessRevoked } = useApp();
  const t = useTranslations();
  const [confirmLogout, setConfirmLogout] = useState(false);

  if (!accessRevoked) return <>{children}</>;

  const key = accessRevokedMessageKey(accessRevoked);
  return (
    <main style={{ display: 'flex', justifyContent: 'center', padding: '48px 16px' }}>
      <section role="alert" style={{ ...sectionCardStyle, maxWidth: 420, width: '100%', padding: 24, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 20, color: memberTheme.title1, fontFamily: memberTheme.title1Font }}>
          {t('access_revoked.title')}
        </h1>
        <p style={{ margin: 0, fontSize: 15, color: memberTheme.text }}>
          {key === 'message'
            ? t('access_revoked.message', { gymName: accessRevoked.gymName ?? '' })
            : t('access_revoked.message_no_gym')}
        </p>
        <button
          type="button"
          onClick={() => setConfirmLogout(true)}
          style={{ ...primaryButtonStyle, padding: '12px 24px', fontSize: 15, fontWeight: 600 }}
        >
          {t('nav.logout')}
        </button>
      </section>
      {confirmLogout && <LogoutConfirmDialog onClose={() => setConfirmLogout(false)} />}
    </main>
  );
}
