'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';

type CatalogType = 'dishes' | 'sides' | 'sauces';

interface CatalogItem {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  calories: number | null;
  protein: number | null;
  carbohydrates: number | null;
  fat: number | null;
  status: string;
  created_at: string;
  modified_at: string | null;
  deleted_at: string | null;
  created_by_name: string | null;
  modified_by_name: string | null;
  deleted_by_name: string | null;
}

const emptyForm = { name: '', description: '', calories: '', protein: '', carbohydrates: '', fat: '', status: 'active' };
type ItemForm = typeof emptyForm;

function formatDate(value: string | null, locale: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

function itemToForm(item: CatalogItem): ItemForm {
  return {
    name: item.name,
    description: item.description ?? '',
    calories: item.calories != null ? String(item.calories) : '',
    protein: item.protein != null ? String(item.protein) : '',
    carbohydrates: item.carbohydrates != null ? String(item.carbohydrates) : '',
    fat: item.fat != null ? String(item.fat) : '',
    status: item.status,
  };
}

function formToBody(form: ItemForm) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    calories: form.calories !== '' ? parseFloat(form.calories) : null,
    protein: form.protein !== '' ? parseFloat(form.protein) : null,
    carbohydrates: form.carbohydrates !== '' ? parseFloat(form.carbohydrates) : null,
    fat: form.fat !== '' ? parseFloat(form.fat) : null,
    status: form.status,
  };
}

function NutritionFields({ item, t }: { item: CatalogItem; t: ReturnType<typeof useTranslations> }) {
  const fields: Array<[keyof CatalogItem, string]> = [
    ['calories', t('meals_catalog.label_calories')],
    ['protein', t('meals_catalog.label_protein')],
    ['carbohydrates', t('meals_catalog.label_carbohydrates')],
    ['fat', t('meals_catalog.label_fat')],
  ];
  const present = fields.filter(([k]) => item[k] != null);
  if (present.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
      {present.map(([k, label]) => (
        <span key={k} style={{ fontSize: 13, color: '#555' }}>
          <strong>{label}:</strong> {String(item[k])}
        </span>
      ))}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 14 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1 }}>{value || '—'}</span>
    </div>
  );
}

interface CatalogSectionProps {
  type: CatalogType;
  label: string;
  canWrite: boolean;
}

