'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
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
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, overlayStyle, modalStyle } from '@/components/ui';
import { PlanWorkoutBlocksModal } from '../../members/PlanWorkoutBlocksModal';
import { PlanBlockExercisesModal } from '../../members/PlanBlockExercisesModal';

/**
 * #67: Training Plan editor. Plan header (name/desc/dates/status) + workout
 * tree with drag-reorder, contextual duplicate/remove, and cross-parent move
 * dialogs at block and exercise level. Delegates full block/exercise CRUD to
 * the existing PlanWorkoutBlocksModal / PlanBlockExercisesModal — they take
 * memberId+planId, which we pull off the plan we fetched.
 */

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const STATUSES = ['draft', 'active', 'expired'] as const;

interface Exercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null; rest_seconds: number | null; tempo: string | null; notes: string | null;
}
interface Block {
  id: number; position: number; name: string | null; description: string | null;
  type: string; result_type: string; rounds: number | null; duration_seconds: number | null;
  work_seconds: number | null; rest_seconds: number | null; is_optional: boolean; notes: string | null;
  exercises: Exercise[] | null;
}
interface Workout {
  id: number; position: number; name: string; description: string | null; scheduled_weekday: number | null;
  blocks: Block[] | null;
}
interface Plan {
  id: number; name: string; description: string | null; status: 'draft' | 'active' | 'expired';
  start_date: string; end_date: string | null;
  member_id: number; member_name: string;
  template_id: number | null; template_name: string | null;
  created_by_name: string | null;
  workouts: Workout[] | null;
}

