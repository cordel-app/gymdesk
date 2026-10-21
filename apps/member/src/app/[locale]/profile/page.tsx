'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDateOnly } from '@/lib/gymFormat';
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
  image_thumbnail_url?: string | null;
  modified_at?: string | null;
  /** #1948: the rest of the member's personal information, shown read-only. */
  date_of_birth?: string | null;
  gender?: string | null;
  address?: string | null;
  emergency_contact?: string | null;
  nif_nie_passport?: string | null;
}

interface PaymentRequest {
  status: 'pending' | 'completed' | 'failed' | 'expired';
}

export default function ProfilePage() {
  const t = useTranslations();
  const locale = useLocale();
  const gymFmt = useGymFormatSettings();
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
  const [paymentStatus, setPaymentStatus] = useState<'ok' | 'pending' | 'failed' | null>(null);

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
        const [data, prs] = await Promise.all([
          apiFetch<Profile>('/me/profile'),
          apiFetch<PaymentRequest[]>('/me/payment-requests').catch(() => []),
        ]);
        if (cancelled) return;
        setProfile(data);
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
    if (member) updateMember({
      ...member,
      image_url: next.image_url ?? null,
      image_thumbnail_url: next.image_thumbnail_url ?? null,
      modified_at: next.modified_at ?? null,
    });
  }

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('profile.loading')}</p></main>;
  }

  if (error || !profile) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: memberTheme.statusError }}>{error ?? t('common.error')}</p></main>;
  }

  return (
    <main style={styles.container}>

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

        {/* #1948: every personal field is read-only; only the preferences
            below (gym, center, language) can be changed here. Empty optional
            fields are omitted rather than shown as placeholders. */}
        <Field label={t('profile.phone')} value={profile.phone || t('profile.not_set')} />
        {profile.date_of_birth && <Field label={t('profile.date_of_birth')} value={formatGymDateOnly(profile.date_of_birth, gymFmt)} />}
        {profile.gender && <Field label={t('profile.gender')} value={profile.gender} />}
        {profile.address && <Field label={t('profile.address')} value={profile.address} />}
        {profile.emergency_contact && <Field label={t('profile.emergency_contact')} value={profile.emergency_contact} />}
        {profile.nif_nie_passport && <Field label={t('profile.document_id')} value={profile.nif_nie_passport} />}
      </div>

      {/* #361: default gym / center + payment status summary */}
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
