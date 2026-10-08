'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { memberAvatarColors, memberInitials } from '@/lib/memberAvatar';
import { logoutMember } from '@/lib/memberLogout';
import { userMenuItems } from '@/lib/memberUserMenu';
import {
  destructiveButtonStyle, memberTheme, rowDividerStyle, secondaryButtonStyle,
} from '@/lib/memberChrome';
import { MemberDialog } from '@/components/MemberDialog';

/**
 * #1282 — the avatar in the top bar, as a menu: the member's email, **Profile**
 * and **Log out** (which asks first).
 *
 * Presentation and the one sequence it triggers: which entries exist and where a
 * logout lands are `lib/memberUserMenu.ts`'s, the logout itself is
 * `lib/memberLogout.ts`'s (push token first, then the session), and every colour
 * is `lib/memberChrome.ts`'s (#983).
 */
export function MemberUserMenu() {
  const t = useTranslations();
  const router = useRouter();
  const locale = useLocale();
  const { member } = useApp();
  const { isImpersonating } = useImpersonation();
  const { signOut } = useAuth();
  const { apiFetch } = useApiClient();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items = userMenuItems(isImpersonating);

  async function confirmLogout() {
    setBusy(true);
    try {
      await logoutMember(apiFetch, signOut, locale);
    } finally {
      // On success the page is replaced; this only matters when signing out failed.
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div ref={wrapperRef} style={styles.wrapper}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={member?.name ? `${t('nav.user_menu')}: ${member.name}` : t('nav.user_menu')}
        title={member?.name || undefined}
        style={{ ...styles.avatar, ...memberAvatarColors(member?.id ?? member?.name) }}
      >
        {memberInitials(member?.name) || '◉'}
      </button>

      {open && (
        <div id={menuId} role="menu" style={styles.menu}>
          {member?.email && <div style={styles.email} title={member.email}>{member.email}</div>}
          {items.includes('profile') && (
            <button
              type="button"
              role="menuitem"
              style={styles.item}
              onClick={() => { setOpen(false); router.push(`/${locale}/profile`); }}
            >
              {t('nav.profile')}
            </button>
          )}
          {items.includes('logout') && (
            <button
              type="button"
              role="menuitem"
              style={{ ...styles.item, color: memberTheme.statusError }}
              onClick={() => { setOpen(false); setConfirming(true); }}
            >
              {t('nav.logout')}
            </button>
          )}
        </div>
      )}

      {confirming && (
        <MemberDialog
          labelledBy="logout-confirm-title"
          title={t('nav.logout_confirm_title')}
          onClose={busy ? () => {} : () => setConfirming(false)}
          actions={(
            <>
              <button
                type="button"
                style={{ ...styles.dialogButton, ...secondaryButtonStyle }}
                onClick={() => setConfirming(false)}
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
          <p style={styles.confirmText}>{t('nav.logout_confirm_body')}</p>
        </MemberDialog>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: { position: 'relative' },
  avatar: {
    width: 32, height: 32, flexShrink: 0, borderRadius: '50%', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 13, fontWeight: 700, lineHeight: 1, padding: 0, fontFamily: 'inherit',
  },
  menu: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 50,
    minWidth: 200, maxWidth: 'min(280px, 80vw)',
    background: memberTheme.surface, color: memberTheme.text,
    border: `1px solid ${memberTheme.cardBorderColor}`, borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '4px 0', overflow: 'hidden',
  },
  email: {
    ...rowDividerStyle, padding: '10px 14px', fontSize: 12, color: memberTheme.textMuted,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  item: {
    display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
    cursor: 'pointer', padding: '12px 14px', fontSize: 14, fontFamily: 'inherit', color: memberTheme.text,
  },
  dialogButton: { flex: 1, padding: '10px 14px', fontSize: 14, fontWeight: 600, fontFamily: 'inherit' },
  confirmText: { margin: 0, fontSize: 14, color: memberTheme.text },
};
