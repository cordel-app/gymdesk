'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { withSafeArea } from '@/lib/memberChrome';
import { ImpersonationBanner } from './ImpersonationBanner';
import { LogoutConfirmDialog } from './LogoutConfirmDialog';
import { MemberImpersonationDialog } from './MemberImpersonationDialog';

/**
 * #983 — the one surface in this app that deliberately does **not** follow the
 * gym's Theme, with `ImpersonationBanner` beside it. It tells a superadmin
 * which account they are looking at, so its colours are the platform's and are
 * fixed: a Theme able to repaint it could make the bar disappear into the page
 * the gym designed, and the member whose account is open would be the only clue
 * left. Every member-facing surface reads `lib/memberChrome.ts` instead.
 */
export function AdminBar() {
  const t = useTranslations('impersonation');
  const tNav = useTranslations('nav');
  const { isSuperadmin } = useApp();
  const { isImpersonating } = useImpersonation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  // Only render anything for superadmins
  if (!isSuperadmin) return null;

  if (isImpersonating) {
    return <ImpersonationBanner />;
  }

  return (
    <>
      <div style={{
        background: '#1e293b',
        color: '#fff',
        // #1294: in the native shell this is the top of the screen, under the status
        // bar (clock, Wi-Fi). The inset is the bar's own padding so its colour fills
        // that strip; `env()` is 0px on the web. `TopBar` skips its own top inset
        // for a superadmin, because this bar is above it.
        paddingTop: withSafeArea(8, 'top'),
        paddingBottom: 8,
        paddingLeft: withSafeArea(16, 'left'),
        paddingRight: withSafeArea(16, 'right'),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        gap: 12,
        fontSize: 13,
      }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>{t('home_prompt_title')}</span>
        <button
          onClick={() => setDialogOpen(true)}
          style={{
            padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
            background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff',
          }}
        >
          {t('button_impersonate')}
        </button>
        <button
          onClick={() => setLogoutOpen(true)}
          style={{
            padding: '4px 12px', fontSize: 12, fontWeight: 600, borderRadius: 4, cursor: 'pointer',
            background: 'transparent', border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff',
          }}
        >
          {tNav('logout')}
        </button>
      </div>
      {logoutOpen && <LogoutConfirmDialog onClose={() => setLogoutOpen(false)} />}
      {dialogOpen && <MemberImpersonationDialog onClose={() => setDialogOpen(false)} />}
    </>
  );
}
