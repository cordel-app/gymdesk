'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { MemberImageField, MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, type GymFormatSettings } from '@/lib/gymFormat';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusFilter } from '@/components/StatusFilter';
import { CardGrid } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
// #974 §5: the list's own filter control (#724), so the search box and the Type
// filter follow the Theme's input pair instead of a hardcoded `#ccc`.
import { filterControlStyle } from '@/components/FilterBar';
import {
  cardMutedTextStyle,
  formCheckboxLabelStyle,
  formControlStyle,
  formErrorStyle,
  formFieldLabelStyle,
  formHelpTextStyle,
  inlineActionsRowStyle,
  secondaryBtnSmall,
  secondaryBtnStyle,
} from '@/components/formChrome';
import {
  ProductLayout,
  productCheckboxCellStyle,
  productTextareaStyle,
  productValueStyle,
} from './ProductLayout';
import {
  EMPTY_VALUE,
  PRODUCT_ENROLLMENT_STATUSES,
  PRODUCT_STATUSES,
  PRODUCT_TYPES,
  type ProductEnrollmentStatus,
  type ProductFormValues,
  type ProductStatus,
  type ProductType,
  type VisibleProductField,
  toProductFormValues,
  toTranslationsPayload,
  PRODUCT_TRANSLATION_LOCALES,
  visibleProductSections,
} from './productProfile';
import { BILLING_FREQUENCY_NAMESPACE, billingFrequencyLabel } from '@/lib/billingFrequency';
import {
  ProductCardHeader,
  ProductListFrame,
  ProductListRow,
  type ProductListText,
  fmtAmount,
  productCardStyle as cardStyle,
  productExpandedBodyStyle as expandedBodyStyle,
  productValueHintStyle as valueHintStyle,
} from '@/components/products/ProductListChrome';
import { ImportSystemProductsModal } from './ImportSystemProductsModal';
import { Frequency, frequencyOptions, legacyFrequencyLabelKey } from './productFrequency';
import {
  SESSION_ITEM_TYPE,
  SessionPackageNote,
  sessionPackageNote,
  sessionPackageNoteForForm,
  taxNoteKey,
} from './productPriceNotes';

// ─── Types ────────────────────────────────────────────────────────────────────

// #974: the three option sets live beside the field set that renders them
// (`productProfile.ts`), so the create card, the inline editor and the
// read-only card cannot offer or display different ones.
const TYPES = PRODUCT_TYPES;
const STATUSES = PRODUCT_STATUSES;
const ENROLLMENT_STATUSES = PRODUCT_ENROLLMENT_STATUSES;

type ItemType = ProductType;
type ItemStatus = ProductStatus;
type EnrollmentStatus = ProductEnrollmentStatus;

// #546: Professional Services only apply to Session-type ('sessions') items.
// #942: the literal itself lives in `productPriceNotes.ts`, which is what
// decides the "total price for N sessions" line, so the page cannot ask one
// question of one spelling and another of a second.
const SESSION_TYPE: ItemType = SESSION_ITEM_TYPE;

interface LinkedProfessionalService {
  id: number;
  name: string;
  is_system: number;
}

interface Product {
  id: number;
  gym_id: string;
  charge_type_id: number | null;
  /** #2253: set when the Product was imported from a System Base Product. */
  base_product_id?: number | null;
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
  /** #1349: 0/1 from MySQL; a badge only, never derived from billing_frequency. */
  one_time_purchase?: number;
  description: string | null;
  translations?: Partial<Record<'es' | 'ca', { name: string; description: string | null }>>;
  display_name?: string;
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
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  // #1715: the product's image (1080 WebP) and its 256 thumbnail.
  image_url?: string | null;
  image_thumbnail_url?: string | null;
}

