'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates, arrayMove } from '@dnd-kit/sortable';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DependencyDialog, ReferenceReport } from '@/components/DependencyDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
import { WorkoutTemplateTree, WtHierarchy, TemplateDropTarget } from './WorkoutTemplateTree';
// BlockModal and ExerciseModal removed in #130 — editing is now fully inline inside WorkoutTemplateTree.

export interface WorkoutTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  created_by_name: string | null;
  created_at: string;
}

interface ListResponse {
  items: WorkoutTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { membership_id: number; name: string }

type SortKey = 'name' | 'created_at' | 'status';

const STATUSES = ['active', 'inactive'] as const;
const LIMIT = 20;
const emptyForm = { name: '', description: '', status: 'active' };

export default function WorkoutTemplatesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<WorkoutTemplate[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  const [statusFilter, setStatusFilter] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [nameQuery, setNameQuery] = useState('');
  const [createdByFilter, setCreatedByFilter] = useState('');
  const [createdByOptions, setCreatedByOptions] = useState<CreatedByOption[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WorkoutTemplate | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<WorkoutTemplate | null>(null);
  const [depDialog, setDepDialog] = useState<{ action: 'edit' | 'delete'; entity: WorkoutTemplate; refs: ReferenceReport } | null>(null);
  const [checkingDeps, setCheckingDeps] = useState(false);
  const [depBusy, setDepBusy] = useState(false);

  // Row expansion + per-template lazy-loaded, cached hierarchy.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, WtHierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());
  const [inlineEditId, setInlineEditId] = useState<number | null>(null);

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  // Debounce the name text input into the query that actually drives fetches.
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
      params.set('sort', sortKey);
      params.set('dir', sortDir);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const res = await apiFetch<ListResponse>(`/workout-templates?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('workout_templates.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, createdByFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  // Reset to first page whenever a filter or sort changes.
  useEffect(() => { setOffset(0); }, [statusFilter, nameQuery, createdByFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/workout-templates/created-by-options')
      .then(setCreatedByOptions)
      .catch(() => { /* filter is best-effort; ignore load failure */ });
  }, [activeGymId, gymLoading]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(w: WorkoutTemplate) {
    setEditing(w);
    setForm({ name: w.name, description: w.description ?? '', status: w.status });
    setError(null); setModalOpen(true);
  }

  /** #62: check dependencies before edit/delete; warn only when some exist. */
  async function guardedAction(action: 'edit' | 'delete', w: WorkoutTemplate) {
    if (checkingDeps) return;
    setCheckingDeps(true);
    try {
      const refs = await apiFetch<ReferenceReport>(`/workout-templates/${w.id}/references`);
      if (refs.usageCount > 0) { setDepDialog({ action, entity: w, refs }); return; }
      if (action === 'edit') openEdit(w);
      else setDeleting(w);
    } catch (err: any) {
      toast(err.message ?? t('workout_templates.error_generic'));
    } finally { setCheckingDeps(false); }
  }

  async function depContinue() {
    if (!depDialog) return;
    if (depDialog.action === 'edit') {
      openEdit(depDialog.entity);
      setDepDialog(null);
      return;
    }
    setDepBusy(true);
    try {
      await apiFetch(`/workout-templates/${depDialog.entity.id}`, { method: 'DELETE' });
      setDepDialog(null); load();
    } catch (err: any) { setDepDialog(null); toast(err.message ?? t('workout_templates.error_generic')); }
    finally { setDepBusy(false); }
  }

  async function save() {
    if (!form.name.trim()) { setError(t('workout_templates.error_required')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, status: form.status };
    try {
      if (editing) await apiFetch(`/workout-templates/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/workout-templates', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('workout_templates.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/workout-templates/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('workout_templates.error_generic')); }
  }

  async function handleDuplicate(w: WorkoutTemplate) {
    try {
      const created = await apiFetch<WorkoutTemplate>(`/workout-templates/${w.id}/duplicate`, { method: 'POST' });
      toast(t('workout_templates.duplicated'));
      await load();
      setExpanded((prev) => new Set(prev).add(created.id));
      await refetchBranch(created.id);
      setEditing(created);
      setForm({ name: created.name, description: created.description ?? '', status: created.status });
      setError(null);
      setModalOpen(true);
    } catch (err: any) {
      toast(err.message ?? t('workout_templates.error_generic'));
    }
  }

