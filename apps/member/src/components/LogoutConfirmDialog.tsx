'use client';

import { useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { reportImpersonationStopped } from '@/lib/endImpersonation';
import { logoutMember } from '@/lib/memberLogout';
import { destructiveButtonStyle, memberTheme, secondaryButtonStyle } from '@/lib/memberChrome';
import { MemberDialog } from '@/components/MemberDialog';

/**
 * #1282 — the one confirmation in front of Log out, rendered by the avatar menu
 * and by the superadmin's Support bar (which has no avatar: a superadmin who is
 * not impersonating is not linked to a member, so `TopBar` renders nothing).
 *
 * Nothing is signed out before the confirm. **While impersonating, Log out
 * leaves the impersonated member and lands on Support mode** — the superadmin's
 * own session stays signed in, exactly as the banner's *Stop Impersonating*: the
 * impersonation is audited and its stored session cleared, and nothing else.
 */
export function LogoutConfirmDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { signOut } = useAuth();
  const { apiFetch } = useApiClient();
  const { session, stopImpersonation } = useImpersonation();
  const [busy, setBusy] = useState(false);
  const impersonating = session !== null;

  async function confirmLogout() {
    setBusy(true);
    try {
      if (session) {
        await reportImpersonationStopped(apiFetch, session);
        stopImpersonation();
        router.replace(`/${locale}`);
        return;
      }
      await logoutMember(apiFetch, signOut, locale);
    } finally {
      // On success the page is replaced; this only matters when signing out failed.
      setBusy(false);
      onClose();
    }
  }

  return (
    <MemberDialog
      labelledBy="logout-confirm-title"
      title={t(impersonating ? 'nav.logout_impersonating_title' : 'nav.logout_confirm_title')}
      onClose={busy ? () => {} : onClose}
      actions={(
        <>
          <button
            type="button"
            style={{ ...styles.dialogButton, ...secondaryButtonStyle }}
            onClick={onClose}
            disabled={busy}
          >
            {t('nav.logout_cancel')}
          </button>
          <button
            type="button"
            style={{ ...styles.dialogButton, ...destructiveButtonStyle, ...(busy ? { opacity: 0.6 } : null) }}
            onClick={confirmLogout}
            disabled={busy}
          >
            {t('nav.logout')}
          </button>
        </>
      )}
    >
      <p style={styles.confirmText}>
        {t(impersonating ? 'nav.logout_impersonating_body' : 'nav.logout_confirm_body')}
      </p>
    </MemberDialog>
  );
}

const styles: Record<string, CSSProperties> = {
  dialogButton: { flex: 1, padding: '10px 14px', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' },
  confirmText: { margin: 0, fontSize: 14, color: memberTheme.text },
};