function CatalogSection({ type, label, canWrite }: CatalogSectionProps) {
  const t = useTranslations();
  const locale = useLocale();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState('');

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ItemForm>(emptyForm);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit modal
  const [editItem, setEditItem] = useState<CatalogItem | null>(null);
  const [editForm, setEditForm] = useState<ItemForm>(emptyForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Details modal
  const [detailsItem, setDetailsItem] = useState<CatalogItem | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<CatalogItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nameInput.trim()) params.set('name', nameInput.trim());
      const rows = await apiFetch<CatalogItem[]>(`/${type}?${params.toString()}`);
      setItems(rows);
    } catch (err: any) {
      toast(err.message ?? t('meals_catalog.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [type, nameInput]);

  useEffect(() => {
    const id = setTimeout(load, 300);
    return () => clearTimeout(id);
  }, [load]);

  async function saveAdd() {
    if (!addForm.name.trim()) { setAddError(t('meals_catalog.error_name_required')); return; }
    setAddSaving(true); setAddError(null);
    try {
      await apiFetch(`/${type}`, { method: 'POST', body: JSON.stringify(formToBody(addForm)) });
      setAddOpen(false); setAddForm(emptyForm); load();
    } catch (err: any) {
      setAddError(err.message ?? t('meals_catalog.error_generic'));
    } finally { setAddSaving(false); }
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('meals_catalog.error_name_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/${type}/${editItem!.id}`, { method: 'PUT', body: JSON.stringify(formToBody(editForm)) });
      setEditItem(null); load();
    } catch (err: any) {
      setEditError(err.message ?? t('meals_catalog.error_generic'));
    } finally { setEditSaving(false); }
  }

  async function doDuplicate(item: CatalogItem) {
    try {
      await apiFetch(`/${type}/${item.id}/duplicate`, { method: 'POST' });
      toast(t('meals_catalog.duplicated'));
      load();
    } catch (err: any) {
      toast(err.message ?? t('meals_catalog.error_generic'));
    }
  }

  async function doDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/${type}/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('meals_catalog.error_generic'));
    }
  }

  const columns: Column<CatalogItem>[] = [
    {
      header: t('meals_catalog.col_name'),
      width: '22%',
      render: (item) => <span style={{ fontWeight: 600 }}>{item.name}</span>,
    },
    {
      header: t('meals_catalog.col_description'),
      render: (item) => (
        <span style={{ color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block', maxWidth: 300 }}>
          {item.description ?? '—'}
        </span>
      ),
    },
    {
      header: t('meals_catalog.col_created_at'),
      width: 140,
      render: (item) => <span style={{ color: '#555', fontSize: 14 }}>{formatDate(item.created_at, locale)}</span>,
    },
    {
      header: t('meals_catalog.col_created_by'),
      width: 140,
      render: (item) => <span style={{ color: '#555', fontSize: 14 }}>{item.created_by_name ?? '—'}</span>,
    },
    {
      header: t('meals_catalog.col_status'),
      width: 110,
      render: (item) => <StatusBadge status={item.status} label={t(`status.${item.status}`)} />,
    },
    {
      header: t('meals_catalog.col_actions'),
      width: 60,
      render: (item) => (
        <ContextMenu
          ariaLabel={t('meals_catalog.col_actions')}
          items={[
            { label: t('meals_catalog.details'), onClick: () => setDetailsItem(item) },
            ...(canWrite ? [
              { label: t('meals_catalog.edit'), onClick: () => { setEditItem(item); setEditForm(itemToForm(item)); setEditError(null); } },
              { label: t('meals_catalog.duplicate'), onClick: () => doDuplicate(item) },
              { label: t('meals_catalog.delete'), onClick: () => setDeleting(item), danger: true },
            ] : []),
          ]}
        />
      ),
    },
  ];

  const SINGULAR: Record<CatalogType, 'dish' | 'side' | 'sauce'> = { dishes: 'dish', sides: 'side', sauces: 'sauce' };
  const singularKey = SINGULAR[type];

  return (
    <div style={{ marginBottom: 48 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 20 }}>{label}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('meals_catalog.filter_name')}
            style={filterInputStyle}
          />
          {canWrite && (
            <button onClick={() => { setAddForm(emptyForm); setAddError(null); setAddOpen(true); }} style={btnStyle()}>
              {t(`meals_catalog.add_${singularKey}`)}
            </button>
          )}
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(item) => item.id}
        loading={loading}
        loadingText={t('meals_catalog.loading')}
        emptyText={t(`meals_catalog.empty_${type}`)}
      />

      {/* Add modal */}
      <CrudModal
        open={addOpen}
        title={t(`meals_catalog.add_${singularKey}`)}
        error={addError}
        saving={addSaving}
        cancelLabel={t('meals_catalog.cancel')}
        saveLabel={addSaving ? t('meals_catalog.saving') : t(`meals_catalog.add_${singularKey}`)}
        onCancel={() => { setAddOpen(false); setAddForm(emptyForm); setAddError(null); }}
        onSave={saveAdd}
      >
        <ItemFormFields form={addForm} onChange={(f) => setAddForm(f)} t={t} showStatus={false} />
      </CrudModal>

      {/* Edit modal */}
      <CrudModal
        open={editItem !== null}
        title={t('meals_catalog.modal_edit')}
        error={editError}
        saving={editSaving}
        cancelLabel={t('meals_catalog.cancel')}
        saveLabel={editSaving ? t('meals_catalog.saving') : t('meals_catalog.save_changes')}
        onCancel={() => { setEditItem(null); setEditError(null); }}
        onSave={saveEdit}
      >
        <ItemFormFields form={editForm} onChange={(f) => setEditForm(f)} t={t} showStatus />
      </CrudModal>

      {/* Details modal */}
      <CrudModal
        open={detailsItem !== null}
        title={t('meals_catalog.details_dialog_title')}
        error={null}
        saving={false}
        cancelLabel={t('meals_catalog.close')}
        saveLabel=""
        hideSave
        onCancel={() => setDetailsItem(null)}
        onSave={() => setDetailsItem(null)}
      >
        {detailsItem && (
          <div>
            <DetailRow label={t('meals_catalog.label_name')} value={detailsItem.name} />
            {detailsItem.description && (
              <DetailRow label={t('meals_catalog.label_description')} value={detailsItem.description} />
            )}
            <DetailRow label={t('meals_catalog.label_status')} value={t(`status.${detailsItem.status}`)} />
            <NutritionFields item={detailsItem} t={t} />
            <div style={{ borderTop: '1px solid #eee', margin: '12px 0 8px' }} />
            <DetailRow label={t('meals_catalog.label_created_at')} value={formatDate(detailsItem.created_at, locale)} />
            {detailsItem.created_by_name && (
              <DetailRow label={t('meals_catalog.label_created_by')} value={detailsItem.created_by_name} />
            )}
            {detailsItem.modified_at && (
              <DetailRow label={t('meals_catalog.label_modified_at')} value={formatDate(detailsItem.modified_at, locale)} />
            )}
            {detailsItem.modified_by_name && (
              <DetailRow label={t('meals_catalog.label_modified_by')} value={detailsItem.modified_by_name} />
            )}
            {detailsItem.deleted_at && (
              <DetailRow label={t('meals_catalog.label_deleted_at')} value={formatDate(detailsItem.deleted_at, locale)} />
            )}
            {detailsItem.deleted_by_name && (
              <DetailRow label={t('meals_catalog.label_deleted_by')} value={detailsItem.deleted_by_name} />
            )}
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('meals_catalog.confirm_delete', { name: deleting?.name ?? '' })}
        confirmLabel={t('meals_catalog.delete')}
        cancelLabel={t('meals_catalog.cancel')}
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function ItemFormFields({
  form,
  onChange,
  t,
  showStatus,
}: {
  form: ItemForm;
  onChange: (f: ItemForm) => void;
  t: ReturnType<typeof useTranslations>;
  showStatus: boolean;
}) {
  return (
    <>
      <FormLabel>{t('meals_catalog.label_name')} *</FormLabel>
      <FormInput value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} autoFocus />
      <FormLabel>{t('meals_catalog.label_description')}</FormLabel>
      <FormInput value={form.description} onChange={(e) => onChange({ ...form, description: e.target.value })} />
      {showStatus && (
        <>
          <FormLabel>{t('meals_catalog.label_status')}</FormLabel>
          <select
            value={form.status}
            onChange={(e) => onChange({ ...form, status: e.target.value })}
            style={selectStyle}
          >
            <option value="active">{t('status.active')}</option>
          </select>
        </>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
        {(['calories', 'protein', 'carbohydrates', 'fat'] as const).map((field) => (
          <div key={field}>
            <FormLabel>{t(`meals_catalog.label_${field}`)}</FormLabel>
            <FormInput
              type="number"
              min="0"
              step="0.1"
              value={form[field]}
              onChange={(e) => onChange({ ...form, [field]: e.target.value })}
            />
          </div>
        ))}
      </div>
    </>
  );
}

const filterInputStyle: React.CSSProperties = {
  padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff',
};

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 15, boxSizing: 'border-box', background: '#fff', marginBottom: 8,
};

export default function MealsPage() {
  const t = useTranslations();
  const { activeGym, loading: gymLoading, isSuperadmin } = useGym();

  if (gymLoading) return null;

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'NUTRITION'));

  return (
    <div>
      <h1 style={{ marginBottom: 32 }}>{t('meals_catalog.title')}</h1>
      <CatalogSection type="dishes" label={t('meals_catalog.section_dishes')} canWrite={canWrite} />
      <CatalogSection type="sides" label={t('meals_catalog.section_sides')} canWrite={canWrite} />
      <CatalogSection type="sauces" label={t('meals_catalog.section_sauces')} canWrite={canWrite} />
    </div>
  );
}
