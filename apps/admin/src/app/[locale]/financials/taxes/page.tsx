'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

const STATUSES = ['active', 'inactive'] as const;
type TaxStatus = typeof STATUSES[number];
type ActorType = 'staff' | 'superadmin';

interface TaxImpact {
  sellable_items: number;
  membership_plans: number;
}

interface TaxRate {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  rate_percent: string;
  is_system: number;
  status: TaxStatus;
  deleted_at: string | null;
  created_at: string;
  modified_at: string | null;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  created_by_type: ActorType | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
  modified_by_type: ActorType | null;
}

type EditForm = {
  name: string;
  description: string;
  rate_percent: string;
  status: TaxStatus;
};

type InlineNew = {
  name: string;
  description: string;
  rate_percent: string;
  saving: boolean;
  error: string | null;
};

function emptyEditForm(item: TaxRate): EditForm {
  return {
    name: item.name,
    description: item.description ?? '',
    rate_percent: parseFloat(item.rate_percent).toString(),
    status: item.status,
  };
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TaxesPage() {
  const t = useTranslations('taxes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [items, setItems] = useState<TaxRate[]>([]);
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [pendingImpact, setPendingImpact] = useState<{ item: TaxRate; impact: TaxImpact } | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [details, setDetails] = useState<TaxRate | null>(null);
  const [deleting, setDeleting] = useState<TaxRate | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
  }, [gymLoading, isAdmin]);

  useEffect(() => {
    if (!gymLoading && isAdmin) load();
  }, [activeGymId, gymLoading]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setItems(await apiFetch<TaxRate[]>('/taxes'));
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
    setInlineNew({ name: '', description: '', rate_percent: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() { setInlineNew(null); }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) { setInlineNew({ ...inlineNew, error: t('error_name_required') }); return; }
    const rate = parseFloat(inlineNew.rate_percent);
    if (isNaN(rate) || rate < 0 || rate > 100) { setInlineNew({ ...inlineNew, error: t('error_rate_invalid') }); return; }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch('/taxes', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          description: inlineNew.description.trim() || null,
          rate_percent: rate,
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  function openEdit(item: TaxRate) {
    setEditingId(item.id);
    setEditForm(emptyEditForm(item));
    setEditError(null);
    setExpanded((prev) => new Set([...prev, item.id]));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditError(null);
  }

  async function submitSave(item: TaxRate, confirmImpact: boolean) {
    if (!editForm) return;
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/taxes/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          rate_percent: parseFloat(editForm.rate_percent),
          status: editForm.status,
          confirmImpact,
        }),
      });
      setPendingImpact(null);
      cancelEdit();
      load();
    } catch (err: any) {
      if (err.status === 409 && err.body?.error === 'confirmation_required') {
        setPendingImpact({ item, impact: err.body.impact });
      } else {
        setEditError(err.message ?? t('error_generic'));
      }
    } finally {
      setEditSaving(false);
    }
  }

  async function handleSave(item: TaxRate) {
    if (!editForm) return;
    if (!editForm.name.trim()) { setEditError(t('error_name_required')); return; }
    const rate = parseFloat(editForm.rate_percent);
    if (isNaN(rate) || rate < 0 || rate > 100) { setEditError(t('error_rate_invalid')); return; }
    await submitSave(item, false);
  }

  async function handleConfirmImpact() {
    if (!pendingImpact) return;
    await submitSave(pendingImpact.item, true);
  }

  // ─── Activate / Deactivate ───────────────────────────────────────────────────

  async function handleActivate(item: TaxRate) {
    try {
      await apiFetch(`/taxes/${item.id}/activate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  async function handleDeactivate(item: TaxRate) {
    try {
      await apiFetch(`/taxes/${item.id}/deactivate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/taxes/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) { setEditingId(null); setEditForm(null); }
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function actorLabel(name: string | null, type: ActorType | null) {
    if (!name) return '—';
    if (!type) return name;
    return `${name} · ${type === 'superadmin' ? t('actor_superadmin') : t('actor_staff')}`;
  }

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr', gap: 12, marginBottom: 12 }}>
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
                placeholder={t('placeholder_description')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_rate')}</label>
              <input
                type="number" min="0" max="100" step="0.01"
                value={inlineNew.rate_percent}
                onChange={(e) => setInlineNew({ ...inlineNew, rate_percent: e.target.value })}
                placeholder="21.00"
                style={inlineInputStyle}
              />
            </div>
          </div>
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall('#6c63ff')}>
              {inlineNew.saving ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  function renderRow(item: TaxRate) {
    const isSystem = Boolean(item.is_system);
    const isExpanded = expanded.has(item.id);
    const isEditing = editingId === item.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(item) },
      { label: t('edit'), onClick: () => openEdit(item) },
      item.status === 'active'
        ? { label: t('deactivate'), onClick: () => handleDeactivate(item) }
        : { label: t('activate'), onClick: () => handleActivate(item) },
      ...(!isSystem ? [{ label: t('delete'), onClick: () => setDeleting(item), danger: true }] : []),
    ];

    return (
      <div key={item.id} style={cardStyle}>
        {/* Collapsed header */}
        <div style={rowStyle} onClick={() => toggleExpand(item.id)}>
          <div style={{ flex: 2, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name}
              {isSystem && (
                <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#888', background: '#f0f0f0', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle' }}>
                  {t('system_badge')}
                </span>
              )}
            </div>
            {item.description && (
              <div style={{ fontSize: 12.5, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                {item.description}
              </div>
            )}
          </div>
          <div style={{ minWidth: 80, fontSize: 13, color: '#555', flexShrink: 0, textAlign: 'right' }}>
            {parseFloat(item.rate_percent) === 0 ? '0%' : `${parseFloat(item.rate_percent)}%`}
          </div>
          <div style={{ minWidth: 100, flexShrink: 0 }}>
            <StatusBadge status={item.status} label={tStatus(item.status)} />
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
          </div>
        </div>

        {/* Inline edit */}
        {isEditing && editForm && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
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
                <label style={inlineLabelStyle}>{t('label_rate')}</label>
                <input
                  type="number" min="0" max="100" step="0.01"
                  value={editForm.rate_percent}
                  onChange={(e) => setEditForm({ ...editForm, rate_percent: e.target.value })}
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as TaxStatus })}
                  style={inlineSelectStyle}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                placeholder={t('placeholder_description')}
                style={inlineInputStyle}
              />
            </div>
            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(item)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                {editSaving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <DetailRow label={t('label_description')} value={item.description ?? t('no_description')} />
          </div>
        )}
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (gymLoading || !isAdmin) return null;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{t('title')}</h1>
        <button onClick={openInlineNew} style={btnStyle('#6c63ff')} disabled={inlineNew !== null}>{t('add')}</button>
      </div>

      {/* Column headers */}
      {(items.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ minWidth: 80, textAlign: 'right' }}>{t('col_rate')}</div>
          <div style={{ minWidth: 100 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new */}
      {renderInlineNewRow()}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : items.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map(renderRow)}
        </div>
      )}

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <ModalField label={t('label_name')} value={details.name} />
            <ModalField label={t('label_description')} value={details.description ?? t('no_description')} />
            <ModalField label={t('label_rate')} value={`${parseFloat(details.rate_percent)}%`} />
            <ModalField label={t('label_status')} value={tStatus(details.status)} />
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('audit_created_at')} value={fmtDate(details.created_at)} />
              <ModalField label={t('audit_created_by')} value={actorLabel(details.created_by_name, details.created_by_type)} />
              <ModalField label={t('audit_modified_at')} value={fmtDate(details.modified_at)} />
              <ModalField label={t('audit_modified_by')} value={actorLabel(details.modified_by_name, details.modified_by_type)} />
            </div>
          </div>
        )}
      </CrudModal>

      {/* Impact confirmation before persisting an edit */}
      <ConfirmDialog
        open={pendingImpact !== null}
        message={pendingImpact ? ((
          <div>
            <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('impact_title')}</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '0 0 8px' }}>
              <span>{t('impact_sellable_items')}: {t('impact_affected', { count: pendingImpact.impact.sellable_items })}</span>
              <span>{t('impact_membership_plans')}: {t('impact_affected', { count: pendingImpact.impact.membership_plans })}</span>
            </div>
            <p style={{ margin: 0 }}>{t('impact_body')}</p>
          </div>
        )) as any : ''}
        confirmLabel={t('impact_continue')}
        cancelLabel={t('cancel')}
        onConfirm={handleConfirmImpact}
        onCancel={() => setPendingImpact(null)}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={(<div><p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('confirm_delete_title')}</p><p style={{ margin: 0 }}>{t('confirm_delete_body')}</p></div>) as any}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1, whiteSpace: 'pre-wrap' }}>{value}</span>
    </div>
  );
}

function ModalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>}
      <p style={{ margin: '2px 0 0', fontSize: 14 }}>{value}</p>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--gd-card-border, #e2e2e6)',
  borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
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

const inlineSelectStyle: React.CSSProperties = inlineInputStyle;

const errorStyle: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, color: '#c0392b' };
