'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface BenefitType {
  id: number;
  code: string;
  active: 0 | 1;
}

interface Benefit {
  id: number;
  benefit_type_id: number;
  benefit_code: string;
  quantity: number | null;
  duration_days: number | null;
  recurrence: string | null;
  valid_from: string | null;
  valid_to: string | null;
}

const emptyForm = { benefit_type_id: '', quantity: '', duration_days: '', recurrence: '', valid_from: '', valid_to: '' };
const day = (d: string | null) => (d ? d.slice(0, 10) : null);

export function PlanBenefitsModal({ planId, planName, onClose }: { planId: number; planName: string; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [types, setTypes] = useState<BenefitType[]>([]);
  const [benefits, setBenefits] = useState<Benefit[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Benefit | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [b, ty] = await Promise.all([
        apiFetch<Benefit[]>(`/membership-plans/${planId}/benefits`),
        apiFetch<BenefitType[]>('/benefit-types'),
      ]);
      setBenefits(b);
      setTypes(ty.filter((x) => x.active === 1));
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

  function startEdit(b: Benefit) {
    setEditingId(b.id);
    setForm({
      benefit_type_id: String(b.benefit_type_id),
      quantity: b.quantity != null ? String(b.quantity) : '',
      duration_days: b.duration_days != null ? String(b.duration_days) : '',
      recurrence: b.recurrence ?? '',
      valid_from: day(b.valid_from) ?? '',
      valid_to: day(b.valid_to) ?? '',
    });
    setError(null);
  }

  // Summarises a row: "1 × free locker · 90 days · monthly"
  function describe(b: Benefit) {
    const parts: string[] = [];
    if (b.quantity != null) parts.push(`${b.quantity} ×`);
    parts.push(t(`benefit_type.${b.benefit_code}`));
    if (b.duration_days != null) parts.push(`· ${t('benefits.days', { n: b.duration_days })}`);
    if (b.recurrence) parts.push(`· ${t(`benefits.recurrence_${b.recurrence}`)}`);
    return parts.join(' ');
  }

  async function save() {
    if (!form.benefit_type_id) {
      setError(t('benefits.error_type'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      benefit_type_id: Number(form.benefit_type_id),
      quantity: form.quantity || null,
      duration_days: form.duration_days || null,
      recurrence: form.recurrence || null,
      valid_from: form.valid_from || null,
      valid_to: form.valid_to || null,
    };
    try {
      if (editingId) {
        await apiFetch(`/membership-plans/${planId}/benefits/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiFetch(`/membership-plans/${planId}/benefits`, { method: 'POST', body: JSON.stringify(body) });
      }
      resetForm();
      load();
    } catch (err: any) {
      setError(err.message ?? t('plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/membership-plans/${planId}/benefits/${deleting.id}`, { method: 'DELETE' });
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
      <div style={{ ...modalStyle, width: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('benefits.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{planName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('benefits.loading')}</p>
        ) : benefits.length === 0 ? (
          <p style={{ color: '#666' }}>{t('benefits.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <tbody>
              {benefits.map((b) => (
                <tr key={b.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{describe(b)}</td>
                  <td style={{ ...td, fontSize: 13, color: '#888' }}>
                    {day(b.valid_from) || day(b.valid_to)
                      ? `${day(b.valid_from) ?? '…'} → ${day(b.valid_to) ?? '…'}`
                      : null}
                  </td>
                  <td style={{ ...td, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={() => startEdit(b)} style={btnSmall('#444')}>{t('plans.edit')}</button>
                    <button onClick={() => setDeleting(b)} style={btnSmall('#c0392b')}>{t('plans.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>
            {editingId ? t('benefits.edit_heading') : t('benefits.add_heading')}
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Field label={t('benefits.label_type')}>
              <select value={form.benefit_type_id} onChange={(e) => setForm({ ...form, benefit_type_id: e.target.value })} style={{ ...input, minWidth: 170 }}>
                <option value="">—</option>
                {types.map((ty) => (
                  <option key={ty.id} value={ty.id}>{t(`benefit_type.${ty.code}`)}</option>
                ))}
              </select>
            </Field>
            <Field label={t('benefits.label_quantity')}>
              <input type="number" min="1" value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} style={{ ...input, width: 70 }} />
            </Field>
            <Field label={t('benefits.label_duration')}>
              <input type="number" min="1" value={form.duration_days} onChange={(e) => setForm({ ...form, duration_days: e.target.value })} style={{ ...input, width: 80 }} />
            </Field>
            <Field label={t('benefits.label_recurrence')}>
              <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })} style={input}>
                <option value="">{t('benefits.recurrence_once')}</option>
                <option value="monthly">{t('benefits.recurrence_monthly')}</option>
                <option value="yearly">{t('benefits.recurrence_yearly')}</option>
              </select>
            </Field>
            <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('plans.saving') : editingId ? t('plans.save_changes') : t('benefits.add')}
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
          message={t('benefits.confirm_delete')}
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

const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14 };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
