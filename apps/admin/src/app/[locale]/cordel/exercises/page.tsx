'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle } from '@/components/ui';

interface Exercise {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive';
  created_at: string;
}

export default function CordelExercisesPage() {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<Exercise[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<Exercise | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const [deleting, setDeleting] = useState<Exercise | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = search ? `?q=${encodeURIComponent(search)}` : '';
      setRows(await apiFetch<Exercise[]>(`/platform/exercises${qs}`));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch, search]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/platform/exercises', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() }),
      });
      setCreating(false); setNewName('');
      toast('Exercise created', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch(`/platform/exercises/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editName.trim(), description: editDescription.trim() || null }),
      });
      setEditing(null);
      toast('Exercise updated', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/exercises/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast('Exercise deleted', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1>Base Exercises</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 200 }}
          />
          <button style={btnStyle()} onClick={() => { setNewName(''); setCreating(true); }}>+ New Exercise</button>
        </div>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>No base exercises yet.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Name</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Description</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Status</th>
              <th style={{ textAlign: 'left', padding: '6px 8px' }}>Created</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
                <td style={{ padding: '10px 8px', fontWeight: 500 }}>{row.name}</td>
                <td style={{ padding: '10px 8px', color: '#666' }}>{row.description ?? '—'}</td>
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
        title="New Base Exercise"
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Create"
      >
        <FormLabel>Name *</FormLabel>
        <input className="form-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Bench Press" autoFocus />
      </CrudModal>

      <CrudModal
        open={editing !== null}
        title="Edit Base Exercise"
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
        message={`Delete base exercise "${deleting?.name}"?`}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
