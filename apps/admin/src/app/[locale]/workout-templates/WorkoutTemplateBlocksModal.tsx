'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { overlayStyle, modalStyle, btnStyle, btnSmall } from '@/components/ui';
import { BlockExercisesModal } from './BlockExercisesModal';

export interface Block {
  id: number; position: number; name: string | null; description: string | null;
  type: string; result_type: string;
  rounds: number | null; duration_seconds: number | null; work_seconds: number | null; rest_seconds: number | null;
  is_optional: boolean; notes: string | null;
}

export const BLOCK_TYPES = ['Standard', 'Superset', 'Triset', 'GiantSet', 'Circuit', 'EMOM', 'AMRAP', 'Tabata'];
export const RESULT_TYPES = ['None', 'Time', 'Rounds', 'Repetitions', 'Distance', 'Calories', 'Weight', 'Score'];

const emptyForm = {
  name: '', description: '', type: 'Standard', result_type: 'None',
  rounds: '', duration_seconds: '', work_seconds: '', rest_seconds: '', is_optional: false, notes: '',
};

export function WorkoutTemplateBlocksModal({ workoutTemplateId, workoutTemplateName, onClose }: {
  workoutTemplateId: number; workoutTemplateName: string; onClose: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [blocks, setBlocks] = useState<Block[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Block | null>(null);
  const [exercisesFor, setExercisesFor] = useState<Block | null>(null);

  async function load() {
    setLoading(true);
    try { setBlocks(await apiFetch<Block[]>(`/workout-templates/${workoutTemplateId}/blocks`)); }
    catch (err: any) { toast(err.message ?? t('workout_template_blocks.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [workoutTemplateId]);

  function resetForm() { setForm(emptyForm); setEditingId(null); setError(null); }
  function startEdit(b: Block) {
    setEditingId(b.id);
    setForm({
      name: b.name ?? '', description: b.description ?? '', type: b.type, result_type: b.result_type,
      rounds: b.rounds != null ? String(b.rounds) : '', duration_seconds: b.duration_seconds != null ? String(b.duration_seconds) : '',
      work_seconds: b.work_seconds != null ? String(b.work_seconds) : '', rest_seconds: b.rest_seconds != null ? String(b.rest_seconds) : '',
      is_optional: b.is_optional, notes: b.notes ?? '',
    });
    setError(null);
  }

  async function save() {
    setSaving(true); setError(null);
    const body = {
      name: form.name.trim() || null, description: form.description.trim() || null,
      type: form.type, result_type: form.result_type,
      rounds: form.rounds ? parseInt(form.rounds, 10) : null,
      duration_seconds: form.duration_seconds ? parseInt(form.duration_seconds, 10) : null,
      work_seconds: form.work_seconds ? parseInt(form.work_seconds, 10) : null,
      rest_seconds: form.rest_seconds ? parseInt(form.rest_seconds, 10) : null,
      is_optional: form.is_optional, notes: form.notes.trim() || null,
    };
    try {
      if (editingId) await apiFetch(`/workout-templates/${workoutTemplateId}/blocks/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch(`/workout-templates/${workoutTemplateId}/blocks`, { method: 'POST', body: JSON.stringify(body) });
      resetForm(); load();
    } catch (err: any) { setError(err.message ?? t('workout_template_blocks.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try {
      await apiFetch(`/workout-templates/${workoutTemplateId}/blocks/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); if (editingId === deleting.id) resetForm(); load();
    } catch (err: any) { setDeleting(null); toast(err.message ?? t('workout_template_blocks.error_generic')); }
  }

  async function move(idx: number, dir: -1 | 1) {
    const next = idx + dir;
    if (next < 0 || next >= blocks.length) return;
    const order = [...blocks];
    [order[idx], order[next]] = [order[next], order[idx]];
    try {
      await apiFetch(`/workout-templates/${workoutTemplateId}/blocks/reorder`, { method: 'PUT', body: JSON.stringify({ order: order.map((b) => b.id) }) });
      load();
    } catch (err: any) { toast(err.message ?? t('workout_template_blocks.error_generic')); }
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={{ ...modalStyle, width: 720 }} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 4px' }}>{t('workout_template_blocks.title')}</h2>
        <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{workoutTemplateName}</p>

        {loading ? (
          <p style={{ color: '#666' }}>{t('workout_template_blocks.loading')}</p>
        ) : blocks.length === 0 ? (
          <p style={{ color: '#666' }}>{t('workout_template_blocks.empty')}</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #eee' }}>
                <th style={th}>{t('workout_template_blocks.col_position')}</th>
                <th style={th}>{t('workout_template_blocks.col_type')}</th>
                <th style={th}>{t('workout_template_blocks.col_result_type')}</th>
                <th style={{ ...th, width: 260 }} />
              </tr>
            </thead>
            <tbody>
              {blocks.map((b, i) => (
                <tr key={b.id} style={{ borderBottom: '1px solid #f4f4f4' }}>
                  <td style={td}>{b.position}</td>
                  <td style={td}>{b.name ? `${b.name} (${t(`workout_template_blocks.type_${b.type.toLowerCase()}`)})` : t(`workout_template_blocks.type_${b.type.toLowerCase()}`)}</td>
                  <td style={td}>{t(`workout_template_blocks.result_type_${b.result_type.toLowerCase()}`)}</td>
                  <td style={{ ...td, display: 'flex', gap: 6 }}>
                    <button onClick={() => setExercisesFor(b)} style={btnSmall('#1e7e40')}>{t('workout_template_blocks.exercises')}</button>
                    <button onClick={() => move(i, -1)} style={btnSmall('#888')} disabled={i === 0}>↑</button>
                    <button onClick={() => move(i, 1)} style={btnSmall('#888')} disabled={i === blocks.length - 1}>↓</button>
                    <button onClick={() => startEdit(b)} style={btnSmall('#444')}>{t('workout_template_blocks.edit')}</button>
                    <button onClick={() => setDeleting(b)} style={btnSmall('#c0392b')}>{t('workout_template_blocks.delete')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ borderTop: '1px solid #eee', paddingTop: 16 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>
            {editingId ? t('workout_template_blocks.edit_heading') : t('workout_template_blocks.add_heading')}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <Field label={t('workout_template_blocks.col_name')}>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input} />
            </Field>
            <Field label={t('workout_template_blocks.col_type')}>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={input}>
                {BLOCK_TYPES.map((ty) => <option key={ty} value={ty}>{t(`workout_template_blocks.type_${ty.toLowerCase()}`)}</option>)}
              </select>
            </Field>
            <Field label={t('workout_template_blocks.col_result_type')}>
              <select value={form.result_type} onChange={(e) => setForm({ ...form, result_type: e.target.value })} style={input}>
                {RESULT_TYPES.map((rt) => <option key={rt} value={rt}>{t(`workout_template_blocks.result_type_${rt.toLowerCase()}`)}</option>)}
              </select>
            </Field>
            <Field label={t('workout_template_blocks.col_rounds')}>
              <input type="number" min="0" value={form.rounds} onChange={(e) => setForm({ ...form, rounds: e.target.value })} style={input} />
            </Field>
            <Field label={t('workout_template_blocks.col_duration')}>
              <input type="number" min="0" value={form.duration_seconds} onChange={(e) => setForm({ ...form, duration_seconds: e.target.value })} style={input} />
            </Field>
            <Field label={t('workout_template_blocks.col_work_seconds')}>
              <input type="number" min="0" value={form.work_seconds} onChange={(e) => setForm({ ...form, work_seconds: e.target.value })} style={input} />
            </Field>
            <Field label={t('workout_template_blocks.col_rest_seconds')}>
              <input type="number" min="0" value={form.rest_seconds} onChange={(e) => setForm({ ...form, rest_seconds: e.target.value })} style={input} />
            </Field>
            <Field label={t('workout_template_blocks.col_optional')}>
              <input type="checkbox" checked={form.is_optional} onChange={(e) => setForm({ ...form, is_optional: e.target.checked })} />
            </Field>
          </div>
          <div style={{ marginTop: 10 }}>
            <Field label={t('workout_template_blocks.col_notes')}>
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...input, width: '100%' }} />
            </Field>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button onClick={save} style={btnStyle('#6c63ff')} disabled={saving}>
              {saving ? t('workout_template_blocks.saving') : editingId ? t('workout_template_blocks.save_changes') : t('workout_template_blocks.add')}
            </button>
            {editingId && <button onClick={resetForm} style={btnStyle('#aaa')} disabled={saving}>{t('workout_template_blocks.cancel')}</button>}
          </div>
          {error && <p style={{ color: '#c0392b', margin: '10px 0 0', fontSize: 14 }}>{error}</p>}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
          <button onClick={onClose} style={btnStyle('#444')}>{t('workout_template_blocks.close')}</button>
        </div>

        <ConfirmDialog
          open={deleting !== null}
          message={t('workout_template_blocks.confirm_delete')}
          confirmLabel={t('workout_template_blocks.delete')}
          cancelLabel={t('workout_template_blocks.cancel')}
          onConfirm={del}
          onCancel={() => setDeleting(null)}
        />

        {exercisesFor && (
          <BlockExercisesModal
            workoutTemplateId={workoutTemplateId}
            blockId={exercisesFor.id}
            blockLabel={exercisesFor.name ?? t(`workout_template_blocks.type_${exercisesFor.type.toLowerCase()}`)}
            onClose={() => setExercisesFor(null)}
          />
        )}
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
