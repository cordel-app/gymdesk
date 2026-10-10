'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { clerkStatusLine, clerkInvitationLine } from '@/lib/clerkAccountLines';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useImpersonation } from '@/context/ImpersonationContext';
import { useApiClient } from '@/lib/apiClient';
import { useFeatureFlags, isFeatureEnabled } from '@/context/FeatureFlagsContext';
import { MEMBER_LOCALES, isMemberLocale, memberLocaleLabel } from '@/lib/memberLocale';
import { MemberPhotoField } from '@/components/MemberPhotoField';
import {
  inputStyle,
  memberTheme,
  noticeStyle,
  primaryButtonStyle,
  secondaryButtonStyle,
  sectionCardStyle,
} from '@/lib/memberChrome';

interface Profile {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  /** #1039: the member's stored default language, or `null` for no preference. */
  preferred_locale: string | null;
  /** #1374/#1375: the member's photo and the stamp its preview is busted on. */
  image_url?: string | null;
  modified_at?: string | null;
  /** #1234: Clerk account history, stored dates. */
  clerk_user_id?: string | null;
  invitation_id?: string | null;
  invited_at?: string | null;
  enrolled_at?: string | null;
}

interface Membership {
  status: 'active' | 'paused' | 'cancelled' | 'expired';
}

interface PaymentRequest {
  status: 'pending' | 'completed' | 'failed' | 'expired';
}

