'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';
import { MemberAvatar } from '@/components/MemberAvatar';
import { ImagePreviewButton } from '@/components/ImagePreview';
import {
  familyMemberPreviewSrc, familySectionMembers, type FamilyMenuMember,
} from '@/lib/memberUserMenu';
import { memberTheme, sectionCardStyle, statusPillStyle } from '@/lib/memberChrome';

/**
 * #3156 stage 2 — the Family page, opened from the avatar menu's **Family**
 * item. It lists every member of the caller's Family (`GET /me/family`, owner
 * first, then alphabetically) with their thumbnail, name and an Owner chip; a
 * thumbnail opens the 1080 × 1080 picture in the app's one image preview.
 * Read-only: the Family is managed by staff. Every decision is
 * `lib/memberUserMenu.ts`'s, every colour `lib/memberChrome.ts`'s (#983).
 */
export default function FamilyPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { isLinked, loading: appLoading } = useApp();
  const { apiFetch } = useApiClient();
  const [members, setMembers] = useState<FamilyMenuMember[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    apiFetch('/me/family')
      .then((body) => { if (!cancelled) setMembers(familySectionMembers(body)); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [appLoading, isLinked, apiFetch, locale, router]);

  if (error) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{t('common.error')}</p></main>;
  }
  if (!members) {
    return <main style={styles.container}><p style={styles.hint}>{t('family.loading')}</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('family.title')}</h1>
      {members.length === 0 ? (
        <p style={styles.hint}>{t('family.empty')}</p>
      ) : (
        <ul style={styles.card} aria-label={t('family.title')}>
          {members.map((m, i) => (
            <li key={m.member_id} style={{ ...styles.row, ...(i === 0 ? null : styles.divider) }}>
              <ImagePreviewButton
                src={familyMemberPreviewSrc(m)}
                alt={m.name}
                title={m.name}
                style={styles.thumbButton}
              >
                <MemberAvatar
                  member={{ id: m.member_id, name: m.name, image_url: m.image_url, image_thumbnail_url: m.image_thumbnail_url, modified_at: m.modified_at }}
                  size={48}
                />
              </ImagePreviewButton>
              <span style={styles.name} title={m.name}>{m.name}</span>
              {m.is_owner && <span style={styles.ownerChip}>{t('nav.family_owner')}</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const styles: Record<string, CSSProperties> = {
  container: { padding: 16, maxWidth: 720, margin: '0 auto' },
  title: { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  card: { ...sectionCardStyle, listStyle: 'none', margin: 0, padding: '0 18px' },
  row: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', minWidth: 0 },
  divider: { borderTop: `1px solid ${memberTheme.separator}` },
  thumbButton: { width: 48, height: 48, flexShrink: 0, borderRadius: '50%' },
  name: {
    flex: 1, minWidth: 0, fontSize: 16, fontWeight: 500, color: memberTheme.text,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  ownerChip: { ...statusPillStyle('info'), padding: '2px 10px', fontSize: 12, flexShrink: 0 },
  hint: { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
