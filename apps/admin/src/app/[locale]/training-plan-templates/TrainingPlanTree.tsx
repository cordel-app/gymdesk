'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
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
import { btnStyle } from '@/components/ui';
import { isBlockFieldVisible } from '../workout-templates/blockFieldConfig';

/* Shapes returned by GET /training-plan-templates/:id/hierarchy */
export interface HierExercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null;
  rest_seconds: number | null; tempo: string | null;
}
export interface HierBlock {
  id: number; position: number; name: string | null; description: string | null;
  type: string; result_type: string; rounds: number | null; duration_seconds: number | null;
  work_seconds: number | null; rest_seconds: number | null; is_optional: number | boolean;
  notes: string | null; exercises: HierExercise[] | null;
}
export interface HierWorkout {
  id: number; position: number; scheduled_weekday: number | null;
  workout_template_id: number; workout_template_name: string; blocks: HierBlock[] | null;
}
export interface Hierarchy {
  id: number; name: string; status: string; workouts: HierWorkout[] | null;
}

interface WorkoutTemplateOption { id: number; name: string }

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

export function TrainingPlanTree({
  templateId, hierarchy, canWrite, onChanged,
}: {
  templateId: number;
  hierarchy: Hierarchy;
  canWrite: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const base = `/training-plan-templates/${templateId}/workouts`;

  // Local copy for smooth optimistic drag reordering; resynced whenever the
  // cached hierarchy prop changes (after a branch refetch).
  const [workouts, setWorkouts] = useState<HierWorkout[]>(hierarchy.workouts ?? []);
  useEffect(() => { setWorkouts(hierarchy.workouts ?? []); }, [hierarchy]);

  const [options, setOptions] = useState<WorkoutTemplateOption[]>([]);
  const [addWorkoutId, setAddWorkoutId] = useState('');
  const [addWeekday, setAddWeekday] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<HierWorkout | null>(null);

  useEffect(() => {
    if (!canWrite) return;
    apiFetch<WorkoutTemplateOption[]>('/workout-templates')
      .then(setOptions)
      .catch((err: any) => toast(err.message ?? t('training_plan_templates.error_generic')));
  }, [canWrite]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = workouts.findIndex((w) => w.id === active.id);
    const newIndex = workouts.findIndex((w) => w.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const reordered = arrayMove(workouts, oldIndex, newIndex);
    setWorkouts(reordered);
    try {
      await apiFetch(`${base}/reorder`, { method: 'PUT', body: JSON.stringify({ order: reordered.map((w) => w.id) }) });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
      await onChanged(); // resync from server on failure
    }
  }

  async function addWorkout() {
    if (!addWorkoutId) { toast(t('training_plan_templates.tree_error_pick_workout')); return; }
    setAdding(true);
    try {
      await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({
          workout_template_id: parseInt(addWorkoutId, 10),
          scheduled_weekday: addWeekday === '' ? null : parseInt(addWeekday, 10),
        }),
      });
      setAddWorkoutId(''); setAddWeekday('');
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    } finally {
      setAdding(false);
    }
  }

  async function changeWeekday(link: HierWorkout, value: string) {
    try {
      await apiFetch(`${base}/${link.id}`, {
        method: 'PUT',
        body: JSON.stringify({ scheduled_weekday: value === '' ? null : parseInt(value, 10) }),
      });
      await onChanged();
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    }
  }

  async function removeWorkout() {
    if (!removing) return;
    try {
      await apiFetch(`${base}/${removing.id}`, { method: 'DELETE' });
      setRemoving(null);
      await onChanged();
    } catch (err: any) {
      setRemoving(null);
      toast(err.message ?? t('training_plan_templates.error_generic'));
    }
  }

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      {canWrite && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <select value={addWorkoutId} onChange={(e) => setAddWorkoutId(e.target.value)} style={selectStyle}>
            <option value="">{t('training_plan_templates.tree_select_workout')}</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <select value={addWeekday} onChange={(e) => setAddWeekday(e.target.value)} style={selectStyle}>
            <option value="">{t('training_plan_templates.tree_no_weekday')}</option>
            {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
          </select>
          <button onClick={addWorkout} disabled={adding} style={btnStyle()}>
            {adding ? t('training_plan_templates.saving') : t('training_plan_templates.tree_add_workout')}
          </button>
        </div>
      )}

      {workouts.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14, margin: '4px 0' }}>{t('training_plan_templates.tree_no_workouts')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={workouts.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {workouts.map((w) => (
              <WorkoutRow
                key={w.id}
                workout={w}
                canWrite={canWrite}
                onChangeWeekday={(v) => changeWeekday(w, v)}
                onOpenTemplate={() => router.push(`/${locale}/workout-templates`)}
                onRemove={() => setRemoving(w)}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog
        open={removing !== null}
        message={t('training_plan_templates.tree_confirm_remove_workout')}
        confirmLabel={t('training_plan_templates.tree_remove_from_plan')}
        cancelLabel={t('training_plan_templates.cancel')}
        onConfirm={removeWorkout}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

function WorkoutRow({
  workout, canWrite, onChangeWeekday, onOpenTemplate, onRemove,
}: {
  workout: HierWorkout;
  canWrite: boolean;
  onChangeWeekday: (value: string) => void;
  onOpenTemplate: () => void;
  onRemove: () => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: workout.id });
  const [editingWeekday, setEditingWeekday] = useState(false);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    background: '#fff',
    border: '1px solid #ececf0',
    borderRadius: 8,
    padding: '10px 14px',
    marginBottom: 10,
  };

  const blocks = workout.blocks ?? [];

  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {canWrite && (
          <span
            {...attributes}
            {...listeners}
            aria-label={t('training_plan_templates.tree_drag_handle')}
            style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none' }}
          >
            ⠿
          </span>
        )}
        {editingWeekday && canWrite ? (
          <select
            autoFocus
            defaultValue={workout.scheduled_weekday != null ? String(workout.scheduled_weekday) : ''}
            onChange={(e) => { onChangeWeekday(e.target.value); setEditingWeekday(false); }}
            onBlur={() => setEditingWeekday(false)}
            style={selectStyle}
          >
            <option value="">{t('training_plan_templates.tree_no_weekday')}</option>
            {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
          </select>
        ) : (
          <button
            onClick={() => canWrite && setEditingWeekday(true)}
            title={canWrite ? t('training_plan_templates.tree_edit_weekday') : undefined}
            style={{ ...weekdayBadge, cursor: canWrite ? 'pointer' : 'default' }}
          >
            🗓 {workout.scheduled_weekday != null ? t(`workouts.weekday_${workout.scheduled_weekday}`) : t('training_plan_templates.tree_no_weekday')}
          </button>
        )}
        <span style={{ fontWeight: 600, fontSize: 15 }}>{workout.workout_template_name}</span>
        <span style={{ flex: 1 }} />
        <ContextMenu
          ariaLabel={t('training_plan_templates.col_actions')}
          items={[
            { label: t('training_plan_templates.tree_open_workout_template'), onClick: onOpenTemplate },
            ...(canWrite ? [{ label: t('training_plan_templates.tree_remove_from_plan'), onClick: onRemove, danger: true }] : []),
          ]}
        />
      </div>

      <div style={{ marginTop: blocks.length ? 10 : 0, paddingLeft: canWrite ? 26 : 0 }}>
        {blocks.length === 0 ? (
          <p style={{ color: '#aaa', fontSize: 13, margin: '2px 0' }}>{t('training_plan_templates.tree_no_blocks')}</p>
        ) : (
          blocks.map((b) => <BlockRow key={b.id} block={b} />)
        )}
      </div>
    </div>
  );
}

function BlockRow({ block }: { block: HierBlock }) {
  const t = useTranslations();
  const exercises = block.exercises ?? [];
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        {block.name || t(`workout_template_blocks.type_${block.type.toLowerCase()}`)}
      </div>
      <div style={{ color: '#888', fontSize: 12.5 }}>{blockSummary(block, t)}</div>
      <div style={{ marginTop: 4, paddingLeft: 16 }}>
        {exercises.length === 0 ? (
          <p style={{ color: '#bbb', fontSize: 12.5, margin: '2px 0' }}>{t('training_plan_templates.tree_no_exercises')}</p>
        ) : (
          exercises.map((ex) => (
            <div key={ex.id} style={{ padding: '3px 0' }}>
              <span style={{ fontSize: 13.5 }}>{ex.exercise_name}</span>
              {exerciseSummary(ex, t) && (
                <span style={{ color: '#999', fontSize: 12.5, marginLeft: 8 }}>{exerciseSummary(ex, t)}</span>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

type T = (key: string, values?: Record<string, any>) => string;

/** Compact block execution summary; only fields relevant to the block type are shown. */
function blockSummary(b: HierBlock, t: T): string {
  const parts: string[] = [t(`workout_template_blocks.type_${b.type.toLowerCase()}`)];
  if (isBlockFieldVisible(b.type, 'result_type') && b.result_type && b.result_type !== 'None') {
    parts.push(t(`workout_template_blocks.result_type_${b.result_type.toLowerCase()}`));
  }
  if (isBlockFieldVisible(b.type, 'rounds') && b.rounds != null) {
    parts.push(t('training_plan_templates.summary_rounds', { n: b.rounds }));
  }
  if (isBlockFieldVisible(b.type, 'duration_seconds') && b.duration_seconds != null) {
    parts.push(t('training_plan_templates.summary_min', { n: Math.round(b.duration_seconds / 60) }));
  }
  if (isBlockFieldVisible(b.type, 'work_seconds') && b.work_seconds != null) {
    parts.push(t('training_plan_templates.summary_work', { n: b.work_seconds }));
  }
  if (isBlockFieldVisible(b.type, 'rest_seconds') && b.rest_seconds != null) {
    parts.push(t('training_plan_templates.summary_rest', { n: b.rest_seconds }));
  }
  return parts.join(' • ');
}

/** Compact exercise execution summary: sets × reps • Tempo • Rest. Nulls omitted. */
function exerciseSummary(ex: HierExercise, t: T): string {
  const parts: string[] = [];
  let reps: string | null = null;
  if (ex.min_reps != null && ex.max_reps != null) {
    reps = ex.min_reps === ex.max_reps ? String(ex.min_reps) : `${ex.min_reps}–${ex.max_reps}`;
  } else if (ex.min_reps != null) {
    reps = String(ex.min_reps);
  } else if (ex.max_reps != null) {
    reps = String(ex.max_reps);
  }
  if (ex.sets != null && reps) parts.push(`${ex.sets} × ${reps}`);
  else if (ex.sets != null) parts.push(t('training_plan_templates.summary_sets', { n: ex.sets }));
  else if (reps) parts.push(reps);
  if (ex.tempo) parts.push(t('training_plan_templates.summary_tempo', { tempo: ex.tempo }));
  if (ex.rest_seconds != null) parts.push(t('training_plan_templates.summary_rest_ex', { n: ex.rest_seconds }));
  return parts.join(' • ');
}

const selectStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff' };
const weekdayBadge: React.CSSProperties = {
  background: '#eef0ff', color: '#4b45c6', border: 'none', borderRadius: 999,
  padding: '3px 10px', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
};