export default function ProfilePage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const {
    isLinked, loading: appLoading,
    gyms, gymId, switchGym,
    centers, activeCenterId, setActiveCenterId,
    isSuperadmin,
    member, updateMember,
  } = useApp();
  const { isImpersonating } = useImpersonation();
  const { flags: featureFlags } = useFeatureFlags();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<'ok' | 'pending' | 'failed' | null>(null);

  // edit state
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // #1039: the Language selector persists on change rather than behind the
  // phone field's Edit/Save pair — it is one value, and the app switches to it
  // as soon as it is stored.
  const [savingLocale, setSavingLocale] = useState(false);
  const [localeError, setLocaleError] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    if (!(isSuperadmin && !isImpersonating) && !isFeatureEnabled(featureFlags, 'member_web.profile')) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const [data, mship, prs] = await Promise.all([
          apiFetch<Profile>('/me/profile'),
          apiFetch<{ membership: Membership | null }>('/me/membership').catch(() => ({ membership: null })),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
        ]);
        if (cancelled) return;
        setProfile(data);
        setPhone(data.phone ?? '');
        setMembership(mship.membership);
        if (prs.some((p) => p.status === 'failed')) setPaymentStatus('failed');
        else if (prs.some((p) => p.status === 'pending')) setPaymentStatus('pending');
        else setPaymentStatus('ok');
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale, isSuperadmin, isImpersonating, featureFlags]);

  function startEdit() {
    setPhone(profile?.phone ?? '');
    setSaveError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setSaveError(null);
  }

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiFetch<Profile>('/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ phone: phone.trim() || null }),
      });
      setProfile(updated);
      setEditing(false);
      setToast(t('profile.saved'));
      setTimeout(() => setToast(null), 3000);
    } catch (err: any) {
      setSaveError(err.message ?? t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  async function changeLanguage(next: string) {
    setSavingLocale(true);
    setLocaleError(null);
    try {
      const updated = await apiFetch<Profile>('/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ preferred_locale: next }),
      });
      setProfile(updated);
      // The redirect is `MemberLocalePreference`'s, off the context's copy of
      // the profile (#1039, §5: one switching mechanism for the whole app) —
      // so the only thing left to do here is stop that copy being stale.
      if (member) updateMember({ ...member, preferred_locale: updated.preferred_locale });
      setToast(t('profile.saved'));
      setTimeout(() => setToast(null), 3000);
    } catch (err: any) {
      setLocaleError(err.message ?? t('common.error'));
    } finally {
      setSavingLocale(false);
    }
  }

  /**
   * #1375: the photo control answers with the profile as `GET /me/profile`
   * shapes it, so the page takes it whole and the context's copy — which is
   * what the top-bar avatar reads — follows in the same breath.
   */
  function photoChanged(updated: unknown) {
    const next = updated as Profile;
    setProfile(next);
    if (member) updateMember({ ...member, image_url: next.image_url ?? null, modified_at: next.modified_at ?? null });
  }

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('profile.loading')}</p></main>;
  }

  if (error || !profile) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{error ?? t('common.error')}</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('profile.title')}</h1>

      {toast && <div style={styles.toast}>{toast}</div>}

      <div style={styles.card}>
        {/* #1375: the member's own photo. A superadmin impersonating them sees
            it and gets no control (§2) — the staff path is the Member card. */}
        <MemberPhotoField
          member={profile}
          canEdit={!isImpersonating}
          label={(key) => t(`profile.${key}`)}
          onChanged={photoChanged}
        />
        <Field label={t('profile.name')} value={profile.name} />
        <Field label={t('profile.email')} value={profile.email} note={t('profile.email_readonly')} />

        {editing ? (
          <div style={styles.editRow}>
            <label style={styles.label}>{t('profile.phone')}</label>
            <input
              style={styles.input}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t('profile.phone_placeholder')}
              autoFocus
            />
            {saveError && <p style={styles.fieldError}>{saveError}</p>}
            <div style={styles.editActions}>
              <button style={styles.btnSave} disabled={saving} onClick={save}>
                {saving ? '…' : t('profile.save')}
              </button>
              <button style={styles.btnCancel} disabled={saving} onClick={cancelEdit}>
                {t('profile.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <div style={styles.fieldRow}>
            <div>
              <p style={styles.label}>{t('profile.phone')}</p>
              <p style={styles.value}>{profile.phone ?? <span style={styles.empty}>{t('profile.not_set')}</span>}</p>
            </div>
            <button style={styles.editBtn} onClick={startEdit}>{t('profile.edit')}</button>
          </div>
        )}
      </div>

      {/* #361: default gym / center + enrollment / payment status summary */}
      <div style={{ ...styles.card, marginTop: 16 }}>
        {gyms.length > 1 && (
          <div style={styles.editRow}>
            <p style={styles.label}>{t('profile.default_gym')}</p>
            <select
              value={gymId ?? ''}
              onChange={(e) => switchGym(e.target.value)}
              style={styles.select}
              aria-label={t('common.gym_switcher_label')}
            >
              {gyms.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        )}

        <div style={styles.editRow}>
          <p style={styles.label}>{t('profile.default_center')}</p>
          {centers.length > 0 ? (
            <select
              value={activeCenterId ?? ''}
              onChange={(e) => setActiveCenterId(Number(e.target.value))}
              style={styles.select}
              aria-label={t('common.center_switcher_label')}
            >
              {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : (
            <p style={styles.value}><span style={styles.empty}>{t('profile.no_center')}</span></p>
          )}
        </div>

        {/* #1039: the member's default language, beside Default Center and in
            the same control, per §1/§12. A member with no stored preference
            sees the locale the app is already rendering in selected (§11) —
            the selector never offers "no preference", since choosing a language
            is the whole point of it. A stored locale this app cannot render
            (one the deployment configures and the Members App has no messages
            for) falls back the same way, rather than leaving the control
            showing a language that is not the one selected. */}
        <div style={styles.editRow}>
          <p style={styles.label}>{t('profile.language')}</p>
          <select
            value={isMemberLocale(profile.preferred_locale) ? profile.preferred_locale : locale}
            onChange={(e) => changeLanguage(e.target.value)}
            style={styles.select}
            disabled={savingLocale}
            aria-label={t('profile.language')}
          >
            {MEMBER_LOCALES.map((code) => (
              <option key={code} value={code}>{memberLocaleLabel(code, t)}</option>
            ))}
          </select>
          {localeError && <p style={styles.fieldError}>{localeError}</p>}
        </div>

        <div style={styles.fieldRow}>
          <div>
            <p style={styles.label}>{t('profile.enrollment')}</p>
            <p style={styles.value}>
              {membership ? t(`membership.status.${membership.status}`) : <span style={styles.empty}>{t('home.no_membership')}</span>}
            </p>
          </div>
        </div>

        {/* #1234: Clerk Status and Clerk Invitation, from stored dates. */}
        {(() => {
          const fields = { clerk_user_id: profile.clerk_user_id, has_pending_invitation: !!profile.invitation_id, invited_at: profile.invited_at, enrolled_at: profile.enrolled_at };
          const status = clerkStatusLine(fields, locale);
          const invitation = clerkInvitationLine(fields, locale);
          return (
            <>
              <Field label={t('profile.label_clerk_status')} value={t(`profile.${status.key}`, { date: status.date ?? '' })} />
              <Field label={t('profile.label_clerk_invitation')} value={t(`profile.${invitation.key}`, { date: invitation.date ?? '' })} />
            </>
          );
        })()}

        <div style={{ padding: '12px 0' }}>
          <p style={styles.label}>{t('profile.payment_status')}</p>
          <p style={styles.value}>
            {paymentStatus === 'failed' && t('profile.payment_status_failed')}
            {paymentStatus === 'pending' && t('profile.payment_status_pending')}
            {paymentStatus === 'ok' && t('profile.payment_status_ok')}
          </p>
        </div>
      </div>
    </main>
  );
}

function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={styles.editRow}>
      <p style={styles.label}>{label}</p>
      <p style={styles.value}>{value}</p>
      {note && <p style={styles.note}>{note}</p>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:   { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:       { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: memberTheme.title1, fontFamily: memberTheme.title1Font },
  card:        { ...sectionCardStyle, padding: '0 18px' },
  fieldRow:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${memberTheme.separator}` },
  label:       { margin: 0, fontSize: 12, color: memberTheme.textMuted, fontWeight: 500, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  value:       { margin: '4px 0 0', fontSize: 16, color: memberTheme.text, fontWeight: 500 },
  note:        { margin: '2px 0 0', fontSize: 12, color: memberTheme.textMuted },
  empty:       { color: memberTheme.textMuted, fontWeight: 400, fontStyle: 'italic' as const },
  editBtn:     { ...secondaryButtonStyle, padding: '6px 14px', fontSize: 13, fontWeight: 600, flexShrink: 0 },
  editRow:     { padding: '12px 0', borderBottom: `1px solid ${memberTheme.separator}` },
  input:       { ...inputStyle, display: 'block', width: '100%', padding: '10px 12px', fontSize: 16, marginTop: 6, boxSizing: 'border-box' as const, outline: 'none' },
  select:      { ...inputStyle, display: 'block', width: '100%', padding: '10px 12px', fontSize: 15, marginTop: 6, boxSizing: 'border-box' as const },
  fieldError:  { margin: '6px 0 0', fontSize: 13, color: memberTheme.statusError },
  editActions: { display: 'flex', gap: 8, marginTop: 10 },
  btnSave:     { ...primaryButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 },
  btnCancel:   { ...secondaryButtonStyle, flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 },
  toast:       { ...noticeStyle('success'), marginBottom: 16 },
  hint:        { color: memberTheme.textMuted, fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
