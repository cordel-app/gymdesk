'use client';

import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useToast } from '@/components/Toast';

interface Gym {
  id: string;
  name: string;
  slug: string;
  plan: string;
  created_at: string;
}

const emptyForm = { name: '', slug: '', plan: 'free' };

export default function SystemGymsPage() {
  const t = useTranslations('system_gyms');
  const { apiFetch } = useApiClient();
  const { isSuperadmin, setActiveGymId } = useGym();
  const router = useRouter();
  const locale = useLocale();
  const { toast } = useToast();

  const [gyms, setGyms] = useState<Gym[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuperadmin) {
      router.replace(`/${locale}`);
      return;
    }
    load();
  }, [isSuperadmin]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Gym[]>('/platform/gyms');
      setGyms(data);
    } catch (err: any) {
      setGyms([]);
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!form.name.trim() || !form.slug.trim()) {
      setError(t('error_required'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch('/platform/gyms', {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), slug: form.slug.trim(), plan: form.plan }),
      });
      setModalOpen(false);
      setForm(emptyForm);
      load();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  function handleManage(gymId: string) {
    setActiveGymId(gymId);
    router.push(`/${locale}/members`);
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button onClick={() => { setModalOpen(true); setForm(emptyForm); setError(null); }} style={btnStyle('#6c63ff')}>
          {t('create')}
        </button>
      </div>

      {loading ? (
        <p style={{ color: '#666' }}>{t('loading')}</p>
      ) : gyms.length === 0 ? (
        <p style={{ color: '#666' }}>{t('empty')}</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
              <th style={th}>{t('col_name')}</th>
              <th style={th}>{t('col_slug')}</th>
              <th style={th}>{t('col_plan')}</th>
              <th style={th}>{t('col_created')}</th>
              <th style={{ ...th, width: 120 }}>{t('col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {gyms.map((g) => (
              <tr key={g.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{g.name}</td>
                <td style={td}><code style={{ fontSize: 13 }}>{g.slug}</code></td>
                <td style={td}>{g.plan}</td>
                <td style={td}>{new Date(g.created_at).toLocaleDateString()}</td>
                <td style={td}>
                  <button onClick={() => handleManage(g.id)} style={btnSmall('#444')}>{t('manage')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalOpen && (
        <div style={overlayStyle} onClick={() => setModalOpen(false)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px' }}>{t('modal_title')}</h2>

            <label style={labelStyle}>{t('label_name')}</label>
            <input
              style={inputStyle}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="My Gym"
              autoFocus
            />

            <label style={labelStyle}>{t('label_slug')}</label>
            <input
              style={inputStyle}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
              placeholder="my-gym"
            />

            <label style={labelStyle}>{t('label_plan')}</label>
            <select style={inputStyle} value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
              <option value="free">{t('plan_free')}</option>
              <option value="pro">{t('plan_pro')}</option>
            </select>

            {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
              <button onClick={() => setModalOpen(false)} style={btnStyle('#aaa')} disabled={saving}>{t('cancel')}</button>
              <button onClick={handleCreate} style={btnStyle('#6c63ff')} disabled={saving}>
                {saving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
const th: React.CSSProperties = { padding: '12px 16px', fontWeight: 600, fontSize: 15 };
const td: React.CSSProperties = { padding: '12px 16px', fontSize: 15 };
function btnStyle(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
}
function btnSmall(bg: string): React.CSSProperties {
  return { background: bg, color: '#fff', border: 'none', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', fontSize: 13 };
}
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalStyle: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 32, width: 420, maxWidth: '90vw', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' };
