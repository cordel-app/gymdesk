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
import { ExerciseMediaThumbnails } from '@/components/ExerciseMediaThumbnails';
import {
  TREE_COMBO_ITEM_SELECTED_BG, treeAddBtnStyle, treeBlockCardStyle, treeCellInputStyle,
  treeComboCaretStyle, treeComboDropdownStyle, treeComboItemEmptyStyle, treeComboItemStyle,
  treeComboListStyle, treeComboPlaceholderStyle, treeComboSearchStyle, treeComboTriggerStyle,
  treeControlLabelStyle, treeControlUnitStyle, treeDragHandleStyle, treeDraftRemoveBtnStyle,
  treeDropTargetStyle, treeEmptyTextStyle, treeHeaderInputStyle, treeHeaderSelectStyle,
  treeNestedEmptyTextStyle, treeRowDragHandleStyle, treeSeparatorTextStyle, treeSummaryTextStyle,
  treeTableStyle, treeTdStyle, treeThStyle,
} from '@/components/workoutChrome';
import { HierBlock, HierExercise } from './summaries';
import { exerciseMatchesQuery, exerciseName } from '@/lib/exerciseNames';
import {
  BLOCK_TYPES, BLOCK_TYPE_MAX_EXERCISES,
  blockConfigInput, blockConfigPatch, getBlockConfig,
} from './blockFieldConfig';

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
    <div ref={setNodeRef} style={treeDropTargetStyle(isOver && foreignBlock)}>
      {children}
    </div>
  );
}

