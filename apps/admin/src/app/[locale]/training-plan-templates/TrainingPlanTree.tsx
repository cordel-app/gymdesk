'use client';

import React, { useEffect, useState } from 'react';
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
import { ExerciseMediaThumbnails } from '@/components/ExerciseMediaThumbnails';
import { primaryBtnStyle } from '@/components/ui';
import { treeSummaryTextStyle, weekdayChipStyle } from '@/components/workoutChrome';
import { HierBlock, blockSummary, exerciseSummary } from '../workout-templates/summaries';

/* Shapes returned by GET /training-plan-templates/:id/hierarchy */
export type { HierExercise, HierBlock } from '../workout-templates/summaries';
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
    apiFetch<WorkoutTemplateOption[]>('/workout-templates?status=active')
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
          <button onClick={addWorkout} disabled={adding} style={primaryBtnStyle()}>
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
            style={{ ...weekdayChipStyle, cursor: canWrite ? 'pointer' : 'default' }}
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
      {/* #1032: the block's name and its execution summary share one line, as
        * they already do in both Workout Template trees — two stacked lines per
        * block is what made a plan with a handful of workouts so tall. They are
        * inline spans rather than a flex row so a narrow viewport wraps the
        * summary under the name by itself, with no horizontal overflow. */}
      <div style={{ fontWeight: 600, fontSize: 14 }}>
        {block.name || t(`workout_template_blocks.type_${block.type.toLowerCase()}`)}
        <span style={treeSummaryTextStyle}>{blockSummary(block, t)}</span>
      </div>
      <div style={{ marginTop: 4, paddingLeft: 16 }}>
        {exercises.length === 0 ? (
          <p style={{ color: '#bbb', fontSize: 12.5, margin: '2px 0' }}>{t('training_plan_templates.tree_no_exercises')}</p>
        ) : (
          exercises.map((ex) => (
            <div key={ex.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
              <span style={{ fontSize: 13.5 }}>{ex.exercise_name}</span>
              {exerciseSummary(ex, t) && (
                <span style={{ color: '#999', fontSize: 12.5 }}>{exerciseSummary(ex, t)}</span>
              )}
              {/* Media (#720) — pushed to the right of the line. */}
              <span style={{ marginLeft: 'auto' }}><ExerciseMediaThumbnails exercise={ex} size={24} /></span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  padding: '7px 10px', borderRadius: 6, fontSize: 14,
  border: '1px solid var(--gd-input-border, #ccc)', background: 'var(--gd-input-bg, #ffffff)',
};
// #971: the weekday chip this page used to declare for itself — the same pill
// the Assigned Training Plans card had, both in a lilac (`#eef0ff` /
// `#4b45c6`) no Theme setting reaches — is `workoutChrome`'s.
