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
import { CrudModal } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

const TYPES = ['fee', 'service', 'sessions', 'merchandise', 'other'] as const;
const STATUSES = ['active', 'inactive'] as const;
const ENROLLMENT_STATUSES = ['public', 'staff_only'] as const;
const FREQUENCIES = ['once', 'per_session', 'week', 'month', 'year'] as const;

type ItemType = typeof TYPES[number];
type ItemStatus = typeof STATUSES[number];
type EnrollmentStatus = typeof ENROLLMENT_STATUSES[number];
type Frequency = typeof FREQUENCIES[number];

interface SellableItem {
  id: number;
  gym_id: string;
  charge_type_id: number | null;
  charge_type_code: string | null;
  charge_type_name: string | null;
  name: string;
  type: ItemType;
  units: number | null;
  status: ItemStatus;
  enrollment_status: EnrollmentStatus;
  is_system: number;
  description: string | null;
  amount: string | null;
  currency: string;
  billing_frequency: Frequency | null;
  availability: string;
  notes: string | null;
  package_information: string | null;
  validity_days: number | null;
  tax_rate_id: number | null;
  tax_behavior: 'inclusive' | 'exclusive';
  tax_rate_name: string | null;
  tax_rate_percent: string | null;
  amount_excl_tax: number | null;
  amount_incl_tax: number | null;
  applied_tax_rate: number | null;
  deleted_at: string | null;
  created_at: string;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
}

type EditForm = {
  name: string;
  type: ItemType;
  units: string;
  description: string;
  amount: string;
  billing_frequency: string;
  status: ItemStatus;
  enrollment_status: EnrollmentStatus;
  notes: string;
  package_information: string;
  validity_days: string;
};

type InlineNew = {
  name: string;
  type: ItemType;
  units: string;
  amount: string;
  billing_frequency: string;
  saving: boolean;
  error: string | null;
};