export default function TrainingPlanEditorPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const planId = params.id;
  const { apiFetch } = useApiClient();
  const { activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [workouts, setWorkouts] = useState<Workout[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = await apiFetch<Plan>(`/training-plans/${planId}`);
      setPlan(p);
      setWorkouts(p.workouts ?? []);
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
    finally { setLoading(false); }
  }, [planId]);
  useEffect(() => { load(); }, [load]);

  // Plan header form — local while typing, saved on blur.
  const [headerForm, setHeaderForm] = useState({ name: '', description: '', start_date: '', end_date: '', status: 'active' });
  useEffect(() => {
    if (plan) setHeaderForm({
      name: plan.name, description: plan.description ?? '',
      start_date: (plan.start_date ?? '').slice(0, 10),
      end_date: plan.end_date ? plan.end_date.slice(0, 10) : '',
      status: plan.status,
    });
  }, [plan?.id]);

  async function saveHeader(patch: Partial<typeof headerForm>) {
    if (!plan) return;
    try {
      const body: any = {};
      if ('name' in patch) body.name = patch.name?.trim() || plan.name;
      if ('description' in patch) body.description = patch.description?.trim() || null;
      if ('start_date' in patch) body.start_date = patch.start_date || null;
      if ('end_date' in patch) body.end_date = patch.end_date || null;
      if ('status' in patch) body.status = patch.status;
      await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}`, { method: 'PUT', body: JSON.stringify(body) });
      load();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }

  // Workout ops
  const workoutBase = plan ? `/members/${plan.member_id}/training-plans/${plan.id}/workouts` : '';
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  async function onWorkoutsDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldI = workouts.findIndex((w) => w.id === active.id);
    const newI = workouts.findIndex((w) => w.id === over.id);
    if (oldI < 0 || newI < 0) return;
    const reordered = arrayMove(workouts, oldI, newI);
    setWorkouts(reordered);
    try {
      await apiFetch(`${workoutBase}/reorder`, { method: 'PUT', body: JSON.stringify({ order: reordered.map((w) => w.id) }) });
      load();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); load(); }
  }

  const [addingWorkout, setAddingWorkout] = useState(false);
  async function addWorkout() {
    if (!plan) return;
    const name = window.prompt(t('training_plans.editor_add_workout'));
    if (!name?.trim()) return;
    setAddingWorkout(true);
    try {
      await apiFetch(workoutBase, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      load();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
    finally { setAddingWorkout(false); }
  }
  async function renameWorkout(w: Workout) {
    const name = window.prompt(t('training_plans.editor_rename'), w.name);
    if (!name?.trim() || name.trim() === w.name) return;
    try { await apiFetch(`${workoutBase}/${w.id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) }); load(); }
    catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }
  async function changeWeekday(w: Workout, value: string) {
    try {
      await apiFetch(`${workoutBase}/${w.id}`, {
        method: 'PUT',
        body: JSON.stringify({ scheduled_weekday: value === '' ? null : parseInt(value, 10) }),
      });
      load();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }
  async function duplicateWorkout(w: Workout) {
    try { await apiFetch(`${workoutBase}/${w.id}/duplicate`, { method: 'POST' }); load(); }
    catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }
  const [removingWorkout, setRemovingWorkout] = useState<Workout | null>(null);
  async function removeWorkout() {
    if (!removingWorkout) return;
    try { await apiFetch(`${workoutBase}/${removingWorkout.id}`, { method: 'DELETE' }); setRemovingWorkout(null); load(); }
    catch (err: any) { setRemovingWorkout(null); toast(err.message ?? t('training_plans.error_generic')); }
  }

  // Block ops (duplicate + move + remove; the full CRUD stays inside PlanWorkoutBlocksModal)
  const [blocksFor, setBlocksFor] = useState<Workout | null>(null);
  const [exercisesFor, setExercisesFor] = useState<{ workout: Workout; block: Block } | null>(null);
  const [movingBlock, setMovingBlock] = useState<{ workout: Workout; block: Block } | null>(null);
  const [movingExercise, setMovingExercise] = useState<{ workout: Workout; block: Block; exercise: Exercise } | null>(null);
  const [removingBlock, setRemovingBlock] = useState<{ workout: Workout; block: Block } | null>(null);
  const [removingExercise, setRemovingExercise] = useState<{ workout: Workout; block: Block; exercise: Exercise } | null>(null);

  async function duplicateBlock(w: Workout, b: Block) {
    if (!plan) return;
    try { await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${w.id}/blocks/${b.id}/duplicate`, { method: 'POST' }); load(); }
    catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }
  async function confirmRemoveBlock() {
    if (!plan || !removingBlock) return;
    try {
      await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${removingBlock.workout.id}/blocks/${removingBlock.block.id}`, { method: 'DELETE' });
      setRemovingBlock(null); load();
    } catch (err: any) { setRemovingBlock(null); toast(err.message ?? t('training_plans.error_generic')); }
  }
  async function duplicateExercise(w: Workout, b: Block, ex: Exercise) {
    if (!plan) return;
    try {
      await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${w.id}/blocks/${b.id}/exercises/${ex.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }
  async function confirmRemoveExercise() {
    if (!plan || !removingExercise) return;
    try {
      const r = removingExercise;
      await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${r.workout.id}/blocks/${r.block.id}/exercises/${r.exercise.id}`, { method: 'DELETE' });
      setRemovingExercise(null); load();
    } catch (err: any) { setRemovingExercise(null); toast(err.message ?? t('training_plans.error_generic')); }
  }

  if (gymLoading || !canWrite) return null;
  if (loading || !plan) return <p style={{ color: '#666' }}>{t('training_plans.loading')}</p>;

  const allBlocks = workouts.flatMap((w) => (w.blocks ?? []).map((b) => ({ w, b })));

  return (
    <div>
      <button onClick={() => router.push(`/${locale}/training-plans`)} style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: 14, padding: 0, marginBottom: 12 }}>
        {t('training_plans.editor_back')}
      </button>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>{plan.name}</h1>
        <StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />
      </div>
      <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>
        {plan.member_name} · {plan.template_name ?? t('training_plans.custom')}
        {plan.created_by_name && ` · ${plan.created_by_name}`}
      </p>

      {/* Plan header form */}
      <div style={{ background: '#fff', border: '1px solid #ececf0', borderRadius: 10, padding: 20, marginBottom: 24 }}>
        <h2 style={{ margin: '0 0 14px', fontSize: 16 }}>{t('training_plans.editor_plan_details')}</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <Field label={t('training_plans.label_name')}>
            <input value={headerForm.name} onChange={(e) => setHeaderForm({ ...headerForm, name: e.target.value })}
              onBlur={() => headerForm.name.trim() && headerForm.name !== plan.name && saveHeader({ name: headerForm.name })} style={inputStyle} />
          </Field>
          <Field label={t('training_plans.label_status')}>
            <select value={headerForm.status} onChange={(e) => { const v = e.target.value; setHeaderForm({ ...headerForm, status: v }); saveHeader({ status: v }); }} style={inputStyle}>
              {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
            </select>
          </Field>
          <Field label={t('training_plans.label_start_date')}>
            <input type="date" value={headerForm.start_date}
              onChange={(e) => setHeaderForm({ ...headerForm, start_date: e.target.value })}
              onBlur={() => headerForm.start_date && headerForm.start_date !== (plan.start_date ?? '').slice(0, 10) && saveHeader({ start_date: headerForm.start_date })} style={inputStyle} />
          </Field>
          <Field label={t('training_plans.label_end_date')}>
            <input type="date" value={headerForm.end_date}
              onChange={(e) => setHeaderForm({ ...headerForm, end_date: e.target.value })}
              onBlur={() => { const cur = plan.end_date ? plan.end_date.slice(0, 10) : ''; if (headerForm.end_date !== cur) saveHeader({ end_date: headerForm.end_date }); }} style={inputStyle} />
          </Field>
          <Field label={t('training_plans.label_description')}>
            <input value={headerForm.description} onChange={(e) => setHeaderForm({ ...headerForm, description: e.target.value })}
              onBlur={() => headerForm.description !== (plan.description ?? '') && saveHeader({ description: headerForm.description })} style={inputStyle} />
          </Field>
        </div>
      </div>

      {/* Workouts tree */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t('nav.workouts')}</h2>
        <button onClick={addWorkout} disabled={addingWorkout} style={btnStyle()}>{t('training_plans.editor_add_workout')}</button>
      </div>

      {workouts.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14 }}>{t('training_plans.editor_no_workouts')}</p>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onWorkoutsDragEnd}>
          <SortableContext items={workouts.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            {workouts.map((w) => (
              <WorkoutCard key={w.id} workout={w}
                onChangeWeekday={(v) => changeWeekday(w, v)}
                onRename={() => renameWorkout(w)}
                onDuplicate={() => duplicateWorkout(w)}
                onRemove={() => setRemovingWorkout(w)}
                onManageBlocks={() => setBlocksFor(w)}
                onDuplicateBlock={(b) => duplicateBlock(w, b)}
                onMoveBlock={(b) => setMovingBlock({ workout: w, block: b })}
                onRemoveBlock={(b) => setRemovingBlock({ workout: w, block: b })}
                onManageExercises={(b) => setExercisesFor({ workout: w, block: b })}
                onDuplicateExercise={(b, ex) => duplicateExercise(w, b, ex)}
                onMoveExercise={(b, ex) => setMovingExercise({ workout: w, block: b, exercise: ex })}
                onRemoveExercise={(b, ex) => setRemovingExercise({ workout: w, block: b, exercise: ex })}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}

      {blocksFor && (
        <PlanWorkoutBlocksModal
          memberId={plan.member_id} planId={plan.id} workoutId={blocksFor.id} workoutName={blocksFor.name}
          onClose={() => { setBlocksFor(null); load(); }}
        />
      )}
      {exercisesFor && (
        <PlanBlockExercisesModal
          memberId={plan.member_id} planId={plan.id} workoutId={exercisesFor.workout.id} blockId={exercisesFor.block.id}
          blockLabel={exercisesFor.block.name ?? exercisesFor.block.type}
          onClose={() => { setExercisesFor(null); load(); }}
        />
      )}

      {movingBlock && (
        <MoveDialog
          title={t('training_plans.editor_move_to_workout')}
          fieldLabel={t('training_plans.editor_move_target_workout')}
          options={workouts.filter((w) => w.id !== movingBlock.workout.id).map((w) => ({ id: w.id, label: w.name }))}
          onCancel={() => setMovingBlock(null)}
          onConfirm={async (targetId) => {
            try {
              await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${movingBlock.workout.id}/blocks/${movingBlock.block.id}/move`,
                { method: 'PUT', body: JSON.stringify({ target_workout_id: targetId }) });
              setMovingBlock(null); load();
            } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
          }}
        />
      )}
      {movingExercise && (
        <MoveDialog
          title={t('training_plans.editor_move_to_block')}
          fieldLabel={t('training_plans.editor_move_target_block')}
          options={allBlocks.filter(({ b }) => b.id !== movingExercise.block.id).map(({ w, b }) => ({
            id: b.id, label: `${w.name} — ${b.name ?? b.type}`,
          }))}
          onCancel={() => setMovingExercise(null)}
          onConfirm={async (targetId) => {
            try {
              await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${movingExercise.workout.id}/blocks/${movingExercise.block.id}/exercises/${movingExercise.exercise.id}/move`,
                { method: 'PUT', body: JSON.stringify({ target_block_id: targetId }) });
              setMovingExercise(null); load();
            } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
          }}
        />
      )}

      <ConfirmDialog open={removingWorkout !== null} message={t('training_plans.editor_confirm_remove_workout')}
        confirmLabel={t('training_plans.editor_remove')} cancelLabel={t('training_plans.cancel')}
        onConfirm={removeWorkout} onCancel={() => setRemovingWorkout(null)} />
      <ConfirmDialog open={removingBlock !== null} message={t('training_plans.editor_confirm_remove_block')}
        confirmLabel={t('training_plans.editor_remove')} cancelLabel={t('training_plans.cancel')}
        onConfirm={confirmRemoveBlock} onCancel={() => setRemovingBlock(null)} />
      <ConfirmDialog open={removingExercise !== null} message={t('training_plans.editor_confirm_remove_exercise')}
        confirmLabel={t('training_plans.editor_remove')} cancelLabel={t('training_plans.cancel')}
        onConfirm={confirmRemoveExercise} onCancel={() => setRemovingExercise(null)} />
    </div>
  );
}

function WorkoutCard(props: {
  workout: Workout;
  onChangeWeekday: (v: string) => void;
  onRename: () => void; onDuplicate: () => void; onRemove: () => void;
  onManageBlocks: () => void;
  onDuplicateBlock: (b: Block) => void; onMoveBlock: (b: Block) => void; onRemoveBlock: (b: Block) => void;
  onManageExercises: (b: Block) => void;
  onDuplicateExercise: (b: Block, ex: Exercise) => void; onMoveExercise: (b: Block, ex: Exercise) => void; onRemoveExercise: (b: Block, ex: Exercise) => void;
}) {
  const { workout: w } = props;
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1,
    background: '#fff', border: '1px solid #ececf0', borderRadius: 10, padding: 14, marginBottom: 12,
  };
  const blocks = w.blocks ?? [];
  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span {...attributes} {...listeners} aria-label={t('training_plan_templates.tree_drag_handle')}
          style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none' }}>⠿</span>
        <select value={w.scheduled_weekday != null ? String(w.scheduled_weekday) : ''}
          onChange={(e) => props.onChangeWeekday(e.target.value)}
          style={{ padding: '4px 8px', borderRadius: 999, background: '#eef0ff', color: '#4b45c6', border: 'none', fontSize: 12.5, fontWeight: 600 }}>
          <option value="">{t('training_plan_templates.tree_no_weekday')}</option>
          {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
        </select>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{w.name}</span>
        <span style={{ flex: 1 }} />
        <button onClick={props.onManageBlocks} style={{ ...btnStyle('#1e7e40'), padding: '4px 10px', fontSize: 13 }}>{t('training_plans.editor_manage_blocks')}</button>
        <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
          { label: t('training_plans.editor_rename'), onClick: props.onRename },
          { label: t('training_plans.editor_duplicate'), onClick: props.onDuplicate },
          { label: t('training_plans.editor_remove'), onClick: props.onRemove, danger: true },
        ]} />
      </div>
      <div style={{ marginTop: blocks.length ? 10 : 0, paddingLeft: 26 }}>
        {blocks.length === 0 ? (
          <p style={{ color: '#aaa', fontSize: 13, margin: '2px 0' }}>{t('training_plan_templates.tree_no_blocks')}</p>
        ) : (
          blocks.map((b) => (
            <div key={b.id} style={{ borderTop: '1px dashed #eee', paddingTop: 8, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>
                    {b.name || t(`workout_template_blocks.type_${b.type.toLowerCase()}`)}
                  </div>
                </div>
                <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
                  { label: t('training_plans.editor_manage_exercises'), onClick: () => props.onManageExercises(b) },
                  { label: t('training_plans.editor_duplicate'), onClick: () => props.onDuplicateBlock(b) },
                  { label: t('training_plans.editor_move_to_workout'), onClick: () => props.onMoveBlock(b) },
                  { label: t('training_plans.editor_remove'), onClick: () => props.onRemoveBlock(b), danger: true },
                ]} />
              </div>
              <div style={{ marginTop: 4, paddingLeft: 16 }}>
                {(b.exercises ?? []).length === 0 ? (
                  <p style={{ color: '#bbb', fontSize: 12.5, margin: '2px 0' }}>{t('training_plan_templates.tree_no_exercises')}</p>
                ) : (
                  (b.exercises ?? []).map((ex) => (
                    <div key={ex.id} style={{ padding: '2px 0', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13.5, flex: 1 }}>{ex.exercise_name}</span>
                      <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
                        { label: t('training_plans.editor_duplicate'), onClick: () => props.onDuplicateExercise(b, ex) },
                        { label: t('training_plans.editor_move_to_block'), onClick: () => props.onMoveExercise(b, ex) },
                        { label: t('training_plans.editor_remove'), onClick: () => props.onRemoveExercise(b, ex), danger: true },
                      ]} />
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MoveDialog({ title, fieldLabel, options, onConfirm, onCancel }: {
  title: string; fieldLabel: string;
  options: { id: number; label: string }[];
  onConfirm: (targetId: number) => Promise<void> | void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  const [target, setTarget] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div style={overlayStyle} onClick={onCancel}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: '0 0 16px' }}>{title}</h2>
        <Field label={fieldLabel}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={inputStyle} autoFocus>
            <option value="">—</option>
            {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button onClick={onCancel} style={btnStyle('#aaa')} disabled={saving}>{t('training_plans.cancel')}</button>
          <button onClick={async () => { if (!target) return; setSaving(true); await onConfirm(parseInt(target, 10)); setSaving(false); }}
            style={btnStyle()} disabled={saving || !target}>
            {saving ? t('training_plans.saving') : t('training_plans.editor_move')}
          </button>
        </div>
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

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};
