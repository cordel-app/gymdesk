'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import type { HierExercise } from './summaries';

interface ExerciseOption { id: number; name: string; min_reps_default: number | null; max_reps_default: number | null; sets_default: number | null; rest_default_seconds: number | null }

/* #63: add/edit one exercise of a block, in place from the tree grid. */
export function ExerciseModal({ workoutTemplateId, blockId, item, onCancel, onSaved }: {
  workoutTemplateId: number;
  blockId: number;
  item: HierExercise | null; // null = add
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [exercises, setExercises] = useState<ExerciseOption[]>([]);
  const [form, setForm] = useState({
    exercise_id: item ? String(item.exercise_id) : '',
    min_reps: item?.min_reps != null ? String(item.min_reps) : '',
    max_reps: item?.max_reps != null ? String(item.max_reps) : '',
    sets: item?.sets != null ? String(item.sets) : '',
    rest_seconds: item?.rest_seconds != null ? String(item.rest_seconds) : '',
    tempo: item?.tempo ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<ExerciseOption[]>('/exercises?status=active')
      .then(setExercises)
      .catch((err: any) => toast(err.message ?? t('block_exercises.error_generic')));
  }, []);

  const base = `/workout-templates/${workoutTemplateId}/blocks/${blockId}/exercises`;
  const selected = exercises.find((e) => String(e.id) === form.exercise_id);
  const ph = (v: number | null | undefined) => (v != null ? String(v) : '—');

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
      if (item) await apiFetch(`${base}/${item.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch(base, { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (err: any) { setError(err.message ?? t('block_exercises.error_generic')); }
    finally { setSaving(false); }
  }

  return (
    <CrudModal
      open
      title={item ? t('block_exercises.edit_heading') : t('block_exercises.add_heading')}
      error={error} saving={saving}
      cancelLabel={t('block_exercises.cancel')}
      saveLabel={saving ? t('block_exercises.saving') : item ? t('block_exercises.save_changes') : t('block_exercises.add')}
      onCancel={onCancel}
      onSave={save}
    >
      <Field label={t('block_exercises.col_exercise')}>
        <select value={form.exercise_id} onChange={(e) => setForm({ ...form, exercise_id: e.target.value })} style={input} autoFocus>
          <option value="">—</option>
          {exercises.map((ex) => <option key={ex.id} value={ex.id}>{ex.name}</option>)}
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginTop: 10 }}>
        <Field label={t('block_exercises.col_min_reps')}>
          <input type="number" min="0" placeholder={ph(selected?.min_reps_default)}
                 value={form.min_reps} onChange={(e) => setForm({ ...form, min_reps: e.target.value })} style={input} />
        </Field>
        <Field label={t('block_exercises.col_max_reps')}>
          <input type="number" min="0" placeholder={ph(selected?.max_reps_default)}
                 value={form.max_reps} onChange={(e) => setForm({ ...form, max_reps: e.target.value })} style={input} />
        </Field>
        <Field label={t('block_exercises.col_sets')}>
          <input type="number" min="0" placeholder={ph(selected?.sets_default)}
                 value={form.sets} onChange={(e) => setForm({ ...form, sets: e.target.value })} style={input} />
        </Field>
        <Field label={t('block_exercises.col_rest_seconds')}>
          <input type="number" min="0" placeholder={ph(selected?.rest_default_seconds)}
                 value={form.rest_seconds} onChange={(e) => setForm({ ...form, rest_seconds: e.target.value })} style={input} />
        </Field>
      </div>
      <div style={{ marginTop: 10, width: 160 }}>
        <Field label={t('block_exercises.col_tempo')}>
          <input value={form.tempo} onChange={(e) => setForm({ ...form, tempo: e.target.value })} style={input} placeholder="e.g. 3-1-1" />
        </Field>
      </div>
    </CrudModal>
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

const input: React.CSSProperties = { padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', width: '100%' };
