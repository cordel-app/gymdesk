'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { HierBlock, HierExercise } from './summaries';
import { BLOCK_TYPES, isBlockFieldVisible, BLOCK_TYPE_MAX_EXERCISES } from './blockFieldConfig';

/* Shape returned by GET /workout-templates/:id */
export interface WtHierarchy {
  id: number; name: string; description: string | null; status: string;
  created_by_name: string | null; created_at: string;
  blocks: HierBlock[] | null;
}

export const blockDragId = (templateId: number, blockId: number) => `block:${templateId}:${blockId}`;
export const exerciseDragId = (templateId: number, blockId: number, exId: number) => `ex:${templateId}:${blockId}:${exId}`;
export const templateDropId = (templateId: number) => `tmpl:${templateId}`;

export function TemplateDropTarget({ templateId, children }: { templateId: number; children: React.ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: templateDropId(templateId) });
  const activeId = active != null ? String(active.id) : '';
  const foreignBlock = activeId.startsWith('block:') && !activeId.startsWith(`block:${templateId}:`);
  return (
    <div
      ref={setNodeRef}
      style={{
        margin: '-6px -8px', padding: '6px 8px', borderRadius: 6,
        background: isOver && foreignBlock ? '#eef0ff' : undefined,
        outline: isOver && foreignBlock ? '2px dashed #6c63ff' : 'none',
        transition: 'background 0.1s',
      }}
    >
      {children}
    </div>
  );
}

/* ---- Exercise option (for the combobox) ---- */
interface ExerciseOption {
  id: number; name: string;
  min_reps_default: number | null; max_reps_default: number | null;
  sets_default: number | null; rest_default_seconds: number | null;
}

