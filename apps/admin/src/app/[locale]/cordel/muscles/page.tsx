'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ContextMenu } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ExerciseImageField } from '@/components/ExerciseImageField';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { cardSurfaceStyle, primaryBtnStyle, primaryBtnSmall, overlayStyle, modalStyle, btnStyle } from '@/components/ui';
import { formControlStyle, formFieldLabelStyle, inlineActionsRowStyle, secondaryBtnSmall, formErrorStyle } from '@/components/formChrome';
import { formatExerciseTimestamp, exerciseDisplayValue } from '@/components/exercises/exerciseForm';
import { SAFE_IMAGE_SRC } from '@/lib/exerciseImageUpload';

/**
 * #1368 stage 3 — Cordel → Muscles: the global muscle catalogue and its image
 * pair. Every route is `/platform/muscles` (superadmin); the image control is
 * the Base Exercise one, pointed at that route (`basePath`) and told no gym
 * bucket is involved (`requiresGymStorage={false}`), so there is one upload UI.
 */
const API_BASE = '/platform/muscles';

interface Muscle {
  id: number;
  slug: string;
  name: string;
  image_url: string | null;
  image_thumbnail_url: string | null;
  exercise_count: number;
  created_by: string | null;
  modified_by: string | null;
  created_at?: string | null;
  modified_at?: string | null;
}

