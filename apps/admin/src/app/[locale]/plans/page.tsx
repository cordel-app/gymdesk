'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';
import { PlanPricesModal } from './PlanPricesModal';

interface Plan {
  id: number;
  name: string;
  description: string | null;
  base_price: string;
  status: 'active' | 'inactive';
}

const STATUSES = ['active', 'inactive'] as const;
const emptyForm = { name: '', description: '', base_price: '', status: 'active' };

export default function PlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Plan | null>(null);
  const [pricesFor, setPricesFor] = useState<Plan | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  useEffect(() => {
    if (!gymLoading && !isAdmin) {
      router.replace(`/${locale}`);
    }
  }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const data = await apiFetch<Plan[]>(`/membership-plans${statusFilter ? `?status=${statusFilter}` : ''}`);
      setPlans(data);
    } catch (err: any) {
      setPlans([]);
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading, statusFilter]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(p: Plan) {
    setEditing(p);
    setForm({ name: p.name, description: p.description ?? '', base_price: p.base_price, status: p.status });
    setError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setError(null);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.base_price.trim()) {
      setError(t('plans.error_required'));
      return;
    }
    const price = parseFloat(form.base_price);
    if (isNaN(price) || price < 0) {
      setError(t('plans.error_price'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      base_price: price,
      status: form.status,
    };
    try {
      if (editing) {
        await apiFetch(`/membership-plans/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiFetch('/membership-plans', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      load();
    } catch (err: any) {
      toast(err.message ?? t('plans.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/membership-plans/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('plans.error_generic'));
    }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Plan>[] = [
    { header: t('plans.col_name'), render: (p) => p.name },
    { header: t('plans.col_description'), render: (p) => p.description ?? '—' },
    { header: t('plans.col_price'), render: (p) => parseFloat(p.base_price).toFixed(2) },
    { header: t('plans.col_status'), width: 110, render: (p) => <StatusBadge status={p.status} label={t(`status.${p.status}`)} /> },
    {
      header: t('plans.col_actions'),
      width: 200,
      render: (p) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setPricesFor(p)} style={btnSmall('#6c63ff')}>{t('plans.prices')}</button>
          <button onClick={() => openEdit(p)} style={btnSmall('#444')}>{t('plans.edit')}</button>
          <button onClick={() => setDeleting(p)} style={btnSmall('#c0392b')}>{t('plans.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('plans.title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
            allLabel={t('status.all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('plans.add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={plans}
        rowKey={(p) => p.id}
        loading={loading}
        loadingText={t('plans.loading')}
        emptyText={t('plans.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('plans.modal_edit') : t('plans.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('plans.cancel')}
        saveLabel={saving ? t('plans.saving') : editing ? t('plans.save_changes') : t('plans.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('plans.label_name')}</FormLabel>
        <FormInput
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t('plans.placeholder_name')}
          autoFocus
        />

        <FormLabel>{t('plans.label_description')}</FormLabel>
        <FormInput
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          placeholder={t('plans.placeholder_description')}
        />

        <FormLabel>{t('plans.label_price')}</FormLabel>
        <FormInput
          type="number"
          min="0"
          step="0.01"
          value={form.base_price}
          onChange={(e) => setForm({ ...form, base_price: e.target.value })}
          placeholder="0.00"
        />

        <FormLabel>{t('plans.label_status')}</FormLabel>
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value })}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>{t(`status.${s}`)}</option>
          ))}
        </select>
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('plans.confirm_delete')}
        confirmLabel={t('plans.delete')}
        cancelLabel={t('plans.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {pricesFor && (
        <PlanPricesModal planId={pricesFor.id} planName={pricesFor.name} onClose={() => setPricesFor(null)} />
      )}
    </div>
  );
}