/* ---- Searchable Exercise Combobox ---- */
function ExerciseCombobox({ value, options, placeholder, onChange }: {
  value: number | null;
  options: ExerciseOption[];
  placeholder: string;
  onChange: (opt: ExerciseOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.id === value);
  const filtered = query
    ? options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function handleOpen() {
    setOpen(true);
    setQuery('');
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function pick(opt: ExerciseOption) {
    onChange(opt);
    setOpen(false);
    setQuery('');
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', minWidth: 160 }}>
      <button
        type="button"
        onClick={handleOpen}
        style={comboTrigger}
      >
        {selected ? selected.name : <span style={{ color: '#aaa' }}>{placeholder}</span>}
        <span style={{ marginLeft: 4, fontSize: 10, color: '#888' }}>▾</span>
      </button>
      {open && (
        <div style={comboDropdown}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            style={comboSearch}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); setQuery(''); }
              if (e.key === 'Enter' && filtered.length === 1) pick(filtered[0]);
            }}
          />
          <ul style={comboList}>
            {filtered.length === 0 && (
              <li style={comboItemEmpty}>—</li>
            )}
            {filtered.map((opt) => (
              <li
                key={opt.id}
                onMouseDown={() => pick(opt)}
                style={{ ...comboItem, background: opt.id === value ? '#f0eeff' : undefined }}
              >
                {opt.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---- Template metadata header (display + inline edit) ---- */
function TemplateHeader({ hierarchy, editMode, onEditSave, onEditCancel }: {
  hierarchy: WtHierarchy;
  editMode: boolean;
  onEditSave: (data: { name: string; description: string | null; status: string }) => Promise<void>;
  onEditCancel: () => void;
}) {
  const t = useTranslations();
  const [name, setName] = useState(hierarchy.name);
  const [description, setDescription] = useState(hierarchy.description ?? '');
  const [status, setStatus] = useState(hierarchy.status);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when entering edit mode from fresh hierarchy values
  useEffect(() => {
    if (editMode) {
      setName(hierarchy.name);
      setDescription(hierarchy.description ?? '');
      setStatus(hierarchy.status);
      setError(null);
    }
  }, [editMode, hierarchy.name, hierarchy.description, hierarchy.status]);

  async function handleSave() {
    if (!name.trim()) { setError(t('workout_templates.error_required')); return; }
    setSaving(true); setError(null);
    try {
      await onEditSave({ name: name.trim(), description: description.trim() || null, status });
    } catch (err: any) {
      setError(err.message ?? t('workout_templates.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  if (!editMode) {
    return (
      <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 4, fontSize: 14 }}>
          <span style={metaLabel}>{t('workout_templates.label_description')}:</span>
          <span style={{ color: hierarchy.description ? '#333' : '#aaa' }}>{hierarchy.description ?? '—'}</span>
          <span style={metaLabel}>{t('workout_templates.col_created_by')}:</span>
          <span style={{ color: hierarchy.created_by_name ? '#333' : '#aaa' }}>{hierarchy.created_by_name ?? '—'}</span>
          <span style={metaLabel}>{t('workout_templates.col_created_at')}:</span>
          <span>{hierarchy.created_at ? new Date(hierarchy.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid #eee' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 480 }}>
        <div>
          <label style={editFieldLabel}>{t('workout_templates.label_name')} *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            style={editFieldInput}
          />
        </div>
        <div>
          <label style={editFieldLabel}>{t('workout_templates.label_description')}</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={editFieldInput}
          />
        </div>
        <div>
          <label style={editFieldLabel}>{t('workout_templates.label_status')}</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={editFieldSelect}>
            <option value="active">{t('status.active')}</option>
            <option value="inactive">{t('status.inactive')}</option>
          </select>
        </div>
        {error && <p style={{ margin: 0, color: '#c0392b', fontSize: 13 }}>{error}</p>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onEditCancel} disabled={saving} style={headerCancelBtnStyle}>{t('workout_templates.cancel')}</button>
          <button onClick={handleSave} disabled={saving} style={headerSaveBtnStyle}>
            {saving ? t('workout_templates.saving') : t('workout_templates.save_changes')}
          </button>
        </div>
      </div>
    </div>
  );
}

const metaLabel: React.CSSProperties = { color: '#888', fontWeight: 500, whiteSpace: 'nowrap' };
const editFieldLabel: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 600, color: '#555', marginBottom: 4 };
const editFieldInput: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box' };
const editFieldSelect: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const headerCancelBtnStyle: React.CSSProperties = { padding: '7px 16px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 14 };
const headerSaveBtnStyle: React.CSSProperties = { padding: '7px 16px', borderRadius: 6, border: 'none', background: '#6c63ff', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 };

/* ---- Main tree ---- */
export function WorkoutTemplateTree({ templateId, hierarchy, canWrite, onChanged, editMode, onEditSave, onEditCancel }: {
  templateId: number;
  hierarchy: WtHierarchy;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
  editMode?: boolean;
  onEditSave?: (data: { name: string; description: string | null; status: string }) => Promise<void>;
  onEditCancel?: () => void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [exercises, setExercises] = useState<ExerciseOption[]>([]);
  const [deletingBlock, setDeletingBlock] = useState<HierBlock | null>(null);
  const [deletingExercise, setDeletingExercise] = useState<{ block: HierBlock; item: HierExercise } | null>(null);

  useEffect(() => {
    apiFetch<ExerciseOption[]>('/exercises?status=active')
      .then(setExercises)
      .catch(() => {});
  }, []);

  const blocks = hierarchy.blocks ?? [];

  async function addBlock() {
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks`, {
        method: 'POST',
        body: JSON.stringify({ type: 'Standard' }),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  async function duplicateBlock(block: HierBlock) {
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${block.id}/duplicate`, { method: 'POST' });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  async function deleteBlock() {
    if (!deletingBlock) return;
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${deletingBlock.id}`, { method: 'DELETE' });
      setDeletingBlock(null);
      await onChanged();
    } catch (err: any) {
      setDeletingBlock(null);
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  async function deleteExercise() {
    if (!deletingExercise) return;
    try {
      await apiFetch(
        `/workout-templates/${templateId}/blocks/${deletingExercise.block.id}/exercises/${deletingExercise.item.id}`,
        { method: 'DELETE' },
      );
      setDeletingExercise(null);
      await onChanged();
    } catch (err: any) {
      setDeletingExercise(null);
      toast(err.message ?? t('block_exercises.error_generic'));
    }
  }

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      <TemplateHeader
        hierarchy={hierarchy}
        editMode={!!editMode}
        onEditSave={onEditSave ?? (() => Promise.resolve())}
        onEditCancel={onEditCancel ?? (() => {})}
      />
      {canWrite && (
        <button onClick={addBlock} style={inlineAddStyle}>
          {t('workout_templates.tree_add_block')}
        </button>
      )}

      {blocks.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14, margin: '8px 0 4px' }}>{t('workout_templates.tree_no_blocks')}</p>
      ) : (
        <SortableContext items={blocks.map((b) => blockDragId(templateId, b.id))} strategy={verticalListSortingStrategy}>
          {blocks.map((b) => (
            <BlockRow
              key={b.id}
              templateId={templateId}
              block={b}
              canWrite={canWrite}
              exercises={exercises}
              onDuplicate={() => duplicateBlock(b)}
              onDelete={() => setDeletingBlock(b)}
              onDeleteExercise={(ex) => setDeletingExercise({ block: b, item: ex })}
              onChanged={onChanged}
            />
          ))}
        </SortableContext>
      )}

      <ConfirmDialog
        open={deletingBlock !== null}
        message={t('workout_template_blocks.confirm_delete')}
        confirmLabel={t('workout_template_blocks.delete')}
        cancelLabel={t('workout_template_blocks.cancel')}
        onConfirm={deleteBlock}
        onCancel={() => setDeletingBlock(null)}
      />
      <ConfirmDialog
        open={deletingExercise !== null}
        message={t('block_exercises.confirm_delete')}
        confirmLabel={t('block_exercises.delete')}
        cancelLabel={t('block_exercises.cancel')}
        onConfirm={deleteExercise}
        onCancel={() => setDeletingExercise(null)}
      />
    </div>
  );
}

/* ---- Block row (always-editable header) ---- */
function BlockRow({ templateId, block, canWrite, exercises, onDuplicate, onDelete, onDeleteExercise, onChanged }: {
  templateId: number;
  block: HierBlock;
  canWrite: boolean;
  exercises: ExerciseOption[];
  onDuplicate: () => void;
  onDelete: () => void;
  onDeleteExercise: (ex: HierExercise) => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: blockDragId(templateId, block.id) });

  const [name, setName] = useState(block.name ?? '');
  const [type, setType] = useState(block.type);
  const [rounds, setRounds] = useState(block.rounds != null ? String(block.rounds) : '');

  // Keep local state in sync when parent hierarchy refreshes
  useEffect(() => { setName(block.name ?? ''); }, [block.name]);
  useEffect(() => { setType(block.type); }, [block.type]);
  useEffect(() => { setRounds(block.rounds != null ? String(block.rounds) : ''); }, [block.rounds]);

  const blockExercises = block.exercises ?? [];
  const maxEx = BLOCK_TYPE_MAX_EXERCISES[type];
  const atLimit = maxEx !== null && blockExercises.length >= maxEx;

  async function patchBlock(patch: Record<string, unknown>) {
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${block.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: block.name, description: block.description,
          type: block.type,
          rounds: block.rounds, duration_seconds: block.duration_seconds,
          work_seconds: block.work_seconds, rest_seconds: block.rest_seconds,
          is_optional: block.is_optional, notes: block.notes,
          ...patch,
        }),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    border: '1px solid #ececf0',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 10,
    background: '#fff',
  };

  const showRounds = isBlockFieldVisible(type, 'rounds');

  return (
    <div ref={setNodeRef} style={style}>
      {/* Compact one-line header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {canWrite && (
          <span
            {...attributes}
            {...listeners}
            aria-label={t('workout_templates.tree_drag_handle')}
            style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none', touchAction: 'none', flexShrink: 0 }}
          >
            ⠿
          </span>
        )}

        {canWrite ? (
          <>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => patchBlock({ name: name.trim() || null })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
              placeholder={t(`workout_template_blocks.type_${type.toLowerCase()}`)}
              style={headerInput}
            />
            <select
              value={type}
              onChange={(e) => {
                const newType = e.target.value;
                setType(newType);
                patchBlock({ type: newType });
              }}
              style={headerSelect}
            >
              {BLOCK_TYPES.map((ty) => (
                <option key={ty} value={ty}>{t(`workout_template_blocks.type_${ty.toLowerCase()}`)}</option>
              ))}
            </select>
            {showRounds && (
              <>
                <span style={{ color: '#aaa', fontSize: 13 }}>•</span>
                <input
                  type="number"
                  min="1"
                  value={rounds}
                  onChange={(e) => setRounds(e.target.value)}
                  onBlur={() => patchBlock({ rounds: rounds ? parseInt(rounds, 10) : null })}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  placeholder="—"
                  style={{ ...headerInput, width: 56, textAlign: 'center' }}
                />
                <span style={{ color: '#666', fontSize: 13 }}>{t('training_plan_templates.summary_rounds', { n: '' }).trim()}</span>
              </>
            )}
          </>
        ) : (
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {block.name || t(`workout_template_blocks.type_${block.type.toLowerCase()}`)}
            {showRounds && block.rounds != null && (
              <span style={{ fontWeight: 400, color: '#888', fontSize: 12.5, marginLeft: 6 }}>
                {t(`workout_template_blocks.type_${block.type.toLowerCase()}`)} • {t('training_plan_templates.summary_rounds', { n: block.rounds })}
              </span>
            )}
          </span>
        )}

        <span style={{ flex: 1 }} />

        {canWrite && (
          <ContextMenu
            ariaLabel={t('workout_templates.col_actions')}
            items={[
              { label: t('workout_template_blocks.duplicate'), onClick: onDuplicate },
              { label: t('workout_template_blocks.delete'), onClick: onDelete, danger: true },
            ]}
          />
        )}
      </div>

      {/* Exercise list */}
      <div style={{ marginTop: 8, paddingLeft: canWrite ? 26 : 0 }}>
        <ExerciseTable
          templateId={templateId}
          block={block}
          canWrite={canWrite}
          exercises={exercises}
          atLimit={atLimit}
          onDeleteExercise={onDeleteExercise}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}

/* ---- Exercise table ---- */
function ExerciseTable({ templateId, block, canWrite, exercises, atLimit, onDeleteExercise, onChanged }: {
  templateId: number;
  block: HierBlock;
  canWrite: boolean;
  exercises: ExerciseOption[];
  atLimit: boolean;
  onDeleteExercise: (ex: HierExercise) => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const blockExercises = block.exercises ?? [];

  // Track which exercises are being added (pending rows not yet persisted)
  const [pendingRows, setPendingRows] = useState<number[]>([]);

  async function addExerciseRow() {
    const key = Date.now();
    setPendingRows((prev) => [...prev, key]);
  }

  async function commitPending(key: number, opt: ExerciseOption) {
    setPendingRows((prev) => prev.filter((k) => k !== key));
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${block.id}/exercises`, {
        method: 'POST',
        body: JSON.stringify({
          exercise_id: opt.id,
          sets: opt.sets_default ?? null,
          min_reps: opt.min_reps_default ?? null,
          max_reps: opt.max_reps_default ?? null,
          rest_seconds: opt.rest_default_seconds ?? null,
        }),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('block_exercises.error_generic'));
    }
  }

  function cancelPending(key: number) {
    setPendingRows((prev) => prev.filter((k) => k !== key));
  }

  async function duplicateExercise(ex: HierExercise) {
    try {
      await apiFetch(
        `/workout-templates/${templateId}/blocks/${block.id}/exercises/${ex.id}/duplicate`,
        { method: 'POST' },
      );
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('block_exercises.error_generic'));
    }
  }

  if (blockExercises.length === 0 && pendingRows.length === 0) {
    return (
      <>
        <p style={{ color: '#bbb', fontSize: 12.5, margin: '4px 0 4px' }}>{t('workout_templates.tree_no_exercises')}</p>
        {canWrite && !atLimit && (
          <button onClick={addExerciseRow} style={inlineAddStyle}>{t('workout_templates.tree_add_exercise')}</button>
        )}
      </>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            {canWrite && <th style={thStyle} />}
            <th style={{ ...thStyle, minWidth: 180 }}>{t('block_exercises.col_exercise')}</th>
            <th style={{ ...thStyle, width: 64 }}>{t('block_exercises.col_sets')}</th>
            <th style={{ ...thStyle, width: 90 }}>{t('block_exercises.col_target')}</th>
            <th style={{ ...thStyle, width: 56 }}>{t('block_exercises.col_unit')}</th>
            <th style={{ ...thStyle, width: 80 }}>{t('block_exercises.col_rest_min')}</th>
            {canWrite && <th style={thStyle} />}
          </tr>
        </thead>
        <tbody>
          <SortableContext items={blockExercises.map((ex) => exerciseDragId(templateId, block.id, ex.id))} strategy={verticalListSortingStrategy}>
            {blockExercises.map((ex) => (
              <ExerciseRow
                key={ex.id}
                templateId={templateId}
                block={block}
                exercise={ex}
                canWrite={canWrite}
                exercises={exercises}
                onDelete={() => onDeleteExercise(ex)}
                onDuplicate={() => duplicateExercise(ex)}
                onChanged={onChanged}
              />
            ))}
          </SortableContext>
          {pendingRows.map((key) => (
            <PendingExerciseRow
              key={key}
              exercises={exercises}
              placeholder={t('block_exercises.search_placeholder')}
              onCommit={(opt) => commitPending(key, opt)}
              onCancel={() => cancelPending(key)}
            />
          ))}
        </tbody>
      </table>
      {canWrite && !atLimit && (
        <button onClick={addExerciseRow} style={{ ...inlineAddStyle, marginTop: 6 }}>{t('workout_templates.tree_add_exercise')}</button>
      )}
    </div>
  );
}

/* ---- Pending (new) exercise row ---- */
function PendingExerciseRow({ exercises, placeholder, onCommit, onCancel }: {
  exercises: ExerciseOption[];
  placeholder: string;
  onCommit: (opt: ExerciseOption) => void;
  onCancel: () => void;
}) {
  return (
    <tr>
      <td style={tdStyle} colSpan={2}>
        <ExerciseCombobox
          value={null}
          options={exercises}
          placeholder={placeholder}
          onChange={onCommit}
        />
      </td>
      <td style={tdStyle} colSpan={4}>
        <button onClick={onCancel} style={cancelBtnStyle}>✕</button>
      </td>
    </tr>
  );
}

/* ---- Existing exercise row (always-editable) ---- */
function ExerciseRow({ templateId, block, exercise, canWrite, exercises, onDelete, onDuplicate, onChanged }: {
  templateId: number;
  block: HierBlock;
  exercise: HierExercise;
  canWrite: boolean;
  exercises: ExerciseOption[];
  onDelete: () => void;
  onDuplicate: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: exerciseDragId(templateId, block.id, exercise.id),
  });

  const slug = exercise.result_type_slug;
  const [exerciseId, setExerciseId] = useState(exercise.exercise_id);
  const [sets, setSets] = useState(exercise.sets != null ? String(exercise.sets) : '');
  const [minReps, setMinReps] = useState(exercise.min_reps != null ? String(exercise.min_reps) : '');
  const [maxReps, setMaxReps] = useState(exercise.max_reps != null ? String(exercise.max_reps) : '');
  const [restMin, setRestMin] = useState(exercise.rest_seconds != null ? String(exercise.rest_seconds / 60) : '');
  const [targetValue, setTargetValue] = useState(exercise.target_value != null ? String(exercise.target_value) : '');
  const [unit, setUnit] = useState(exercise.unit ?? '');

  useEffect(() => { setExerciseId(exercise.exercise_id); }, [exercise.exercise_id]);
  useEffect(() => { setSets(exercise.sets != null ? String(exercise.sets) : ''); }, [exercise.sets]);
  useEffect(() => { setMinReps(exercise.min_reps != null ? String(exercise.min_reps) : ''); }, [exercise.min_reps]);
  useEffect(() => { setMaxReps(exercise.max_reps != null ? String(exercise.max_reps) : ''); }, [exercise.max_reps]);
  useEffect(() => { setRestMin(exercise.rest_seconds != null ? String(exercise.rest_seconds / 60) : ''); }, [exercise.rest_seconds]);
  useEffect(() => { setTargetValue(exercise.target_value != null ? String(exercise.target_value) : ''); }, [exercise.target_value]);
  useEffect(() => { setUnit(exercise.unit ?? ''); }, [exercise.unit]);

  const buildBody = useCallback((overrides: Record<string, unknown> = {}) => ({
    exercise_id: exerciseId,
    sets: sets ? parseInt(sets, 10) : null,
    min_reps: minReps ? parseInt(minReps, 10) : null,
    max_reps: maxReps ? parseInt(maxReps, 10) : null,
    rest_seconds: restMin ? Math.round(parseFloat(restMin) * 60) : null,
    result_type_id: exercise.result_type_id ?? null,
    target_value: targetValue ? parseFloat(targetValue) : null,
    unit: unit || null,
    tempo: exercise.tempo,
    ...overrides,
  }), [exerciseId, sets, minReps, maxReps, restMin, exercise.result_type_id, targetValue, unit, exercise.tempo]);

  async function persist(body: Record<string, unknown>) {
    try {
      await apiFetch(`/workout-templates/${templateId}/blocks/${block.id}/exercises/${exercise.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('block_exercises.error_generic'));
    }
  }

  function handleBlurSets() { persist(buildBody({ sets: sets ? parseInt(sets, 10) : null })); }
  function handleBlurMinReps() { persist(buildBody({ min_reps: minReps ? parseInt(minReps, 10) : null })); }
  function handleBlurMaxReps() { persist(buildBody({ max_reps: maxReps ? parseInt(maxReps, 10) : null })); }
  function handleBlurRest() { persist(buildBody({ rest_seconds: restMin ? Math.round(parseFloat(restMin) * 60) : null })); }
  function handleBlurTarget() { persist(buildBody({ target_value: targetValue ? parseFloat(targetValue) : null })); }
  function handleBlurUnit() { persist(buildBody({ unit: unit || null })); }

  function handleSelectExercise(opt: ExerciseOption) {
    setExerciseId(opt.id);
    const newSets = opt.sets_default != null ? String(opt.sets_default) : '';
    const newMin = opt.min_reps_default != null ? String(opt.min_reps_default) : '';
    const newMax = opt.max_reps_default != null ? String(opt.max_reps_default) : '';
    const newRest = opt.rest_default_seconds != null ? String(opt.rest_default_seconds / 60) : '';
    setSets(newSets);
    setMinReps(newMin);
    setMaxReps(newMax);
    setRestMin(newRest);
    persist({
      exercise_id: opt.id,
      sets: newSets ? parseInt(newSets, 10) : null,
      min_reps: newMin ? parseInt(newMin, 10) : null,
      max_reps: newMax ? parseInt(newMax, 10) : null,
      rest_seconds: newRest ? Math.round(parseFloat(newRest) * 60) : null,
      result_type_id: exercise.result_type_id ?? null,
      target_value: targetValue ? parseFloat(targetValue) : null,
      unit: unit || null,
      tempo: exercise.tempo,
    });
  }

  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const numInput = (value: string, onChange: (v: string) => void, onBlur: () => void, width = 56): React.ReactNode => (
    <input
      type="number"
      min="0"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={{ ...cellInput, width }}
      disabled={!canWrite}
    />
  );

  return (
    <tr ref={setNodeRef} style={rowStyle}>
      {canWrite && (
        <td style={{ ...tdStyle, width: 20, paddingRight: 2 }}>
          <span
            {...attributes}
            {...listeners}
            aria-label={t('workout_templates.tree_drag_handle')}
            style={{ cursor: 'grab', color: '#ccc', fontSize: 13, userSelect: 'none', touchAction: 'none' }}
          >
            ⠿
          </span>
        </td>
      )}

      {/* Exercise selector */}
      <td style={tdStyle}>
        {canWrite ? (
          <ExerciseCombobox
            value={exerciseId}
            options={exercises}
            placeholder={t('block_exercises.search_placeholder')}
            onChange={handleSelectExercise}
          />
        ) : (
          <span style={{ fontSize: 13.5 }}>{exercise.exercise_name}</span>
        )}
      </td>

      {/* Sets */}
      <td style={tdStyle}>{numInput(sets, setSets, handleBlurSets)}</td>

      {/* Target value: reps range for rep-based types, numeric value otherwise */}
      {slug === 'repetitions' || slug === 'weight' || slug == null ? (
        <td style={tdStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {numInput(minReps, setMinReps, handleBlurMinReps, 44)}
            <span style={{ color: '#aaa', fontSize: 12 }}>–</span>
            {numInput(maxReps, setMaxReps, handleBlurMaxReps, 44)}
          </div>
        </td>
      ) : (
        <td style={tdStyle}>{numInput(targetValue, setTargetValue, handleBlurTarget, 72)}</td>
      )}

      {/* Unit */}
      <td style={tdStyle}>
        {canWrite ? (
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onBlur={handleBlurUnit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ ...cellInput, width: 48 }}
            placeholder="—"
          />
        ) : <span style={{ fontSize: 13 }}>{exercise.unit ?? '—'}</span>}
      </td>

      {/* Rest (minutes) */}
      <td style={tdStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {numInput(restMin, setRestMin, handleBlurRest, 48)}
          <span style={{ color: '#888', fontSize: 12 }}>min</span>
        </div>
      </td>

      {/* Context menu */}
      {canWrite && (
        <td style={{ ...tdStyle, width: 32 }}>
          <ContextMenu
            ariaLabel={t('workout_templates.col_actions')}
            items={[
              { label: t('block_exercises.duplicate'), onClick: onDuplicate },
              { label: t('block_exercises.delete'), onClick: onDelete, danger: true },
            ]}
          />
        </td>
      )}
    </tr>
  );
}

/* ---- Styles ---- */
const inlineAddStyle: React.CSSProperties = {
  background: 'none', border: '1px dashed #b9b5ee', color: '#6c63ff', borderRadius: 6,
  padding: '3px 10px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', marginBottom: 6,
};

const headerInput: React.CSSProperties = {
  padding: '4px 8px', borderRadius: 5, border: '1px solid #ddd', fontSize: 13.5,
  background: '#fafafa', minWidth: 90, maxWidth: 200,
};

const headerSelect: React.CSSProperties = {
  padding: '4px 8px', borderRadius: 5, border: '1px solid #ddd', fontSize: 13,
  background: '#fafafa', cursor: 'pointer',
};

const tableStyle: React.CSSProperties = {
  width: '100%', borderCollapse: 'collapse', fontSize: 13,
};

const thStyle: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px 6px', color: '#888', fontSize: 12,
  borderBottom: '1px solid #eee', fontWeight: 500, whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '4px 8px', verticalAlign: 'middle',
};

const cellInput: React.CSSProperties = {
  padding: '4px 6px', borderRadius: 5, border: '1px solid #ddd', fontSize: 13,
  background: '#fafafa', width: 56, boxSizing: 'border-box',
};

const comboTrigger: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 8px', borderRadius: 5, border: '1px solid #ddd',
  background: '#fafafa', fontSize: 13.5, cursor: 'pointer',
  whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis',
};

const comboDropdown: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, zIndex: 200,
  background: '#fff', border: '1px solid #ddd', borderRadius: 7,
  boxShadow: '0 4px 16px rgba(0,0,0,0.12)', minWidth: 220, marginTop: 2,
};

const comboSearch: React.CSSProperties = {
  display: 'block', width: '100%', padding: '8px 10px', border: 'none',
  borderBottom: '1px solid #eee', fontSize: 13.5, outline: 'none',
  borderRadius: '7px 7px 0 0', boxSizing: 'border-box',
};

const comboList: React.CSSProperties = {
  listStyle: 'none', margin: 0, padding: '4px 0', maxHeight: 220, overflowY: 'auto',
};

const comboItem: React.CSSProperties = {
  padding: '7px 12px', cursor: 'pointer', fontSize: 13.5,
};

const comboItemEmpty: React.CSSProperties = {
  padding: '7px 12px', color: '#aaa', fontSize: 13,
};

const cancelBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14, padding: '2px 6px',
};