/* ---- Exercise option (for the combobox) ---- */
interface ExerciseOption {
  id: number; name: string;
  /** #967: the name in the user's language, and the stored translations a search also matches. */
  display_name?: string | null; translations?: Record<string, string> | null;
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
    // #967 §7: the same three things the API's `?q=` matches — the displayed
    // name, the base name and every stored translation.
    ? options.filter((o) => exerciseMatchesQuery(o, query))
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
        style={treeComboTriggerStyle}
      >
        {selected ? exerciseName(selected) : <span style={treeComboPlaceholderStyle}>{placeholder}</span>}
        <span style={treeComboCaretStyle}>▾</span>
      </button>
      {open && (
        <div style={treeComboDropdownStyle}>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            style={treeComboSearchStyle}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); setQuery(''); }
              if (e.key === 'Enter' && filtered.length === 1) pick(filtered[0]);
            }}
          />
          <ul style={treeComboListStyle}>
            {filtered.length === 0 && (
              <li style={treeComboItemEmptyStyle}>—</li>
            )}
            {filtered.map((opt) => (
              <li
                key={opt.id}
                onMouseDown={() => pick(opt)}
                style={{ ...treeComboItemStyle, background: opt.id === value ? TREE_COMBO_ITEM_SELECTED_BG : undefined }}
              >
                {exerciseName(opt)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* ---- Main tree ---- */
export function WorkoutTemplateTree({ templateId, hierarchy, canWrite, onChanged }: {
  templateId: number;
  hierarchy: WtHierarchy;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
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
    <div style={{ marginTop: 4 }}>
      {canWrite && (
        <button onClick={addBlock} style={treeAddBtnStyle}>
          {t('workout_templates.tree_add_block')}
        </button>
      )}

      {blocks.length === 0 ? (
        <p style={treeEmptyTextStyle}>{t('workout_templates.tree_no_blocks')}</p>
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
  // #672: one configuration input, chosen by block type (Rounds / Minutes / Intervals).
  const [configInput, setConfigInput] = useState(() => blockConfigInput(block));

  // Keep local state in sync when parent hierarchy refreshes
  useEffect(() => { setName(block.name ?? ''); }, [block.name]);
  useEffect(() => { setType(block.type); }, [block.type]);
  useEffect(() => {
    setConfigInput(blockConfigInput(block));
  }, [block.type, block.rounds, block.duration_seconds]);

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
    ...treeBlockCardStyle,
  };

  const config = getBlockConfig(type);
  const savedConfig = getBlockConfig(block.type);

  return (
    <div ref={setNodeRef} style={style}>
      {/* Compact one-line header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {canWrite && (
          <span
            {...attributes}
            {...listeners}
            aria-label={t('workout_templates.tree_drag_handle')}
            style={treeDragHandleStyle}
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
              style={treeHeaderInputStyle}
            />
            <select
              value={type}
              onChange={(e) => {
                const newType = e.target.value;
                setType(newType);
                patchBlock({ type: newType });
              }}
              style={treeHeaderSelectStyle}
            >
              {BLOCK_TYPES.map((ty) => (
                <option key={ty} value={ty}>{t(`workout_template_blocks.type_${ty.toLowerCase()}`)}</option>
              ))}
            </select>
            {config && (
              <>
                <span style={treeSeparatorTextStyle}>•</span>
                <input
                  type="number"
                  min="1"
                  value={configInput}
                  onChange={(e) => setConfigInput(e.target.value)}
                  onBlur={() => patchBlock(blockConfigPatch(config, configInput))}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  placeholder="—"
                  style={{ ...treeHeaderInputStyle, width: 56, textAlign: 'center' }}
                />
                <span style={treeControlLabelStyle}>{t(config.labelKey)}</span>
              </>
            )}
          </>
        ) : (
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            {block.name || t(`workout_template_blocks.type_${block.type.toLowerCase()}`)}
            {savedConfig && blockConfigInput(block) !== '' && (
              <span style={treeSummaryTextStyle}>
                {t(`workout_template_blocks.type_${block.type.toLowerCase()}`)} • {t(savedConfig.summaryKey, { n: blockConfigInput(block) })}
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
        <p style={treeNestedEmptyTextStyle}>{t('workout_templates.tree_no_exercises')}</p>
        {canWrite && !atLimit && (
          <button onClick={addExerciseRow} style={treeAddBtnStyle}>{t('workout_templates.tree_add_exercise')}</button>
        )}
      </>
    );
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={treeTableStyle}>
        <thead>
          <tr>
            {canWrite && <th style={treeThStyle} />}
            <th style={{ ...treeThStyle, minWidth: 180 }}>{t('block_exercises.col_exercise')}</th>
            <th style={{ ...treeThStyle, width: 64 }}>{t('block_exercises.col_sets')}</th>
            <th style={{ ...treeThStyle, width: 90 }}>{t('block_exercises.col_target')}</th>
            <th style={{ ...treeThStyle, width: 56 }}>{t('block_exercises.col_unit')}</th>
            <th style={{ ...treeThStyle, width: 80 }}>{t('block_exercises.col_rest_min')}</th>
            {/* #720: media column — header stays empty, the thumbnails label themselves. */}
            <th style={{ ...treeThStyle, width: 72 }} />
            {canWrite && <th style={treeThStyle} />}
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
              cancelLabel={t('block_exercises.cancel')}
              onCommit={(opt) => commitPending(key, opt)}
              onCancel={() => cancelPending(key)}
            />
          ))}
        </tbody>
      </table>
      {canWrite && !atLimit && (
        <button onClick={addExerciseRow} style={{ ...treeAddBtnStyle, marginTop: 6 }}>{t('workout_templates.tree_add_exercise')}</button>
      )}
    </div>
  );
}

/* ---- Pending (new) exercise row ---- */
function PendingExerciseRow({ exercises, placeholder, cancelLabel, onCommit, onCancel }: {
  exercises: ExerciseOption[];
  placeholder: string;
  /** #1031: the `✕` is one glyph, so its accessible name is the caller's. */
  cancelLabel: string;
  onCommit: (opt: ExerciseOption) => void;
  onCancel: () => void;
}) {
  return (
    <tr>
      <td style={treeTdStyle} colSpan={2}>
        <ExerciseCombobox
          value={null}
          options={exercises}
          placeholder={placeholder}
          onChange={onCommit}
        />
      </td>
      <td style={treeTdStyle} colSpan={4}>
        <button onClick={onCancel} style={treeDraftRemoveBtnStyle} aria-label={cancelLabel}>✕</button>
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
      style={{ ...treeCellInputStyle, width }}
      disabled={!canWrite}
    />
  );

  return (
    <tr ref={setNodeRef} style={rowStyle}>
      {canWrite && (
        <td style={{ ...treeTdStyle, width: 20, paddingRight: 2 }}>
          <span
            {...attributes}
            {...listeners}
            aria-label={t('workout_templates.tree_drag_handle')}
            style={treeRowDragHandleStyle}
          >
            ⠿
          </span>
        </td>
      )}

      {/* Exercise selector */}
      <td style={treeTdStyle}>
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
      <td style={treeTdStyle}>{numInput(sets, setSets, handleBlurSets)}</td>

      {/* Target value: reps range for rep-based types, numeric value otherwise */}
      {slug === 'repetitions' || slug === 'weight' || slug == null ? (
        <td style={treeTdStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {numInput(minReps, setMinReps, handleBlurMinReps, 44)}
            <span style={treeSeparatorTextStyle}>–</span>
            {numInput(maxReps, setMaxReps, handleBlurMaxReps, 44)}
          </div>
        </td>
      ) : (
        <td style={treeTdStyle}>{numInput(targetValue, setTargetValue, handleBlurTarget, 72)}</td>
      )}

      {/* Unit */}
      <td style={treeTdStyle}>
        {canWrite ? (
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onBlur={handleBlurUnit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ ...treeCellInputStyle, width: 48 }}
            placeholder="—"
          />
        ) : <span style={{ fontSize: 13 }}>{exercise.unit ?? '—'}</span>}
      </td>

      {/* Rest (minutes) */}
      <td style={treeTdStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {numInput(restMin, setRestMin, handleBlurRest, 48)}
          <span style={treeControlUnitStyle}>min</span>
        </div>
      </td>

      {/* Media (#720) — whatever image/video the exercise carries, at the right of the row. */}
      <td style={{ ...treeTdStyle, textAlign: 'right' }}>
        <ExerciseMediaThumbnails exercise={exercise} />
      </td>

      {/* Context menu */}
      {canWrite && (
        <td style={{ ...treeTdStyle, width: 32 }}>
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
