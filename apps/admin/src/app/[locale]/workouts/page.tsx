'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { btnStyle, btnSmall } from '@/components/ui';

interface Exercise { id: number; name: string; default_reps: string | null; default_rest_seconds: number | null }
interface WorkoutExercise { exercise_id: number; reps: string | null; rest_seconds: number | null; name?: string }
interface Workout {
  id: number; name: string; description: string | null; weekday: number | null;
  exercises: (WorkoutExercise & { id: number; position: number })[] | null;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const emptyForm = { name: '', description: '', weekday: '' };

export default function WorkoutsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Workout[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Workout | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [items, setItems] = useState<WorkoutExercise[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Workout | null>(null);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ws, ex] = await Promise.all([apiFetch<Workout[]>('/workouts'), apiFetch<Exercise[]>('/exercises?status=active')]);
      setRows(ws); setExercises(ex);
    } catch (err: any) { toast(err.message ?? t('workouts.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openAdd() { setEditing(null); setForm(emptyForm); setItems([]); setError(null); setModalOpen(true); }
  function openEdit(w: Workout) {
    setEditing(w);
    setForm({ name: w.name, description: w.description ?? '', weekday: w.weekday != null ? String(w.weekday) : '' });
    setItems((w.exercises ?? []).map((e) => ({ exercise_id: e.exercise_id, reps: e.reps, rest_seconds: e.rest_seconds })));
    setError(null); setModalOpen(true);
  }

  function moveItem(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= items.length) return;
    const copy = [...items];
    [copy[idx], copy[next]] = [copy[next], copy[idx]];
    setItems(copy);
  }

  async function save() {
    if (!form.name.trim()) { setError(t('workouts.error_required')); return; }
    setSaving(true); setError(null);
    const body = {
      name: form.name.trim(), description: form.description.trim() || null,
      weekday: form.weekday === '' ? null : parseInt(form.weekday, 10),
      exercises: items,
    };
    try {
      if (editing) await apiFetch(`/workouts/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/workouts', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); setItems([]); load();
    } catch (err: any) { setError(err.message ?? t('workouts.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/workouts/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('workouts.error_generic')); }
  }

  if (gymLoading || !canWrite) return null;

  const columns: Column<Workout>[] = [
    { header: t('workouts.col_name'), render: (w) => w.name },
    { header: t('workouts.col_weekday'), width: 120, render: (w) => w.weekday != null ? t(`workouts.weekday_${w.weekday}`) : '—' },
    { header: t('workouts.col_exercises'), width: 100, render: (w) => (w.exercises ?? []).length },
    {
      header: t('workouts.col_actions'), width: 180,
      render: (w) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(w)} style={btnSmall('#444')}>{t('workouts.edit')}</button>
          <button onClick={() => setDeleting(w)} style={btnSmall('#c0392b')}>{t('workouts.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('workouts.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('workouts.add')}</button>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
                 loadingText={t('workouts.loading')} emptyText={t('workouts.empty')} />

      <CrudModal
        open={modalOpen}
        title={editing ? t('workouts.modal_edit') : t('workouts.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('workouts.cancel')}
        saveLabel={saving ? t('workouts.saving') : editing ? t('workouts.save_changes') : t('workouts.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setItems([]); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('workouts.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('workouts.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('workouts.label_weekday')}</FormLabel>
        <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: e.target.value })}
                style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}>
          <option value="">—</option>
          {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
        </select>

        <FormLabel>{t('workouts.label_exercises')}</FormLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
          {items.map((it, i) => {
            const ex = exercises.find((e) => e.id === it.exercise_id);
            return (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', border: '1px solid #eee', padding: 6, borderRadius: 6 }}>
                <span style={{ width: 20, textAlign: 'center', color: '#666' }}>{i + 1}</span>
                <span style={{ flex: 1, fontSize: 14 }}>{ex?.name ?? '—'}</span>
                <input placeholder={ex?.default_reps ?? '—'} value={it.reps ?? ''}
                       onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, reps: e.target.value || null } : x))}
                       style={{ width: 70, padding: 4, fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }} />
                <input type="number" placeholder={ex?.default_rest_seconds ? String(ex.default_rest_seconds) : '—'}
                       value={it.rest_seconds ?? ''}
                       onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, rest_seconds: e.target.value ? parseInt(e.target.value, 10) : null } : x))}
                       style={{ width: 60, padding: 4, fontSize: 12, border: '1px solid #ccc', borderRadius: 4 }} />
                <button onClick={() => moveItem(i, -1)} style={btnSmall('#888')} disabled={i === 0}>↑</button>
                <button onClick={() => moveItem(i, 1)} style={btnSmall('#888')} disabled={i === items.length - 1}>↓</button>
                <button onClick={() => setItems(items.filter((_, j) => j !== i))} style={btnSmall('#c0392b')}>×</button>
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <select onChange={(e) => {
            const id = parseInt(e.target.value, 10);
            if (!id) return;
            setItems([...items, { exercise_id: id, reps: null, rest_seconds: null }]);
            e.target.value = '';
          }} style={{ flex: 1, padding: '8px', fontSize: 14, border: '1px solid #ccc', borderRadius: 4 }}>
            <option value="">{t('workouts.add_exercise')}</option>
            {exercises.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('workouts.confirm_delete')}
                     confirmLabel={t('workouts.delete')} cancelLabel={t('workouts.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />
    </div>
  );
}
