'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';
import { PlanWorkoutBlocksModal } from './PlanWorkoutBlocksModal';

interface Workout { id: number; position: number; name: string; description: string | null; scheduled_weekday: number | null }

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const emptyForm = { name: '', description: '', scheduled_weekday: '' };

/**
 * #55: editor for an assigned TrainingPlan's Workout -> WorkoutBlock ->
 * WorkoutExercise hierarchy — editing here never touches the original
 * TrainingPlanTemplate it may have been cloned from.
 */
export function TrainingPlanEditorModal({ memberId, planId, planName, onClose }: {
  memberId: number; planId: number; planName: string; onClose: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Workout | null>(null);
  const [blocksFor, setBlocksFor] = useState<Workout | null>(null);

  const base = `/members/${memberId}/training-plans/${planId}/workouts`;

  async function load() {
    setLoading(true);
    try {
      const plan = await apiFetch<{ workouts: Workout[] | null }>(`/members/${memberId}/training-plans/${planId}`);
      setWorkouts(plan.workouts ?? []);
    } catch (err: any) { toast(err.message ?? t('training_plan_editor.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [memberId, planId]);

  function resetForm() { setForm(emptyForm); setEditingId(null); setError(null); }
  function startEdit(w: Workout) {
    setEditingId(w.id);
    setForm({ name: w.name, description: w.description ?? '', scheduled_weekday: w.scheduled_weekday != null ? String(w.scheduled_weekday) : '' });
    setError(null);
  }

  async function save() {
    if (!form.name.trim()) { setError(t('training_plan_editor.error_required')); return; }
    setSaving(true); setError(null);
    const body = {
      name: form.name.trim(), description: form.description.trim() || null,
      scheduled_weekday: form.scheduled_weekday === '' ? null : parseInt(form.scheduled_weekday, 10),
    };
    try {
      if (editingId) await apiFetch(`${base}/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch(base, { method: 'POST', body: JSON.stringify(body) });
      resetForm(); load();
    } catch (err: any) { setError(err.message ?? t('training_plan_editor.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`${base}/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); if (editingId === deleting.id) resetForm(); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('training_plan_editor.error_generic')); }
  }

  async function move(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= workouts.length) return;
    const order = [...workouts];
    [order[idx], order[next]] = [order[next], order[idx]];
    try { await apiFetch(`${base}/reorder`, { method: 'PUT', body: JSON.stringify({ order: order.map((w) => w.id) }) }); load(); }
    catch (err: any) { toast(err.message ?? t('training_plan_editor.error_generic')); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('training_plan_editor.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{planName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('training_plan_editor.loading')}</p>
        ) : workouts.length === 0 ? (
          <p style={{ color: '#666' }}>{t('training_plan_editor.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('training_plan_editor.col_name')}</th>
                <th style={th}>{t('training_plan_editor.col_weekday')}</th>
                <th style={{ ...th, width: 260 }} />
              </tr>
            </thead>
            <tbody>
              {workouts.map((w, idx) => (
                <tr key={w.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{w.name}</td>
                  <td style={td}>{w.scheduled_weekday != null ? t(`workouts.weekday_${w.scheduled_weekday}`) : '—'}</td>
                  <td style={{ ...td, display: 'flex', gap: 6 }}>
                    <button onClick={() => setBlocksFor(w)} style={btnSmall('#1e7e40')}>{t('training_plan_editor.blocks')}</button>
                    <button onClick={() => move(idx, -1)} style={btnSmall('#888')} disabled={idx === 0}>↑</button>
                    <button onClick={() => move(idx, 1)} style={btnSmall('#888')} disabled={idx === workouts.length - 1}>↓</button>
                    <button onClick={() => startEdit(w)} style={btnSmall('#444')}>{t('training_plan_editor.edit')}</button>
                    <button onClick={() => setDeleting(w)} style={btnSmall('#c0392b')}>{t('training_plan_editor.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>
            {editingId ? t('training_plan_editor.edit_heading') : t('training_plan_editor.add_heading')}
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('training_plan_editor.col_name')} style={{ ...input, width: 200 }} />
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={t('training_plan_editor.label_description')} style={{ ...input, width: 220 }} />
            <select value={form.scheduled_weekday} onChange={(e) => setForm({ ...form, scheduled_weekday: e.target.value })} style={{ ...input, width: 140 }}>
              <option value="">—</option>
              {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
            </select>
            <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('training_plan_editor.saving') : editingId ? t('training_plan_editor.save_changes') : t('training_plan_editor.add')}
            </button>
            {editingId && <button onClick={resetForm} style={btnStyle('#aaa')} disabled={saving}>{t('training_plan_editor.cancel')}</button>}
          </div>
          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('training_plan_editor.close')}</button>
        </div>

        <ConfirmDialog
          open={deleting !== null}
          message={t('training_plan_editor.confirm_delete')}
          confirmLabel={t('training_plan_editor.delete')}
          cancelLabel={t('training_plan_editor.cancel')}
          onConfirm={del}
          onCancel={() => setDeleting(null)}
        />

        {blocksFor && (
          <PlanWorkoutBlocksModal
            memberId={memberId} planId={planId} workoutId={blocksFor.id} workoutName={blocksFor.name}
            onClose={() => setBlocksFor(null)}
          />
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '8px 10px', fontSize: 13, fontWeight: 600, color: '#555' };
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 14 };
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
