'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import { listNameBadgeAccentStyle, listNameBadgeStyle } from '@/components/listChrome';
import { formHelpTextStyle } from '@/components/formChrome';
import { Frequency, frequencyOptions, isLegacyFrequency } from './sellableItemFrequency';
import {
  SESSION_ITEM_TYPE,
  SessionPackageNote,
  sessionPackageNote,
  sessionPackageNoteForForm,
  taxNoteKey,
} from './sellableItemPriceNotes';

// ─── Types ────────────────────────────────────────────────────────────────────

const TYPES = ['fee', 'service', 'sessions', 'merchandise', 'other'] as const;
const STATUSES = ['active', 'inactive'] as const;
const ENROLLMENT_STATUSES = ['public', 'staff_only'] as const;

type ItemType = typeof TYPES[number];
type ItemStatus = typeof STATUSES[number];
type EnrollmentStatus = typeof ENROLLMENT_STATUSES[number];

// #546: Professional Services only apply to Session-type ('sessions') items.
// #942: the literal itself lives in `sellableItemPriceNotes.ts`, which is what
// decides the "total price for N sessions" line, so the page cannot ask one
// question of one spelling and another of a second.
const SESSION_TYPE: ItemType = SESSION_ITEM_TYPE;

// ─── List columns (#637) ──────────────────────────────────────────────────────
// The column headers and every collapsed row are laid out from this one
// definition, so a long name or a long "created by" can never push a row's
// values out of line with its header. Every column is a fixed track except the
// name, which is the only one allowed to absorb the leftover width; when the
// viewport is narrower than the sum of the tracks the list scrolls
// horizontally instead of dropping or squeezing columns.

interface ListColumn {
  /** Header label, a key in the `sellable_items` namespace. */
  labelKey: string;
  /** Fixed track width in px — also the minimum for the flexible column. */
  width: number;
  /** Set on the one flexible column: it becomes minmax(width, growfr). */
  grow?: number;
  align?: 'right';
}

const LIST_COLUMNS: ListColumn[] = [
  { labelKey: 'col_name', width: 180, grow: 2 },
  { labelKey: 'col_type', width: 100 },
  { labelKey: 'col_units', width: 70, align: 'right' },
  // #942: the Price cell carries the "Total price for N sessions" line under
  // the figure, and every cell on this grid is nowrap-and-ellipsis (#637). 200
  // is what the longest of those sentences needs in en/es/ca without being cut.
  { labelKey: 'col_price', width: 200 },
  { labelKey: 'col_tax_rate', width: 80 },
  { labelKey: 'col_frequency', width: 110 },
  { labelKey: 'col_created_by', width: 100 },
  { labelKey: 'col_created_at', width: 90 },
  { labelKey: 'col_status', width: 90 },
  { labelKey: 'col_enrollment_status', width: 100 },
  // Wide enough for the longest translated header ("ACCIONES") next to the
  // chevron and the ⋮ menu the cell also holds.
  { labelKey: 'col_actions', width: 84 },
];

const LIST_COLUMN_GAP = 10;
const LIST_ROW_PADDING_X = 16;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + LIST_ROW_PADDING_X * 2;

interface LinkedProfessionalService {
  id: number;
  name: string;
  is_system: number;
}

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
  /** #832: 0/1 from MySQL, like `is_system` — read through Boolean(). */
  mandatory: number;
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
  professional_services: LinkedProfessionalService[];
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
  tax_rate_id: string;
  mandatory: boolean;
  professionalServiceIds: number[];
};

type InlineNew = {
  name: string;
  type: ItemType;
  units: string;
  amount: string;
  billing_frequency: string;
  tax_rate_id: string;
  mandatory: boolean;
  professionalServiceIds: number[];
  saving: boolean;
  error: string | null;
};

interface TaxRate {
  id: number;
  name: string;
  rate_percent: string;
  status: 'active' | 'inactive';
}

