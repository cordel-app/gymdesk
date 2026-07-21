'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
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
  created_at: string;
  modified_at: string | null;
}

const emptyForm = { name: '', description: '', calories: '', protein: '', carbohydrates: '', fat: '' };
type ItemForm = typeof emptyForm;

interface CatalogSectionProps {
  type: CatalogType;
  label: string;
  canWrite: boolean;
}

function NutritionField({ label, value }: { label: string; value: string | null | undefined }) {
  if (value == null || value === '') return null;
  return (
    <span style={{ fontSize: 12.5, color: '#888', marginLeft: 8 }}>
      {label}: {value}
    </span>
  );
}

function CatalogSection({ type, label, canWrite }: CatalogSectionProps) {
  const t = useTranslations();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ItemForm>(emptyForm);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Inline editing
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<ItemForm>(emptyForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete
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

  function itemToForm(item: CatalogItem): ItemForm {
    return {
      name: item.name,
      description: item.description ?? '',
      calories: item.calories != null ? String(item.calories) : '',
      protein: item.protein != null ? String(item.protein) : '',
      carbohydrates: item.carbohydrates != null ? String(item.carbohydrates) : '',
      fat: item.fat != null ? String(item.fat) : '',
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
    };
  }

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

  function startEdit(item: CatalogItem) {
    setEditingId(item.id);
    setEditForm(itemToForm(item));
    setEditError(null);
    setExpandedIds((prev) => { const next = new Set(prev); next.add(item.id); return next; });
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('meals_catalog.error_name_required')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/${type}/${editingId}`, { method: 'PUT', body: JSON.stringify(formToBody(editForm)) });
      setEditingId(null); setEditForm(emptyForm); load();
    } catch (err: any) {
      setEditError(err.message ?? t('meals_catalog.error_generic'));
    } finally { setEditSaving(false); }
  }

  async function del() {
    if (!deleting) return;
    try {
      await apiFetch(`/${type}/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null); load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('meals_catalog.error_generic'));
    }
  }

  function toggleExpand(id: number) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ marginBottom: 40 }}>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{label}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            placeholder={t('meals_catalog.filter_name')}
            style={filterInputStyle}
          />
          {canWrite && (
            <button onClick={() => { setAddForm(emptyForm); setAddError(null); setAddOpen(true); }} style={btnStyle()}>
              {t(`meals_catalog.add_${type.slice(0, -1)}`)}
            </button>
          )}
        </div>
      </div>

      {/* Items */}
      {loading ? (
        <p style={{ color: '#888', fontSize: 14 }}>{t('meals_catalog.loading')}</p>
      ) : items.length === 0 ? (
        <p style={{ color: '#888', fontSize: 14 }}>{t(`meals_catalog.empty_${type}`)}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => {
            const isExpanded = expandedIds.has(item.id);
            const isEditing = editingId === item.id;
            return (
              <div key={item.id} style={cardStyle(isEditing)}>
                {isEditing ? (
                  <div style={{ padding: '14px 16px 0' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div>
                        <label style={inlineLabelStyle}>{t('meals_catalog.label_name')} *</label>
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                          autoFocus
                          style={inlineInputStyle}
                        />
                        {editError && <p style={{ color: '#c00', fontSize: 13, margin: '4px 0 0' }}>{editError}</p>}
                      </div>
                      <div>
                        <label style={inlineLabelStyle}>{t('meals_catalog.label_description')}</label>
                        <textarea
                          value={editForm.description}
                          onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                          rows={2}
                          style={{ ...inlineInputStyle, resize: 'vertical' }}
                        />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
                        {(['calories', 'protein', 'carbohydrates', 'fat'] as const).map((field) => (
                          <div key={field}>
                            <label style={inlineLabelStyle}>{t(`meals_catalog.label_${field}`)}</label>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={editForm[field]}
                              onChange={(e) => setEditForm({ ...editForm, [field]: e.target.value })}
                              style={inlineInputStyle}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0 14px', marginTop: 10, borderTop: '1px solid #ececf0' }}>
                      <button onClick={() => { setEditingId(null); setEditForm(emptyForm); }} style={cancelBtnStyle}>
                        {t('meals_catalog.cancel')}
                      </button>
                      <button onClick={saveEdit} disabled={editSaving} style={btnStyle()}>
                        {editSaving ? t('meals_catalog.saving') : t('meals_catalog.save_changes')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      onClick={() => toggleExpand(item.id)}
                      style={headerRowStyle}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleExpand(item.id); }}
                    >
                      <span style={{ fontSize: 12, color: '#aaa', userSelect: 'none', flexShrink: 0 }}>{isExpanded ? '▼' : '▶'}</span>
                      <span style={nameCellStyle}>{item.name}</span>
                      <span style={descCellStyle}>{item.description ?? '—'}</span>
                      <NutritionField label="kcal" value={item.calories != null ? String(item.calories) : null} />
                      <span style={{ flex: 1 }} />
                      {canWrite && (
                        <span onClick={(e) => e.stopPropagation()}>
                          <ContextMenu
                            ariaLabel={t('meals_catalog.col_actions')}
                            items={[
                              { label: t('meals_catalog.edit'), onClick: () => startEdit(item) },
                              { label: t('meals_catalog.delete'), onClick: () => setDeleting(item), danger: true },
                            ]}
                          />
                        </span>
                      )}
                    </div>
                    {isExpanded && (
                      <div style={{ padding: '10px 20px 14px 36px', borderTop: '1px solid #ececf0' }}>
                        {item.description && <p style={{ margin: '0 0 8px', fontSize: 14, color: '#444' }}>{item.description}</p>}
                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
                          {([['calories', 'kcal'], ['protein', 'g'], ['carbohydrates', 'g'], ['fat', 'g']] as const).map(([field, unit]) =>
                            item[field] != null ? (
                              <span key={field} style={{ fontSize: 13.5, color: '#555' }}>
                                <strong>{t(`meals_catalog.label_${field}`)}</strong>: {item[field]}{unit}
                              </span>
                            ) : null,
                          )}
                        </div>
                        {!item.calories && !item.protein && !item.carbohydrates && !item.fat && !item.description && (
                          <p style={{ margin: 0, fontSize: 13.5, color: '#aaa' }}>{t('meals_catalog.no_nutrition_info')}</p>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add modal */}
      <CrudModal
        open={addOpen}
        title={t(`meals_catalog.add_${type.slice(0, -1)}`)}
        error={addError}
        saving={addSaving}
        cancelLabel={t('meals_catalog.cancel')}
        saveLabel={addSaving ? t('meals_catalog.saving') : t(`meals_catalog.add_${type.slice(0, -1)}`)}
        onCancel={() => { setAddOpen(false); setAddForm(emptyForm); setAddError(null); }}
        onSave={saveAdd}
      >
        <FormLabel>{t('meals_catalog.label_name')} *</FormLabel>
        <FormInput value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} autoFocus />
        <FormLabel>{t('meals_catalog.label_description')}</FormLabel>
        <FormInput value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.target.value })} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 4 }}>
          {(['calories', 'protein', 'carbohydrates', 'fat'] as const).map((field) => (
            <div key={field}>
              <FormLabel>{t(`meals_catalog.label_${field}`)}</FormLabel>
              <FormInput
                type="number"
                min="0"
                step="0.1"
                value={addForm[field]}
                onChange={(e) => setAddForm({ ...addForm, [field]: e.target.value })}
              />
            </div>
          ))}
        </div>
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={t('meals_catalog.confirm_delete', { name: deleting?.name ?? '' })}
        confirmLabel={t('meals_catalog.delete')}
        cancelLabel={t('meals_catalog.cancel')}
        onConfirm={del}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

export default function MealsCatalogPage() {
  const t = useTranslations();
  const { activeGym, loading: gymLoading, isSuperadmin } = useGym();

  const canWrite = isSuperadmin || activeGym?.role === 'admin' || activeGym?.role === 'coach';

  if (gymLoading) return null;

  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>{t('meals_catalog.title')}</h1>
      <CatalogSection type="dishes" label={t('meals_catalog.section_dishes')} canWrite={!!canWrite} />
      <CatalogSection type="sides" label={t('meals_catalog.section_sides')} canWrite={!!canWrite} />
      <CatalogSection type="sauces" label={t('meals_catalog.section_sauces')} canWrite={!!canWrite} />
    </div>
  );
}

const filterInputStyle: React.CSSProperties = { padding: '9px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, background: '#fff' };
const cardStyle = (editing: boolean): React.CSSProperties => ({
  border: editing ? '1.5px solid #4b45c6' : '1px solid #ececf0',
  borderRadius: 10,
  background: '#fff',
  overflow: 'hidden',
});
const headerRowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
  cursor: 'pointer', userSelect: 'none',
};
const nameCellStyle: React.CSSProperties = {
  fontWeight: 600, fontSize: 15, flexShrink: 0, maxWidth: 220,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const descCellStyle: React.CSSProperties = {
  color: '#888', fontSize: 13.5, flex: 1,
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const inlineLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4 };
const inlineInputStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const cancelBtnStyle: React.CSSProperties = { background: '#f4f4f6', color: '#444', border: '1px solid #ddd', borderRadius: 6, padding: '9px 18px', cursor: 'pointer', fontSize: 15, fontWeight: 500 };
