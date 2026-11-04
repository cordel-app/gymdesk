'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { primaryBtnSmall } from '@/components/ui';
import {
  cardMutedTextStyle, formControlStyle, formErrorStyle, innerCardStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { listNameBadgeAccentStyle } from '@/components/listChrome';
import { MemberAvatar } from '@/components/MemberAvatar';
import { memberImagePreviewSrc } from '@/components/MemberImageField';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';
import { overlayStyle, modalStyle } from '@/components/ui';

interface FamilyMember { member_id: number; name: string; email: string; is_owner: boolean;
  image_url?: string | null; image_thumbnail_url?: string | null; modified_at?: string | null }
interface Family { id: number; name: string; owner_member_id: number | null; members: FamilyMember[] }
interface Candidate { id: number; name: string }

type Pending = { kind: 'remove'; member: FamilyMember } | { kind: 'dissolve' } | null;

/**
 * #2123 stage 1 — the Member card's **Family** tab. The family is the server's
 * (`/members/:id/family`): this component only draws it and calls the routes, and decides
 * no ownership rule. The owner is shown as the future payer of family purchases.
 */
export function MemberFamily({ memberId, canWrite }: { memberId: number | string; canWrite: boolean }) {
  const t = useTranslations();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const base = `/members/${memberId}/family`;
  const [family, setFamily] = useState<Family | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<FamilyMember | null>(null);

  const load = useCallback(() => {
    apiFetch<{ family: Family | null }>(base)
      .then((r) => { setFamily(r.family); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setCandidates([]); return; }
    const handle = setTimeout(() => {
      apiFetch<Candidate[]>(`/members?q=${encodeURIComponent(q)}`)
        .then((rows) => setCandidates(rows.filter((m) => !family?.members.some((f) => f.member_id === m.id))))
        .catch(() => setCandidates([]));
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, family]);

  async function run(fn: () => Promise<{ family: Family | null } | undefined | void>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (r && 'family' in r) setFamily(r.family); else setFamily(null);
      setSearch('');
    } catch (err: any) {
      setError(err?.body?.error ?? t('members.family_action_error'));
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  if (failed) return <p style={formErrorStyle}>{t('members.family_error')}</p>;
  if (family === undefined) return <p style={cardMutedTextStyle}>{t('members.family_loading')}</p>;

  if (family === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <p style={cardMutedTextStyle}>{t('members.family_none')}</p>
        {canWrite && (
          <div>
            <button style={primaryBtnSmall()} disabled={busy} onClick={() => run(() => apiFetch(base, { method: 'POST', body: JSON.stringify({}) }))}>
              {t('members.family_create')}
            </button>
          </div>
        )}
        {error && <p style={formErrorStyle}>{error}</p>}
      </div>
    );
  }

  const owner = family.members.find((m) => m.is_owner);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 600 }}>{family.name}</div>
      {owner && <p style={cardMutedTextStyle}>{t('members.family_payer_note', { name: owner.name })}</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {family.members.map((m) => (
          <div key={m.member_id} style={{ ...innerCardStyle, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {m.image_url && SAFE_IMAGE_SRC.test(memberImagePreviewSrc(m.image_url, m.modified_at) ?? '') ? (
              <button type="button" onClick={() => setPhoto(m)} aria-label={t('members.family_photo_open', { name: m.name })}
                style={{ border: 0, padding: 0, background: 'none', cursor: 'pointer', display: 'flex', borderRadius: '50%' }}>
                <MemberAvatar name={m.name} imageUrl={m.image_thumbnail_url ?? m.image_url} stamp={m.modified_at} />
              </button>
            ) : (
              <MemberAvatar name={m.name} imageUrl={null} />
            )}
            <span style={{ fontWeight: 500 }}>{m.name}</span>
            {m.is_owner && <span style={listNameBadgeAccentStyle}>{t('members.family_owner_badge')}</span>}
            <span style={cardMutedTextStyle}>{m.email}</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <a href={`/${locale}/members?member=${m.member_id}`} style={{ ...secondaryBtnSmall, textDecoration: 'none', display: 'inline-block' }}>
                {t('members.family_view')}
              </a>
              {canWrite && (<>
                <button style={secondaryBtnSmall} disabled={busy} onClick={() => setPending({ kind: 'remove', member: m })}>
                  {t('members.family_remove')}
                </button>
              </>)}
            </span>
          </div>
        ))}
      </div>
      {canWrite && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <input style={formControlStyle} value={search} placeholder={t('members.family_add_placeholder')}
            aria-label={t('members.family_add_member')} onChange={(e) => setSearch(e.target.value)} />
          {candidates.map((c) => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{c.name}</span>
              <button style={primaryBtnSmall()} disabled={busy}
                onClick={() => run(() => apiFetch(`${base}/members`, { method: 'POST', body: JSON.stringify({ member_id: c.id }) }))}>
                {t('members.family_add_member')}
              </button>
            </div>
          ))}
          <div>
            <button style={secondaryBtnSmall} disabled={busy} onClick={() => setPending({ kind: 'dissolve' })}>
              {t('members.family_dissolve')}
            </button>
          </div>
        </div>
      )}
      {error && <p style={formErrorStyle}>{error}</p>}
      {photo && (
        <div style={overlayStyle} onClick={() => setPhoto(null)} role="presentation"
          onKeyDown={(e) => { if (e.key === 'Escape') setPhoto(null); }}>
          <div role="dialog" aria-modal="true" aria-label={photo.name}
            style={{ ...modalStyle, width: 'auto', maxWidth: '90vw', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
            onClick={(e) => e.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={memberImagePreviewSrc(photo.image_url, photo.modified_at) ?? ''} alt={photo.name}
              style={{ maxWidth: '100%', maxHeight: '75vh', objectFit: 'contain', display: 'block' }} />
            <div><button type="button" autoFocus style={secondaryBtnSmall} onClick={() => setPhoto(null)}>{t('members.family_photo_close')}</button></div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={pending !== null}
        message={pending?.kind === 'remove'
          ? t('members.family_confirm_remove', { name: pending.member.name })
          : t('members.family_confirm_dissolve')}
        confirmLabel={t('members.family_confirm_action')}
        cancelLabel={t('members.family_cancel')}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending?.kind === 'remove') {
            const id = pending.member.member_id;
            run(() => apiFetch(`${base}/members/${id}`, { method: 'DELETE' }));
          } else {
            run(async () => { await apiFetch(base, { method: 'DELETE' }); return { family: null }; });
          }
        }}
      />
    </div>
  );
}
