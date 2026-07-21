'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { btnStyle } from '@/components/ui';
import { NewTrainingPlanDialog } from './NewTrainingPlanDialog';
import { PlanWorkoutBlocksModal } from '../members/PlanWorkoutBlocksModal';
import { PlanBlockExercisesModal } from '../members/PlanBlockExercisesModal';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy,
  arrayMove, useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

/* ---- Types ---- */

interface Exercise {
  id: number; position: number; exercise_id: number; exercise_name: string;
  min_reps: number | null; max_reps: number | null; sets: number | null;
  rest_seconds: number | null; tempo: string | null; notes: string | null;
}
interface Block {
  id: number; position: number; name: string | null; type: string;
  rounds: number | null; exercises: Exercise[] | null;
}
interface Workout {
  id: number; position: number; name: string; description: string | null;
  scheduled_weekday: number | null; blocks: Block[] | null;
}
interface TrainingPlanRow {
  id: number;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'expired' | 'completed';
  start_date: string;
  end_date: string | null;
  member_id: number;
  member_name: string;
  template_id: number | null;
  template_name: string | null;
  assigned_by_membership_id: number | null;
  created_by_name: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by_name: string | null;
  workouts?: Workout[] | null;
}
interface ListResponse { items: TrainingPlanRow[]; total: number; limit: number; offset: number }
interface CreatedByOption { membership_id: number; name: string }
interface MemberOption { id: number; name: string }
interface TemplateOption { id: number; name: string }

type SortKey = 'name' | 'member' | 'template' | 'status' | 'start_date' | 'created_by' | 'created_at' | 'modified_at';

const STATUSES = ['draft', 'active', 'expired', 'completed'] as const;
const EDITABLE_STATUSES = ['draft', 'active', 'expired'] as const;
const LIMIT = 20;
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/* ---- Page ---- */

