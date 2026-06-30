'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';

interface Fare {
  id: number;
  name: string;
  price: string;
}

const emptyForm = { name: '', price: '' };

export default function FaresPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [fares, setFares] = useState<Fare[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Fare | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) {
      router.replace(`/${locale}`);
    }
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await apiFetch<Fare[]>('/fares');
      setFares(data);
    } catch {
      setFares([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(f: Fare) {
    setEditing(f);
    setForm({ name: f.name, price: f.price });
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.price.trim()) {
      setError(t('fares.error_required'));
      return;
    }
    const price = parseFloat(form.price);
    if (isNaN(price) || price < 0) {
      setError(t('fares.error_price'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = { name: form.name.trim(), price };
    try {
      if (editing) {
        await apiFetch(`/fares/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiFetch('/fares', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      load();
    } catch (err: any) {
      toast(err.message ?? t('fares.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm(t('fares.confirm_delete'))) return;
    try {
      await apiFetch(`/fares/${id}`, { method: 'DELETE' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('fares.error_generic'));
    }
  }

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('fares.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('fares.add')}</button>
      </div>

      {loading ? (
        <p style={{ color: '#666' }}>{t('fares.loading')}</p>
      ) : fares.length === 0 ? (
        <p style={{ color: '#666' }}>{t('fares.empty')}</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr style={{ background: '#f0f0f0', textAlign: 'left' }}>
              <th style={th}>{t('fares.col_name')}</th>
              <th style={th}>{t('fares.col_price')}</th>
              <th style={{ ...th, width: 120 }}>{t('fares.col_actions')}</th>
            </tr>
          </thead>
          <tbody>
            {fares.map((f) => (
              <tr key={f.id} style={{ borderTop: '1px solid #eee' }}>
                <td style={td}>{f.name}</td>
                <td style={td}>{parseFloat(f.price).toFixed(2)}</td>
                <td style={{ ...td, display: 'flex', gap: 8 }}>
                  <button onClick={() => openEdit(f)} style={btnSmall('#444')}>{t('fares.edit')}</button>
                  <button onClick={() => handleDelete(f.id)} style={btnSmall('#c0392b')}>{t('fares.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {modalOpen && (
        <div style={overlayStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px' }}>{editing ? t('fares.modal_edit') : t('fares.modal_add')}</h2>

            <label style={labelStyle}>{t('fares.label_name')}</label>
            <input
              style={inputStyle}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('fares.placeholder_name')}
              autoFocus
            />

            <label style={labelStyle}>{t('fares.label_price')}</label>
            <input
              style={inputStyle}
              type="number"
              min="0"
              step="0.01"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              placeholder="0.00"
            />

            {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={btnStyle('#aaa')} disabled={saving}>{t('fares.cancel')}</button>
              <button onClick={handleSave} style={btnStyle('#6c63ff')} disabled={saving}>
                {saving ? t('fares.saving') : editing ? t('fares.save_changes') : t('fares.modal_add')}
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
