'use client';

import React, { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { useApiClient } from '@/lib/apiClient';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { cardSurfaceStyle, primaryBtnStyle } from '@/components/ui';
import { formControlStyle, secondaryBtnStyle } from '@/components/formChrome';
import { weekdayChipStyle, weekdaySelectStyle } from '@/components/workoutChrome';
import { WorkoutBlockBuilder } from '../workout-templates/WorkoutBlockBuilder';
import type { HierBlock } from '../workout-templates/summaries';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export interface Workout {
  id: number; position: number; name: string; description: string | null;
  scheduled_weekday: number | null; blocks: HierBlock[] | null;
}

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/* ---- PlanWorkoutTree ---- */

export function PlanWorkoutTree({
  plan, canWrite, apiFetch, toast, onChanged,
}: {
  plan: { id: number; member_id: number; workouts?: Workout[] | null };
  canWrite: boolean;
  apiFetch: ReturnType<typeof useApiClient>['apiFetch'];
  toast: (msg: string) => void;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const base = `/members/${plan.member_id}/training-plans/${plan.id}/workouts`;

  const [workouts, setWorkouts] = useState<Workout[]>(plan.workouts ?? []);
  useEffect(() => { setWorkouts(plan.workouts ?? []); }, [plan]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [addSaving, setAddSaving] = useState(false);
  const [removingWorkout, setRemovingWorkout] = useState<Workout | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldI = workouts.findIndex((w) => w.id === active.id);
    const newI = workouts.findIndex((w) => w.id === over.id);
    if (oldI < 0 || newI < 0) return;
    const reordered = arrayMove(workouts, oldI, newI);
    setWorkouts(reordered);
    try {
      await apiFetch(`${base}/reorder`, { method: 'PUT', body: JSON.stringify({ order: reordered.map((w) => w.id) }) });
      onChanged();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); onChanged(); }
  }

  async function addWorkout() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    setAddSaving(true);
    try {
      await apiFetch(base, { method: 'POST', body: JSON.stringify({ name: trimmed }) });
      setShowAddForm(false);
      setNewName('');
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setAddSaving(false);
    }
  }

  async function changeWeekday(w: Workout, value: string) {
    try {
      await apiFetch(`${base}/${w.id}`, {
        method: 'PUT',
        body: JSON.stringify({ scheduled_weekday: value === '' ? null : parseInt(value, 10) }),
      });
      onChanged();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }

  async function duplicateWorkout(w: Workout) {
    try { await apiFetch(`${base}/${w.id}/duplicate`, { method: 'POST' }); onChanged(); }
    catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }

  async function removeWorkout() {
    if (!removingWorkout) return;
    try { await apiFetch(`${base}/${removingWorkout.id}`, { method: 'DELETE' }); setRemovingWorkout(null); onChanged(); }
    catch (err: any) { setRemovingWorkout(null); toast(err.message ?? t('training_plans.error_generic')); }
  }

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      {canWrite && (
        showAddForm ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14 }}>
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addWorkout();
                if (e.key === 'Escape') { setShowAddForm(false); setNewName(''); }
              }}
              placeholder={t('training_plans.editor_add_workout')}
              style={addWorkoutInput}
            />
            <button onClick={addWorkout} disabled={addSaving || !newName.trim()} style={primaryBtnStyle()}>
              {addSaving ? t('training_plans.saving') : t('training_plans.save_changes')}
            </button>
            <button onClick={() => { setShowAddForm(false); setNewName(''); }} style={secondaryBtnStyle}>
              {t('training_plans.cancel')}
            </button>
          </div>
        ) : (
          <button onClick={() => setShowAddForm(true)} style={{ ...primaryBtnStyle(), marginBottom: 14 }}>
            {t('training_plans.editor_add_workout')}
          </button>
        )
      )}

      {workouts.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14, margin: '4px 0' }}>{t('training_plans.editor_no_workouts')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={workouts.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {workouts.map((w) => (
              <WorkoutCard
                key={w.id}
                workout={w}
                memberId={plan.member_id}
                planId={plan.id}
                canWrite={canWrite}
                apiFetch={apiFetch}
                toast={toast}
                onChangeWeekday={(v) => changeWeekday(w, v)}
                onDuplicate={() => duplicateWorkout(w)}
                onRemove={() => setRemovingWorkout(w)}
                onChanged={onChanged}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

      <ConfirmDialog open={removingWorkout !== null} message={t('training_plans.editor_confirm_remove_workout')}
        confirmLabel={t('training_plans.editor_remove')} cancelLabel={t('training_plans.cancel')}
        onConfirm={removeWorkout} onCancel={() => setRemovingWorkout(null)} />
    </div>
  );
}

/* ---- WorkoutCard ---- */

function WorkoutCard({
  workout: w, memberId, planId, canWrite, apiFetch, toast,
  onChangeWeekday, onDuplicate, onRemove, onChanged,
}: {
  workout: Workout;
  memberId: number;
  planId: number;
  canWrite: boolean;
  apiFetch: ReturnType<typeof useApiClient>['apiFetch'];
  toast: (msg: string) => void;
  onChangeWeekday: (v: string) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const [name, setName] = useState(w.name);

  useEffect(() => { setName(w.name); }, [w.name]);

  const blocksUrl = `/members/${memberId}/training-plans/${planId}/workouts/${w.id}/blocks`;

  async function saveName() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === w.name) { setName(w.name); return; }
    try {
      await apiFetch(`/members/${memberId}/training-plans/${planId}/workouts/${w.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: trimmed }),
      });
      onChanged();
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
      setName(w.name);
    }
  }

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1,
    ...cardSurfaceStyle, padding: '10px 14px', marginBottom: 10,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {canWrite && (
          <span
            {...attributes}
            {...listeners}
            style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none', touchAction: 'none' }}
          >
            ⠿
          </span>
        )}
        {/* #971: the same chip in both modes — a `<select>` while editing, the
            value itself while reading, so switching modes does not move the row
            and neither half declares a colour of its own. */}
        {canWrite ? (
          <select
            value={w.scheduled_weekday != null ? String(w.scheduled_weekday) : ''}
            onChange={(e) => onChangeWeekday(e.target.value)}
            style={weekdaySelectStyle}
          >
            <option value="">{t('training_plan_templates.tree_no_weekday')}</option>
            {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
          </select>
        ) : (
          <span style={weekdayChipStyle}>
            {w.scheduled_weekday != null
              ? t(`workouts.weekday_${w.scheduled_weekday}`)
              : t('training_plan_templates.tree_no_weekday')}
          </span>
        )}
        {canWrite ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            style={workoutNameInput}
          />
        ) : (
          <span style={{ fontWeight: 600, fontSize: 15 }}>{w.name}</span>
        )}
        <span style={{ flex: 1 }} />
        {canWrite && (
          <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
            { label: t('training_plans.editor_duplicate'), onClick: onDuplicate },
            { label: t('training_plans.editor_remove'), onClick: onRemove, danger: true },
          ]} />
        )}
      </div>

      <div style={{ marginTop: 12, paddingLeft: canWrite ? 26 : 0 }}>
        <WorkoutBlockBuilder
          workoutKey={w.id}
          blocksUrl={blocksUrl}
          blocks={w.blocks ?? []}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      </div>
    </div>
  );
}


const workoutNameInput: React.CSSProperties = {
  ...formControlStyle, width: 'auto', fontWeight: 600, fontSize: 15,
  padding: '3px 6px', borderRadius: 5, minWidth: 120,
};
const addWorkoutInput: React.CSSProperties = { ...formControlStyle, width: 'auto', minWidth: 200 };