// #974: the form's values and the row → values mapping are declared beside the
// field set, so a field added to the card cannot be left out of the form the
// context menu opens (#800).
type EditForm = ProductFormValues;

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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null, s: GymFormatSettings) {
  if (!iso) return '—';
  return formatGymDate(iso, s);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProductsPage() {
  const gymFmt = useGymFormatSettings();
  const t = useTranslations('products');
  // #1128: a Product's Billing Frequency is labelled from the one namespace that
  // labels every billing frequency, so this page, a Membership Plan's benefit
  // row and an Assigned Plan card cannot name the same frequency three ways.
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();
  const [importOpen, setImportOpen] = useState(false);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('FINANCIALS');

  const [items, setItems] = useState<Product[]>([]);
  const [taxRates, setTaxRates] = useState<TaxRate[]>([]);
  const [professionalServices, setProfessionalServices] = useState<ProfessionalService[]>([]);
  const [professionalServicesLoading, setProfessionalServicesLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQ, setSearchQ] = useState('');

  // #1832: Cards / List, the same saved choice Exercises, Activities and Promotions use.
  const [view, setView] = useExerciseViewMode();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [details, setDetails] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

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
    // #1827: at most one Professional Service — picking another replaces the selection.
    return ids.length === 1 && ids[0] === id ? [] : [id];
  }

  function renderProfessionalServiceCheckboxes(selected: number[], onChange: (ids: number[]) => void) {
    const options = professionalServiceOptions(selected);
    if (professionalServicesLoading) {
      return <p style={cardMutedTextStyle}>{t('loading')}</p>;
    }
    if (options.length === 0) {
      return <p style={cardMutedTextStyle}>{t('professional_services_empty')}</p>;
    }
    return (
      <div style={chipRowStyle}>
        {options.map((ps) => (
          <label key={ps.id} style={chipCheckboxLabel(selected.includes(ps.id))}>
            <input
              type="checkbox"
              checked={selected.includes(ps.id)}
              onChange={() => onChange(toggleServiceId(selected.length > 1 ? [] : selected, ps.id))}
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
      setItems(await apiFetch<Product[]>(`/products${qs ? `?${qs}` : ''}`));
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
      await apiFetch<Product>('/products', {
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

  function openEdit(item: Product) {
    // Editing happens in the List view only (#1832): Edit from a card switches
    // to it, expands this product and opens its editor in place.
    setView('list');
    setEditingId(item.id);
    setEditForm(toProductFormValues(item));
    setEditError(null);
    setExpanded((prev) => new Set([...prev, item.id]));
    // The row exists in List view by now: bring it into view even when it was
    // far down the list.
    requestAnimationFrame(() => {
      document.getElementById(`product-card-${item.id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditError(null);
  }

  async function handleSave(item: Product) {
    if (!editForm) return;
    if (!item.is_system && !editForm.name.trim()) { setEditError(t('error_name_required')); return; }
    if (editForm.units !== '' && (isNaN(Number(editForm.units)) || !Number.isInteger(Number(editForm.units)) || Number(editForm.units) <= 0)) {
      setEditError(t('error_units_positive')); return;
    }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/products/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim() || undefined,
          type: editForm.type || undefined,
          units: editForm.units !== '' ? parseInt(editForm.units, 10) : null,
          description: editForm.description.trim() || null,
          translations: toTranslationsPayload(editForm.tr),
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

  async function handleDuplicate(item: Product) {
    try {
      await apiFetch(`/products/${item.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Resync with System (#2253) ─────────────────────────────────────────────

  async function handleResync(item: Product) {
    try {
      const res = await apiFetch<{ updated: boolean }>(`/products/${item.id}/resync`, { method: 'POST' });
      toast(res?.updated ? t('resync_success') : t('resync_no_change'));
      if (res?.updated) load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Activate / Deactivate ───────────────────────────────────────────────────

  async function handleActivate(item: Product) {
    try {
      await apiFetch(`/products/${item.id}/activate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  async function handleDeactivate(item: Product) {
    try {
      await apiFetch(`/products/${item.id}/deactivate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/products/${deleting.id}`, { method: 'DELETE' });
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
              <label style={formFieldLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                placeholder={t('placeholder_name')}
                style={formControlStyle}
              />
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('label_type')} *</label>
              <select
                value={inlineNew.type}
                onChange={(e) => setInlineNew({ ...inlineNew, type: e.target.value as ItemType })}
                style={formControlStyle}
              >
                {TYPES.map((tp) => <option key={tp} value={tp}>{t(`type_${tp}`)}</option>)}
              </select>
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('label_units')}</label>
              <input
                type="number" min="1" step="1"
                value={inlineNew.units}
                onChange={(e) => setInlineNew({ ...inlineNew, units: e.target.value })}
                placeholder="—"
                style={formControlStyle}
              />
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('label_price')}</label>
              <input
                type="number" min="0" step="0.01"
                value={inlineNew.amount}
                onChange={(e) => setInlineNew({ ...inlineNew, amount: e.target.value })}
                placeholder="0.00"
                style={formControlStyle}
              />
              {/* #942: the person typing the figure is the one who most needs
                  to know it buys the whole package. */}
              {draftSessionNote && <p style={formHelpTextStyle}>{draftSessionNote}</p>}
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('label_frequency')}</label>
              {/* #821 / #945: four choices — neither 'week' nor 'per_session'
                  is one of them. A new item never holds a legacy value, so
                  this list is always the four. */}
              <select
                value={inlineNew.billing_frequency}
                onChange={(e) => setInlineNew({ ...inlineNew, billing_frequency: e.target.value })}
                style={formControlStyle}
              >
                <option value="">—</option>
                {frequencyOptions(inlineNew.billing_frequency).map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>{tFreq(o.labelKey as any)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={formFieldLabelStyle}>{t('label_tax_rate')}</label>
              <select
                value={inlineNew.tax_rate_id}
                onChange={(e) => setInlineNew({ ...inlineNew, tax_rate_id: e.target.value })}
                style={formControlStyle}
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
            <label style={formCheckboxLabelStyle}>
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
              <label style={formFieldLabelStyle}>{t('label_professional_services')}</label>
              {renderProfessionalServiceCheckboxes(
                inlineNew.professionalServiceIds,
                (ids) => setInlineNew({ ...inlineNew, professionalServiceIds: ids }),
              )}
            </div>
          )}
          {inlineNew.error && <p style={formErrorStyle}>{inlineNew.error}</p>}
          {/* #974 §4: the same left-aligned pair the inline editor below uses,
              so creating and editing an item do not put Save in two places. */}
          <div style={inlineActionsRowStyle}>
            <button onClick={cancelInlineNew} style={secondaryBtnSmall}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={primaryBtnSmall()}>
              {inlineNew.saving ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const listText: ProductListText = {
    t: t as any,
    tFreq: tFreq as any,
    tStatus: tStatus as any,
    formatDate: (iso) => fmtDate(iso, gymFmt),
  };

  function renderRow(item: Product) {
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
    // #945: null unless the form holds a retired frequency ('week', #821;
    // 'per_session', #945) — the editor is where such a value gets corrected,
    // so the notice that flags it belongs beside its select.
    const editLegacyFrequencyLabelKey = editForm ? legacyFrequencyLabelKey(editForm.billing_frequency) : null;

    // #974: both halves ask the one declaration which sections this row shows
    // and which of its fields it may edit. The Session-only Professional
    // Services section follows the *draft's* Type while the editor is open, so
    // choosing Sessions reveals it before the row is saved — and a System row's
    // frozen name/type/units come back as `editable: false`, which is what
    // renders them as values in the form instead of as controls `PUT
    // /products/:id` would ignore.
    const draftType = isEditing && editForm ? editForm.type : item.type;
    const sections = visibleProductSections({
      isSystem,
      isSessionType: draftType === SESSION_TYPE,
    });

    /** The persisted value of one field, in the box its control occupies. */
    function renderReadOnlyValue(field: VisibleProductField): React.ReactNode {
      switch (field.key) {
        case 'name':
          return <div style={productValueStyle}>{item.name}</div>;
        case 'type':
          return <div style={productValueStyle}>{t(`type_${item.type}` as any)}</div>;
        case 'description':
          return <div style={productValueStyle}>{item.description ?? EMPTY_VALUE}</div>;
        case 'translations':
          return (
            <div style={productValueStyle}>
              {PRODUCT_TRANSLATION_LOCALES.map((l) => (
                <div key={l}>
                  <strong>{l.toUpperCase()}:</strong>{' '}
                  {item.translations?.[l]?.name
                    ? `${item.translations[l]!.name}${item.translations[l]!.description ? ` — ${item.translations[l]!.description}` : ''}`
                    : EMPTY_VALUE}
                </div>
              ))}
            </div>
          );
        case 'units':
          return (
            <div style={productValueStyle}>
              {item.units != null ? String(item.units) : EMPTY_VALUE}
            </div>
          );
        case 'status':
          return <div style={productValueStyle}>{tStatus(item.status)}</div>;
        case 'enrollment_status':
          return <div style={productValueStyle}>{tStatus(item.enrollment_status)}</div>;
        case 'mandatory':
          return <div style={productValueStyle}>{isMandatory ? t('yes') : t('no')}</div>;
        case 'amount':
          // #942: the figure, then the line that says what it covers. The note
          // is the row's own (`sessionPackageNote`), so the collapsed cell and
          // this one cannot disagree about whether the price is a package total.
          return (
            <div>
              <div style={productValueStyle}>
                {withTaxNote(fmtAmount(item.amount, item.currency), item)}
              </div>
              {sessionNote && <p style={valueHintStyle}>{sessionNote}</p>}
            </div>
          );
        case 'billing_frequency':
          // A retired frequency (#821 'week', #945 'per_session') still reads
          // truthfully here; the notice that flags it for correction belongs
          // beside the editor's select and nowhere else.
          return (
            <div style={productValueStyle}>
              {billingFrequencyLabel(item.billing_frequency, tFreq) ?? EMPTY_VALUE}
            </div>
          );
        case 'validity_days':
          return (
            <div style={productValueStyle}>
              {item.validity_days != null ? String(item.validity_days) : EMPTY_VALUE}
            </div>
          );
        case 'tax_rate_id':
          return (
            <div style={productValueStyle}>
              {item.tax_rate_name
                ? `${item.tax_rate_name} (${item.tax_rate_percent}%)`
                : t('option_no_tax')}
            </div>
          );
        case 'professional_services':
          // Spans wearing the editor's own selected-chip style, never disabled
          // checkboxes: the read-only half of a "catalogue, selected ones
          // highlighted" section reuses the form's colours through one helper
          // (#799) rather than collapsing the selection into a sentence.
          return item.professional_services.length === 0 ? (
            <p style={cardMutedTextStyle}>{t('professional_services_empty')}</p>
          ) : (
            <div style={chipRowStyle}>
              {item.professional_services.map((ps) => (
                <span key={ps.id} style={selectedChipStyle}>{ps.name}</span>
              ))}
            </div>
          );
        case 'package_information':
          return <div style={productValueStyle}>{item.package_information ?? EMPTY_VALUE}</div>;
        case 'notes':
          return <div style={productValueStyle}>{item.notes ?? EMPTY_VALUE}</div>;
      }
    }

    /** The control for one field, while `⋮ → Edit` is open on this row. */
    function renderEditControl(field: VisibleProductField): React.ReactNode {
      if (!editForm) return null;
      switch (field.key) {
        case 'name':
          return (
            <input
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              autoFocus
              style={formControlStyle}
            />
          );
        case 'type':
          return (
            <select
              value={editForm.type}
              onChange={(e) => setEditForm({ ...editForm, type: e.target.value as ItemType })}
              style={formControlStyle}
            >
              {TYPES.map((tp) => <option key={tp} value={tp}>{t(`type_${tp}` as any)}</option>)}
            </select>
          );
        case 'description':
          return (
            <textarea
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              rows={2}
              style={productTextareaStyle}
            />
          );
        case 'translations':
          return (
            <div>
              {PRODUCT_TRANSLATION_LOCALES.map((l) => (
                <div key={l}>
                  <label style={formFieldLabelStyle}>{t('name_in', { locale: l.toUpperCase() })}</label>
                  <input
                    style={formControlStyle} maxLength={150} value={editForm.tr[l].name}
                    onChange={(e) => setEditForm({ ...editForm, tr: { ...editForm.tr, [l]: { ...editForm.tr[l], name: e.target.value } } })}
                  />
                  <label style={formFieldLabelStyle}>{t('description_in', { locale: l.toUpperCase() })}</label>
                  <textarea
                    rows={2} style={productTextareaStyle} value={editForm.tr[l].description}
                    onChange={(e) => setEditForm({ ...editForm, tr: { ...editForm.tr, [l]: { ...editForm.tr[l], description: e.target.value } } })}
                  />
                </div>
              ))}
            </div>
          );
        case 'units':
          return (
            <input
              type="number" min="1" step="1"
              value={editForm.units}
              onChange={(e) => setEditForm({ ...editForm, units: e.target.value })}
              placeholder={EMPTY_VALUE}
              style={formControlStyle}
            />
          );
        case 'status':
          return (
            <select
              value={editForm.status}
              onChange={(e) => setEditForm({ ...editForm, status: e.target.value as ItemStatus })}
              style={formControlStyle}
            >
              {STATUSES.map((st) => <option key={st} value={st}>{tStatus(st)}</option>)}
            </select>
          );
        case 'enrollment_status':
          return (
            <select
              value={editForm.enrollment_status}
              onChange={(e) => setEditForm({ ...editForm, enrollment_status: e.target.value as EnrollmentStatus })}
              style={formControlStyle}
            >
              {ENROLLMENT_STATUSES.map((st) => <option key={st} value={st}>{tStatus(st)}</option>)}
            </select>
          );
        case 'mandatory':
          // #832: offered on a System item too — the flag is written outside
          // `PUT /:id`'s `is_system` guard, unlike the three fields above it.
          return (
            <label style={productCheckboxCellStyle}>
              <input
                type="checkbox"
                checked={editForm.mandatory}
                onChange={(e) => setEditForm({ ...editForm, mandatory: e.target.checked })}
              />
              {editForm.mandatory ? t('yes') : t('no')}
            </label>
          );
        case 'amount':
          return (
            <div>
              <input
                type="number" min="0" step="0.01"
                value={editForm.amount}
                onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                placeholder="0.00"
                style={formControlStyle}
              />
              {/* #942, as in the create card — the same note from the same
                  rule, off this form's live Type and Units. */}
              {editSessionNote && <p style={formHelpTextStyle}>{editSessionNote}</p>}
            </div>
          );
        case 'billing_frequency':
          return (
            <div>
              {/* #821 / #945: an item stored on a retired frequency ('week',
                  'per_session') still shows it — disabled, so it reads
                  truthfully and submits back unchanged, but cannot be re-chosen
                  once the user moves off it. */}
              <select
                value={editForm.billing_frequency}
                onChange={(e) => setEditForm({ ...editForm, billing_frequency: e.target.value })}
                style={formControlStyle}
              >
                <option value="">{EMPTY_VALUE}</option>
                {frequencyOptions(editForm.billing_frequency).map((o) => (
                  <option key={o.value} value={o.value} disabled={o.disabled}>{tFreq(o.labelKey as any)}</option>
                ))}
              </select>
              {/* #945: the notice names the frequency the row holds, since
                  there are two retired values now. The label is resolved before
                  `t()` is called and passed in as a value — next-intl has no
                  `defaultValue` option and would print the key. */}
              {editLegacyFrequencyLabelKey && (
                <div style={legacyFrequencyNoticeStyle}>
                  {t('frequency_legacy_notice', { frequency: tFreq(editLegacyFrequencyLabelKey as any) })}
                </div>
              )}
            </div>
          );
        case 'validity_days':
          return (
            <input
              type="number" min="0" step="1"
              value={editForm.validity_days}
              onChange={(e) => setEditForm({ ...editForm, validity_days: e.target.value })}
              placeholder={EMPTY_VALUE}
              style={formControlStyle}
            />
          );
        case 'tax_rate_id':
          return (
            <select
              value={editForm.tax_rate_id}
              onChange={(e) => setEditForm({ ...editForm, tax_rate_id: e.target.value })}
              style={formControlStyle}
            >
              <option value="">{t('option_no_tax')}</option>
              {taxRateOptions(editForm.tax_rate_id).map((tr) => (
                <option key={tr.id} value={tr.id}>{tr.name} ({parseFloat(tr.rate_percent)}%)</option>
              ))}
            </select>
          );
        case 'professional_services':
          return renderProfessionalServiceCheckboxes(
            editForm.professionalServiceIds,
            (ids) => setEditForm({ ...editForm, professionalServiceIds: ids }),
          );
        case 'package_information':
          return (
            <textarea
              value={editForm.package_information}
              onChange={(e) => setEditForm({ ...editForm, package_information: e.target.value })}
              rows={3}
              placeholder={t('placeholder_package_info')}
              style={productTextareaStyle}
            />
          );
        case 'notes':
          return (
            <textarea
              value={editForm.notes}
              onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
              rows={3}
              style={productTextareaStyle}
            />
          );
      }
    }

    // #1188: Details is always the last option (#802's order), after
    // Activate / Deactivate and after Delete where a row has one.
    const menuItems: ContextMenuItem[] = [
      { label: t('edit'), onClick: () => openEdit(item), disabled: !canWrite, title: readOnlyTitle },
      { label: t('duplicate'), onClick: () => handleDuplicate(item), disabled: !canWrite, title: readOnlyTitle },
      ...(item.base_product_id != null ? [{ label: t('resync_system'), onClick: () => handleResync(item), disabled: !canWrite, title: readOnlyTitle }] : []),
      item.status === 'active'
        ? { label: t('deactivate'), onClick: () => handleDeactivate(item), disabled: !canWrite, title: readOnlyTitle }
        : { label: t('activate'), onClick: () => handleActivate(item), disabled: !canWrite, title: readOnlyTitle },
      ...(!isSystem ? [{ label: t('delete'), onClick: () => setDeleting(item), danger: true, disabled: !canWrite, title: readOnlyTitle }] : []),
      { label: t('details'), onClick: () => setDetails(item) },
    ];

    return (
      <div key={item.id} id={`product-card-${item.id}`} style={cardStyle}>
        {view === 'cards' ? (
          <ProductCardHeader
            item={item}
            isExpanded={isExpanded}
            menuItems={menuItems}
            text={listText}
            onToggle={() => toggleExpand(item.id)}
          />
        ) : (
        <ProductListRow
          item={item}
          isExpanded={isExpanded}
          menuItems={menuItems}
          sessionNote={sessionNote}
          text={listText}
          onToggle={() => toggleExpand(item.id)}
        />
        )}

        {/* #974: one layout, two modes. Expanding the card reads and
            `⋮ → Edit` writes (#797), and because both halves render
            `ProductLayout` over the same declaration neither can lay the
            item out differently from the other, or show a field the other does
            not. */}
        {(isExpanded || isEditing) && (
          <div style={expandedBodyStyle}>
            <ProductLayout
              sections={sections}
              editing={isEditing}
              sectionTitle={(section) => t(section.titleKey as any)}
              fieldLabel={(field) => t(field.labelKey as any)}
              renderField={renderEditControl}
              renderValue={renderReadOnlyValue}
            />
            {/* #1715 — the product's image. Read-only outside Edit mode; in it
                the control acts on the server straight away (`POST`/`DELETE
                /products/:id/image`), so the surrounding PUT neither carries
                nor can undo it. The key carries the product's id, so the create
                row offers none. */}
            <div style={{ margin: '12px 0 4px' }}>
              {isEditing ? (
                <MemberImageField
                  target={{
                    kind: 'immediate',
                    memberId: item.id,
                    basePath: '/products',
                    imageUrl: item.image_url ?? null,
                    stamp: item.modified_at,
                    onChanged: (updated) => {
                      setItems((prev) => prev.map((p) => (p.id === item.id ? { ...p, ...(updated as Product) } : p)));
                    },
                  }}
                  disabled={!canWrite}
                  disabledTitle={readOnlyTitle}
                  label={(key) => t(key as any)}
                />
              ) : (
                <MemberImagePreview
                  src={memberImagePreviewSrc(item.image_url ?? null, item.modified_at)}
                  emptyLabel={t('image_none')}
                />
              )}
            </div>
            {isEditing && editForm && (
              <>
                {editError && <p style={formErrorStyle}>{editError}</p>}
                {/* #974 §4: the editor's pair sits at the fields' own content
                    margin, left-aligned and with no rule above it — where every
                    other inline editor in the app puts it (#929's
                    `inlineActionsRowStyle`, #968). It used to be a
                    `justifyContent: 'flex-end'` row with a grey Cancel of its
                    own, so this card's actions sat where no other card's do. */}
                <div style={inlineActionsRowStyle}>
                  <button onClick={cancelEdit} style={secondaryBtnSmall}>{t('cancel')}</button>
                  <button onClick={() => handleSave(item)} disabled={editSaving} style={primaryBtnSmall()}>
                    {editSaving ? t('saving') : t('save')}
                  </button>
                </div>
              </>
            )}
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
              style={{ ...filterControlStyle, width: 180 }}
            />
            <button type="submit" style={primaryBtnSmall()}>{t('search')}</button>
          </form>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            style={filterControlStyle}
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
          <ExerciseViewToggle value={view} onChange={setView} />
          <button onClick={() => setImportOpen(true)} title={readOnlyTitle} style={readOnlyStyle(secondaryBtnStyle, !canWrite)} disabled={!canWrite}>{t('import_system')}</button>
          <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {view === 'cards' ? (
        <>
          {renderInlineNewRow()}
          {loading ? (
            <p style={{ color: '#888' }}>{t('loading')}</p>
          ) : items.length === 0 && !inlineNew ? (
            <p style={{ color: '#888' }}>{t('empty')}</p>
          ) : (
            <CardGrid>{items.map(renderRow)}</CardGrid>
          )}
        </>
      ) : (
      <ProductListFrame showHeader={items.length > 0 || inlineNew !== null} t={t as any}>
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
      </ProductListFrame>
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
        extraFooter={<ViewAuditLogButton entityType="product" entityId={details?.id} onNavigate={() => setDetails(null)} />}
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
              <ModalField label={t('label_frequency')} value={billingFrequencyLabel(details.billing_frequency, tFreq) ?? '—'} />
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
              <ModalField label={t('audit_created_at')} value={fmtDate(details.created_at, gymFmt)} />
              <ModalField label={t('audit_created_by')} value={details.created_by ?? '—'} />
              <ModalField label={t('audit_modified_at')} value={fmtDate(details.modified_at, gymFmt)} />
              <ModalField label={t('audit_modified_by')} value={details.modified_by ?? '—'} />
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

      {/* #1851: Import System Products */}
      <ImportSystemProductsModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImported={(result) => {
          setImportOpen(false);
          toast(t('import_done', { n: result.imported.length }) + (result.skipped.length > 0 ? ` ${t('import_skipped', { n: result.skipped.length })}` : ''));
          load();
        }}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

/** The row the Professional Services chips wrap in, in both modes. */
const chipRowStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8 };

/**
 * A linked Professional Service as the read-only card shows it: the editor's own
 * selected chip, through the same helper, so the two halves cannot colour the
 * same selection differently (#799). It is a `<span>` and not a disabled
 * checkbox, and it loses only the pointer the editor's chip carries.
 */
const selectedChipStyle: React.CSSProperties = { ...chipCheckboxLabel(true), cursor: 'default' };

/** #945: the line that flags a retired Billing Frequency for correction. */
const legacyFrequencyNoticeStyle: React.CSSProperties = {
  fontSize: 11, color: '#8a6d1f', marginTop: 4,
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
