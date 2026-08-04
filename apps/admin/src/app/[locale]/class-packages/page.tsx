'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Pkg {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  number_of_sessions: number;
  price: string;
  validity_days: number;
  status: 'active' | 'inactive';
  notes: string | null;
  created_at: string;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_membership_id: number | null;
  deleted_by_name: string | null;
}

const STATUSES = ['active', 'inactive'] as const;

const emptyEditForm = {
  name: '',
  description: '',
  number_of_sessions: '',
  price: '',
  validity_days: '',
  status: 'active' as Pkg['status'],
  notes: '',
};

type EditForm = typeof emptyEditForm;

type InlineNew = {
  name: string;
  description: string;
  number_of_sessions: string;
  saving: boolean;
  error: string | null;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ClassPackagesPage() {
  const t = useTranslations('class_packages');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [packages, setPackages] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [details, setDetails] = useState<Pkg | null>(null);
  const [deleting, setDeleting] = useState<Pkg | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
  }, [gymLoading, isAdmin]);

  useEffect(() => { if (!gymLoading && isAdmin) load(); }, [activeGymId, gymLoading, statusFilter]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setPackages(await apiFetch<Pkg[]>(`/class-packages${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Accordion ──────────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline new ─────────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew({ name: '', description: '', number_of_sessions: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() {
    setInlineNew(null);
  }

  async function saveInlineNew() {
    if (!inlineNew || !activeGymId) return;
    if (!inlineNew.name.trim()) {
      setInlineNew({ ...inlineNew, error: t('error_required') });
      return;
    }
    const sessions = parseInt(inlineNew.number_of_sessions, 10);
    if (isNaN(sessions) || sessions <= 0) {
      setInlineNew({ ...inlineNew, error: t('error_positive') });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<Pkg>('/class-packages', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          description: inlineNew.description.trim() || null,
          number_of_sessions: sessions,
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ─────────────────────────────────────────────────────────────────

  function openEdit(pkg: Pkg) {
    setEditingId(pkg.id);
    setEditForm({
      name: pkg.name,
      description: pkg.description ?? '',
      number_of_sessions: String(pkg.number_of_sessions),
      price: parseFloat(pkg.price).toString(),
      validity_days: String(pkg.validity_days),
      status: pkg.status,
      notes: pkg.notes ?? '',
    });
    setEditError(null);
    setExpanded((prev) => new Set([...prev, pkg.id]));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleSave(pkg: Pkg) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    const sessions = parseInt(editForm.number_of_sessions, 10);
    if (isNaN(sessions) || sessions <= 0) { setEditError(t('error_positive')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/class-packages/${pkg.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          number_of_sessions: sessions,
          price: editForm.price !== '' ? parseFloat(editForm.price) : undefined,
          validity_days: editForm.validity_days !== '' ? parseInt(editForm.validity_days, 10) : undefined,
          status: editForm.status,
          notes: editForm.notes.trim() || null,
        }),
      });
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ───────────────────────────────────────────────────────────────

  async function handleDuplicate(pkg: Pkg) {
    try {
      await apiFetch(`/class-packages/${pkg.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/class-packages/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) setEditingId(null);
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                placeholder={t('placeholder_name')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_sessions')} *</label>
              <input
                type="number" min="1" step="1"
                value={inlineNew.number_of_sessions}
                onChange={(e) => setInlineNew({ ...inlineNew, number_of_sessions: e.target.value })}
                style={inlineInputStyle}
              />
            </div>
          </div>
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall('#6c63ff')}>
              {inlineNew.saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderPackageRow(pkg: Pkg) {
    const isExpanded = expanded.has(pkg.id);
    const isEditing = editingId === pkg.id;

    const descText = pkg.description
      ? pkg.description.length > 70 ? pkg.description.slice(0, 70) + '…' : pkg.description
      : '—';

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(pkg) },
      { label: t('edit'), onClick: () => openEdit(pkg) },
      { label: t('duplicate'), onClick: () => handleDuplicate(pkg) },
      { label: t('delete'), onClick: () => setDeleting(pkg), danger: true },
    ];

    return (
      <div key={pkg.id} style={cardStyle}>
        {/* Collapsed header */}
        <div style={rowStyle} onClick={() => toggleExpand(pkg.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pkg.name}
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {descText}
          </div>
          <div style={{ minWidth: 100, fontSize: 13, color: '#555', flexShrink: 0 }}>
            {t('sessions_label', { n: pkg.number_of_sessions })}
          </div>
          <div style={{ minWidth: 90, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {fmtDate(pkg.created_at)}
          </div>
          <div style={{ minWidth: 100, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {pkg.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={pkg.status} label={tStatus(pkg.status)} />
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${pkg.name}`} />
          </div>
        </div>

        {/* Inline edit form */}
        {isEditing && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  autoFocus
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_sessions')} *</label>
                <input
                  type="number" min="1" step="1"
                  value={editForm.number_of_sessions}
                  onChange={(e) => setEditForm({ ...editForm, number_of_sessions: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={2}
                  style={{ ...inlineInputStyle, resize: 'vertical' }}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as Pkg['status'] })}
                  style={inlineSelectStyle}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
            </div>

            <SectionHeader title={t('section_configuration')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_price')}</label>
                <input
                  type="number" min="0" step="0.01"
                  value={editForm.price}
                  onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_validity')}</label>
                <input
                  type="number" min="0" step="1"
                  value={editForm.validity_days}
                  onChange={(e) => setEditForm({ ...editForm, validity_days: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
            </div>

            <SectionHeader title={t('section_availability')} />
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#aaa', fontStyle: 'italic' }}>{t('availability_placeholder')}</p>

            <SectionHeader title={t('section_restrictions')} />
            <p style={{ margin: '0 0 12px', fontSize: 13, color: '#aaa', fontStyle: 'italic' }}>{t('restrictions_placeholder')}</p>

            <SectionHeader title={t('section_notes')} />
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              placeholder={t('notes_placeholder')}
              style={{ ...inlineInputStyle, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />

            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(pkg)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                {editSaving ? t('saving') : t('save_changes')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded sections */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <DetailRow label={t('label_description')} value={pkg.description ?? '—'} />
            <DetailRow label={t('label_sessions')} value={t('sessions_label', { n: pkg.number_of_sessions })} />
            <DetailRow label={t('label_status')} value={tStatus(pkg.status)} />

            <SectionHeader title={t('section_availability')} />
            <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#aaa', fontStyle: 'italic' }}>{t('availability_placeholder')}</p>

            <SectionHeader title={t('section_restrictions')} />
            <p style={{ margin: '4px 0 12px', fontSize: 13, color: '#aaa', fontStyle: 'italic' }}>{t('restrictions_placeholder')}</p>

            <SectionHeader title={t('section_notes')} />
            <p style={{ margin: '4px 0 0', fontSize: 13, color: pkg.notes ? '#333' : '#aaa', whiteSpace: 'pre-wrap' }}>
              {pkg.notes ?? '—'}
            </p>
          </div>
        )}
      </div>
    );
  }

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={openInlineNew} style={btnStyle('#6c63ff')} disabled={inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {/* Column headers */}
      {(packages.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 3 }}>{t('col_description')}</div>
          <div style={{ minWidth: 100 }}>{t('col_package_info')}</div>
          <div style={{ minWidth: 90 }}>{t('col_created')}</div>
          <div style={{ minWidth: 100 }}>{t('col_created_by')}</div>
          <div style={{ minWidth: 90 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new row */}
      {renderInlineNewRow()}

      {/* Package list */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : packages.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {packages.map(renderPackageRow)}
        </div>
      )}

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
            <div>
              <span style={detailLabelStyle}>{t('details_name')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{details.name}</p>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('details_description')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.description ? '#333' : '#aaa' }}>
                {details.description ?? '—'}
              </p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_sessions')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{t('sessions_label', { n: details.number_of_sessions })}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_status')}</span>
                <div style={{ marginTop: 4 }}>
                  <StatusBadge status={details.status} label={tStatus(details.status)} />
                </div>
              </div>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_configuration')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_price')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{parseFloat(details.price).toFixed(2)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_validity')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{t('days_label', { n: details.validity_days })}</p>
              </div>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_notes')}</div>
            <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.notes ? '#333' : '#aaa' }}>
              {details.notes ?? '—'}
            </p>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>Audit</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('details_created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{new Date(details.created_at).toLocaleString()}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_at ? new Date(details.modified_at).toLocaleString() : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by_name ?? '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_at ? new Date(details.deleted_at).toLocaleString() : '—'}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_deleted_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_by_name ?? '—'}</p>
              </div>
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={`${t('confirm_delete_title')}\n\n${t('confirm_delete_body')}`}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid var(--gd-border, #eee)', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1 }}>{value}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e2e6', borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailSectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const errorStyle: React.CSSProperties = {
  margin: '8px 0 0', fontSize: 13, color: '#c0392b',
};
