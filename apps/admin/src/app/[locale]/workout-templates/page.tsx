'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useApiClient } from '@/lib/apiClient';
import { formatGymDate, formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { type ContextMenuItem } from '@/components/ContextMenu';
import { cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS,
  listScrollerClass,
} from '@/components/listChrome';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { CardSection } from '@/components/CardSection';
import { cardSectionTitleStyle } from '@/components/CardSectionHeader';
import { CardDetailRow } from '@/components/CardDetailRow';
import { WorkoutTemplateTree, WtHierarchy, TemplateDropTarget } from './WorkoutTemplateTree';
import { ImportWorkoutTemplatesModal, type ImportTemplatesResult } from './ImportWorkoutTemplatesModal';
import { cascadeResultParts } from './cascadeImportPreview';
import { WorkoutTemplateCard } from './WorkoutTemplateCard';
import { canResyncWithSystem, templateSource, toNumBlocks } from './workoutTemplateList';
import {
  CELL_CLASS, LIST_COLUMNS, LIST_COLUMN_GAP, LIST_GRID_COLUMNS, LIST_MIN_WIDTH, ROW_PADDING_X,
  WorkoutTemplateRowCells,
} from './WorkoutTemplateRowCells';
import {
  cardMutedTextStyle, formControlStyle, formErrorStyle, formFieldLabelStyle,
  inlineActionsRowStyle, secondaryBtnSmall,
} from '@/components/formChrome';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkoutTemplate {
  id: number;
  name: string;
  description: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  blocks_count: number;
  /** #3335: the live block count, derived on read by the API. */
  num_blocks?: number;
  /** #3335: derived by the API — 'system' for a copy of a System template, else 'custom'. */
  source?: 'system' | 'custom';
  cloned_from_id?: number | null;
  gym_id: string | null;
  created_by: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

interface ListResponse {
  items: WorkoutTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { name: string }

const STATUSES = ['active', 'inactive'] as const;

type InlineNew = {
  name: string;
  description: string;
  saving: boolean;
  error: string | null;
};

type EditForm = {
  name: string;
  description: string;
  status: WorkoutTemplate['status'];
  notes: string;
};

const emptyEditForm: EditForm = { name: '', description: '', status: 'active', notes: '' };

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkoutTemplatesPage() {
  const t = useTranslations('workout_templates');
  const gymFmt = useGymFormatSettings();
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  // #613: impersonation-aware; read-only roles see controls disabled.
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('TRAINING');

  const [rows, setRows] = useState<WorkoutTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [createdByFilter, setCreatedByFilter] = useState('');
  const [createdByOptions, setCreatedByOptions] = useState<CreatedByOption[]>([]);

  // Expandable rows + lazy-loaded hierarchy cache
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, WtHierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

  // Edit mode (General section inline edit)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Inline new row
  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  // Details modal
  const [details, setDetails] = useState<WorkoutTemplate | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<WorkoutTemplate | null>(null);

  // #3335 stage 2: Cards by default, the saved choice afterwards (the Exercises toggle).
  const [viewMode, setViewMode] = useExerciseViewMode();
  const [importOpen, setImportOpen] = useState(false);

  useEffect(() => { if (!gymLoading && !canRead) router.replace(`/${locale}`); }, [gymLoading, canRead]);

  // Debounce name search
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
      if (createdByFilter) params.set('created_by', createdByFilter);
      params.set('sort', 'name');
      params.set('dir', 'asc');
      params.set('limit', '200');
      params.set('offset', '0');
      const res = await apiFetch<ListResponse>(`/workout-templates?${params.toString()}`);
      setRows(res.items);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, createdByFilter]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/workout-templates/created-by-options')
      .then(setCreatedByOptions)
      .catch(() => {});
  }, [activeGymId, gymLoading]);

  // ─── Expand / hierarchy ───────────────────────────────────────────────────

  async function loadHierarchy(id: number) {
    if (hierarchies[id] || hierLoading.has(id)) return;
    setHierLoading((prev) => new Set(prev).add(id));
    try {
      const h = await apiFetch<WtHierarchy>(`/workout-templates/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setHierLoading((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    loadHierarchy(id);
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<WtHierarchy>(`/workout-templates/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }, [apiFetch]);

  // ─── Inline new ──────────────────────────────────────────────────────────

  function openInlineNew() {
    // The inline form and the block tree live in the List view.
    if (viewMode !== 'list') setViewMode('list');
    setInlineNew({ name: '', description: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() { setInlineNew(null); }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) {
      setInlineNew({ ...inlineNew, error: t('error_required') });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<WorkoutTemplate>('/workout-templates', {
        method: 'POST',
        body: JSON.stringify({ name: inlineNew.name.trim(), description: inlineNew.description.trim() || null }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit (General section) ───────────────────────────────────────────────

  /**
   * #3485: Edit mode opens a server-side checkpoint of the template's blocks
   * and exercises (#3482's device) — the tree persists each change at once, so
   * Cancel restores the checkpoint and Save drops it. Only one template is in
   * Edit mode at a time, and nothing is editable outside it.
   */
  async function openEdit(wt: WorkoutTemplate) {
    if (editingId === wt.id) return; // re-checkpointing would lose what Cancel restores
    if (editingId !== null) await cancelEdit();
    try {
      await apiFetch(`/workout-templates/${wt.id}/edit-session`, { method: 'POST' });
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
      return;
    }
    if (viewMode !== 'list') setViewMode('list');
    setEditingId(wt.id);
    setEditForm({
      name: wt.name,
      description: wt.description ?? '',
      status: wt.status,
      notes: wt.notes ?? '',
    });
    setEditError(null);
    setExpanded((prev) => new Set([...prev, wt.id]));
    loadHierarchy(wt.id);
  }

  async function cancelEdit() {
    const id = editingId;
    setEditingId(null); setEditError(null);
    if (id === null) return;
    try {
      await apiFetch(`/workout-templates/${id}/edit-session/cancel`, { method: 'POST' });
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
    await refetchBranch(id);
    load();
  }

  async function handleSave(wt: WorkoutTemplate) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/workout-templates/${wt.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          status: editForm.status,
          notes: editForm.notes.trim() || null,
        }),
      });
      await apiFetch(`/workout-templates/${wt.id}/edit-session`, { method: 'DELETE' });
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Resync with System (#3335, the Exercises' #2302) ─────────────────────

  async function handleResync(wt: WorkoutTemplate) {
    try {
      const res = await apiFetch<{ updated: string[] }>(`/workout-templates/${wt.id}/resync-with-system`, { method: 'POST' });
      toast(res.updated.length > 0 ? t('resync_done') : t('resync_up_to_date'), res.updated.length > 0 ? 'success' : 'info');
      load();
    } catch (err: any) {
      const code = err?.body?.code;
      toast(code === 'base_unavailable' ? t('resync_base_gone')
        : code === 'name_taken' ? t('resync_name_taken')
        : (err.message ?? t('error_generic')));
    }
  }

  function handleImported(result: ImportTemplatesResult) {
    setImportOpen(false);
    toast(cascadeResultParts(result).map(([key, n]) => t(key, { n })).join(' '), 'success');
    load();
  }

  /** The `⋮` actions of one template — shared by the list row and the card. */
  function templateMenuItems(wt: WorkoutTemplate): ContextMenuItem[] {
    const roTitle = canWrite ? undefined : readOnlyTitle;
    return [
      { kind: 'details' as const, label: t('details'), onClick: () => setDetails(wt) },
      { kind: 'edit' as const, label: t('edit'), onClick: () => openEdit(wt), disabled: !canWrite, title: roTitle },
      { label: t('duplicate'), onClick: () => handleDuplicate(wt), disabled: !canWrite, title: roTitle },
      ...(canResyncWithSystem(wt)
        ? [{ label: t('resync_with_system'), onClick: () => handleResync(wt), disabled: !canWrite, title: roTitle }]
        : []),
      { kind: 'delete' as const, label: t('delete'), onClick: () => setDeleting(wt), danger: true, disabled: !canWrite, title: roTitle },
    ];
  }

  // ─── Duplicate ────────────────────────────────────────────────────────────

  async function handleDuplicate(wt: WorkoutTemplate) {
    try {
      const created = await apiFetch<WorkoutTemplate>(`/workout-templates/${wt.id}/duplicate`, { method: 'POST' });
      toast(t('duplicated'), 'success');
      await load();
      openEdit(created);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ───────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/workout-templates/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) setEditingId(null);
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── DnD (cross-template block moves) ─────────────────────────────────────

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function moveBlock(sourceId: number, blockId: number, targetId: number, position: number | null) {
    // #3485: a block leaving the template in Edit mode would escape its checkpoint.
    if (editingId !== null) return;
    const src = hierarchies[sourceId];
    const block = src?.blocks?.find((b) => b.id === blockId);
    if (src?.blocks && block) {
      setHierarchies((prev) => {
        const next = { ...prev, [sourceId]: { ...src, blocks: src.blocks!.filter((b) => b.id !== blockId) } };
        const tgt = prev[targetId];
        if (tgt?.blocks !== undefined) {
          const list = [...(tgt.blocks ?? [])];
          const at = position === null ? list.length : Math.min(position - 1, list.length);
          list.splice(at, 0, block);
          next[targetId] = { ...tgt, blocks: list };
        }
        return next;
      });
    }
    try {
      await apiFetch(`/workout-templates/${sourceId}/blocks/${blockId}/move`, {
        method: 'PUT',
        body: JSON.stringify({ target_workout_template_id: targetId, position }),
      });
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
    refetchBranch(sourceId);
    if (hierarchies[targetId]) refetchBranch(targetId);
  }

  async function onDragEnd(e: DragEndEvent) {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || activeId === overId) return;

    if (activeId.startsWith('ex:')) {
      const [, tplStr, blockStr, exStr] = activeId.split(':');
      if (!overId.startsWith(`ex:${tplStr}:${blockStr}:`)) return;
      const templateId = Number(tplStr);
      const blockId = Number(blockStr);
      const exId = Number(exStr);
      const overExId = Number(overId.split(':')[3]);
      const h = hierarchies[templateId];
      const block = h?.blocks?.find((b) => b.id === blockId);
      if (!block?.exercises) return;
      const oldIndex = block.exercises.findIndex((x) => x.id === exId);
      const newIndex = block.exercises.findIndex((x) => x.id === overExId);
      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
      const reordered = arrayMove(block.exercises, oldIndex, newIndex);
      setHierarchies((prev) => ({
        ...prev,
        [templateId]: { ...h!, blocks: h!.blocks!.map((b) => (b.id === blockId ? { ...b, exercises: reordered } : b)) },
      }));
      try {
        await apiFetch(`/workout-templates/${templateId}/blocks/${blockId}/exercises/reorder`, {
          method: 'PUT', body: JSON.stringify({ order: reordered.map((x) => x.id) }),
        });
      } catch (err: any) {
        toast(err.message ?? t('error_generic'));
        refetchBranch(templateId);
      }
      return;
    }

    if (activeId.startsWith('block:')) {
      const [, srcStr, blockStr] = activeId.split(':');
      const sourceId = Number(srcStr);
      const blockId = Number(blockStr);
      const src = hierarchies[sourceId];
      if (!src?.blocks) return;

      if (overId.startsWith('block:')) {
        const [, overTplStr, overBlockStr] = overId.split(':');
        const overTplId = Number(overTplStr);
        const overBlockId = Number(overBlockStr);
        if (overTplId === sourceId) {
          const oldIndex = src.blocks.findIndex((b) => b.id === blockId);
          const newIndex = src.blocks.findIndex((b) => b.id === overBlockId);
          if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;
          const reordered = arrayMove(src.blocks, oldIndex, newIndex);
          setHierarchies((prev) => ({ ...prev, [sourceId]: { ...src, blocks: reordered } }));
          try {
            await apiFetch(`/workout-templates/${sourceId}/blocks/reorder`, {
              method: 'PUT', body: JSON.stringify({ order: reordered.map((b) => b.id) }),
            });
          } catch (err: any) {
            toast(err.message ?? t('error_generic'));
            refetchBranch(sourceId);
          }
        } else {
          const tgt = hierarchies[overTplId];
          const idx = tgt?.blocks ? tgt.blocks.findIndex((b) => b.id === overBlockId) : -1;
          await moveBlock(sourceId, blockId, overTplId, idx >= 0 ? idx + 1 : null);
        }
        return;
      }

      if (overId.startsWith('tmpl:')) {
        const targetId = Number(overId.split(':')[1]);
        if (targetId !== sourceId) await moveBlock(sourceId, blockId, targetId, null);
      }
    }
  }

  // ─── Render ───────────────────────────────────────────────────────────────

  function fmtDate(iso: string) {
    return formatGymDate(iso, gymFmt);
  }

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={formFieldLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveInlineNew(); if (e.key === 'Escape') cancelInlineNew(); }}
                style={formControlStyle}
              />
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveInlineNew(); if (e.key === 'Escape') cancelInlineNew(); }}
                style={formControlStyle}
              />
            </div>
          </div>
          {inlineNew.error && <p style={formErrorStyle}>{inlineNew.error}</p>}
          <div style={inlineActionsRowStyle}>
            <button onClick={cancelInlineNew} style={secondaryBtnSmall}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={primaryBtnSmall()}>
              {inlineNew.saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRow(wt: WorkoutTemplate) {
    const isExpanded = expanded.has(wt.id);
    const isEditing = editingId === wt.id;
    const h = hierarchies[wt.id];

    return (
      <div key={wt.id} style={cardStyle}>
        {/* Collapsed header */}
        <div
          className={LIST_GRID_ROW_CLASS}
          style={rowStyle}
          onClick={() => toggleExpand(wt.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(wt.id); }}
        >
          <WorkoutTemplateRowCells
            template={wt}
            expanded={isExpanded}
            menuItems={templateMenuItems(wt)}
            fmtDate={fmtDate}
            nameSlot={(name) => <TemplateDropTarget templateId={wt.id}>{name}</TemplateDropTarget>}
          />
        </div>

        {/* Inline edit form */}
        {isEditing && (
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
            <CardSection label={t('section_general')} first>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={formFieldLabelStyle}>{t('label_name')} *</label>
                  <input
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    autoFocus
                    style={formControlStyle}
                  />
                </div>
                <div>
                  <label style={formFieldLabelStyle}>{t('label_status')}</label>
                  <select
                    value={editForm.status}
                    onChange={(e) => setEditForm({ ...editForm, status: e.target.value as WorkoutTemplate['status'] })}
                    style={formControlStyle}
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                  </select>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={formFieldLabelStyle}>{t('label_notes_for_member')}</label>
                  <textarea
                    value={editForm.notes}
                    onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    rows={3}
                    placeholder={t('notes_placeholder')}
                    style={{ ...formControlStyle, resize: 'vertical' }}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={formFieldLabelStyle}>{t('label_description')}</label>
                  <textarea
                    value={editForm.description}
                    onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    rows={2}
                    style={{ ...formControlStyle, resize: 'vertical' }}
                  />
                </div>
              </div>
            </CardSection>

            <CardSection label={t('section_workout_structure')}>
              {hierLoading.has(wt.id) ? (
                <p style={{ ...cardMutedTextStyle, margin: '4px 0 12px' }}>{t('loading')}</p>
              ) : h ? (
                <WorkoutTemplateTree
                  templateId={wt.id}
                  hierarchy={h}
                  canWrite={!!canWrite && isEditing}
                  onChanged={() => refetchBranch(wt.id)}
                />
              ) : null}
            </CardSection>

            {editError && <p style={formErrorStyle}>{editError}</p>}
            <div style={{ ...inlineActionsRowStyle, marginTop: 16 }}>
              <button onClick={cancelEdit} style={secondaryBtnSmall}>{t('cancel')}</button>
              <button onClick={() => handleSave(wt)} disabled={editSaving} style={primaryBtnSmall()}>
                {editSaving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded sections */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '16px 20px 20px', borderTop: '1px solid var(--gd-card-border, #eee)' }}>
            <CardSection label={t('section_general')} first>
              <CardDetailRow label={t('label_description')} value={wt.description ?? '—'} />
              <CardDetailRow label={t('label_status')} value={tStatus(wt.status)} />
              <CardDetailRow
                label={t('label_notes_for_member')}
                value={<span style={{ whiteSpace: 'pre-wrap' }}>{wt.notes || '—'}</span>}
              />
            </CardSection>

            <CardSection label={t('section_workout_structure')}>
              {hierLoading.has(wt.id) ? (
                <p style={{ ...cardMutedTextStyle, margin: '4px 0 12px' }}>{t('loading')}</p>
              ) : h ? (
                <WorkoutTemplateTree
                  templateId={wt.id}
                  hierarchy={h}
                  canWrite={false}
                  onChanged={() => refetchBranch(wt.id)}
                />
              ) : null}
            </CardSection>
          </div>
        )}
      </div>
    );
  }

  if (gymLoading || !canRead) return null;

  return (
    <div>
      {/* Header (#3335 stage 2: the Exercises page's title + actions) */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => setImportOpen(true)} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite}>
            {t('import_system_templates')}
          </button>
          <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      <FilterBar>
        <FilterField label={t('filter_search')} htmlFor="wt-search">
          <input
            id="wt-search"
            type="search"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('filter_name')}
            style={filterControlStyle}
          />
        </FilterField>
        <FilterField label={t('label_created_by')} htmlFor="wt-created-by">
          <select id="wt-created-by" value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterControlStyle}>
            <option value="">{t('filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.name} value={o.name}>{o.name}</option>)}
          </select>
        </FilterField>
        <FilterField label={t('label_status')} htmlFor="wt-status">
          <StatusFilter
            id="wt-status"
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
            style={filterControlStyle}
          />
        </FilterField>
        <div style={{ marginLeft: 'auto' }}>
          <ExerciseViewToggle value={viewMode} onChange={setViewMode} />
        </div>
      </FilterBar>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : rows.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : viewMode === 'cards' && inlineNew === null ? (
        <CardGrid>
          {rows.map((wt) => (
            <WorkoutTemplateCard key={wt.id} template={wt} menuItems={templateMenuItems(wt)} />
          ))}
        </CardGrid>
      ) : (
        /* The header band and the cards share LIST_GRID_COLUMNS and scroll
           together, so they cannot fall out of line, and a narrow viewport
           scrolls the list instead of the page (#1011). */
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
            <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
              {/* Column headers */}
              <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
                {LIST_COLUMNS.map((col) => (
                  <div key={col.key} className={CELL_CLASS[col.key]}>
                    {col.labelKey ? t(col.labelKey) : null}
                  </div>
                ))}
              </div>

              {/* Inline new row */}
              {renderInlineNewRow()}

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {rows.map(renderRow)}
              </div>
            </div>
          </div>
        </DndContext>
      )}

      <ImportWorkoutTemplatesModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImported={handleImported}
      />

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        extraFooter={<ViewAuditLogButton entityType="workout_template" entityId={details?.id} onNavigate={() => setDetails(null)} />}
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={cardSectionTitleStyle}>{t('section_general')}</div>
            <div>
              <span style={detailLabelStyle}>{t('details_name')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{details.name}</p>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('details_description')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.description ? '#333' : '#aaa' }}>
                {details.description ?? '—'}
              </p>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('details_status')}</span>
              <div style={{ marginTop: 4 }}>
                <StatusBadge status={details.status} label={tStatus(details.status)} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('col_blocks')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{toNumBlocks(details)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('col_source')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{templateSource(details) === 'system' ? t('source_system') : t('source_custom')}</p>
              </div>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('label_notes_for_member')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.notes ? '#333' : '#aaa' }}>
                {details.notes ?? '—'}
              </p>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={cardSectionTitleStyle}>Audit</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{formatGymDateTime(details.created_at, gymFmt)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_at ? formatGymDateTime(details.modified_at, gymFmt) : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_at ? formatGymDateTime(details.deleted_at, gymFmt) : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_by ?? '—'}</p>
              </div>
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={`${t('confirm_delete_title')}\n\n${t('confirm_delete_body')}`}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };

const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `12px ${ROW_PADDING_X}px`,
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', padding: `6px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};