  async function toggleExpand(row: WorkoutTemplate) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
    // Lazy-load the hierarchy once and cache it; re-expand does not refetch.
    if (!hierarchies[row.id] && !hierLoading.has(row.id)) {
      setHierLoading((prev) => new Set(prev).add(row.id));
      try {
        const h = await apiFetch<WtHierarchy>(`/workout-templates/${row.id}`);
        setHierarchies((prev) => ({ ...prev, [row.id]: h }));
      } catch (err: any) {
        toast(err.message ?? t('workout_templates.error_generic'));
      } finally {
        setHierLoading((prev) => { const next = new Set(prev); next.delete(row.id); return next; });
      }
    }
  }

  async function openInlineEdit(w: WorkoutTemplate) {
    setExpanded((prev) => { const next = new Set(prev); next.add(w.id); return next; });
    if (!hierarchies[w.id] && !hierLoading.has(w.id)) {
      setHierLoading((prev) => new Set(prev).add(w.id));
      try {
        const h = await apiFetch<WtHierarchy>(`/workout-templates/${w.id}`);
        setHierarchies((prev) => ({ ...prev, [w.id]: h }));
      } catch (err: any) {
        toast(err.message ?? t('workout_templates.error_generic'));
        return;
      } finally {
        setHierLoading((prev) => { const next = new Set(prev); next.delete(w.id); return next; });
      }
    }
    setInlineEditId(w.id);
  }

  async function saveInlineEdit(id: number, data: { name: string; description: string | null; status: string }) {
    await apiFetch(`/workout-templates/${id}`, { method: 'PUT', body: JSON.stringify(data) });
    setInlineEditId(null);
    // Refresh the row in the list and the cached hierarchy
    setRows((prev) => prev.map((r) => r.id === id ? { ...r, name: data.name, description: data.description, status: data.status as WorkoutTemplate['status'] } : r));
    const h = await apiFetch<WtHierarchy>(`/workout-templates/${id}`);
    setHierarchies((prev) => ({ ...prev, [id]: h }));
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<WtHierarchy>(`/workout-templates/${id}`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('workout_templates.error_generic'));
    }
  }, [apiFetch]);

  /* ---- Drag-and-drop (blocks within/between templates, exercises within a block) ---- */

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function moveBlock(sourceId: number, blockId: number, targetId: number, position: number | null) {
    // Optimistic: remove from the source branch; insert into the target branch
    // when its hierarchy is already loaded (a never-expanded target loads fresh
    // on first expand, so nothing to patch there).
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
      toast(err.message ?? t('workout_templates.error_generic'));
    }
    // Refresh only the affected branches, preserving expansion/filters/paging.
    refetchBranch(sourceId);
    if (hierarchies[targetId]) refetchBranch(targetId);
  }

  async function onDragEnd(e: DragEndEvent) {
    const activeId = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || activeId === overId) return;

    if (activeId.startsWith('ex:')) {
      // ex:<templateId>:<blockId>:<exId> — reorder within the same block only.
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
        toast(err.message ?? t('workout_templates.error_generic'));
        refetchBranch(templateId); // resync from server on failure
      }
      return;
    }

    if (activeId.startsWith('block:')) {
      // block:<templateId>:<blockId>
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
            toast(err.message ?? t('workout_templates.error_generic'));
            refetchBranch(sourceId);
          }
        } else {
          // Cross-template: insert at the hovered block's slot.
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

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  if (gymLoading || !canWrite) return null;

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortHeader = (key: SortKey, label: string) => (
    <button onClick={() => toggleSort(key)} style={sortHeaderStyle}>{label}{sortArrow(key)}</button>
  );

  const columns: Column<WorkoutTemplate>[] = [
    {
      header: sortHeader('name', t('workout_templates.col_name')),
      render: (w) => <TemplateDropTarget templateId={w.id}>{w.name}</TemplateDropTarget>,
    },
    { header: t('workout_templates.col_description'), render: (w) => w.description ?? '—' },
    { header: t('workout_templates.col_created_by'), width: 180, render: (w) => w.created_by_name ?? '—' },
    { header: sortHeader('created_at', t('workout_templates.col_created_at')), width: 160, render: (w) => formatDate(w.created_at, locale) },
    { header: sortHeader('status', t('workout_templates.col_status')), width: 120, render: (w) => <StatusBadge status={w.status} label={t(`status.${w.status}`)} /> },
    {
      header: t('workout_templates.col_actions'), width: 80,
      render: (w) => (
        <ContextMenu
          ariaLabel={t('workout_templates.col_actions')}
          items={[
            { label: t('workout_templates.details'), onClick: () => guardedAction('edit', w) },
            { label: t('workout_templates.edit'), onClick: () => openInlineEdit(w) },
            { label: t('workout_templates.duplicate'), onClick: () => handleDuplicate(w) },
            { label: t('workout_templates.delete'), onClick: () => guardedAction('delete', w), danger: true },
          ]}
        />
      ),
    },
  ];

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('workout_templates.title')}</h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('workout_templates.filter_name')}
            style={filterInputStyle}
          />
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('workout_templates.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle()}>{t('workout_templates.add')}</button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={loading}
          loadingText={t('workout_templates.loading')}
          emptyText={t('workout_templates.empty')}
          expandedRowKeys={expanded}
          onToggleExpand={toggleExpand}
          renderExpanded={(row) => {
            const h = hierarchies[row.id];
            if (!h) return <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>{t('workout_templates.loading')}</p>;
            return (
              <WorkoutTemplateTree
                templateId={row.id}
                hierarchy={h}
                canWrite={!!canWrite}
                onChanged={() => refetchBranch(row.id)}
                editMode={inlineEditId === row.id}
                onEditSave={(data) => saveInlineEdit(row.id, data)}
                onEditCancel={() => setInlineEditId(null)}
              />
            );
          }}
        />
      </DndContext>

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <span style={{ color: '#666', fontSize: 14 }}>{t('audit.page_info', { start: pageStart, end: pageEnd, total })}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={pagerStyle(offset === 0)}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={pagerStyle(pageEnd >= total)}>›</button>
        </div>
      )}

      <CrudModal
        open={modalOpen}
        title={editing ? t('workout_templates.modal_edit') : t('workout_templates.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('workout_templates.cancel')}
        saveLabel={saving ? t('workout_templates.saving') : editing ? t('workout_templates.save_changes') : t('workout_templates.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('workout_templates.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('workout_templates.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('workout_templates.label_status')}</FormLabel>
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('workout_templates.confirm_delete')}
                     confirmLabel={t('workout_templates.delete')} cancelLabel={t('workout_templates.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />

      <DependencyDialog
        open={depDialog !== null}
        message={depDialog ? t(`dependencies.workout_template_${depDialog.action}`, { name: depDialog.entity.name, count: depDialog.refs.usageCount }) : ''}
        question={t('dependencies.question')}
        references={depDialog?.refs.references ?? []}
        moreLabel={depDialog && depDialog.refs.usageCount > depDialog.refs.references.length
          ? t('dependencies.more', { n: depDialog.refs.usageCount - depDialog.refs.references.length }) : null}
        referenceHref={`/${locale}/training-plan-templates`}
        confirmLabel={t('dependencies.continue')}
        cancelLabel={t('dependencies.cancel')}
        onConfirm={depContinue}
        onCancel={() => setDepDialog(null)}
        busy={depBusy}
      />
    </div>
  );
}

function formatDate(value: string, locale: string): string {
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

const filterInputStyle: React.CSSProperties = { padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff' };
const sortHeaderStyle: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontWeight: 600, color: 'inherit' };
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
  background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '4px 12px',
  cursor: disabled ? 'default' : 'pointer', color: disabled ? '#bbb' : '#333', fontSize: 16,
});
