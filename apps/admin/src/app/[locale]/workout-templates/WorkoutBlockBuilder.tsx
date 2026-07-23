'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { HierBlock, HierExercise } from './summaries';
import { BLOCK_TYPES, isBlockFieldVisible, BLOCK_TYPE_MAX_EXERCISES } from './blockFieldConfig';

interface ExerciseOption {
  id: number; name: string;
  min_reps_default: number | null; max_reps_default: number | null;
  sets_default: number | null; rest_default_seconds: number | null;
}

// DnD ID helpers — workoutKey scopes IDs to avoid collisions between concurrent builder instances
const mkBlockId = (key: string | number, blockId: number) => `wbb:${key}:block:${blockId}`;
const mkExId = (key: string | number, blockId: number, exId: number) => `wbb:${key}:ex:${blockId}:${exId}`;

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
      <button type="button" onClick={handleOpen} style={comboTrigger}>
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
            {filtered.length === 0 && <li style={comboItemEmpty}>—</li>}
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

/* ---- Block row ---- */
function BlockRow({ workoutKey, blocksUrl, block, canWrite, exercises, onDuplicate, onDelete, onDeleteExercise, onChanged }: {
  workoutKey: string | number;
  blocksUrl: string;
  block: HierBlock;
  canWrite: boolean;
  exercises: ExerciseOption[];
  onDuplicate: () => void;
  onDelete: () => void;
  onDeleteExercise: (ex: HierExercise) => void;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mkBlockId(workoutKey, block.id),
  });

  const [name, setName] = useState(block.name ?? '');
  const [type, setType] = useState(block.type);
  const [rounds, setRounds] = useState(block.rounds != null ? String(block.rounds) : '');

  useEffect(() => { setName(block.name ?? ''); }, [block.name]);
  useEffect(() => { setType(block.type); }, [block.type]);
  useEffect(() => { setRounds(block.rounds != null ? String(block.rounds) : ''); }, [block.rounds]);

  const blockExercises = block.exercises ?? [];
  const maxEx = BLOCK_TYPE_MAX_EXERCISES[type];
  const atLimit = maxEx !== null && blockExercises.length >= maxEx;

  async function patchBlock(patch: Record<string, unknown>) {
    try {
      await apiFetch(`${blocksUrl}/${block.id}`, {
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

      <div style={{ marginTop: 8, paddingLeft: canWrite ? 26 : 0 }}>
        <ExerciseTable
          workoutKey={workoutKey}
          blocksUrl={blocksUrl}
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
function ExerciseTable({ workoutKey, blocksUrl, block, canWrite, exercises, atLimit, onDeleteExercise, onChanged }: {
  workoutKey: string | number;
  blocksUrl: string;
  block: HierBlock;
  canWrite: boolean;
  exercises: ExerciseOption[];
  atLimit: boolean;
  onDeleteExercise: (ex: HierExercise) => void;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const blockExercises = block.exercises ?? [];
  const [pendingRows, setPendingRows] = useState<number[]>([]);

  async function commitPending(key: number, opt: ExerciseOption) {
    setPendingRows((prev) => prev.filter((k) => k !== key));
    try {
      await apiFetch(`${blocksUrl}/${block.id}/exercises`, {
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

  async function duplicateExercise(ex: HierExercise) {
    try {
      await apiFetch(`${blocksUrl}/${block.id}/exercises/${ex.id}/duplicate`, { method: 'POST' });
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
          <button onClick={() => setPendingRows((p) => [...p, Date.now()])} style={inlineAddStyle}>
            {t('workout_templates.tree_add_exercise')}
          </button>
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
          <SortableContext
            items={blockExercises.map((ex) => mkExId(workoutKey, block.id, ex.id))}
            strategy={verticalListSortingStrategy}
          >
            {blockExercises.map((ex) => (
              <ExerciseRow
                key={ex.id}
                workoutKey={workoutKey}
                blocksUrl={blocksUrl}
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
              onCancel={() => setPendingRows((p) => p.filter((k) => k !== key))}
            />
          ))}
        </tbody>
      </table>
      {canWrite && !atLimit && (
        <button
          onClick={() => setPendingRows((p) => [...p, Date.now()])}
          style={{ ...inlineAddStyle, marginTop: 6 }}
        >
          {t('workout_templates.tree_add_exercise')}
        </button>
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
        <ExerciseCombobox value={null} options={exercises} placeholder={placeholder} onChange={onCommit} />
      </td>
      <td style={tdStyle} colSpan={4}>
        <button onClick={onCancel} style={cancelBtnStyle}>✕</button>
      </td>
    </tr>
  );
}

/* ---- Existing exercise row (always-editable) ---- */
function ExerciseRow({ workoutKey, blocksUrl, block, exercise, canWrite, exercises, onDelete, onDuplicate, onChanged }: {
  workoutKey: string | number;
  blocksUrl: string;
  block: HierBlock;
  exercise: HierExercise;
  canWrite: boolean;
  exercises: ExerciseOption[];
  onDelete: () => void;
  onDuplicate: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mkExId(workoutKey, block.id, exercise.id),
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
      await apiFetch(`${blocksUrl}/${block.id}/exercises/${exercise.id}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('block_exercises.error_generic'));
    }
  }

  function handleSelectExercise(opt: ExerciseOption) {
    setExerciseId(opt.id);
    const newSets = opt.sets_default != null ? String(opt.sets_default) : '';
    const newMin = opt.min_reps_default != null ? String(opt.min_reps_default) : '';
    const newMax = opt.max_reps_default != null ? String(opt.max_reps_default) : '';
    const newRest = opt.rest_default_seconds != null ? String(opt.rest_default_seconds / 60) : '';
    setSets(newSets); setMinReps(newMin); setMaxReps(newMax); setRestMin(newRest);
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

      <td style={tdStyle}>{numInput(sets, setSets, () => persist(buildBody({ sets: sets ? parseInt(sets, 10) : null })))}</td>

      {slug === 'repetitions' || slug === 'weight' || slug == null ? (
        <td style={tdStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {numInput(minReps, setMinReps, () => persist(buildBody({ min_reps: minReps ? parseInt(minReps, 10) : null })), 44)}
            <span style={{ color: '#aaa', fontSize: 12 }}>–</span>
            {numInput(maxReps, setMaxReps, () => persist(buildBody({ max_reps: maxReps ? parseInt(maxReps, 10) : null })), 44)}
          </div>
        </td>
      ) : (
        <td style={tdStyle}>{numInput(targetValue, setTargetValue, () => persist(buildBody({ target_value: targetValue ? parseFloat(targetValue) : null })), 72)}</td>
      )}

      <td style={tdStyle}>
        {canWrite ? (
          <input
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            onBlur={() => persist(buildBody({ unit: unit || null }))}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={{ ...cellInput, width: 48 }}
            placeholder="—"
          />
        ) : <span style={{ fontSize: 13 }}>{exercise.unit ?? '—'}</span>}
      </td>

      <td style={tdStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {numInput(restMin, setRestMin, () => persist(buildBody({ rest_seconds: restMin ? Math.round(parseFloat(restMin) * 60) : null })), 48)}
          <span style={{ color: '#888', fontSize: 12 }}>min</span>
        </div>
      </td>

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

/* ---- Main builder ---- */
export function WorkoutBlockBuilder({ workoutKey, blocksUrl, blocks, canWrite, onChanged }: {
  workoutKey: number | string;
  blocksUrl: string;
  blocks: HierBlock[];
  canWrite: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [localBlocks, setLocalBlocks] = useState<HierBlock[]>(blocks);
  const [exercises, setExercises] = useState<ExerciseOption[]>([]);
  const [deletingBlock, setDeletingBlock] = useState<HierBlock | null>(null);
  const [deletingExercise, setDeletingExercise] = useState<{ block: HierBlock; item: HierExercise } | null>(null);

  useEffect(() => { setLocalBlocks(blocks); }, [blocks]);
  useEffect(() => {
    apiFetch<ExerciseOption[]>('/exercises?status=active').then(setExercises).catch(() => {});
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;

    const activeStr = String(active.id);
    const overStr = String(over.id);

    if (activeStr.includes(':block:')) {
      // Block reorder
      const oldI = localBlocks.findIndex((b) => mkBlockId(workoutKey, b.id) === activeStr);
      const newI = localBlocks.findIndex((b) => mkBlockId(workoutKey, b.id) === overStr);
      if (oldI < 0 || newI < 0) return;
      const reordered = arrayMove(localBlocks, oldI, newI);
      setLocalBlocks(reordered);
      try {
        await apiFetch(`${blocksUrl}/reorder`, {
          method: 'PUT',
          body: JSON.stringify({ order: reordered.map((b) => b.id) }),
        });
        await onChanged();
      } catch (err: any) {
        toast(err.message ?? t('workout_template_blocks.error_generic'));
        await onChanged();
      }
    } else if (activeStr.includes(':ex:')) {
      // Exercise drag — ID format: wbb:KEY:ex:BLOCKID:EXID
      const aParts = activeStr.split(':');
      const oParts = overStr.split(':');
      // oParts may be a block ID (wbb:KEY:block:BLOCKID) if dropped on block header — ignore
      if (!overStr.includes(':ex:')) return;
      const srcBlockId = parseInt(aParts[aParts.length - 2], 10);
      const tgtBlockId = parseInt(oParts[oParts.length - 2], 10);
      const srcExId = parseInt(aParts[aParts.length - 1], 10);

      if (srcBlockId === tgtBlockId) {
        // Same-block reorder
        const blockIdx = localBlocks.findIndex((b) => b.id === srcBlockId);
        if (blockIdx < 0) return;
        const exs = localBlocks[blockIdx].exercises ?? [];
        const oldI = exs.findIndex((ex) => mkExId(workoutKey, srcBlockId, ex.id) === activeStr);
        const newI = exs.findIndex((ex) => mkExId(workoutKey, srcBlockId, ex.id) === overStr);
        if (oldI < 0 || newI < 0) return;
        const reordered = arrayMove(exs, oldI, newI);
        setLocalBlocks((prev) =>
          prev.map((b, i) => i === blockIdx ? { ...b, exercises: reordered } : b),
        );
        try {
          await apiFetch(`${blocksUrl}/${srcBlockId}/exercises/reorder`, {
            method: 'PUT',
            body: JSON.stringify({ order: reordered.map((ex) => ex.id) }),
          });
          await onChanged();
        } catch (err: any) {
          toast(err.message ?? t('block_exercises.error_generic'));
          await onChanged();
        }
      } else {
        // Cross-block exercise move
        try {
          await apiFetch(`${blocksUrl}/${srcBlockId}/exercises/${srcExId}/move`, {
            method: 'PUT',
            body: JSON.stringify({ target_block_id: tgtBlockId }),
          });
          await onChanged();
        } catch (err: any) {
          toast(err.message ?? t('block_exercises.error_generic'));
        }
      }
    }
  }

  async function addBlock() {
    try {
      await apiFetch(blocksUrl, { method: 'POST', body: JSON.stringify({ type: 'Standard' }) });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  async function duplicateBlock(block: HierBlock) {
    try {
      await apiFetch(`${blocksUrl}/${block.id}/duplicate`, { method: 'POST' });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('workout_template_blocks.error_generic'));
    }
  }

  async function deleteBlock() {
    if (!deletingBlock) return;
    try {
      await apiFetch(`${blocksUrl}/${deletingBlock.id}`, { method: 'DELETE' });
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
        `${blocksUrl}/${deletingExercise.block.id}/exercises/${deletingExercise.item.id}`,
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
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      {canWrite && (
        <button onClick={addBlock} style={inlineAddStyle}>
          {t('workout_templates.tree_add_block')}
        </button>
      )}

      {localBlocks.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14, margin: '8px 0 4px' }}>{t('workout_templates.tree_no_blocks')}</p>
      ) : (
        <SortableContext
          items={localBlocks.map((b) => mkBlockId(workoutKey, b.id))}
          strategy={verticalListSortingStrategy}
        >
          {localBlocks.map((b) => (
            <BlockRow
              key={b.id}
              workoutKey={workoutKey}
              blocksUrl={blocksUrl}
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
    </DndContext>
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