export default function CordelMusclesPage() {
  const t = useTranslations('muscles_page');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const [rows, setRows] = useState<Muscle[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Muscle | null>(null);
  const [details, setDetails] = useState<Muscle | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch(`${API_BASE}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
      setRows(Array.isArray(data) ? data : []);
    } catch (err: any) {
      toast(err.message ?? t('load_failed'), 'error');
    } finally {
      setLoading(false);
    }
  }, [apiFetch, q, toast, t]);

  useEffect(() => { void load(); }, [load]);

  function replaceRow(updated: Muscle) {
    setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
  }

  async function create() {
    if (!newName.trim()) { setError(t('name_required')); return; }
    setSaving(true); setError(null);
    try {
      await apiFetch(API_BASE, { method: 'POST', body: JSON.stringify({ name: newName.trim() }) });
      setCreating(false); setNewName('');
      toast(t('saved'), 'success');
      await load();
    } catch (err: any) {
      setError(err.message ?? t('save_failed'));
    } finally { setSaving(false); }
  }

  async function saveEdit(row: Muscle) {
    if (!editName.trim()) { setError(t('name_required')); return; }
    setSaving(true); setError(null);
    try {
      if (editName.trim() !== row.name) {
        const updated = await apiFetch<Muscle>(`${API_BASE}/${row.id}`, { method: 'PUT', body: JSON.stringify({ name: editName.trim() }) });
        replaceRow(updated);
      }
      setEditingId(null);
      toast(t('saved'), 'success');
    } catch (err: any) {
      setError(err.message ?? t('save_failed'));
    } finally { setSaving(false); }
  }

  async function confirmDelete() {
    if (!deleting) return;
    const row = deleting;
    try {
      await apiFetch(`${API_BASE}/${row.id}`, { method: 'DELETE' });
      setDeleting(null);
      toast(t('deleted'), 'success');
      await load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('save_failed'), 'error');
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button type="button" style={primaryBtnStyle()} onClick={() => { setCreating(true); setError(null); }}>{t('add')}</button>
      </div>

      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('search')}
        aria-label={t('search')}
        style={{ ...formControlStyle, maxWidth: 320, marginBottom: 16 }}
      />

      {creating && (
        <div style={{ ...cardSurfaceStyle, padding: 16, marginBottom: 12 }}>
          <label style={formFieldLabelStyle}>{t('name')}</label>
          <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} style={formControlStyle} aria-label={t('name')} />
          <p style={{ fontSize: 12, color: '#888', margin: '8px 0' }}>{t('image_after_create')}</p>
          {error && <p style={formErrorStyle}>{error}</p>}
          <div style={inlineActionsRowStyle}>
            <button type="button" style={primaryBtnSmall()} disabled={saving} onClick={create}>{saving ? t('saving') : t('save')}</button>
            <button type="button" style={secondaryBtnSmall} disabled={saving} onClick={() => { setCreating(false); setNewName(''); setError(null); }}>{t('cancel')}</button>
          </div>
        </div>
      )}

      {loading ? null : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : rows.map((row) => {
        const thumb = row.image_thumbnail_url ?? row.image_url;
        const editing = editingId === row.id;
        return (
          <div key={row.id} style={{ ...cardSurfaceStyle, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 48, height: 48, borderRadius: 6, overflow: 'hidden', flex: '0 0 auto', background: '#f3f4f6' }}>
                {thumb && SAFE_IMAGE_SRC.test(thumb) && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumb} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name}>{row.name}</div>
                <div style={{ fontSize: 12, color: '#888' }}>
                  {t('slug')}: {row.slug} · {t('exercises')}: {row.exercise_count}
                </div>
              </div>
              <ContextMenu
                ariaLabel={row.name}
                items={[
                  { label: t('edit'), onClick: () => { setEditingId(row.id); setEditName(row.name); setError(null); } },
                  { label: t('details'), onClick: () => setDetails(row) },
                  {
                    label: t('delete'), danger: true,
                    disabled: row.exercise_count > 0,
                    title: row.exercise_count > 0 ? t('in_use', { count: row.exercise_count }) : undefined,
                    onClick: () => setDeleting(row),
                  },
                ]}
              />
            </div>

            {editing && (
              <div style={{ marginTop: 12 }}>
                <label style={formFieldLabelStyle}>{t('name')}</label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} style={formControlStyle} aria-label={t('name')} />
                <div style={{ marginTop: 12, maxWidth: 240 }}>
                  <label style={formFieldLabelStyle}>{t('image')}</label>
                  <ExerciseImageField
                    exerciseId={row.id}
                    imageUrl={row.image_url}
                    thumbnailUrl={row.image_thumbnail_url}
                    basePath={API_BASE}
                    requiresGymStorage={false}
                    onChanged={(updated) => replaceRow(updated as Muscle)}
                  />
                </div>
                {error && <p style={formErrorStyle}>{error}</p>}
                <div style={{ ...inlineActionsRowStyle, marginTop: 12 }}>
                  <button type="button" style={primaryBtnSmall()} disabled={saving} onClick={() => saveEdit(row)}>{saving ? t('saving') : t('save')}</button>
                  <button type="button" style={secondaryBtnSmall} disabled={saving} onClick={() => { setEditingId(null); setError(null); }}>{t('cancel')}</button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {details && (
        <div style={overlayStyle} onClick={() => setDetails(null)}>
          <div style={{ ...modalStyle, width: 520, maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 4px' }}>{t('detail_title')}</h2>
            <p style={{ margin: '0 0 20px', color: '#666', fontSize: 14 }}>{details.name}</p>
            {([
              [t('name'), details.name],
              [t('slug'), details.slug],
              [t('exercises'), String(details.exercise_count)],
              [t('col_created_at'), formatExerciseTimestamp(details.created_at)],
              [t('created_by'), exerciseDisplayValue(details.created_by)],
              [t('col_modified_at'), formatExerciseTimestamp(details.modified_at)],
              [t('modified_by'), exerciseDisplayValue(details.modified_by)],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label} style={{ display: 'flex', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--gd-card-border, #f5f5f5)' }}>
                <span style={{ width: 160, flexShrink: 0, fontSize: 13, color: '#888', fontWeight: 500 }}>{label}</span>
                <span style={{ fontSize: 13, color: '#333' }}>{value}</span>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
              <ViewAuditLogButton entityType="muscle" entityId={details.id} scope="platform" onNavigate={() => setDetails(null)} />
              <button type="button" onClick={() => setDetails(null)} style={btnStyle('#444')}>{t('close')}</button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting != null}
        message={deleting ? t('confirm_delete', { name: deleting.name }) : ''}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
