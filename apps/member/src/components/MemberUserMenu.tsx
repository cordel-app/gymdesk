'use client';

import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { MemberAvatar } from '@/components/MemberAvatar';
import { useApiClient } from '@/lib/apiClient';
import {
  familyMemberPreviewSrc, familySectionMembers, userMenuItems, type FamilyMenuMember,
} from '@/lib/memberUserMenu';
import { memberTheme, rowDividerStyle, statusPillStyle } from '@/lib/memberChrome';
import { LogoutConfirmDialog } from '@/components/LogoutConfirmDialog';
import { ImagePreviewButton } from '@/components/ImagePreview';

/**
 * #1282 — the avatar in the top bar, as a menu: **Profile**, the **Family**
 * section (#3156: the caller's Family with each member's thumbnail, name and an
 * Owner chip, a thumbnail opening the 1080 × 1080 picture in the app's one image
 * preview) and **Log out** (which asks first). The email is no longer shown.
 *
 * Presentation and the one sequence it triggers: which entries exist and where a
 * logout lands are `lib/memberUserMenu.ts`'s, the logout itself is
 * `components/LogoutConfirmDialog.tsx` + `lib/memberLogout.ts`'s (push token first, then the session), and every colour
 * is `lib/memberChrome.ts`'s (#983).
 */
export function MemberUserMenu() {
  const t = useTranslations();
  const router = useRouter();
  const locale = useLocale();
  const { member } = useApp();
  const { apiFetch } = useApiClient();
  const [open, setOpen] = useState(false);
  const [family, setFamily] = useState<FamilyMenuMember[]>([]);
  const [confirming, setConfirming] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      // #3156: the image preview is portalled into `document.body`; a click in it
      // must not close the menu, which would unmount the preview with it.
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      if (wrapperRef.current && !wrapperRef.current.contains(target)) setOpen(false);
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

  // #3156: the Family is read each time the menu opens, so a change staff made
  // is shown without a reload. A failed read lists nobody: the section is absent.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch('/me/family')
      .then((body) => { if (!cancelled) setFamily(familySectionMembers(body)); })
      .catch(() => { if (!cancelled) setFamily([]); });
    return () => { cancelled = true; };
  }, [open, apiFetch]);

  const items = userMenuItems();

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
        style={styles.avatar}
      >
        {/* #1375: the photo when there is one, the initials otherwise — one
            rendering, shared with the Profile page. */}
        <MemberAvatar member={member} size={32} />
      </button>

      {open && (
        <div id={menuId} role="menu" style={styles.menu}>
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
          {items.includes('family') && family.length > 0 && (
            <div role="group" aria-label={t('nav.family')} style={styles.family}>
              <div style={styles.familyTitle}>{t('nav.family')}</div>
              {family.map((m) => (
                <div key={m.member_id} style={styles.familyRow}>
                  <ImagePreviewButton
                    src={familyMemberPreviewSrc(m)}
                    alt={m.name}
                    title={m.name}
                    style={styles.thumbButton}
                  >
                    <MemberAvatar
                      member={{ id: m.member_id, name: m.name, image_url: m.image_url, image_thumbnail_url: m.image_thumbnail_url, modified_at: m.modified_at }}
                      size={28}
                    />
                  </ImagePreviewButton>
                  <span style={styles.familyName} title={m.name}>{m.name}</span>
                  {m.is_owner && <span style={styles.ownerChip}>{t('nav.family_owner')}</span>}
                </div>
              ))}
            </div>
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

      {confirming && <LogoutConfirmDialog onClose={() => setConfirming(false)} />}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrapper: { position: 'relative' },
  avatar: {
    width: 32, height: 32, flexShrink: 0, borderRadius: '50%', border: 'none', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 0, background: 'none', fontFamily: 'inherit',
  },
  menu: {
    position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 50,
    minWidth: 200, maxWidth: 'min(280px, 80vw)',
    background: memberTheme.surface, color: memberTheme.text,
    border: `1px solid ${memberTheme.cardBorderColor}`, borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '4px 0', overflow: 'hidden',
  },
  family: { ...rowDividerStyle, borderBottom: rowDividerStyle.borderTop, padding: '8px 14px' },
  familyTitle: {
    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
    color: memberTheme.textMuted, marginBottom: 6,
  },
  familyRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', minWidth: 0 },
  thumbButton: { width: 28, height: 28, flexShrink: 0, borderRadius: '50%' },
  familyName: {
    flex: 1, minWidth: 0, fontSize: 14, color: memberTheme.text,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  ownerChip: { ...statusPillStyle('info'), padding: '2px 8px', fontSize: 11, flexShrink: 0 },
  item: {
    display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
    cursor: 'pointer', padding: '12px 14px', fontSize: 14, fontFamily: 'inherit', color: memberTheme.text,
  },
};
