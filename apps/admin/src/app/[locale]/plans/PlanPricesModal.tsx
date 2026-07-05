'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface Price {
  id: number;
  price: string;
  valid_from: string;
  valid_to: string | null;
}

const emptyForm = { price: '', valid_from: '', valid_to: '' };

// Backend returns dates as ISO datetimes; show just the day.
const day = (d: string | null) => (d ? d.slice(0, 10) : null);

export function PlanPricesModal({ planId, planName, onClose }: { planId: number; planName: string; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [prices, setPrices] = useState<Price[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Price | null>(null);

  async function load() {
    setLoading(true);
    try {
      setPrices(await apiFetch<Price[]>(`/membership-plans/${planId}/prices`));
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [planId]);

  function resetForm() {
    setForm(emptyForm);
    setEditingId(null);
    setError(null);
  }

  function startEdit(p: Price) {
    setEditingId(p.id);
    setForm({ price: p.price, valid_from: day(p.valid_from) ?? '', valid_to: day(p.valid_to) ?? '' });
    setError(null);
  }

  async function save() {
    if (!form.price.trim() || !form.valid_from) {
      setError(t('prices.error_required'));
      return;
    }
    const price = parseFloat(form.price);
    if (isNaN(price) || price < 0) {
      setError(t('prices.error_price'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = { price, valid_from: form.valid_from, valid_to: form.valid_to || null };
    try {
      if (editingId) {
        await apiFetch(`/membership-plans/${planId}/prices/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiFetch(`/membership-plans/${planId}/prices`, { method: 'POST', body: JSON.stringify(body) });
      }
      resetForm();
      load();
    } catch (err: any) {
      // Overlap and validation errors come back as 400 with a specific message
      setError(err.message ?? t('plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/membership-plans/${planId}/prices/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) resetForm();
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 560 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('prices.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{planName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('prices.loading')}</p>
        ) : prices.length === 0 ? (
          <p style={{ color: '#666' }}>{t('prices.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('prices.col_from')}</th>
                <th style={th}>{t('prices.col_to')}</th>
                <th style={th}>{t('prices.col_price')}</th>
                <th style={{ ...th, width: 110 }} />
              </tr>
            </thead>
            <tbody>
              {prices.map((p) => (
                <tr key={p.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{day(p.valid_from)}</td>
                  <td style={td}>{day(p.valid_to) ?? <em style={{ color: '#888' }}>{t('prices.ongoing')}</em>}</td>
                  <td style={td}>{parseFloat(p.price).toFixed(2)}</td>
                  <td style={{ ...td, display: 'flex', gap: 6 }}>
                    <button onClick={() => startEdit(p)} style={btnSmall('#444')}>{t('plans.edit')}</button>
                    <button onClick={() => setDeleting(p)} style={btnSmall('#c0392b')}>{t('plans.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>
            {editingId ? t('prices.edit_heading') : t('prices.add_heading')}
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label={t('prices.col_from')}>
              <input type="date" value={form.valid_from} onChange={(e) => setForm({ ...form, valid_from: e.target.value })} style={input} />
            </Field>
            <Field label={t('prices.col_to')}>
              <input type="date" value={form.valid_to} onChange={(e) => setForm({ ...form, valid_to: e.target.value })} style={input} placeholder={t('prices.ongoing')} />
            </Field>
            <Field label={t('prices.col_price')}>
              <input type="number" min="0" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} style={{ ...input, width: 100 }} placeholder="0.00" />
            </Field>
            <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('plans.saving') : editingId ? t('plans.save_changes') : t('prices.add')}
            </button>
            {editingId && (
              <button onClick={resetForm} style={btnStyle('#aaa')} disabled={saving}>{t('plans.cancel')}</button>
            )}
          </div>
          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('prices.close')}</button>
        </div>

        <ConfirmDialog
          open={deleting !== null}
          message={t('prices.confirm_delete')}
          confirmLabel={t('plans.delete')}
          cancelLabel={t('plans.cancel')}
          onConfirm={handleDelete}
          onCancel={() => setDeleting(null)}
        />
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: '#666' }}>{label}</span>
      {children}
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, fontWeight: 600, color: '#555' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14 };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
