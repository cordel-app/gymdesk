'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
import { TrainingPlanTree, Hierarchy } from './TrainingPlanTree';

export interface TrainingPlanTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft';
  created_by_name: string | null;
  created_at: string;
}

interface ListResponse {
  items: TrainingPlanTemplate[];
  total: number;
  limit: number;
  offset: number;
}

interface CreatedByOption { membership_id: number; name: string }

type SortKey = 'name' | 'created_at' | 'status';

const STATUSES = ['active', 'inactive', 'draft'] as const;
const LIMIT = 20;
const emptyForm = { name: '', description: '', status: 'active' };

export default function TrainingPlanTemplatesPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<TrainingPlanTemplate[]>([]);
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
  const [editing, setEditing] = useState<TrainingPlanTemplate | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TrainingPlanTemplate | null>(null);

  // Row expansion + per-template lazy-loaded, cached hierarchy.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [hierarchies, setHierarchies] = useState<Record<number, Hierarchy>>({});
  const [hierLoading, setHierLoading] = useState<Set<number>>(new Set());

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
      const res = await apiFetch<ListResponse>(`/training-plan-templates?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, statusFilter, nameQuery, createdByFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  // Reset to first page whenever a filter or sort changes.
  useEffect(() => { setOffset(0); }, [statusFilter, nameQuery, createdByFilter, sortKey, sortDir]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<CreatedByOption[]>('/training-plan-templates/created-by-options')
      .then(setCreatedByOptions)
      .catch(() => { /* filter is best-effort; ignore load failure */ });
  }, [activeGymId, gymLoading]);

  function openAdd() { setEditing(null); setForm(emptyForm); setError(null); setModalOpen(true); }
  function openEdit(w: TrainingPlanTemplate) {
    setEditing(w);
    setForm({ name: w.name, description: w.description ?? '', status: w.status });
    setError(null); setModalOpen(true);
  }

  async function save() {
    if (!form.name.trim()) { setError(t('training_plan_templates.error_required')); return; }
    setSaving(true); setError(null);
    const body = { name: form.name.trim(), description: form.description.trim() || null, status: form.status };
    try {
      if (editing) await apiFetch(`/training-plan-templates/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      else await apiFetch('/training-plan-templates', { method: 'POST', body: JSON.stringify(body) });
      setModalOpen(false); setEditing(null); setForm(emptyForm); load();
    } catch (err: any) { setError(err.message ?? t('training_plan_templates.error_generic')); }
    finally { setSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try { await apiFetch(`/training-plan-templates/${deleting.id}`, { method: 'DELETE' }); setDeleting(null); load(); }
    catch (err: any) { setDeleting(null); toast(err.message ?? t('training_plan_templates.error_generic')); }
  }

  async function toggleExpand(row: TrainingPlanTemplate) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
      return next;
    });
    // Lazy-load the hierarchy once and cache it; re-expand does not refetch.
    if (!hierarchies[row.id] && !hierLoading.has(row.id)) {
      setHierLoading((prev) => new Set(prev).add(row.id));
      try {
        const h = await apiFetch<Hierarchy>(`/training-plan-templates/${row.id}/hierarchy`);
        setHierarchies((prev) => ({ ...prev, [row.id]: h }));
      } catch (err: any) {
        toast(err.message ?? t('training_plan_templates.error_generic'));
      } finally {
        setHierLoading((prev) => { const next = new Set(prev); next.delete(row.id); return next; });
      }
    }
  }

  const refetchBranch = useCallback(async (id: number) => {
    try {
      const h = await apiFetch<Hierarchy>(`/training-plan-templates/${id}/hierarchy`);
      setHierarchies((prev) => ({ ...prev, [id]: h }));
    } catch (err: any) {
      toast(err.message ?? t('training_plan_templates.error_generic'));
    }
  }, [apiFetch]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  }

  if (gymLoading || !canWrite) return null;

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortHeader = (key: SortKey, label: string) => (
    <button onClick={() => toggleSort(key)} style={sortHeaderStyle}>{label}{sortArrow(key)}</button>
  );

  const columns: Column<TrainingPlanTemplate>[] = [
    { header: sortHeader('name', t('training_plan_templates.col_name')), render: (w) => w.name },
    { header: t('training_plan_templates.col_created_by'), width: 180, render: (w) => w.created_by_name ?? '—' },
    { header: sortHeader('created_at', t('training_plan_templates.col_created_at')), width: 160, render: (w) => formatDate(w.created_at, locale) },
    { header: sortHeader('status', t('training_plan_templates.col_status')), width: 120, render: (w) => <StatusBadge status={w.status} label={t(`status.${w.status}`)} /> },
    {
      header: t('training_plan_templates.col_actions'), width: 80,
      render: (w) => (
        <ContextMenu
          ariaLabel={t('training_plan_templates.col_actions')}
          items={[
            { label: t('training_plan_templates.details'), onClick: () => openEdit(w) },
            { label: t('training_plan_templates.delete'), onClick: () => setDeleting(w), danger: true },
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
        <h1 style={{ margin: 0 }}>{t('training_plan_templates.title')}</h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('training_plan_templates.filter_name')}
            style={filterInputStyle}
          />
          <select value={createdByFilter} onChange={(e) => setCreatedByFilter(e.target.value)} style={filterInputStyle}>
            <option value="">{t('training_plan_templates.filter_created_by_all')}</option>
            {createdByOptions.map((o) => <option key={o.membership_id} value={o.membership_id}>{o.name}</option>)}
          </select>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle()}>{t('training_plan_templates.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        loadingText={t('training_plan_templates.loading')}
        emptyText={t('training_plan_templates.empty')}
        expandedRowKeys={expanded}
        onToggleExpand={toggleExpand}
        renderExpanded={(row) => {
          const h = hierarchies[row.id];
          if (!h) return <p style={{ color: '#888', fontSize: 14, padding: '12px 20px 12px 44px', margin: 0 }}>{t('training_plan_templates.loading')}</p>;
          return <TrainingPlanTree templateId={row.id} hierarchy={h} canWrite={!!canWrite} onChanged={() => refetchBranch(row.id)} />;
        }}
      />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <span style={{ color: '#666', fontSize: 14 }}>{t('audit.page_info', { start: pageStart, end: pageEnd, total })}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={pagerStyle(offset === 0)}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={pagerStyle(pageEnd >= total)}>›</button>
        </div>
      )}

      <CrudModal
        open={modalOpen}
        title={editing ? t('training_plan_templates.modal_edit') : t('training_plan_templates.modal_add')}
        error={error} saving={saving}
        cancelLabel={t('training_plan_templates.cancel')}
        saveLabel={saving ? t('training_plan_templates.saving') : editing ? t('training_plan_templates.save_changes') : t('training_plan_templates.modal_add')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={save}
      >
        <FormLabel>{t('training_plan_templates.label_name')} *</FormLabel>
        <FormInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
        <FormLabel>{t('training_plan_templates.label_description')}</FormLabel>
        <FormInput value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <FormLabel>{t('training_plan_templates.label_status')}</FormLabel>
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}
        >
          {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('training_plan_templates.confirm_delete')}
                     confirmLabel={t('training_plan_templates.delete')} cancelLabel={t('training_plan_templates.cancel')}
                     onConfirm={del} onCancel={() => setDeleting(null)} />
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
