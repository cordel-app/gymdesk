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
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { btnStyle, btnSmall } from '@/components/ui';
import { WorkoutTemplateTree, WtHierarchy, TemplateDropTarget } from './WorkoutTemplateTree';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkoutTemplate {
  id: number;
  name: string;
  description: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  blocks_count: number;
  created_by_name: string | null;
  created_at: string;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

interface ListResponse {
  items: WorkoutTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { membership_id: number; name: string }

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
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));

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

  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

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

  function openEdit(wt: WorkoutTemplate) {
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

  function cancelEdit() { setEditingId(null); setEditError(null); }

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
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ────────────────────────────────────────────────────────────

  async function handleDuplicate(wt: WorkoutTemplate) {
    try {
      const created = await apiFetch<WorkoutTemplate>(`/workout-templates/${wt.id}/duplicate`, { method: 'POST' });
      toast(t('duplicated'));
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
    return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveInlineNew(); if (e.key === 'Escape') cancelInlineNew(); }}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') saveInlineNew(); if (e.key === 'Escape') cancelInlineNew(); }}
                style={inlineInputStyle}
              />
            </div>
          </div>
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall('#6c63ff')}>
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

    const descText = wt.description
      ? wt.description.length > 60 ? wt.description.slice(0, 60) + '…' : wt.description
      : '—';

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(wt) },
      { label: t('edit'), onClick: () => openEdit(wt) },
      { label: t('duplicate'), onClick: () => handleDuplicate(wt) },
      { label: t('delete'), onClick: () => setDeleting(wt), danger: true },
    ];

    const h = hierarchies[wt.id];

    return (
      <div key={wt.id} style={cardStyle}>
        {/* Collapsed header */}
        <div style={rowStyle} onClick={() => toggleExpand(wt.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <TemplateDropTarget templateId={wt.id}>{wt.name}</TemplateDropTarget>
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {descText}
          </div>
          <div style={{ minWidth: 90, fontSize: 13, color: '#555', flexShrink: 0 }}>
            {t('blocks_count', { n: wt.blocks_count ?? 0 })}
          </div>
          <div style={{ minWidth: 90, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {fmtDate(wt.created_at)}
          </div>
          <div style={{ minWidth: 100, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {wt.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={wt.status} label={tStatus(wt.status)} />
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${wt.name}`} />
          </div>
        </div>

        {/* Inline edit form */}
        {isEditing && (
          <div style={{ padding: '0 20px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  autoFocus
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as WorkoutTemplate['status'] })}
                  style={inlineSelectStyle}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={2}
                  style={{ ...inlineInputStyle, resize: 'vertical' }}
                />
              </div>
            </div>

            <SectionHeader title={t('section_workout_structure')} />
            {hierLoading.has(wt.id) ? (
              <p style={{ color: '#888', fontSize: 13, margin: '4px 0 12px' }}>{t('loading')}</p>
            ) : h ? (
              <WorkoutTemplateTree
                templateId={wt.id}
                hierarchy={h}
                canWrite={!!canWrite}
                onChanged={() => refetchBranch(wt.id)}
              />
            ) : null}

            <SectionHeader title={t('section_notes')} />
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              placeholder={t('notes_placeholder')}
              style={{ ...inlineInputStyle, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />

            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(wt)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                {editSaving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded sections */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <DetailRow label={t('label_description')} value={wt.description ?? '—'} />
            <DetailRow label={t('label_status')} value={tStatus(wt.status)} />

            <SectionHeader title={t('section_workout_structure')} />
            {hierLoading.has(wt.id) ? (
              <p style={{ color: '#888', fontSize: 13, margin: '4px 0 12px' }}>{t('loading')}</p>
            ) : h ? (
              <WorkoutTemplateTree
                templateId={wt.id}
                hierarchy={h}
                canWrite={!!canWrite}
                onChanged={() => refetchBranch(wt.id)}
              />
            ) : null}

            <SectionHeader title={t('section_notes')} />
            <p style={{ margin: '4px 0 0', fontSize: 13, color: wt.notes ? '#333' : '#aaa', whiteSpace: 'pre-wrap' }}>
              {wt.notes ?? '—'}
            </p>
          </div>
        )}
      </div>
    );
  }

  if (gymLoading || !canWrite) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('filter_name')}
            style={filterInputStyle}
          />
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={openInlineNew} style={btnStyle()} disabled={inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {/* Column headers */}
      {(rows.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 3 }}>{t('col_description')}</div>
          <div style={{ minWidth: 90 }}>{t('col_workout_info')}</div>
          <div style={{ minWidth: 90 }}>{t('col_created')}</div>
          <div style={{ minWidth: 100 }}>{t('col_created_by')}</div>
          <div style={{ minWidth: 90 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new row */}
      {renderInlineNewRow()}

      {/* Template list */}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        {loading ? (
          <p style={{ color: '#888' }}>{t('loading')}</p>
        ) : rows.length === 0 && !inlineNew ? (
          <p style={{ color: '#888' }}>{t('empty')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {rows.map(renderRow)}
          </div>
        )}
      </DndContext>

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
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
            <div>
              <span style={detailLabelStyle}>{t('details_notes')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.notes ? '#333' : '#aaa' }}>
                {details.notes ?? '—'}
              </p>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>Audit</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{new Date(details.created_at).toLocaleString()}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_at ? new Date(details.modified_at).toLocaleString() : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_at ? new Date(details.deleted_at).toLocaleString() : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_by_name ?? '—'}</p>
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

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid var(--gd-border, #eee)', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1 }}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e2e6', borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const filterInputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, background: '#fff',
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailSectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const errorStyle: React.CSSProperties = {
  margin: '8px 0 0', fontSize: 13, color: '#c0392b',
};
