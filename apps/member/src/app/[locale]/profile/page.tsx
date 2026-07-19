'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApp } from '@/context/AppContext';
import { useApiClient } from '@/lib/apiClient';

interface Profile {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export default function ProfilePage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isLinked, loading: appLoading } = useApp();

  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // edit state
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (appLoading) return;
    if (!isLinked) { router.replace(`/${locale}`); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await apiFetch<Profile>('/me/profile');
        if (!cancelled) {
          setProfile(data);
          setPhone(data.phone ?? '');
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message ?? t('common.error'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [appLoading, isLinked, locale]);

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

  if (loading) {
    return <main style={styles.container}><p style={styles.hint}>{t('profile.loading')}</p></main>;
  }

  if (error || !profile) {
    return <main style={styles.container}><p style={{ ...styles.hint, color: '#c0392b' }}>{error ?? t('common.error')}</p></main>;
  }

  return (
    <main style={styles.container}>
      <h1 style={styles.title}>{t('profile.title')}</h1>

      {toast && <div style={styles.toast}>{toast}</div>}

      <div style={styles.card}>
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
    </main>
  );
}

function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid #f0f0f0' }}>
      <p style={{ margin: 0, fontSize: 12, color: '#71717a', fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</p>
      <p style={{ margin: '4px 0 0', fontSize: 16, color: '#18181b', fontWeight: 500 }}>{value}</p>
      {note && <p style={{ margin: '2px 0 0', fontSize: 12, color: '#a1a1aa' }}>{note}</p>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container:   { padding: 16, maxWidth: 720, margin: '0 auto' },
  title:       { margin: '8px 0 16px', fontSize: 24, fontWeight: 700, color: '#18181b' },
  card:        { background: '#fff', borderRadius: 12, padding: '0 18px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' },
  fieldRow:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid #f0f0f0' },
  label:       { margin: 0, fontSize: 12, color: '#71717a', fontWeight: 500, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  value:       { margin: '4px 0 0', fontSize: 16, color: '#18181b', fontWeight: 500 },
  empty:       { color: '#a1a1aa', fontWeight: 400, fontStyle: 'italic' as const },
  editBtn:     { background: 'none', border: '1px solid #e4e4e7', borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', color: '#18181b', flexShrink: 0 },
  editRow:     { padding: '12px 0', borderBottom: '1px solid #f0f0f0' },
  input:       { display: 'block', width: '100%', padding: '10px 12px', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 16, marginTop: 6, boxSizing: 'border-box' as const, outline: 'none' },
  fieldError:  { margin: '6px 0 0', fontSize: 13, color: '#c0392b' },
  editActions: { display: 'flex', gap: 8, marginTop: 10 },
  btnSave:     { flex: 1, padding: '10px 0', background: '#18181b', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  btnCancel:   { flex: 1, padding: '10px 0', background: 'transparent', color: '#18181b', border: '1px solid #e4e4e7', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  toast:       { background: '#e6f6ec', color: '#1e7e40', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 14 },
  hint:        { color: '#71717a', fontSize: 14, textAlign: 'center', margin: '20px 0' },
};
