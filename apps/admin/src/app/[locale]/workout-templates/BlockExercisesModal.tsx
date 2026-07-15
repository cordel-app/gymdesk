'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';

interface ExerciseOption { id: number; name: string; min_reps_default: number | null; max_reps_default: number | null; sets_default: number | null; rest_default_seconds: number | null }
interface BlockExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null; rest_seconds: number | null; tempo: string | null;
}

const emptyForm = { exercise_id: '', min_reps: '', max_reps: '', sets: '', rest_seconds: '', tempo: '' };

export function BlockExercisesModal({ workoutTemplateId, blockId, blockLabel, onClose }: {
  workoutTemplateId: number; blockId: number; blockLabel: string; onClose: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [items, setItems] = useState<BlockExercise[]>([]);
  const [exercises, setExercises] = useState<ExerciseOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BlockExercise | null>(null);

  const base = `/workout-templates/${workoutTemplateId}/blocks/${blockId}/exercises`;

  async function load() {
    setLoading(true);
    try {
      const [its, ex] = await Promise.all([
        apiFetch<BlockExercise[]>(base),
        apiFetch<ExerciseOption[]>('/exercises?status=active'),
      ]);
      setItems(its); setExercises(ex);
    } catch (err: any) { toast(err.message ?? t('block_exercises.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [workoutTemplateId, blockId]);

  function resetForm() { setForm(emptyForm); setEditingId(null); setError(null); }
  function startEdit(i: BlockExercise) {
    setEditingId(i.id);
    setForm({
      exercise_id: String(i.exercise_id),
      min_reps: i.min_reps != null ? String(i.min_reps) : '', max_reps: i.max_reps != null ? String(i.max_reps) : '',
      sets: i.sets != null ? String(i.sets) : '', rest_seconds: i.rest_seconds != null ? String(i.rest_seconds) : '',
      tempo: i.tempo ?? '',
    });
    setError(null);
  }

  async function save() {
    if (!form.exercise_id) { setError(t('block_exercises.error_required')); return; }
    setSaving(true); setError(null);
    const body = {
      exercise_id: parseInt(form.exercise_id, 10),
      min_reps: form.min_reps ? parseInt(form.min_reps, 10) : null,
      max_reps: form.max_reps ? parseInt(form.max_reps, 10) : null,
      sets: form.sets ? parseInt(form.sets, 10) : null,
      rest_seconds: form.rest_seconds ? parseInt(form.rest_seconds, 10) : null,
      tempo: form.tempo.trim() || null,
    };
    try {
      if (editingId) await apiFetch(`${base}/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch(base, { method: 'POST', body: JSON.stringify(body) });
      resetForm(); load();
    } catch (err: any) { setError(err.message ?? t('block_exercises.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`${base}/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); if (editingId === deleting.id) resetForm(); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('block_exercises.error_generic')); }
  }

  async function move(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= items.length) return;
    const order = [...items];
    [order[idx], order[next]] = [order[next], order[idx]];
    try { await apiFetch(`${base}/reorder`, { method: 'PUT', body: JSON.stringify({ order: order.map((i) => i.id) }) }); load(); }
    catch (err: any) { toast(err.message ?? t('block_exercises.error_generic')); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 680 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('block_exercises.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{blockLabel}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('block_exercises.loading')}</p>
        ) : items.length === 0 ? (
          <p style={{ color: '#666' }}>{t('block_exercises.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('block_exercises.col_exercise')}</th>
                <th style={th}>{t('block_exercises.col_min_reps')}</th>
                <th style={th}>{t('block_exercises.col_max_reps')}</th>
                <th style={th}>{t('block_exercises.col_sets')}</th>
                <th style={th}>{t('block_exercises.col_rest_seconds')}</th>
                <th style={{ ...th, width: 220 }} />
              </tr>
            </thead>
            <tbody>
              {items.map((i, idx) => (
                <tr key={i.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{i.exercise_name}</td>
                  <td style={td}>{i.min_reps ?? '—'}</td>
                  <td style={td}>{i.max_reps ?? '—'}</td>
                  <td style={td}>{i.sets ?? '—'}</td>
                  <td style={td}>{i.rest_seconds ?? '—'}</td>
                  <td style={{ ...td, display: 'flex', gap: 6 }}>
                    <button onClick={() => move(idx, -1)} style={btnSmall('#888')} disabled={idx === 0}>↑</button>
                    <button onClick={() => move(idx, 1)} style={btnSmall('#888')} disabled={idx === items.length - 1}>↓</button>
                    <button onClick={() => startEdit(i)} style={btnSmall('#444')}>{t('block_exercises.edit')}</button>
                    <button onClick={() => setDeleting(i)} style={btnSmall('#c0392b')}>{t('block_exercises.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>
            {editingId ? t('block_exercises.edit_heading') : t('block_exercises.add_heading')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
            <Field label={t('block_exercises.col_exercise')}>
              <select value={form.exercise_id} onChange={(e) => setForm({ ...form, exercise_id: e.target.value })} style={input}>
                <option value="">—</option>
                {exercises.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
              </select>
            </Field>
            <Field label={t('block_exercises.col_min_reps')}>
              <input type="number" min="0"
                     placeholder={exercises.find((e) => String(e.id) === form.exercise_id)?.min_reps_default != null ? String(exercises.find((e) => String(e.id) === form.exercise_id)!.min_reps_default) : '—'}
                     value={form.min_reps} onChange={(e) => setForm({ ...form, min_reps: e.target.value })} style={input} />
            </Field>
            <Field label={t('block_exercises.col_max_reps')}>
              <input type="number" min="0"
                     placeholder={exercises.find((e) => String(e.id) === form.exercise_id)?.max_reps_default != null ? String(exercises.find((e) => String(e.id) === form.exercise_id)!.max_reps_default) : '—'}
                     value={form.max_reps} onChange={(e) => setForm({ ...form, max_reps: e.target.value })} style={input} />
            </Field>
            <Field label={t('block_exercises.col_sets')}>
              <input type="number" min="0"
                     placeholder={exercises.find((e) => String(e.id) === form.exercise_id)?.sets_default != null ? String(exercises.find((e) => String(e.id) === form.exercise_id)!.sets_default) : '—'}
                     value={form.sets} onChange={(e) => setForm({ ...form, sets: e.target.value })} style={input} />
            </Field>
            <Field label={t('block_exercises.col_rest_seconds')}>
              <input type="number" min="0"
                     placeholder={exercises.find((e) => String(e.id) === form.exercise_id)?.rest_default_seconds != null ? String(exercises.find((e) => String(e.id) === form.exercise_id)!.rest_default_seconds) : '—'}
                     value={form.rest_seconds} onChange={(e) => setForm({ ...form, rest_seconds: e.target.value })} style={input} />
            </Field>
          </div>
          <div style={{ marginTop: 10, width: 160 }}>
            <Field label={t('block_exercises.col_tempo')}>
              <input value={form.tempo} onChange={(e) => setForm({ ...form, tempo: e.target.value })} style={input} placeholder="e.g. 3-1-1" />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('block_exercises.saving') : editingId ? t('block_exercises.save_changes') : t('block_exercises.add')}
            </button>
            {editingId && <button onClick={resetForm} style={btnStyle('#aaa')} disabled={saving}>{t('block_exercises.cancel')}</button>}
          </div>
          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('block_exercises.close')}</button>
        </div>

        <ConfirmDialog
          open={deleting !== null}
          message={t('block_exercises.confirm_delete')}
          confirmLabel={t('block_exercises.delete')}
          cancelLabel={t('block_exercises.cancel')}
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
const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', width: '100%' };
