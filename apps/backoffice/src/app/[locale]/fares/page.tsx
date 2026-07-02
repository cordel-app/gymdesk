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
import { btnStyle, btnSmall } from '@/components/ui';

interface Fare {
  id: number;
  name: string;
  price: string;
}

const emptyForm = { name: '', price: '' };

export default function FaresPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [fares, setFares] = useState<Fare[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Fare | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Fare | null>(null);

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
      const data = await apiFetch<Fare[]>('/fares');
      setFares(data);
    } catch (err: any) {
      setFares([]);
      toast(err.message ?? t('fares.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(f: Fare) {
    setEditing(f);
    setForm({ name: f.name, price: f.price });
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
    if (!form.name.trim() || !form.price.trim()) {
      setError(t('fares.error_required'));
      return;
    }
    const price = parseFloat(form.price);
    if (isNaN(price) || price < 0) {
      setError(t('fares.error_price'));
      return;
    }
    setSaving(true);
    setError(null);
    const body = { name: form.name.trim(), price };
    try {
      if (editing) {
        await apiFetch(`/fares/${editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        await apiFetch('/fares', { method: 'POST', body: JSON.stringify(body) });
      }
      closeModal();
      load();
    } catch (err: any) {
      toast(err.message ?? t('fares.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/fares/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('fares.error_generic'));
    }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Fare>[] = [
    { header: t('fares.col_name'), render: (f) => f.name },
    { header: t('fares.col_price'), render: (f) => parseFloat(f.price).toFixed(2) },
    {
      header: t('fares.col_actions'),
      width: 120,
      render: (f) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => openEdit(f)} style={btnSmall('#444')}>{t('fares.edit')}</button>
          <button onClick={() => setDeleting(f)} style={btnSmall('#c0392b')}>{t('fares.delete')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('fares.title')}</h1>
        <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('fares.add')}</button>
      </div>

      <DataTable
        columns={columns}
        rows={fares}
        rowKey={(f) => f.id}
        loading={loading}
        loadingText={t('fares.loading')}
        emptyText={t('fares.empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('fares.modal_edit') : t('fares.modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('fares.cancel')}
        saveLabel={saving ? t('fares.saving') : editing ? t('fares.save_changes') : t('fares.modal_add')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        <FormLabel>{t('fares.label_name')}</FormLabel>
        <FormInput
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t('fares.placeholder_name')}
          autoFocus
        />

        <FormLabel>{t('fares.label_price')}</FormLabel>
        <FormInput
          type="number"
          min="0"
          step="0.01"
          value={form.price}
          onChange={(e) => setForm({ ...form, price: e.target.value })}
          placeholder="0.00"
        />
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('fares.confirm_delete')}
        confirmLabel={t('fares.delete')}
        cancelLabel={t('fares.cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