interface ProfessionalService {
  id: number;
  name: string;
  is_system: number;
  status: 'active' | 'inactive';
}

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
    tax_rate_id: item.tax_rate_id != null ? String(item.tax_rate_id) : '',
    mandatory: Boolean(item.mandatory),
    professionalServiceIds: item.professional_services?.map((s) => s.id) ?? [],
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
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('FINANCIALS');

  const [items, setItems] = useState<SellableItem[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [professionalServices, setProfessionalServices] = useState<ProfessionalService[]>([]);
  const [professionalServicesLoading, setProfessionalServicesLoading] = useState(true);
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
    if (!canRead) { router.replace(`/${locale}`); return; }
  }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && canRead) load();
  }, [activeGymId, gymLoading, typeFilter, statusFilter]);

  useEffect(() => {
    if (gymLoading || !canRead || !activeGymId) return;
    apiFetch<TaxRate[]>('/taxes').then(setTaxRates).catch(() => setTaxRates([]));
  }, [activeGymId, gymLoading, isAdmin]);

  // #546: gym-scoped Professional Services catalog, for the type='sessions' multi-select.
  useEffect(() => {
    if (gymLoading || !canRead || !activeGymId) return;
    setProfessionalServicesLoading(true);
    apiFetch<ProfessionalService[]>('/professional-services')
      .then(setProfessionalServices)
      .catch(() => setProfessionalServices([]))
      .finally(() => setProfessionalServicesLoading(false));
  }, [activeGymId, gymLoading, isAdmin]);

  // #942: the one place a `SessionPackageNote` becomes a sentence. The label is
  // decided before `t()` is called — never with a `defaultValue` option, which
  // next-intl has no such thing as (it would print the key).
  function noteText(note: SessionPackageNote | null): string | null {
    if (!note) return null;
    return note.key === 'price_total_for_sessions'
      ? t('price_total_for_sessions', { count: note.count })
      : t('price_total_for_package');
  }

  /** A displayed price plus the `(tax …)` suffix that says what it includes. */
  function withTaxNote(price: string, item: { tax_behavior: 'inclusive' | 'exclusive'; applied_tax_rate: number | null }): string {
    const key = taxNoteKey(item);
    return key ? `${price} ${t(key)}` : price;
  }

  function taxRateOptions(currentId: string) {
    const options = taxRates.filter((tr) => tr.status === 'active');
    if (currentId && !options.some((tr) => String(tr.id) === currentId)) {
      const current = taxRates.find((tr) => String(tr.id) === currentId);
      if (current) options.push(current);
    }
    return options;
  }

  /** Active Professional Services, plus any already-selected inactive ones (mirrors taxRateOptions). */
  function professionalServiceOptions(selectedIds: number[]) {
    const options = professionalServices.filter((ps) => ps.status === 'active' || selectedIds.includes(ps.id));
    return options;
  }

  function toggleServiceId(ids: number[], id: number): number[] {
    return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
  }

  function renderProfessionalServiceCheckboxes(selected: number[], onChange: (ids: number[]) => void) {
    const options = professionalServiceOptions(selected);
    if (professionalServicesLoading) {
      return <p style={{ margin: 0, fontSize: 13, color: '#888' }}>{t('loading')}</p>;
    }
    if (options.length === 0) {
      return <p style={{ margin: 0, fontSize: 13, color: '#888' }}>{t('professional_services_empty')}</p>;
    }
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {options.map((ps) => (
          <label key={ps.id} style={chipCheckboxLabel(selected.includes(ps.id))}>
            <input
              type="checkbox"
              checked={selected.includes(ps.id)}
              onChange={() => onChange(toggleServiceId(selected, ps.id))}
              style={{ marginRight: 6 }}
            />
            {ps.name}
          </label>
        ))}
      </div>
    );
  }

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
    setInlineNew({ name: '', type: 'fee', units: '', amount: '', billing_frequency: '', tax_rate_id: '', mandatory: false, professionalServiceIds: [], saving: false, error: null });
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
          tax_rate_id: inlineNew.tax_rate_id !== '' ? parseInt(inlineNew.tax_rate_id, 10) : null,
          mandatory: inlineNew.mandatory,
          professional_service_ids: inlineNew.type === SESSION_TYPE ? inlineNew.professionalServiceIds : undefined,
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
          tax_rate_id: editForm.tax_rate_id !== '' ? parseInt(editForm.tax_rate_id, 10) : null,
          mandatory: editForm.mandatory,
          professional_service_ids: editForm.type === SESSION_TYPE ? editForm.professionalServiceIds : undefined,
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

  // ─── Duplicate ──────────────────────────────────────────────────────────────

  async function handleDuplicate(item: SellableItem) {
    try {
      await apiFetch(`/sellable-items/${item.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
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
    // #942: off the draft's live Type and Units, so the sentence appears the
    // moment Sessions is chosen and follows the count as it is typed.
    const draftSessionNote = noteText(sessionPackageNoteForForm(inlineNew));
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
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
              <label style={inlineLabelStyle}>{t('label_price')}</label>
              <input
                type="number" min="0" step="0.01"
                value={inlineNew.amount}
                onChange={(e) => setInlineNew({ ...inlineNew, amount: e.target.value })}
                placeholder="0.00"
                style={inlineInputStyle}
              />
              {/* #942: the person typing the figure is the one who most needs
                  to know it buys the whole package. */}
              {draftSessionNote && <p style={formHelpTextStyle}>{draftSessionNote}</p>}
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_frequency')}</label>
              {/* #821: five choices, and 'week' is not one of them. A new item
                  never holds a legacy value, so this list is always the five. */}
              <select
                value={inlineNew.billing_frequency}
                onChange={(e) => setInlineNew({ ...inlineNew, billing_frequency: e.target.value })}
                style={inlineSelectStyle}
              >
                <option value="">—</option>
                {frequencyOptions(inlineNew.billing_frequency).map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>{t(o.labelKey as any)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_tax_rate')}</label>
              <select
                value={inlineNew.tax_rate_id}
                onChange={(e) => setInlineNew({ ...inlineNew, tax_rate_id: e.target.value })}
                style={inlineSelectStyle}
              >
                <option value="">{t('option_no_tax')}</option>
                {taxRateOptions(inlineNew.tax_rate_id).map((tr) => (
                  <option key={tr.id} value={tr.id}>{tr.name} ({parseFloat(tr.rate_percent)}%)</option>
                ))}
              </select>
            </div>
          </div>
          {/* #832: its own row rather than a seventh grid cell, so the six
              tracks above keep their widths. The inline editor below renders
              the same control, against the same `label_mandatory`. */}
          <div style={{ marginBottom: 12 }}>
            <label style={checkboxLabelStyle}>
              <input
                type="checkbox"
                checked={inlineNew.mandatory}
                onChange={(e) => setInlineNew({ ...inlineNew, mandatory: e.target.checked })}
              />
              {t('label_mandatory')}
            </label>
          </div>
          {inlineNew.type === SESSION_TYPE && (
            <div style={{ marginBottom: 12 }}>
              <label style={inlineLabelStyle}>{t('label_professional_services')}</label>
              {renderProfessionalServiceCheckboxes(
                inlineNew.professionalServiceIds,
                (ids) => setInlineNew({ ...inlineNew, professionalServiceIds: ids }),
              )}
            </div>
          )}
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
    const isMandatory = Boolean(item.mandatory);
    // #942: resolved once per row, for the collapsed Price cell and the
    // expanded card's Price row — one rule, so the two cannot disagree about
    // whether this item's price is a package total. The editor's own note comes
    // from the form instead, so it tracks a Type or Units the user has changed
    // but not yet saved.
    const sessionNote = noteText(sessionPackageNote(item));
    const editSessionNote = editForm ? noteText(sessionPackageNoteForForm(editForm)) : null;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(item) },
      { label: t('edit'), onClick: () => openEdit(item), disabled: !canWrite, title: readOnlyTitle },
      { label: t('duplicate'), onClick: () => handleDuplicate(item), disabled: !canWrite, title: readOnlyTitle },
      item.status === 'active'
        ? { label: t('deactivate'), onClick: () => handleDeactivate(item), disabled: !canWrite, title: readOnlyTitle }
        : { label: t('activate'), onClick: () => handleActivate(item), disabled: !canWrite, title: readOnlyTitle },
      ...(!isSystem ? [{ label: t('delete'), onClick: () => setDeleting(item), danger: true, disabled: !canWrite, title: readOnlyTitle }] : []),
    ];

    return (
      <div key={item.id} style={cardStyle}>
        {/* Collapsed header — one cell per LIST_COLUMNS entry, same order */}
        <div style={rowStyle} onClick={() => toggleExpand(item.id)}>
          <div style={{ ...cellStyle, fontWeight: 600, fontSize: 15 }}>
            {item.name}
            {isSystem && (
              <span style={listNameBadgeStyle}>
                {t('system_badge')}
              </span>
            )}
            {/* #894: read-only, and read from the column rather than from the
                item's name or type — a System item is not mandatory by virtue
                of being a System item. The checkbox stays in the edit form.
                #913: the accent pill, not the neutral one — Mandatory has to
                be noticeable beside System rather than blend into the row. */}
            {isMandatory && (
              <span style={listNameBadgeAccentStyle}>
                {t('mandatory_badge')}
              </span>
            )}
          </div>
          <div style={{ ...cellStyle, fontSize: 13, color: '#555' }}>
            {t(`type_${item.type}`)}
          </div>
          <div style={{ ...cellStyle, fontSize: 13, color: '#555', textAlign: 'right' }}>
            {item.units != null ? item.units : '—'}
          </div>
          <div style={{ ...cellStyle, fontSize: 13 }}>
            {item.amount_incl_tax != null
              ? `${item.currency === 'EUR' ? '€' : item.currency}${item.amount_incl_tax.toFixed(2)} ${t(item.tax_behavior === 'exclusive' ? 'taxExcluded' : 'taxIncluded')}`
              : fmtAmount(item.amount, item.currency)}
            {/* #942: the figure above is the whole package, not one session.
                The number it shows is unchanged — this line only says what it
                covers, so `5` in the Units column beside `€50.00` can no longer
                be read as €250.00. */}
            {sessionNote && <span style={listHintStyle} title={sessionNote}>{sessionNote}</span>}
          </div>
          <div style={{ ...cellStyle, fontSize: 13, color: '#666' }}>
            {item.applied_tax_rate != null
              ? item.applied_tax_rate === 0 ? t('exempt') : `${item.applied_tax_rate}%`
              : '—'}
          </div>
          <div style={{ ...cellStyle, fontSize: 13, color: '#666' }}>
            {item.billing_frequency ? t(`frequency_${item.billing_frequency}`) : '—'}
          </div>
          <div style={{ ...cellStyle, fontSize: 13, color: '#888' }}>
            {item.created_by_name ?? '—'}
          </div>
          <div style={{ ...cellStyle, fontSize: 13, color: '#888' }}>
            {fmtDate(item.created_at)}
          </div>
          <div style={badgeCellStyle}>
            <StatusBadge status={item.status} label={tStatus(item.status)} />
          </div>
          <div style={badgeCellStyle}>
            <StatusBadge
              status={item.enrollment_status === 'public' ? 'active' : 'paused'}
              label={tStatus(item.enrollment_status)}
            />
          </div>
          <div style={actionsCellStyle}>
            <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
            <div onClick={(e) => e.stopPropagation()}>
              <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
            </div>
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
              {/* #832: deliberately not wrapped in `!isSystem` — a System
                  item's Mandatory flag is editable, unlike the catalogue-shape
                  fields (name/type/units) beside it, which is why `PUT /:id`
                  writes this column outside its is_system guard. */}
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
                <label style={checkboxLabelStyle}>
                  <input
                    type="checkbox"
                    checked={editForm.mandatory}
                    onChange={(e) => setEditForm({ ...editForm, mandatory: e.target.checked })}
                  />
                  {t('label_mandatory')}
                </label>
              </div>
            </div>

            <SectionHeader title={t('section_billing')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_price')}</label>
                <input
                  type="number" min="0" step="0.01"
                  value={editForm.amount}
                  onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                  placeholder="0.00"
                  style={inlineInputStyle}
                />
                {/* #942, as in the create card — the same note from the same
                    rule, off this form's live Type and Units. */}
                {editSessionNote && <p style={formHelpTextStyle}>{editSessionNote}</p>}
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_frequency')}</label>
                {/* #821: an item stored on the retired 'week' frequency still
                    shows it — disabled, so it reads truthfully and submits back
                    unchanged, but cannot be re-chosen once the user moves off it. */}
                <select
                  value={editForm.billing_frequency}
                  onChange={(e) => setEditForm({ ...editForm, billing_frequency: e.target.value })}
                  style={inlineSelectStyle}
                >
                  <option value="">—</option>
                  {frequencyOptions(editForm.billing_frequency).map((o) => (
                    <option key={o.value} value={o.value} disabled={o.disabled}>{t(o.labelKey as any)}</option>
                  ))}
                </select>
                {isLegacyFrequency(editForm.billing_frequency) && (
                  <div style={{ fontSize: 11, color: '#8a6d1f', marginTop: 4 }}>
                    {t('frequency_legacy_notice')}
                  </div>
                )}
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
              <div>
                <label style={inlineLabelStyle}>{t('label_tax_rate')}</label>
                <select
                  value={editForm.tax_rate_id}
                  onChange={(e) => setEditForm({ ...editForm, tax_rate_id: e.target.value })}
                  style={inlineSelectStyle}
                >
                  <option value="">{t('option_no_tax')}</option>
                  {taxRateOptions(editForm.tax_rate_id).map((tr) => (
                    <option key={tr.id} value={tr.id}>{tr.name} ({parseFloat(tr.rate_percent)}%)</option>
                  ))}
                </select>
              </div>
            </div>

            {editForm.type === SESSION_TYPE && (
              <>
                <SectionHeader title={t('section_professional_services')} />
                {renderProfessionalServiceCheckboxes(
                  editForm.professionalServiceIds,
                  (ids) => setEditForm({ ...editForm, professionalServiceIds: ids }),
                )}
              </>
            )}

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
            <DetailRow label={t('label_mandatory')} value={item.mandatory ? t('yes') : t('no')} />

            <SectionHeader title={t('section_billing')} />
            <DetailRow
              label={t('label_price')}
              value={withTaxNote(fmtAmount(item.amount, item.currency), item)}
              hint={sessionNote}
            />
            <DetailRow label={t('label_frequency')} value={item.billing_frequency ? t(`frequency_${item.billing_frequency}`) : '—'} />
            {!isSystem && <DetailRow label={t('label_validity_days')} value={item.validity_days != null ? String(item.validity_days) : '—'} />}
            <DetailRow
              label={t('label_tax_rate')}
              value={item.tax_rate_name ? `${item.tax_rate_name} (${item.tax_rate_percent}%)` : t('option_no_tax')}
            />

            {item.type === SESSION_TYPE && (
              <>
                <SectionHeader title={t('section_professional_services')} />
                <p style={{ margin: '4px 0 0', fontSize: 13, color: item.professional_services.length ? '#333' : '#aaa' }}>
                  {item.professional_services.length
                    ? item.professional_services.map((s) => s.name).join(', ')
                    : t('professional_services_empty')}
                </p>
              </>
            )}

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

  if (gymLoading || !canRead) return null;

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
          <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#6c63ff'), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {/* Headers + rows share LIST_GRID_COLUMNS and scroll together (#637) */}
      <div style={{ overflowX: 'auto' }}>
        <div style={{ minWidth: LIST_MIN_WIDTH }}>
          {/* Column headers */}
          {(items.length > 0 || inlineNew) && (
            <div style={colHeaderStyle}>
              {LIST_COLUMNS.map((col) => (
                <div key={col.labelKey} style={{ ...cellStyle, textAlign: col.align }}>
                  {t(col.labelKey)}
                </div>
              ))}
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
        </div>
      </div>

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        extraFooter={<ViewAuditLogButton entityType="gym_charge" entityId={details?.id} onNavigate={() => setDetails(null)} />}
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
              <ModalField label={t('label_mandatory')} value={details.mandatory ? t('yes') : t('no')} />
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <ModalSection title={t('section_billing')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField
                label={t('label_price')}
                value={withTaxNote(fmtAmount(details.amount, details.currency), details)}
                hint={noteText(sessionPackageNote(details))}
              />
              <ModalField label={t('label_frequency')} value={details.billing_frequency ? t(`frequency_${details.billing_frequency}`) : '—'} />
              <ModalField label={t('label_validity_days')} value={details.validity_days != null ? String(details.validity_days) : '—'} />
              <ModalField
                label={t('label_tax_rate')}
                value={details.tax_rate_name ? `${details.tax_rate_name} (${details.tax_rate_percent}%)` : t('option_no_tax')}
              />
            </div>

            {details.type === SESSION_TYPE && (
              <>
                <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
                <ModalSection title={t('section_professional_services')} />
                <ModalField
                  label=""
                  value={details.professional_services.length ? details.professional_services.map((s) => s.name).join(', ') : t('professional_services_empty')}
                />
              </>
            )}

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

// `hint` (#942) is the sentence that explains the value rather than the field —
// *Total price for 5 sessions* under a session package's Price. It sits under
// the value, not under the label, because it qualifies the figure; a field's
// own explanatory sentence belongs to the form behind `⋮ → Edit` (#797).
function DetailRow({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1, whiteSpace: 'pre-wrap' }}>
        {value}
        {hint && <span style={detailHintStyle}>{hint}</span>}
      </span>
    </div>
  );
}

function ModalSection({ title }: { title: string }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{title}</div>;
}

function ModalField({ label, value, hint }: { label: string; value: string; hint?: string | null }) {
  return (
    <div>
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>}
      <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{value}</p>
      {hint && <p style={valueHintStyle}>{hint}</p>}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

// #942: the clarification line beside a displayed price. One base plus the one
// tweak each surface needs, rather than three looks — `formHelpTextStyle` is the
// help line's chrome and a page does not restate it (#929). Italic, so the line
// reads as a gloss on the figure above it rather than as a second value.
const valueHintStyle: React.CSSProperties = {
  ...formHelpTextStyle, fontStyle: 'italic',
};

// Inside the read-only card's Price row, where the value is a flex item: the
// hint has to claim a line of its own.
const detailHintStyle: React.CSSProperties = {
  ...valueHintStyle, display: 'block',
};

// Inside a collapsed row's Price cell, where the figure above it is 13px and the
// row has no vertical room to spare.
const listHintStyle: React.CSSProperties = {
  ...valueHintStyle, display: 'block', margin: '2px 0 0', fontSize: 11,
};

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };

// The grid the column headers and every collapsed row are laid out on (#637).
const listGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center',
  gap: LIST_COLUMN_GAP,
};

const rowStyle: React.CSSProperties = {
  ...listGridStyle, padding: `12px ${LIST_ROW_PADDING_X}px`,
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  ...listGridStyle, padding: `6px ${LIST_ROW_PADDING_X}px`,
  // Rows sit inside a bordered card, so the header carries a matching
  // transparent border — without it every column would be off by 1px.
  border: '1px solid transparent',
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

/** Keeps an over-long value inside its track instead of widening the row. */
const cellStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

/** Badges size themselves, so this cell only needs to not stretch them. */
const badgeCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center',
};

const actionsCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center', gap: 6,
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

/** #832: matches the Promotion editor's flag checkboxes (`checkboxLabelSt`). */
const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer',
};

function chipCheckboxLabel(checked: boolean): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', padding: '4px 12px', borderRadius: 12,
    border: `1px solid ${checked ? '#bfdbfe' : '#e5e7eb'}`,
    background: checked ? '#eff6ff' : 'transparent',
    color: checked ? '#1d4ed8' : 'inherit',
    cursor: 'pointer', fontSize: 13, fontWeight: 500, userSelect: 'none',
  };
}
