'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { CrudModal, FormInput } from '@/components/CrudModal';
import { StatusFilter } from '@/components/StatusFilter';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { MemberImageField, MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
import { primaryBtnStyle, primaryBtnSmall } from '@/components/ui';
import {
  ProductListFrame, ProductListRow, productCardStyle, productExpandedBodyStyle, type ProductListText, type ProductRowData,
} from '@/components/products/ProductListChrome';
import { ProductLayout, productValueStyle, productTextareaStyle, productCheckboxCellStyle } from '../../financials/products/ProductLayout';
import {
  EMPTY_VALUE, visibleProductSections, type VisibleProductField,
} from '../../financials/products/productProfile';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, inlineEditorStyle,
  inlineEditorTitleStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { BILLING_FREQUENCY_NAMESPACE, billingFrequencyLabel } from '@/lib/billingFrequency';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

/**
 * #1822 — Cordel → Base Products. Superadmin-only templates for the Products a
 * newly created gym starts with (`base_products`, no `gym_id`). Editing or
 * deleting one affects only gyms created afterwards; Products already
 * generated are the gym's own. The validation is the API's.
 */

const TYPES = ['fee', 'sessions'] as const;
// Mirrors BASE_PRODUCT_TAX_BEHAVIORS (api/src/domain/baseProducts.ts): a behaviour only, rate ids are per gym.
const TAX_BEHAVIORS = ['inclusive', 'exclusive'] as const;
// Mirrors OFFERED_PRODUCT_FREQUENCIES (api/src/domain/productFrequency.ts).
const FREQUENCIES = ['once', 'four_weeks', 'month', 'year'] as const;

interface BaseProduct {
  id: number;
  charge_type_code: string | null;
  name: string;
  type: (typeof TYPES)[number];
  units: number | null;
  amount: number | null;
  billing_frequency: (typeof FREQUENCIES)[number];
  status: 'active' | 'inactive';
  enrollment_status: 'public' | 'staff_only';
  mandatory: boolean;
  validity_days: number | null;
  one_time_purchase: boolean;
  description: string | null;
  notes: string | null;
  package_information: string | null;
  tax_behavior: (typeof TAX_BEHAVIORS)[number];
  image_url: string | null;
  image_thumbnail_url: string | null;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
}

interface Form {
  id: number | null;
  charge_type_code: string;
  name: string;
  type: (typeof TYPES)[number];
  units: string;
  amount: string;
  billing_frequency: (typeof FREQUENCIES)[number];
  status: 'active' | 'inactive';
  enrollment_status: 'public' | 'staff_only';
  mandatory: boolean;
  validity_days: string;
  one_time_purchase: boolean;
  description: string;
  notes: string;
  package_information: string;
  tax_behavior: (typeof TAX_BEHAVIORS)[number];
}

function formFor(p: BaseProduct | null): Form {
  return {
    id: p?.id ?? null,
    charge_type_code: p?.charge_type_code ?? '',
    name: p?.name ?? '',
    type: p?.type ?? 'fee',
    units: p?.units != null ? String(p.units) : '',
    amount: p?.amount != null ? String(p.amount) : '',
    billing_frequency: p?.billing_frequency ?? 'once',
    status: p?.status ?? 'active',
    enrollment_status: p?.enrollment_status ?? 'public',
    mandatory: p?.mandatory ?? false,
    validity_days: p?.validity_days != null ? String(p.validity_days) : '',
    one_time_purchase: p?.one_time_purchase ?? false,
    description: p?.description ?? '',
    notes: p?.notes ?? '',
    package_information: p?.package_information ?? '',
    tax_behavior: p?.tax_behavior ?? 'inclusive',
  };
}

function payloadFor(f: Form) {
  return {
    charge_type_code: f.charge_type_code.trim() || null,
    name: f.name.trim(),
    type: f.type,
    units: f.type === 'sessions' && f.units.trim() ? Number(f.units) : null,
    amount: f.amount.trim() ? Number(f.amount) : null,
    billing_frequency: f.billing_frequency,
    status: f.status,
    enrollment_status: f.enrollment_status,
    mandatory: f.mandatory,
    validity_days: f.validity_days.trim() ? Number(f.validity_days) : null,
    one_time_purchase: f.one_time_purchase,
    description: f.description.trim() || null,
    notes: f.notes.trim() || null,
    package_information: f.package_information.trim() || null,
    tax_behavior: f.tax_behavior,
  };
}

export default function BaseProductsPage() {
  const t = useTranslations('base_products');
  // #2105 stage 2: the shared Products list renderer reads the `products` namespace.
  const tp = useTranslations('products');
  const tStatus = useTranslations('status');
  const tFreq = useTranslations(BILLING_FREQUENCY_NAMESPACE);
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const locale = useLocale();
  const router = useRouter();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<BaseProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<BaseProduct | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpand = (id: number) =>
    setExpanded((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [deleting, setDeleting] = useState<BaseProduct | null>(null);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (!gymLoading && isSuperadmin) load();
  }, [gymLoading, isSuperadmin, status, q]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      setRows(await apiFetch<BaseProduct[]>(`/platform/base-products?${params}`));
    } catch (err: any) {
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!form) return;
    if (!form.name.trim()) { setError(t('error_required')); return; }
    setSaving(true); setError(null);
    try {
      const body = JSON.stringify(payloadFor(form));
      if (form.id == null) await apiFetch('/platform/base-products', { method: 'POST', body });
      else await apiFetch(`/platform/base-products/${form.id}`, { method: 'PUT', body });
      setForm(null);
      await load();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/base-products/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  if (gymLoading || !isSuperadmin) return null;

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => f && ({ ...f, [key]: value }));
  const dash = '—';
  const when = (v: string | null | undefined) => (v ? formatGymDateTime(v, fmt) : dash);
  const listText: ProductListText = {
    t: tp as any,
    tFreq: tFreq as any,
    tStatus: tStatus as any,
    formatDate: (iso) => (iso ? formatGymDateTime(iso, fmt) : dash),
  };
  // Adapter: a template has a numeric amount, EUR only and no tax rate.
  const rowData = (p: BaseProduct): ProductRowData => ({
    ...p,
    amount: p.amount == null ? null : String(p.amount),
    currency: 'EUR',
  });
  const price = (p: BaseProduct) => (p.amount == null ? dash : p.amount.toFixed(2));

  // #2251: Base Products render the Gym Products card — the same sections, field
  // order and labels (`visibleProductSections`, `ProductLayout`) — and differ
  // only through what a cell holds: a template has no tax rate (a behaviour),
  // no Professional Services, and carries a charge type code and a
  // one-time-purchase flag the gym card does not.
  const sectionsFor = (type: string) =>
    visibleProductSections({ isSystem: false, isSessionType: false })
      .filter((sec) => sec.key !== 'professional_services')
      .map((sec) => ({ ...sec, fields: sec.fields.filter((f) => type === 'sessions' || f.key !== 'units') }));

  function renderValue(p: BaseProduct, field: VisibleProductField): React.ReactNode {
    const v = (x: React.ReactNode) => <div style={productValueStyle}>{x}</div>;
    switch (field.key) {
      case 'name': return v(p.name);
      case 'type': return v(t(`type_${p.type}`));
      case 'description': return v(p.description ?? EMPTY_VALUE);
      case 'units': return v(p.units ?? EMPTY_VALUE);
      case 'status': return v(tStatus(p.status));
      case 'enrollment_status': return v(tStatus(p.enrollment_status));
      case 'mandatory': return v(p.mandatory ? tp('yes') : tp('no'));
      case 'amount': return v(price(p));
      case 'billing_frequency': return v(billingFrequencyLabel(p.billing_frequency, tFreq) ?? EMPTY_VALUE);
      case 'validity_days': return v(p.validity_days ?? EMPTY_VALUE);
      case 'tax_rate_id': return v(t(`tax_behavior_${p.tax_behavior}`));
      case 'package_information': return v(p.package_information ?? EMPTY_VALUE);
      case 'notes': return v(p.notes ?? EMPTY_VALUE);
      default: return null;
    }
  }

  function renderControl(f: Form, field: VisibleProductField): React.ReactNode {
    switch (field.key) {
      case 'name':
        return <input style={formControlStyle} value={f.name} maxLength={150} autoFocus onChange={(e) => set('name', e.target.value)} />;
      case 'type':
        return (
          <select style={formControlStyle} value={f.type} onChange={(e) => set('type', e.target.value as Form['type'])}>
            {TYPES.map((v) => <option key={v} value={v}>{t(`type_${v}`)}</option>)}
          </select>
        );
      case 'description':
        return <textarea style={productTextareaStyle} rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />;
      case 'units':
        return <input style={formControlStyle} type="number" min={1} step={1} value={f.units} onChange={(e) => set('units', e.target.value)} />;
      case 'status':
        return (
          <select style={formControlStyle} value={f.status} onChange={(e) => set('status', e.target.value as Form['status'])}>
            <option value="active">{t('active')}</option>
            <option value="inactive">{t('inactive')}</option>
          </select>
        );
      case 'enrollment_status':
        return (
          <select style={formControlStyle} value={f.enrollment_status} onChange={(e) => set('enrollment_status', e.target.value as Form['enrollment_status'])}>
            <option value="public">{t('enrollment_public')}</option>
            <option value="staff_only">{t('enrollment_staff_only')}</option>
          </select>
        );
      case 'mandatory':
        return (
          <label style={productCheckboxCellStyle}>
            <input type="checkbox" checked={f.mandatory} onChange={(e) => set('mandatory', e.target.checked)} />
            {f.mandatory ? tp('yes') : tp('no')}
          </label>
        );
      case 'amount':
        return <input style={formControlStyle} type="number" min={0} step="0.01" value={f.amount} placeholder="0.00" onChange={(e) => set('amount', e.target.value)} />;
      case 'billing_frequency':
        return (
          <select style={formControlStyle} value={f.billing_frequency} onChange={(e) => set('billing_frequency', e.target.value as Form['billing_frequency'])}>
            {FREQUENCIES.map((v) => <option key={v} value={v}>{billingFrequencyLabel(v, tFreq) ?? v}</option>)}
          </select>
        );
      case 'validity_days':
        return <input style={formControlStyle} type="number" min={1} step={1} value={f.validity_days} placeholder={EMPTY_VALUE} onChange={(e) => set('validity_days', e.target.value)} />;
      case 'tax_rate_id':
        return (
          <select style={formControlStyle} value={f.tax_behavior} onChange={(e) => set('tax_behavior', e.target.value as Form['tax_behavior'])}>
            {TAX_BEHAVIORS.map((v) => <option key={v} value={v}>{t(`tax_behavior_${v}`)}</option>)}
          </select>
        );
      case 'package_information':
        return <textarea style={productTextareaStyle} rows={3} value={f.package_information} onChange={(e) => set('package_information', e.target.value)} />;
      case 'notes':
        return <textarea style={productTextareaStyle} rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} />;
      default:
        return null;
    }
  }

  /** The base-only fields (not on a gym Product), in the template's own section. */
  const extras = (f: Form | null, p: BaseProduct | null) => (
    <div style={{ marginTop: 12 }}>
      <label style={formFieldLabelStyle}>{t('charge_type_code')}</label>
      {f ? (
        <>
          <input style={formControlStyle} value={f.charge_type_code} onChange={(e) => set('charge_type_code', e.target.value)} />
          <div style={{ fontSize: 12, color: 'var(--gd-text-secondary, #666)' }}>{t('charge_type_code_help')}</div>
          <label style={{ ...productCheckboxCellStyle, marginTop: 12 }}>
            <input type="checkbox" checked={f.one_time_purchase} onChange={(e) => set('one_time_purchase', e.target.checked)} />
            {t('one_time_purchase')}
          </label>
        </>
      ) : (
        <>
          <div style={productValueStyle}>{p?.charge_type_code ?? dash}</div>
          <label style={{ ...formFieldLabelStyle, marginTop: 12 }}>{t('one_time_purchase')}</label>
          <div style={productValueStyle}>{p?.one_time_purchase ? tp('yes') : tp('no')}</div>
        </>
      )}
    </div>
  );

  const mediaFor = (id: number) => (
    <div style={{ margin: '12px 0 4px' }}>
      <label style={formFieldLabelStyle}>{t('section_media')}</label>
      <MemberImageField
        target={{
          kind: 'immediate',
          memberId: id,
          basePath: '/platform/base-products',
          imageUrl: rows.find((r) => r.id === id)?.image_url ?? null,
          stamp: rows.find((r) => r.id === id)?.modified_at,
          onChanged: (updated) => {
            setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...(updated as BaseProduct) } : r)));
          },
        }}
        requiresGymStorage={false}
        label={(key) => t(key as any)}
      />
    </div>
  );

  const actions = (
    <>
      {error && <div style={formErrorStyle} role="alert">{error}</div>}
      <div style={inlineActionsRowStyle}>
        <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
        <button style={secondaryBtnSmall} disabled={saving} onClick={() => { setForm(null); setError(null); }}>{t('cancel')}</button>
      </div>
    </>
  );

  const layoutFor = (f: Form | null, p: BaseProduct | null) => (
    <ProductLayout
      sections={sectionsFor(f?.type ?? p!.type)}
      editing={!!f}
      sectionTitle={(sec) => tp(sec.titleKey as any)}
      fieldLabel={(field) => tp(field.labelKey as any)}
      renderField={(field) => renderControl(f!, field)}
      renderValue={(field) => renderValue(f ? ({ ...p } as BaseProduct) : p!, field)}
    />
  );

  // Create card: the same layout, an empty draft as the "row" being edited.
  const newEditor = form?.id === null && (
    <div style={{ ...productCardStyle, marginBottom: 12 }}>
      <div style={productExpandedBodyStyle}>
        <div style={inlineEditorTitleStyle}>{t('add')}</div>
        {layoutFor(form, null)}
        {extras(form, null)}
        {actions}
      </div>
    </div>
  );

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('title')}</h1>
        <button style={primaryBtnStyle()} disabled={form?.id === null} onClick={() => { setForm(formFor(null)); setError(null); }}>{t('add')}</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 13, color: '#666' }}>{t('subtitle')}</p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <FormInput style={{ width: 220 }} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('search')} />
        <StatusFilter
          value={status}
          onChange={setStatus}
          allLabel={t('all_statuses')}
          options={[{ value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }]}
        />
      </div>

      {newEditor}

      <ProductListFrame showHeader={rows.length > 0} t={tp as any}>
        {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: form?.id === null ? 12 : 0 }}>
            {rows.map((p) => (
              <div key={p.id} style={productCardStyle}>
                <ProductListRow
                  item={rowData(p)}
                  isExpanded={expanded.has(p.id) || form?.id === p.id}
                  sessionNote={null}
                  text={listText}
                  onToggle={() => toggleExpand(p.id)}
                  menuItems={[
                    { label: t('edit'), onClick: () => { setExpanded((prev) => new Set(prev).add(p.id)); setForm(formFor(p)); setError(null); } },
                    { label: t('details'), onClick: () => setDetails(p) },
                    { label: t('delete'), onClick: () => setDeleting(p), danger: true },
                  ]}
                />
                {(expanded.has(p.id) || form?.id === p.id) && (
                  <div style={productExpandedBodyStyle}>
                    {form?.id === p.id ? layoutFor(form, p) : layoutFor(null, p)}
                    {extras(form?.id === p.id ? form : null, p)}
                    {form?.id === p.id ? (
                      <>
                        {mediaFor(p.id)}
                        {actions}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ProductListFrame>

      <CrudModal
        open={!!details}
        title={details?.name ?? ''}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => {}}
        extraFooter={details ? <ViewAuditLogButton entityType="base_product" entityId={details.id} /> : null}
      >
        {details && (
          <div style={{ fontSize: 14 }}>
            <p><strong>{t('charge_type_code')}:</strong> {details.charge_type_code ?? dash}</p>
            <p><strong>{t('type')}:</strong> {t(`type_${details.type}`)}</p>
            <p><strong>{t('units')}:</strong> {details.units ?? dash}</p>
            <p><strong>{t('amount')}:</strong> {price(details)}</p>
            <p><strong>{t('billing_frequency')}:</strong> {billingFrequencyLabel(details.billing_frequency, tFreq) ?? '—'}</p>
            <p><strong>{t('status')}:</strong> {t(details.status)}</p>
            <p><strong>{t('enrollment_status')}:</strong> {t(details.enrollment_status === 'public' ? 'enrollment_public' : 'enrollment_staff_only')}</p>
            <p><strong>{t('tax_behavior')}:</strong> {t(`tax_behavior_${details.tax_behavior}`)}</p>
            <p><strong>{t('description')}:</strong> {details.description ?? dash}</p>
            <p><strong>{t('package_information')}:</strong> {details.package_information ?? dash}</p>
            <p><strong>{t('notes')}:</strong> {details.notes ?? dash}</p>
            <p><strong>{t('validity_days')}:</strong> {details.validity_days ?? dash}</p>
            <MemberImagePreview src={memberImagePreviewSrc(details.image_url, details.modified_at)} emptyLabel={t('image_none')} />
            <p><strong>{t('mandatory')}:</strong> {details.mandatory ? t('yes') : t('no')}</p>
            <p><strong>{t('one_time_purchase')}:</strong> {details.one_time_purchase ? t('yes') : t('no')}</p>
            <p><strong>{t('created_at')}:</strong> {when(details.created_at)}</p>
            <p><strong>{t('created_by')}:</strong> {details.created_by ?? dash}</p>
            <p><strong>{t('modified_at')}:</strong> {when(details.modified_at)}</p>
            <p><strong>{t('modified_by')}:</strong> {details.modified_by ?? dash}</p>
          </div>
        )}
      </CrudModal>

      <ConfirmDialog
        open={!!deleting}
        message={t('delete_confirm', { name: deleting?.name ?? '' })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
