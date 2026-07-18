'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
import { NewTrainingPlanDialog } from './NewTrainingPlanDialog';

interface TrainingPlanRow {
  id: number;
  name: string;
  status: 'draft' | 'active' | 'expired';
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
}
interface ListResponse { items: TrainingPlanRow[]; total: number; limit: number; offset: number }
interface CreatedByOption { membership_id: number; name: string }
interface MemberOption { id: number; name: string }
interface TemplateOption { id: number; name: string }

type SortKey = 'name' | 'member' | 'template' | 'status' | 'start_date' | 'created_by' | 'created_at' | 'modified_at';

const STATUSES = ['draft', 'active', 'expired'] as const;
const LIMIT = 20;

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

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

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

  async function del() {
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

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const sortHeader = (key: SortKey, label: string) => (
    <button onClick={() => toggleSort(key)} style={sortHeaderStyle}>{label}{sortArrow(key)}</button>
  );

  const columns: Column<TrainingPlanRow>[] = [
    { header: sortHeader('name', t('training_plans.col_name')), render: (r) => (
      <a href={`/${locale}/training-plans/${r.id}`} onClick={(e) => { e.preventDefault(); router.push(`/${locale}/training-plans/${r.id}`); }} style={linkStyle}>{r.name}</a>
    ) },
    { header: sortHeader('member', t('training_plans.col_member')), render: (r) => r.member_name },
    { header: sortHeader('template', t('training_plans.col_source')), render: (r) => r.template_name ?? t('training_plans.custom') },
    { header: sortHeader('status', t('training_plans.col_status')), width: 110, render: (r) => <StatusBadge status={r.status} label={t(`status.${r.status}`)} /> },
    { header: sortHeader('start_date', t('training_plans.col_start_date')), width: 120, render: (r) => formatDate(r.start_date, locale) },
    { header: sortHeader('created_by', t('training_plans.col_created_by')), width: 160, render: (r) => r.created_by_name ?? '—' },
    { header: sortHeader('created_at', t('training_plans.col_created_at')), width: 140, render: (r) => formatDate(r.created_at, locale) },
    { header: sortHeader('modified_at', t('training_plans.col_modified_at')), width: 140, render: (r) => r.modified_at ? formatDate(r.modified_at, locale) : '—' },
    {
      header: t('training_plans.col_actions'), width: 80,
      render: (r) => (
        <ContextMenu ariaLabel={t('training_plans.col_actions')} items={[
          { label: t('training_plans.open'), onClick: () => router.push(`/${locale}/training-plans/${r.id}`) },
          { label: t('training_plans.delete'), onClick: () => setDeleting(r), danger: true },
        ]} />
      ),
    },
  ];

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + LIMIT, total);

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
          <button onClick={() => setNewOpen(true)} style={btnStyle()}>{t('training_plans.new_plan')}</button>
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading}
        loadingText={t('training_plans.loading')} emptyText={t('training_plans.empty')} />

      {total > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 16 }}>
          <span style={{ color: '#666', fontSize: 14 }}>{t('audit.page_info', { start: pageStart, end: pageEnd, total })}</span>
          <button onClick={() => setOffset(Math.max(0, offset - LIMIT))} disabled={offset === 0} style={pagerStyle(offset === 0)}>‹</button>
          <button onClick={() => setOffset(offset + LIMIT)} disabled={pageEnd >= total} style={pagerStyle(pageEnd >= total)}>›</button>
        </div>
      )}

      <NewTrainingPlanDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(plan) => { setNewOpen(false); router.push(`/${locale}/training-plans/${plan.id}`); }}
      />

      <ConfirmDialog open={deleting !== null} message={t('training_plans.confirm_delete')}
        confirmLabel={t('training_plans.delete')} cancelLabel={t('training_plans.cancel')}
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
const linkStyle: React.CSSProperties = { color: 'var(--brand, #6c63ff)', textDecoration: 'none', fontWeight: 500 };
