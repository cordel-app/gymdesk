'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle } from '@/components/ui';

interface LibraryItem {
  id: number;
  name: string;
  category: string;
  status: 'active' | 'deleted';
  created_at: string;
  modified_at: string | null;
}

const CATEGORIES = ['main_dish', 'side', 'sauce', 'drink', 'dessert', 'other'] as const;
type Category = typeof CATEGORIES[number];

export default function CordelNutritionLibraryPage() {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDeleted, setShowDeleted] = useState(false);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCategory, setNewCategory] = useState<Category>('main_dish');
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<LibraryItem | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<Category>('main_dish');

  const [deleting, setDeleting] = useState<LibraryItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = showDeleted ? '?status=deleted' : '';
      setItems(await apiFetch<LibraryItem[]>(`/platform/nutrition-library${params}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, showDeleted]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/platform/nutrition-library', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim(), category: newCategory }),
      });
      setCreating(false); setNewName('');
      toast('Item created', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch(`/platform/nutrition-library/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim(), category: editCategory }),
      });
      setEditing(null);
      toast('Item updated', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/nutrition-library/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Item deleted', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Base Nutrition Library</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, cursor: 'pointer' }}>
            <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} />
            Show deleted
          </label>
          <button style={btnStyle()} onClick={() => setCreating(true)}>+ New Item</button>
        </div>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : (
        CATEGORIES.map(cat => {
          const catItems = items.filter(i => i.category === cat);
          if (catItems.length === 0) return null;
          return (
            <section key={cat} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, textTransform: 'capitalize' }}>
                {cat.replace('_', ' ')}
              </h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <tbody>
                  {catItems.map(item => (
                    <tr key={item.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
                      <td style={{ padding: '10px 8px', fontWeight: 500 }}>{item.name}</td>
                      <td style={{ padding: '10px 8px' }}>
                        <StatusBadge status={item.status} label={item.status} />
                      </td>
                      <td style={{ padding: '10px 8px', width: 40, textAlign: 'right' }}>
                        {item.status !== 'deleted' && (
                          <ContextMenu items={[
                            {
                              label: 'Edit',
                              onClick: () => {
                                setEditing(item);
                                setEditName(item.name);
                                setEditCategory(item.category as Category);
                              },
                            },
                            {
                              label: 'Delete',
                              danger: true,
                              onClick: () => setDeleting(item),
                            },
                          ]} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}

      <CrudModal
        open={creating}
        title="New Library Item"
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Create"
      >
        <FormLabel>Name</FormLabel>
        <input
          className="form-input"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="e.g. Chicken"
          autoFocus
        />
        <FormLabel>Category</FormLabel>
        <select className="form-input" value={newCategory} onChange={e => setNewCategory(e.target.value as Category)}>
          {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
        </select>
      </CrudModal>

      <CrudModal
        open={editing !== null}
        title="Edit Library Item"
        onCancel={() => setEditing(null)}
        onSave={handleEdit}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Save"
      >
        <FormLabel>Name</FormLabel>
        <input
          className="form-input"
          value={editName}
          onChange={e => setEditName(e.target.value)}
          autoFocus
        />
        <FormLabel>Category</FormLabel>
        <select className="form-input" value={editCategory} onChange={e => setEditCategory(e.target.value as Category)}>
          {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
        </select>
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={`Delete "${deleting?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