function emptyEditForm(item: SellableItem): EditForm {
  return {
    name: item.name,
    type: item.type,
    units: item.units != null ? String(item.units) : '',
    description: item.description ?? '',
    amount: item.amount != null ? parseFloat(item.amount).toString() : '',
    billing_frequency: item.billing_frequency ?? '',
    status: item.status,
    enrollment_status: item.enrollment_status,
    notes: item.notes ?? '',
    package_information: item.package_information ?? '',
    validity_days: item.validity_days != null ? String(item.validity_days) : '',
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtAmount(amount: string | null, currency: string) {
  if (amount == null) return '—';
  const sym = currency === 'EUR' ? '€' : currency;
  return `${sym}${parseFloat(amount).toFixed(2)}`;
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SellableItemsPage() {
  const t = useTranslations('sellable_items');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [items, setItems] = useState<SellableItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [details, setDetails] = useState<SellableItem | null>(null);
  const [deleting, setDeleting] = useState<SellableItem | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
  }, [gymLoading, isAdmin]);

  useEffect(() => {
    if (!gymLoading && isAdmin) load();
  }, [activeGymId, gymLoading, typeFilter, statusFilter]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set('type', typeFilter);
      if (statusFilter) params.set('status', statusFilter);
      if (searchQ.trim()) params.set('q', searchQ.trim());
      const qs = params.toString();
      setItems(await apiFetch<SellableItem[]>(`/sellable-items${qs ? `?${qs}` : ''}`));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    load();
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
    setInlineNew({ name: '', type: 'fee', units: '', amount: '', billing_frequency: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() { setInlineNew(null); }

  async function saveInlineNew() {
    if (!inlineNew || !activeGymId) return;
    if (!inlineNew.name.trim()) {
      setInlineNew({ ...inlineNew, error: t('error_name_required') });
      return;
    }
    if (!inlineNew.type) {
      setInlineNew({ ...inlineNew, error: t('error_type_required') });
      return;
    }
    if (inlineNew.units !== '' && (isNaN(Number(inlineNew.units)) || !Number.isInteger(Number(inlineNew.units)) || Number(inlineNew.units) <= 0)) {
      setInlineNew({ ...inlineNew, error: t('error_units_positive') });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<SellableItem>('/sellable-items', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          type: inlineNew.type,
          units: inlineNew.units !== '' ? parseInt(inlineNew.units, 10) : null,
          amount: inlineNew.amount !== '' ? parseFloat(inlineNew.amount) : null,
          billing_frequency: inlineNew.billing_frequency || null,
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  function openEdit(item: SellableItem) {
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

  async function handleSave(item: SellableItem) {
    if (!editForm) return;
    if (!item.is_system && !editForm.name.trim()) { setEditError(t('error_name_required')); return; }
    if (editForm.units !== '' && (isNaN(Number(editForm.units)) || !Number.isInteger(Number(editForm.units)) || Number(editForm.units) <= 0)) {
      setEditError(t('error_units_positive')); return;
    }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/sellable-items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim() || undefined,
          type: editForm.type || undefined,
          units: editForm.units !== '' ? parseInt(editForm.units, 10) : null,
          description: editForm.description.trim() || null,
          amount: editForm.amount !== '' ? parseFloat(editForm.amount) : null,
          billing_frequency: editForm.billing_frequency || null,
          status: editForm.status,
          enrollment_status: editForm.enrollment_status,
          notes: editForm.notes.trim() || null,
          package_information: editForm.package_information.trim() || null,
          validity_days: editForm.validity_days !== '' ? parseInt(editForm.validity_days, 10) : null,
        }),
      });
      setEditingId(null);
      setEditForm(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Activate / Deactivate ───────────────────────────────────────────────────

  async function handleActivate(item: SellableItem) {
    try {
      await apiFetch(`/sellable-items/${item.id}/activate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  async function handleDeactivate(item: SellableItem) {
    try {
      await apiFetch(`/sellable-items/${item.id}/deactivate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/sellable-items/${deleting.id}`, { method: 'DELETE' });
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

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
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
              <label style={inlineLabelStyle}>{t('label_type')} *</label>
              <select
                value={inlineNew.type}
                onChange={(e) => setInlineNew({ ...inlineNew, type: e.target.value as ItemType })}
                style={inlineSelectStyle}
              >
                {TYPES.map((tp) => <option key={tp} value={tp}>{t(`type_${tp}`)}</option>)}
              </select>
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_units')}</label>
              <input
                type="number" min="1" step="1"
                value={inlineNew.units}
                onChange={(e) => setInlineNew({ ...inlineNew, units: e.target.value })}
                placeholder="—"
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_amount')}</label>
              <input
                type="number" min="0" step="0.01"
                value={inlineNew.amount}
                onChange={(e) => setInlineNew({ ...inlineNew, amount: e.target.value })}
                placeholder="0.00"
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_frequency')}</label>
              <select
                value={inlineNew.billing_frequency}
                onChange={(e) => setInlineNew({ ...inlineNew, billing_frequency: e.target.value })}
                style={inlineSelectStyle}
              >
                <option value="">—</option>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`frequency_${f}`)}</option>)}
              </select>
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

  function renderRow(item: SellableItem) {
    const isExpanded = expanded.has(item.id);
    const isEditing = editingId === item.id;
    const isSystem = Boolean(item.is_system);

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
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.name}
            {isSystem && (
              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#888', background: '#f0f0f0', borderRadius: 4, padding: '1px 5px', verticalAlign: 'middle' }}>
                {t('system_badge')}
              </span>
            )}
          </div>
          <div style={{ minWidth: 90, fontSize: 13, color: '#555', flexShrink: 0 }}>
            {t(`type_${item.type}`)}
          </div>
          <div style={{ minWidth: 70, fontSize: 13, color: '#555', flexShrink: 0, textAlign: 'right' }}>
            {item.units != null ? item.units : '—'}
          </div>
          <div style={{ minWidth: 110, fontSize: 13, flexShrink: 0 }}>
            {item.amount_incl_tax != null
              ? `${item.currency === 'EUR' ? '€' : item.currency}${item.amount_incl_tax.toFixed(2)} ${t(item.tax_behavior === 'exclusive' ? 'taxExcluded' : 'taxIncluded')}`
              : fmtAmount(item.amount, item.currency)}
          </div>
          <div style={{ minWidth: 80, fontSize: 13, color: '#666', flexShrink: 0 }}>
            {item.applied_tax_rate != null
              ? item.applied_tax_rate === 0 ? t('exempt') : `${item.applied_tax_rate}%`
              : '—'}
          </div>
          <div style={{ minWidth: 90, fontSize: 13, color: '#666', flexShrink: 0 }}>
            {item.billing_frequency ? t(`frequency_${item.billing_frequency}`) : '—'}
          </div>
          <div style={{ minWidth: 80, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {item.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 85, fontSize: 13, color: '#888', flexShrink: 0 }}>
            {fmtDate(item.created_at)}
          </div>
          <div style={{ minWidth: 80, flexShrink: 0 }}>
            <StatusBadge status={item.status} label={tStatus(item.status)} />
          </div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge
              status={item.enrollment_status === 'public' ? 'active' : 'paused'}
              label={tStatus(item.enrollment_status)}
            />
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
          </div>
        </div>

        {/* Inline edit */}
        {isEditing && editForm && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {!isSystem && (
                <div>
                  <label style={inlineLabelStyle}>{t('label_name')} *</label>
                  <input
                    value={editForm.name}
                    onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                    autoFocus={!isSystem}
                    style={inlineInputStyle}
                  />
                </div>
              )}
              {!isSystem && (
                <div>
                  <label style={inlineLabelStyle}>{t('label_type')}</label>
                  <select
                    value={editForm.type}
                    onChange={(e) => setEditForm({ ...editForm, type: e.target.value as ItemType })}
                    style={inlineSelectStyle}
                  >
                    {TYPES.map((tp) => <option key={tp} value={tp}>{t(`type_${tp}`)}</option>)}
                  </select>
                </div>
              )}
              <div style={{ gridColumn: isSystem ? '1 / -1' : undefined }}>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <textarea
                  value={editForm.description}
                  onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                  rows={2}
                  style={{ ...inlineInputStyle, resize: 'vertical' }}
                />
              </div>
              {!isSystem && (
                <div>
                  <label style={inlineLabelStyle}>{t('label_units')}</label>
                  <input
                    type="number" min="1" step="1"
                    value={editForm.units}
                    onChange={(e) => setEditForm({ ...editForm, units: e.target.value })}
                    placeholder="—"
                    style={inlineInputStyle}
                  />
                </div>
              )}
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select
                  value={editForm.status}
                  onChange={(e) => setEditForm({ ...editForm, status: e.target.value as ItemStatus })}
                  style={inlineSelectStyle}
                >
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_enrollment_status')}</label>
                <select
                  value={editForm.enrollment_status}
                  onChange={(e) => setEditForm({ ...editForm, enrollment_status: e.target.value as EnrollmentStatus })}
                  style={inlineSelectStyle}
                >
                  {ENROLLMENT_STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
            </div>

            <SectionHeader title={t('section_billing')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_amount')}</label>
                <input
                  type="number" min="0" step="0.01"
                  value={editForm.amount}
                  onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                  placeholder="0.00"
                  style={inlineInputStyle}
                />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_frequency')}</label>
                <select
                  value={editForm.billing_frequency}
                  onChange={(e) => setEditForm({ ...editForm, billing_frequency: e.target.value })}
                  style={inlineSelectStyle}
                >
                  <option value="">—</option>
                  {FREQUENCIES.map((f) => <option key={f} value={f}>{t(`frequency_${f}`)}</option>)}
                </select>
              </div>
              {!isSystem && (
                <div>
                  <label style={inlineLabelStyle}>{t('label_validity_days')}</label>
                  <input
                    type="number" min="0" step="1"
                    value={editForm.validity_days}
                    onChange={(e) => setEditForm({ ...editForm, validity_days: e.target.value })}
                    placeholder="—"
                    style={inlineInputStyle}
                  />
                </div>
              )}
            </div>

            {!isSystem && (
              <>
                <SectionHeader title={t('section_package_info')} />
                <textarea
                  value={editForm.package_information}
                  onChange={(e) => setEditForm({ ...editForm, package_information: e.target.value })}
                  rows={3}
                  placeholder={t('placeholder_package_info')}
                  style={{ ...inlineInputStyle, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
                />
              </>
            )}

            <SectionHeader title={t('section_notes')} />
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              style={{ ...inlineInputStyle, resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
            />

            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
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
            <SectionHeader title={t('section_general')} />
            <DetailRow label={t('label_description')} value={item.description ?? '—'} />
            <DetailRow label={t('label_type')} value={t(`type_${item.type}`)} />
            <DetailRow label={t('label_units')} value={item.units != null ? String(item.units) : '—'} />
            <DetailRow label={t('label_status')} value={tStatus(item.status)} />
            <DetailRow label={t('label_enrollment_status')} value={tStatus(item.enrollment_status)} />

            <SectionHeader title={t('section_billing')} />
            <DetailRow label={t('label_amount')} value={fmtAmount(item.amount, item.currency)} />
            <DetailRow label={t('label_frequency')} value={item.billing_frequency ? t(`frequency_${item.billing_frequency}`) : '—'} />
            {!isSystem && <DetailRow label={t('label_validity_days')} value={item.validity_days != null ? String(item.validity_days) : '—'} />}

            {!isSystem && item.package_information && (
              <>
                <SectionHeader title={t('section_package_info')} />
                <p style={{ margin: '4px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{item.package_information}</p>
              </>
            )}

            <SectionHeader title={t('section_notes')} />
            <p style={{ margin: '4px 0 0', fontSize: 13, color: item.notes ? '#333' : '#aaa', whiteSpace: 'pre-wrap' }}>
              {item.notes ?? '—'}
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
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: 6 }}>
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder={t('search_placeholder')}
              style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, width: 180 }}
            />
            <button type="submit" style={btnSmall('#6c63ff')}>{t('search')}</button>
          </form>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, background: '#fff' }}
          >
            <option value="">{t('filter_all_types')}</option>
            {TYPES.map((tp) => <option key={tp} value={tp}>{t(`type_${tp}`)}</option>)}
          </select>
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
      {(items.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ minWidth: 90 }}>{t('col_type')}</div>
          <div style={{ minWidth: 70, textAlign: 'right' }}>{t('col_units')}</div>
          <div style={{ minWidth: 110 }}>{t('col_amount')}</div>
          <div style={{ minWidth: 80 }}>{t('col_tax_rate')}</div>
          <div style={{ minWidth: 90 }}>{t('col_frequency')}</div>
          <div style={{ minWidth: 80 }}>{t('col_created_by')}</div>
          <div style={{ minWidth: 85 }}>{t('col_created_at')}</div>
          <div style={{ minWidth: 80 }}>{t('col_status')}</div>
          <div style={{ minWidth: 90 }}>{t('col_enrollment_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new */}
      {renderInlineNewRow()}

      {/* List */}
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
            <ModalSection title={t('section_general')} />
            <ModalField label={t('label_name')} value={details.name} />
            <ModalField label={t('label_type')} value={t(`type_${details.type}`)} />
            <ModalField label={t('label_description')} value={details.description ?? '—'} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('label_units')} value={details.units != null ? String(details.units) : '—'} />
              <ModalField label={t('label_status')} value={tStatus(details.status)} />
              <ModalField label={t('label_enrollment_status')} value={tStatus(details.enrollment_status)} />
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <ModalSection title={t('section_billing')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('label_amount')} value={fmtAmount(details.amount, details.currency)} />
              <ModalField label={t('label_frequency')} value={details.billing_frequency ? t(`frequency_${details.billing_frequency}`) : '—'} />
              <ModalField label={t('label_validity_days')} value={details.validity_days != null ? String(details.validity_days) : '—'} />
            </div>

            {details.package_information && (
              <>
                <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
                <ModalSection title={t('section_package_info')} />
                <ModalField label="" value={details.package_information} />
              </>
            )}

            {details.notes && (
              <>
                <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
                <ModalSection title={t('section_notes')} />
                <ModalField label="" value={details.notes} />
              </>
            )}

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <ModalSection title={t('section_audit')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('audit_created_at')} value={fmtDate(details.created_at)} />
              <ModalField label={t('audit_created_by')} value={details.created_by_name ?? '—'} />
              <ModalField label={t('audit_modified_at')} value={fmtDate(details.modified_at)} />
              <ModalField label={t('audit_modified_by')} value={details.modified_by_name ?? '—'} />
              <ModalField label={t('audit_deleted_at')} value="—" />
              <ModalField label={t('audit_deleted_by')} value="—" />
            </div>
          </div>
        )}
      </CrudModal>

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
      <span style={{ color: '#111', flex: 1, whiteSpace: 'pre-wrap' }}>{value}</span>
    </div>
  );
}

function ModalSection({ title }: { title: string }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>;
}

function ModalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>}
      <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{value}</p>
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

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const errorStyle: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, color: '#c0392b' };