export default function TrainingPlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<TrainingPlanRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [memberFilter, setMemberFilter] = useState('');
  const [templateFilter, setTemplateFilter] = useState('');
  const [createdByFilter, setCreatedByFilter] = useState('');
  const [createdByOptions, setCreatedByOptions] = useState<CreatedByOption[]>([]);
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [templateOptions, setTemplateOptions] = useState<TemplateOption[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<TrainingPlanRow | null>(null);
  const [detailsPlan, setDetailsPlan] = useState<TrainingPlanRow | null>(null);
  const [completingPlan, setCompletingPlan] = useState<TrainingPlanRow | null>(null);
  const [completeEndDate, setCompleteEndDate] = useState('');
  const [completeSaving, setCompleteSaving] = useState(false);

  // Expand/hierarchy state
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, TrainingPlanRow>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  // Inline edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', status: 'active', start_date: '', end_date: '' });
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Workout modals
  const [blocksFor, setBlocksFor] = useState<{ plan: TrainingPlanRow; workout: Workout } | null>(null);
  const [exercisesFor, setExercisesFor] = useState<{ plan: TrainingPlanRow; workout: Workout; block: Block } | null>(null);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  useEffect(() => {
    if (editingId === null) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  useEffect(() => {
    const id = setTimeout(() => setNameQuery(nameInput.trim()), 300);
    return () => clearTimeout(id);
  }, [nameInput]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (nameQuery) params.set('name', nameQuery);
      if (memberFilter) params.set('member_id', memberFilter);
      if (templateFilter) params.set('template_id', templateFilter);
      if (createdByFilter) params.set('created_by', createdByFilter);
      params.set('sort', sortKey);
      params.set('dir', sortDir);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const res = await apiFetch<ListResponse>(`/training-plans?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, memberFilter, templateFilter, createdByFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);
  useEffect(() => { setOffset(0); }, [statusFilter, nameQuery, memberFilter, templateFilter, createdByFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/training-plans/created-by-options').then(setCreatedByOptions).catch(() => {});
    apiFetch<MemberOption[]>('/members').then(setMemberOptions).catch(() => {});
    apiFetch<{ items: TemplateOption[] }>('/training-plan-templates?limit=100')
      .then((r) => setTemplateOptions(r.items)).catch(() => {});
  }, [activeGymId, gymLoading]);

  function guardUnsaved(action: () => void) {
    if (editingId !== null) setPendingAction(() => action);
    else action();
  }

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const plan = await apiFetch<TrainingPlanRow>(`/training-plans/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: plan }));
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  const refetchHierarchy = useCallback(async (id: number) => {
    try {
      const plan = await apiFetch<TrainingPlanRow>(`/training-plans/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: plan }));
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    }
  }, [apiFetch]);

  function toggleExpand(row: TrainingPlanRow) {
    const isExpanded = expanded.has(row.id);
    if (isExpanded && editingId === row.id) {
      guardUnsaved(() => {
        cancelEdit();
        setExpanded((prev) => { const next = new Set(prev); next.delete(row.id); return next; });
      });
      return;
    }
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
    if (!isExpanded) loadHierarchy(row.id);
  }

  function startEdit(row: TrainingPlanRow) {
    setEditingId(row.id);
    setEditForm({
      name: row.name,
      description: row.description ?? '',
      status: row.status,
      start_date: (row.start_date ?? '').slice(0, 10),
      end_date: row.end_date ? row.end_date.slice(0, 10) : '',
    });
    setEditError(null);
    if (!expanded.has(row.id)) {
      setExpanded((prev) => { const next = new Set(prev); next.add(row.id); return next; });
      loadHierarchy(row.id);
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm({ name: '', description: '', status: 'active', start_date: '', end_date: '' });
    setEditError(null);
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('training_plans.error_required')); return; }
    setEditSaving(true); setEditError(null);
    const row = rows.find((r) => r.id === editingId)!;
    try {
      await apiFetch(`/members/${row.member_id}/training-plans/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          status: editForm.status,
          start_date: editForm.start_date || null,
          end_date: editForm.end_date || null,
        }),
      });
      setEditingId(null);
      load();
      refetchHierarchy(editingId!);
    } catch (err: any) {
      setEditError(err.message ?? t('training_plans.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDuplicate(row: TrainingPlanRow) {
    try {
      await apiFetch(`/members/${row.member_id}/training-plans/${row.id}/duplicate`, { method: 'POST' });
      toast(t('training_plan_templates.duplicated'));
      load();
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    }
  }

  async function handleComplete() {
    if (!completingPlan) return;
    setCompleteSaving(true);
    try {
      await apiFetch(`/members/${completingPlan.member_id}/training-plans/${completingPlan.id}/complete`, {
        method: 'POST',
        body: JSON.stringify({ end_date: completeEndDate || null }),
      });
      setCompletingPlan(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('training_plans.error_generic'));
    } finally {
      setCompleteSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/members/${deleting.member_id}/training-plans/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) {
      setDeleting(null); toast(err.message ?? t('training_plans.error_generic'));
    }
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'created_at' || key === 'modified_at' || key === 'start_date' ? 'desc' : 'asc'); }
  }

  if (gymLoading || !canWrite) return null;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortBtn = (key: SortKey, label: string) => (
    <button onClick={() => toggleSort(key)} style={sortBtnStyle(sortKey === key)}>
      {label}{sortArrow(key)}
    </button>
  );

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('training_plans.title')}</h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder={t('training_plans.filter_name')} style={filterInputStyle} />
          <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('training_plans.filter_member_all')}</option>
            {memberOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select value={templateFilter} onChange={(e) => setTemplateFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('training_plans.filter_template_all')}</option>
            <option value="custom">{t('training_plans.custom')}</option>
            {templateOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('training_plans.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter value={statusFilter} onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))} allLabel={t('status.all')} />
          <button onClick={() => guardUnsaved(() => setNewOpen(true))} style={btnStyle()}>{t('training_plans.new_plan')}</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 12, fontSize: 13, color: '#666' }}>
        {([
          ['name', t('training_plans.col_name')],
          ['status', t('training_plans.col_status')],
          ['start_date', t('training_plans.col_start_date')],
          ['created_at', t('training_plans.col_created_at')],
          ['modified_at', t('training_plans.col_modified_at')],
        ] as [SortKey, string][]).map(([key, label]) => <React.Fragment key={key}>{sortBtn(key, label)}</React.Fragment>)}
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('training_plans.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('training_plans.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((row) => (
            <PlanCard
              key={row.id}
              row={row}
              expanded={expanded.has(row.id)}
              editing={editingId === row.id}
              editForm={editForm}
              editError={editError}
              editSaving={editSaving}
              hierarchy={hierarchies[row.id] ?? null}
              hierLoading={hierLoading.has(row.id)}
              canWrite={!!canWrite}
              locale={locale}
              t={t}
              onToggleExpand={() => guardUnsaved(() => toggleExpand(row))}
              onEdit={() => guardUnsaved(() => startEdit(row))}
              onDetails={() => guardUnsaved(() => setDetailsPlan(row))}
              onDuplicate={() => guardUnsaved(() => handleDuplicate(row))}
              onComplete={() => guardUnsaved(() => { setCompletingPlan(row); setCompleteEndDate(new Date().toISOString().slice(0, 10)); })}
              onDelete={() => guardUnsaved(() => setDeleting(row))}
              onEditFormChange={setEditForm}
              onSave={saveEdit}
              onCancel={cancelEdit}
              onManageBlocks={(workout) => setBlocksFor({ plan: row, workout })}
              onManageExercises={(workout, block) => setExercisesFor({ plan: row, workout, block })}
              apiFetch={apiFetch}
              toast={toast}
              onChanged={() => refetchHierarchy(row.id)}
            />
          ))}
        </div>
      )}

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <span style={{ color: '#666', fontSize: 14 }}>{pageStart}–{pageEnd} / {total}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={pagerStyle(offset === 0)}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={pagerStyle(pageEnd >= total)}>›</button>
        </div>
      )}

      <NewTrainingPlanDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={() => { setNewOpen(false); load(); }}
      />

      <ConfirmDialog open={deleting !== null} message={t('training_plans.confirm_delete')}
        confirmLabel={t('training_plans.delete')} cancelLabel={t('training_plans.cancel')}
        onConfirm={handleDelete} onCancel={() => setDeleting(null)} />

      <ConfirmDialog
        open={pendingAction !== null}
        message={t('training_plans.unsaved_changes')}
        confirmLabel={t('training_plans.unsaved_discard')}
        cancelLabel={t('training_plans.cancel')}
        onConfirm={() => { const a = pendingAction!; setPendingAction(null); cancelEdit(); a(); }}
        onCancel={() => setPendingAction(null)}
      />

      {/* Complete dialog */}
      {completingPlan && (
        <CrudModal
          open
          title={t('training_plans.complete_dialog_title')}
          error={null}
          saving={completeSaving}
          cancelLabel={t('training_plans.cancel')}
          saveLabel={completeSaving ? t('training_plans.saving') : t('training_plans.complete_confirm_btn')}
          onCancel={() => setCompletingPlan(null)}
          onSave={handleComplete}
        >
          <p style={{ margin: '0 0 16px', fontSize: 14, lineHeight: 1.5, color: '#555' }}>
            {t('training_plans.confirm_complete')}
          </p>
          <FormLabel>{t('training_plans.complete_end_date_label')}</FormLabel>
          <input
            type="date"
            value={completeEndDate}
            onChange={(e) => setCompleteEndDate(e.target.value)}
            style={modalInputStyle}
          />
        </CrudModal>
      )}

      {/* Details dialog */}
      {detailsPlan && (
        <DetailsDialog plan={detailsPlan} locale={locale} t={t} onClose={() => setDetailsPlan(null)} />
      )}

      {/* Block/exercise modals */}
      {blocksFor && (
        <PlanWorkoutBlocksModal
          memberId={blocksFor.plan.member_id} planId={blocksFor.plan.id}
          workoutId={blocksFor.workout.id} workoutName={blocksFor.workout.name}
          onClose={() => { setBlocksFor(null); refetchHierarchy(blocksFor.plan.id); }}
        />
      )}
      {exercisesFor && (
        <PlanBlockExercisesModal
          memberId={exercisesFor.plan.member_id} planId={exercisesFor.plan.id}
          workoutId={exercisesFor.workout.id} blockId={exercisesFor.block.id}
          blockLabel={exercisesFor.block.name ?? exercisesFor.block.type}
          onClose={() => { setExercisesFor(null); refetchHierarchy(exercisesFor.plan.id); }}
        />
      )}
    </div>
  );
}

