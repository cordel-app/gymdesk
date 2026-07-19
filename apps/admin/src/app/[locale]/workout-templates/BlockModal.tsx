'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { CrudModal } from '@/components/CrudModal';
import { BLOCK_TYPES, RESULT_TYPES, isBlockFieldVisible, BLOCK_TYPE_MAX_EXERCISES } from './blockFieldConfig';
import type { HierBlock } from './summaries';

/* #63: Dynamic Workout Block Form (issue #60 field config) hosted in a
 * CrudModal so blocks are edited in place from the tree grid. */
export function BlockModal({ workoutTemplateId, block, onCancel, onSaved }: {
  workoutTemplateId: number;
  block: HierBlock | null; // null = add
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();

  const [form, setForm] = useState({
    name: block?.name ?? '',
    description: block?.description ?? '',
    type: block?.type ?? 'Standard',
    result_type: block?.result_type ?? 'None',
    rounds: block?.rounds != null ? String(block.rounds) : '',
    duration_seconds: block?.duration_seconds != null ? String(block.duration_seconds) : '',
    work_seconds: block?.work_seconds != null ? String(block.work_seconds) : '',
    rest_seconds: block?.rest_seconds != null ? String(block.rest_seconds) : '',
    is_optional: !!block?.is_optional,
    notes: block?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentExCount = block?.exercises?.length ?? 0;
  const newMaxEx = BLOCK_TYPE_MAX_EXERCISES[form.type];
  const typeError = newMaxEx !== null && currentExCount > newMaxEx
    ? t('workout_templates.block_type_limit_exceeded', { type: t(`workout_template_blocks.type_${form.type.toLowerCase()}`), max: newMaxEx })
    : null;

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
      if (block) await apiFetch(`/workout-templates/${workoutTemplateId}/blocks/${block.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch(`/workout-templates/${workoutTemplateId}/blocks`, { method: 'POST', body: JSON.stringify(body) });
      onSaved();
    } catch (err: any) { setError(err.message ?? t('workout_template_blocks.error_generic')); }
    finally { setSaving(false); }
  }

  return (
    <CrudModal
      open
      title={block ? t('workout_template_blocks.edit_heading') : t('workout_template_blocks.add_heading')}
      error={error} saving={saving}
      cancelLabel={t('workout_template_blocks.cancel')}
      saveLabel={saving ? t('workout_template_blocks.saving') : block ? t('workout_template_blocks.save_changes') : t('workout_template_blocks.add')}
      saveDisabled={!!typeError}
      onCancel={onCancel}
      onSave={save}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
        <Field label={t('workout_template_blocks.col_name')}>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input} autoFocus />
        </Field>
        <Field label={t('workout_template_blocks.col_type')}>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} style={input}>
            {BLOCK_TYPES.map((ty) => <option key={ty} value={ty}>{t(`workout_template_blocks.type_${ty.toLowerCase()}`)}</option>)}
          </select>
          {typeError && <span style={{ color: '#c0392b', fontSize: 12, marginTop: 2 }}>{typeError}</span>}
        </Field>
        {isBlockFieldVisible(form.type, 'result_type') && (
          <Field label={t('workout_template_blocks.col_result_type')}>
            <select value={form.result_type} onChange={(e) => setForm({ ...form, result_type: e.target.value })} style={input}>
              {RESULT_TYPES.map((rt) => <option key={rt} value={rt}>{t(`workout_template_blocks.result_type_${rt.toLowerCase()}`)}</option>)}
            </select>
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'rounds') && (
          <Field label={t('workout_template_blocks.col_rounds')}>
            <input type="number" min="0" value={form.rounds} onChange={(e) => setForm({ ...form, rounds: e.target.value })} style={input} />
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'duration_seconds') && (
          <Field label={t('workout_template_blocks.col_duration')}>
            <input type="number" min="0" value={form.duration_seconds} onChange={(e) => setForm({ ...form, duration_seconds: e.target.value })} style={input} />
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'work_seconds') && (
          <Field label={t('workout_template_blocks.col_work_seconds')}>
            <input type="number" min="0" value={form.work_seconds} onChange={(e) => setForm({ ...form, work_seconds: e.target.value })} style={input} />
          </Field>
        )}
        {isBlockFieldVisible(form.type, 'rest_seconds') && (
          <Field label={t('workout_template_blocks.col_rest_seconds')}>
            <input type="number" min="0" value={form.rest_seconds} onChange={(e) => setForm({ ...form, rest_seconds: e.target.value })} style={input} />
          </Field>
        )}
        <Field label={t('workout_template_blocks.col_optional')}>
          <input type="checkbox" checked={form.is_optional} onChange={(e) => setForm({ ...form, is_optional: e.target.checked })} />
        </Field>
      </div>
      <div style={{ marginTop: 10 }}>
        <Field label={t('workout_template_blocks.col_notes')}>
          <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} style={{ ...input, width: '100%' }} />
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
