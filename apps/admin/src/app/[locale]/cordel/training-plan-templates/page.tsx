'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle } from '@/components/ui';

interface TrainingPlanTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft' | 'deleted';
  workout_count: number;
  created_at: string;
}

interface PaginatedResponse {
  items: TrainingPlanTemplate[];
  total: number;
}

export default function CordelTrainingPlanTemplatesPage() {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [data, setData] = useState<PaginatedResponse>({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<TrainingPlanTemplate | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const [deleting, setDeleting] = useState<TrainingPlanTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = search ? `?name=${encodeURIComponent(search)}` : '';
      setData(await apiFetch<PaginatedResponse>(`/platform/training-plan-templates${qs}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, search]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/platform/training-plan-templates', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setCreating(false); setNewName('');
      toast('Training plan template created', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch(`/platform/training-plan-templates/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim(), description: editDescription.trim() || null }),
      });
      setEditing(null);
      toast('Template updated', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/training-plan-templates/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Template deleted', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Base Training Plan Templates</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 200 }}
          />
          <button style={btnStyle()} onClick={() => { setNewName(''); setCreating(true); }}>+ New Template</button>
        </div>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : data.items.length === 0 ? (
        <p style={{ color: '#888' }}>No base training plan templates yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Name</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Description</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Workouts</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Created</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {data.items.map(row => (
              <tr key={row.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td style={{ padding: '10px 8px', fontWeight: 500 }}>{row.name}</td>
                <td style={{ padding: '10px 8px', color: '#666' }}>{row.description ?? '—'}</td>
                <td style={{ padding: '10px 8px', color: '#888' }}>{row.workout_count}</td>
                <td style={{ padding: '10px 8px' }}>
                  <StatusBadge status={row.status} label={row.status} />
                </td>
                <td style={{ padding: '10px 8px', color: '#888' }}>{row.created_at?.slice(0, 10)}</td>
                <td style={{ padding: '10px 8px', textAlign: 'right' }}>
                  <ContextMenu items={[
                    {
                      label: 'Edit',
                      onClick: () => { setEditing(row); setEditName(row.name); setEditDescription(row.description ?? ''); },
                    },
                    { label: 'Delete', danger: true, onClick: () => setDeleting(row) },
                  ]} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CrudModal
        open={creating}
        title="New Base Training Plan Template"
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Create"
      >
        <FormLabel>Name *</FormLabel>
        <input className="form-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. 12-Week Strength Program" autoFocus />
      </CrudModal>

      <CrudModal
        open={editing !== null}
        title="Edit Base Training Plan Template"
        onCancel={() => setEditing(null)}
        onSave={handleEdit}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Save"
      >
        <FormLabel>Name *</FormLabel>
        <input className="form-input" value={editName} onChange={e => setEditName(e.target.value)} autoFocus />
        <FormLabel>Description</FormLabel>
        <input className="form-input" value={editDescription} onChange={e => setEditDescription(e.target.value)} />
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={`Delete base training plan template "${deleting?.name}"?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