/* ---- PlanCard ---- */

type EditForm = { name: string; description: string; status: string; start_date: string; end_date: string };

function PlanCard({
  row, expanded, editing, editForm, editError, editSaving,
  hierarchy, hierLoading, canWrite, locale, t,
  onToggleExpand, onEdit, onDetails, onDuplicate, onComplete, onDelete,
  onEditFormChange, onSave, onCancel,
  onManageBlocks, onManageExercises,
  apiFetch, toast, onChanged,
}: {
  row: TrainingPlanRow;
  expanded: boolean;
  editing: boolean;
  editForm: EditForm;
  editError: string | null;
  editSaving: boolean;
  hierarchy: TrainingPlanRow | null;
  hierLoading: boolean;
  canWrite: boolean;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDetails: () => void;
  onDuplicate: () => void;
  onComplete: () => void;
  onDelete: () => void;
  onEditFormChange: (f: EditForm) => void;
  onSave: () => void;
  onCancel: () => void;
  onManageBlocks: (w: Workout) => void;
  onManageExercises: (w: Workout, b: Block) => void;
  apiFetch: ReturnType<typeof useApiClient>['apiFetch'];
  toast: (msg: string) => void;
  onChanged: () => void;
}) {
  const isCompleted = row.status === 'completed';

  const menuItems = [
    ...(canWrite && !isCompleted ? [{ label: t('training_plan_templates.edit'), onClick: onEdit }] : []),
    { label: t('training_plans.details'), onClick: onDetails },
    ...(canWrite ? [{ label: t('training_plans.duplicate'), onClick: onDuplicate }] : []),
    ...(canWrite && row.status === 'active' ? [{ label: t('training_plans.complete'), onClick: onComplete }] : []),
    ...(canWrite ? [{ label: t('training_plans.delete'), onClick: onDelete, danger: true }] : []),
  ];

  return (
    <div style={cardStyle(editing)}>
      {/* Editing mode header */}
      {editing ? (
        <div style={{ padding: '16px 16px 0' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={inlineLabelStyle}>{t('training_plans.label_name')} *</label>
              <input value={editForm.name} onChange={(e) => onEditFormChange({ ...editForm, name: e.target.value })}
                autoFocus style={inlineInputStyle} />
              {editError && <p style={{ color: '#c00', fontSize: 13, margin: '4px 0 0' }}>{editError}</p>}
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={inlineLabelStyle}>{t('training_plans.label_description')}</label>
              <textarea value={editForm.description} onChange={(e) => onEditFormChange({ ...editForm, description: e.target.value })}
                rows={2} style={{ ...inlineInputStyle, resize: 'vertical' }} />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('training_plans.label_status')}</label>
              <select value={editForm.status} onChange={(e) => onEditFormChange({ ...editForm, status: e.target.value })}
                style={{ ...inlineInputStyle, width: 'auto' }}>
                {EDITABLE_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
              </select>
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('training_plans.label_start_date')}</label>
              <input type="date" value={editForm.start_date} onChange={(e) => onEditFormChange({ ...editForm, start_date: e.target.value })}
                style={inlineInputStyle} />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('training_plans.label_end_date')}</label>
              <input type="date" value={editForm.end_date} onChange={(e) => onEditFormChange({ ...editForm, end_date: e.target.value })}
                style={inlineInputStyle} />
            </div>
          </div>
        </div>
      ) : (
        /* Normal header row */
        <div onClick={onToggleExpand} style={headerRowStyle} role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onToggleExpand(); }}>
          <span style={{ fontSize: 12, color: '#aaa', userSelect: 'none', flexShrink: 0 }}>{expanded ? '▼' : '▶'}</span>
          <span style={nameCellStyle}>{row.name}</span>
          <span style={memberCellStyle}>{row.member_name}</span>
          <span style={descCellStyle}>{row.description ?? '—'}</span>
          <StatusBadge status={row.status} label={t(`status.${row.status}`)} />
          <span style={dateCellStyle}>{formatDate(row.start_date, locale)}</span>
          <span style={dateCellStyle}>{row.end_date ? formatDate(row.end_date, locale) : '—'}</span>
          <span onClick={(e) => e.stopPropagation()}>
            <ContextMenu ariaLabel={t('training_plans.col_actions')} items={menuItems} />
          </span>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <>
          <div style={{ borderTop: '1px solid #ececf0' }} />
          {isCompleted && (
            <div style={{ padding: '8px 20px', background: '#f9f9f9', fontSize: 13, color: '#888' }}>
              {t('training_plans.completed_read_only')}
            </div>
          )}
          {hierLoading || !hierarchy ? (
            <p style={{ color: '#888', fontSize: 14, padding: '12px 20px', margin: 0 }}>
              {t('training_plans.loading')}
            </p>
          ) : (
            <PlanWorkoutTree
              plan={hierarchy}
              canWrite={canWrite && !isCompleted}
              apiFetch={apiFetch}
              toast={toast}
              onChanged={onChanged}
              onManageBlocks={onManageBlocks}
              onManageExercises={onManageExercises}
            />
          )}
        </>
      )}

      {/* Save/cancel footer (edit mode only) */}
      {editing && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px 14px', borderTop: '1px solid #ececf0', marginTop: 12 }}>
          <button onClick={onCancel} style={cancelBtnStyle}>{t('training_plans.cancel')}</button>
          <button onClick={onSave} disabled={editSaving} style={btnStyle()}>
            {editSaving ? t('training_plans.saving') : t('training_plans.save_changes')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ---- PlanWorkoutTree ---- */

function PlanWorkoutTree({
  plan, canWrite, apiFetch, toast, onChanged, onManageBlocks, onManageExercises,
}: {
  plan: TrainingPlanRow;
  canWrite: boolean;
  apiFetch: ReturnType<typeof useApiClient>['apiFetch'];
  toast: (msg: string) => void;
  onChanged: () => void;
  onManageBlocks: (w: Workout) => void;
  onManageExercises: (w: Workout, b: Block) => void;
}) {
  const t = useTranslations();
  const base = `/members/${plan.member_id}/training-plans/${plan.id}/workouts`;

  const [workouts, setWorkouts] = useState<Workout[]>(plan.workouts ?? []);
  useEffect(() => { setWorkouts(plan.workouts ?? []); }, [plan]);

  const [addingWorkout, setAddingWorkout] = useState(false);
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
    const name = window.prompt(t('training_plans.editor_add_workout'));
    if (!name?.trim()) return;
    setAddingWorkout(true);
    try {
      await apiFetch(base, { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
      onChanged();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
    finally { setAddingWorkout(false); }
  }

  async function renameWorkout(w: Workout) {
    const name = window.prompt(t('training_plans.editor_rename'), w.name);
    if (!name?.trim() || name.trim() === w.name) return;
    try {
      await apiFetch(`${base}/${w.id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim() }) });
      onChanged();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
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

  async function duplicateBlock(w: Workout, b: Block) {
    try {
      await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${w.id}/blocks/${b.id}/duplicate`, { method: 'POST' });
      onChanged();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }

  async function removeBlock(w: Workout, b: Block) {
    try {
      await apiFetch(`/members/${plan.member_id}/training-plans/${plan.id}/workouts/${w.id}/blocks/${b.id}`, { method: 'DELETE' });
      onChanged();
    } catch (err: any) { toast(err.message ?? t('training_plans.error_generic')); }
  }

  return (
    <div style={{ padding: '12px 20px 18px 44px' }}>
      {canWrite && (
        <button onClick={addWorkout} disabled={addingWorkout} style={{ ...btnStyle(), marginBottom: 14 }}>
          {t('training_plans.editor_add_workout')}
        </button>
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
                canWrite={canWrite}
                onChangeWeekday={(v) => changeWeekday(w, v)}
                onRename={() => renameWorkout(w)}
                onDuplicate={() => duplicateWorkout(w)}
                onRemove={() => setRemovingWorkout(w)}
                onManageBlocks={() => onManageBlocks(w)}
                onDuplicateBlock={(b) => duplicateBlock(w, b)}
                onRemoveBlock={(b) => removeBlock(w, b)}
                onManageExercises={(b) => onManageExercises(w, b)}
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
  workout: w, canWrite,
  onChangeWeekday, onRename, onDuplicate, onRemove,
  onManageBlocks, onDuplicateBlock, onRemoveBlock, onManageExercises,
}: {
  workout: Workout;
  canWrite: boolean;
  onChangeWeekday: (v: string) => void;
  onRename: () => void; onDuplicate: () => void; onRemove: () => void;
  onManageBlocks: () => void;
  onDuplicateBlock: (b: Block) => void;
  onRemoveBlock: (b: Block) => void;
  onManageExercises: (b: Block) => void;
}) {
  const t = useTranslations();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: w.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1,
    background: '#fff', border: '1px solid #ececf0', borderRadius: 8, padding: '10px 14px', marginBottom: 10,
  };
  const blocks = w.blocks ?? [];

  return (
    <div ref={setNodeRef} style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {canWrite && (
          <span {...attributes} {...listeners} style={{ cursor: 'grab', color: '#bbb', fontSize: 16, userSelect: 'none' }}>⠿</span>
        )}
        <select
          value={w.scheduled_weekday != null ? String(w.scheduled_weekday) : ''}
          onChange={(e) => canWrite && onChangeWeekday(e.target.value)}
          disabled={!canWrite}
          style={{ padding: '4px 8px', borderRadius: 999, background: '#eef0ff', color: '#4b45c6', border: 'none', fontSize: 12.5, fontWeight: 600 }}
        >
          <option value="">{t('training_plan_templates.tree_no_weekday')}</option>
          {WEEKDAYS.map((d) => <option key={d} value={d}>{t(`workouts.weekday_${d}`)}</option>)}
        </select>
        <span style={{ fontWeight: 600, fontSize: 15 }}>{w.name}</span>
        <span style={{ flex: 1 }} />
        {canWrite && (
          <button onClick={onManageBlocks} style={{ ...btnStyle('#1e7e40'), padding: '4px 10px', fontSize: 13 }}>
            {t('training_plans.editor_manage_blocks')}
          </button>
        )}
        {canWrite && (
          <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
            { label: t('training_plans.editor_rename'), onClick: onRename },
            { label: t('training_plans.editor_duplicate'), onClick: onDuplicate },
            { label: t('training_plans.editor_remove'), onClick: onRemove, danger: true },
          ]} />
        )}
      </div>

      <div style={{ marginTop: blocks.length ? 10 : 0, paddingLeft: canWrite ? 26 : 0 }}>
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
                {canWrite && (
                  <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
                    { label: t('training_plans.editor_manage_exercises'), onClick: () => onManageExercises(b) },
                    { label: t('training_plans.editor_duplicate'), onClick: () => onDuplicateBlock(b) },
                    { label: t('training_plans.editor_remove'), onClick: () => onRemoveBlock(b), danger: true },
                  ]} />
                )}
              </div>
              <div style={{ marginTop: 4, paddingLeft: 16 }}>
                {(b.exercises ?? []).length === 0 ? (
                  <p style={{ color: '#bbb', fontSize: 12.5, margin: '2px 0' }}>{t('training_plan_templates.tree_no_exercises')}</p>
                ) : (
                  (b.exercises ?? []).map((ex) => (
                    <div key={ex.id} style={{ padding: '2px 0', fontSize: 13.5 }}>{ex.exercise_name}</div>
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

/* ---- DetailsDialog ---- */

function DetailsDialog({ plan, locale, t, onClose }: {
  plan: TrainingPlanRow;
  locale: string;
  t: ReturnType<typeof useTranslations>;
  onClose: () => void;
}) {
  return (
    <CrudModal
      open
      title={t('training_plans.details_dialog_title')}
      error={null}
      saving={false}
      cancelLabel={t('training_plans.cancel')}
      saveLabel=""
      onCancel={onClose}
      onSave={onClose}
      hideSave
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('training_plans.label_name')} value={plan.name} />
        <DetailRow label={t('training_plans.label_description')} value={plan.description ?? '—'} />
        <DetailRow label={t('training_plans.label_member')} value={plan.member_name} />
        <DetailRow label={t('training_plans.label_source')} value={plan.template_name ?? t('training_plans.custom')} />
        <DetailRow label={t('training_plans.col_status')} value={<StatusBadge status={plan.status} label={t(`status.${plan.status}`)} />} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('training_plans.label_start_date')} value={formatDate(plan.start_date, locale)} />
        {plan.end_date && <DetailRow label={t('training_plans.label_end_date')} value={formatDate(plan.end_date, locale)} />}
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('training_plans.label_created_by')} value={plan.created_by_name ?? '—'} />
        <DetailRow label={t('training_plans.label_created_at')} value={formatDate(plan.created_at, locale)} />
        {plan.modified_at && (
          <>
            <DetailRow label={t('training_plans.label_modified_by')} value={plan.modified_by_name ?? '—'} />
            <DetailRow label={t('training_plans.label_modified_at')} value={formatDate(plan.modified_at, locale)} />
          </>
        )}
      </div>
    </CrudModal>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ color: '#888', fontSize: 13.5, width: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5 }}>{value}</span>
    </div>
  );
}

/* ---- Helpers & Styles ---- */

function formatDate(value: string, locale: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

const filterInputStyle: React.CSSProperties = { padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff' };
const modalInputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' };
const sortBtnStyle = (active: boolean): React.CSSProperties => ({
  background: 'none', border: 'none', padding: '2px 8px', cursor: 'pointer',
  fontSize: 13, color: active ? '#4b45c6' : '#666', fontWeight: active ? 600 : 400, borderRadius: 4,
});
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
  background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '4px 12px',
  cursor: disabled ? 'default' : 'pointer', color: disabled ? '#bbb' : '#333', fontSize: 16,
});
const cardStyle = (editing: boolean): React.CSSProperties => ({
  border: editing ? '1.5px solid #4b45c6' : '1px solid #ececf0',
  borderRadius: 10, background: '#fff', overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
  cursor: 'pointer', userSelect: 'none',
};
const nameCellStyle: React.CSSProperties = {
  fontWeight: 600, fontSize: 15, flexShrink: 0, maxWidth: 200,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const memberCellStyle: React.CSSProperties = {
  fontSize: 13.5, color: '#555', flexShrink: 0, maxWidth: 150,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const descCellStyle: React.CSSProperties = {
  color: '#888', fontSize: 13.5, flex: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const dateCellStyle: React.CSSProperties = {
  fontSize: 13, color: '#666', whiteSpace: 'nowrap', flexShrink: 0,
};
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
