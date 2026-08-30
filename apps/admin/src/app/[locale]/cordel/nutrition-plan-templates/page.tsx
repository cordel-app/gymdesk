'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
import {
  NutritionPlanTree,
  Hierarchy,
} from '../../nutrition/nutrition-plan-templates/NutritionPlanTree';

const API_BASE = '/platform/nutrition-plan-templates';

interface BaseTemplate {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'inactive' | 'draft' | 'deleted';
  day_count: number;
  created_at: string;
  modified_at: string | null;
}

export default function CordelNutritionPlanTemplatesPage() {
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [templates, setTemplates] = useState<BaseTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(false);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', status: 'draft' });
  const [saving, setSaving] = useState(false);

  const [editing, setEditing] = useState<BaseTemplate | null>(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', status: 'draft' });

  const [deleting, setDeleting] = useState<BaseTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTemplates(await apiFetch<BaseTemplate[]>(API_BASE));
    } catch { /* ignore */ } finally { setLoading(false); }
  }, [apiFetch]);

  useEffect(() => { load(); }, [load]);

  async function expand(id: number) {
    if (expandedId === id) { setExpandedId(null); setHierarchy(null); return; }
    setExpandedId(id);
    setHierarchyLoading(true);
    try {
      setHierarchy(await apiFetch<Hierarchy>(`${API_BASE}/${id}/hierarchy`));
    } catch { setHierarchy(null); } finally { setHierarchyLoading(false); }
  }

  async function reloadHierarchy() {
    if (!expandedId) return;
    try { setHierarchy(await apiFetch<Hierarchy>(`${API_BASE}/${expandedId}/hierarchy`)); } catch { /* ignore */ }
  }

  async function handleCreate() {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await apiFetch(API_BASE, {
        method: 'POST',
        body: JSON.stringify({ name: form.name.trim(), description: form.description || null, status: form.status }),
      });
      setCreating(false); setForm({ name: '', description: '', status: 'draft' });
      toast('Template created', 'success');
      load();
    } catch (e: any) {
      toast(e.message ?? 'Error');
    } finally { setSaving(false); }
  }

  async function handleEdit() {
    if (!editing) return;
    setSaving(true);
    try {
      await apiFetch(`${API_BASE}/${editing.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editForm.name.trim(), description: editForm.description || null, status: editForm.status }),
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
      await apiFetch(`${API_BASE}/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) { setExpandedId(null); setHierarchy(null); }
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
        <h1>Base Nutrition Plan Templates</h1>
        <button style={btnStyle()} onClick={() => setCreating(true)}>+ New Template</button>
      </div>

      {loading ? (
        <p>Loading…</p>
      ) : templates.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>No base templates yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {templates.map(tpl => (
            <div key={tpl.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 8px', cursor: 'pointer' }}
                onClick={() => expand(tpl.id)}
              >
                <span style={{ fontSize: 18, userSelect: 'none' }}>{expandedId === tpl.id ? '▾' : '▸'}</span>
                <span style={{ fontWeight: 500, flex: 1 }}>{tpl.name}</span>
                <StatusBadge status={tpl.status} label={tpl.status} />
                <span style={{ fontSize: 12, color: '#9ca3af' }}>{tpl.day_count} days</span>
                <span onClick={e => e.stopPropagation()}>
                  <ContextMenu items={[
                    {
                      label: 'Edit',
                      onClick: () => {
                        setEditing(tpl);
                        setEditForm({ name: tpl.name, description: tpl.description ?? '', status: tpl.status });
                      },
                    },
                    {
                      label: 'Delete',
                      danger: true,
                      onClick: () => setDeleting(tpl),
                    },
                  ]} />
                </span>
              </div>
              {expandedId === tpl.id && (
                <div style={{ paddingLeft: 32, paddingBottom: 16 }}>
                  {hierarchyLoading ? (
                    <p style={{ fontSize: 13, color: '#9ca3af' }}>Loading…</p>
                  ) : hierarchy ? (
                    <NutritionPlanTree
                      templateId={tpl.id}
                      hierarchy={hierarchy}
                      canWrite
                      onChanged={reloadHierarchy}
                      apiBase={API_BASE}
                    />
                  ) : (
                    <p style={{ fontSize: 13, color: '#9ca3af' }}>Failed to load hierarchy.</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <CrudModal
        open={creating}
        title="New Base Template"
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Create"
      >
        <FormLabel>Name</FormLabel>
        <input className="form-input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
        <FormLabel>Description</FormLabel>
        <textarea className="form-input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} rows={2} />
        <FormLabel>Status</FormLabel>
        <select className="form-input" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
      </CrudModal>

      <CrudModal
        open={editing !== null}
        title="Edit Base Template"
        onCancel={() => setEditing(null)}
        onSave={handleEdit}
        saving={saving}
        cancelLabel="Cancel"
        saveLabel="Save"
      >
        <FormLabel>Name</FormLabel>
        <input className="form-input" value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} autoFocus />
        <FormLabel>Description</FormLabel>
        <textarea className="form-input" value={editForm.description} onChange={e => setEditForm(f => ({ ...f, description: e.target.value }))} rows={2} />
        <FormLabel>Status</FormLabel>
        <select className="form-input" value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}>
          <option value="draft">Draft</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
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
