'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface WorkoutTemplateOption { id: number; name: string }
interface Link { id: number; position: number; workout_template_id: number; workout_template_name: string; scheduled_weekday: number | null }

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const emptyForm = { workout_template_id: '', scheduled_weekday: '' };

export function TemplateWorkoutsModal({ templateId, templateName, onClose }: { templateId: number; templateName: string; onClose: () => void }) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [links, setLinks] = useState<Link[]>([]);
  const [options, setOptions] = useState<WorkoutTemplateOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Link | null>(null);

  const base = `/training-plan-templates/${templateId}/workouts`;

  async function load() {
    setLoading(true);
    try {
      const [ls, opts] = await Promise.all([
        apiFetch<Link[]>(base),
        apiFetch<WorkoutTemplateOption[]>('/workout-templates'),
      ]);
      setLinks(ls); setOptions(opts);
    } catch (err: any) { toast(err.message ?? t('template_workouts.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [templateId]);

  function resetForm() { setForm(emptyForm); setEditingId(null); setError(null); }
  function startEdit(l: Link) {
    setEditingId(l.id);
    setForm({ workout_template_id: String(l.workout_template_id), scheduled_weekday: l.scheduled_weekday != null ? String(l.scheduled_weekday) : '' });
    setError(null);
  }

  async function save() {
    if (!editingId && !form.workout_template_id) { setError(t('template_workouts.error_required')); return; }
    setSaving(true); setError(null);
    try {
      if (editingId) {
        await apiFetch(`${base}/${editingId}`, {
          method: 'PUT',
          body: JSON.stringify({ scheduled_weekday: form.scheduled_weekday === '' ? null : parseInt(form.scheduled_weekday, 10) }),
        });
      } else {
        await apiFetch(base, {
          method: 'POST',
          body: JSON.stringify({
            workout_template_id: parseInt(form.workout_template_id, 10),
            scheduled_weekday: form.scheduled_weekday === '' ? null : parseInt(form.scheduled_weekday, 10),
          }),
        });
      }
      resetForm(); load();
    } catch (err: any) { setError(err.message ?? t('template_workouts.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`${base}/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); if (editingId === deleting.id) resetForm(); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('template_workouts.error_generic')); }
  }

  async function move(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= links.length) return;
    const order = [...links];
    [order[idx], order[next]] = [order[next], order[idx]];
    try { await apiFetch(`${base}/reorder`, { method: 'PUT', body: JSON.stringify({ order: order.map((l) => l.id) }) }); load(); }
    catch (err: any) { toast(err.message ?? t('template_workouts.error_generic')); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 600 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('template_workouts.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{templateName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('template_workouts.loading')}</p>
        ) : links.length === 0 ? (
          <p style={{ color: '#666' }}>{t('template_workouts.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('template_workouts.col_workout_template')}</th>
                <th style={th}>{t('template_workouts.col_weekday')}</th>
                <th style={{ ...th, width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {links.map((l, idx) => (
                <tr key={l.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{l.workout_template_name}</td>
                  <td style={td}>{l.scheduled_weekday != null ? t(`workouts.weekday_${l.scheduled_weekday}`) : '—'}</td>
                  <td style={{ ...td, display: 'flex', gap: 6 }}>
                    <button onClick={() => move(idx, -1)} style={btnSmall('#888')} disabled={idx === 0}>↑</button>
                    <button onClick={() => move(idx, 1)} style={btnSmall('#888')} disabled={idx === links.length - 1}>↓</button>
                    <button onClick={() => startEdit(l)} style={btnSmall('#444')}>{t('template_workouts.edit')}</button>
                    <button onClick={() => setDeleting(l)} style={btnSmall('#c0392b')}>{t('template_workouts.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>
            {editingId ? t('template_workouts.edit_heading') : t('template_workouts.add_heading')}
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            {!editingId && (
              <Field label={t('template_workouts.col_workout_template')}>
                <select value={form.workout_template_id} onChange={(e) => setForm({ ...form, workout_template_id: e.target.value })} style={{ ...input, width: 220 }}>
                  <option value="">—</option>
                  {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </Field>
            )}
            <Field label={t('template_workouts.col_weekday')}>
              <select value={form.scheduled_weekday} onChange={(e) => setForm({ ...form, scheduled_weekday: e.target.value })} style={{ ...input, width: 150 }}>
                <option value="">—</option>
                {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
              </select>
            </Field>
            <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('template_workouts.saving') : editingId ? t('template_workouts.save_changes') : t('template_workouts.add')}
            </button>
            {editingId && <button onClick={resetForm} style={btnStyle('#aaa')} disabled={saving}>{t('template_workouts.cancel')}</button>}
          </div>
          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('template_workouts.close')}</button>
        </div>

        <ConfirmDialog
          open={deleting !== null}
          message={t('template_workouts.confirm_delete')}
          confirmLabel={t('template_workouts.delete')}
          cancelLabel={t('template_workouts.cancel')}
          onConfirm={del}
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
