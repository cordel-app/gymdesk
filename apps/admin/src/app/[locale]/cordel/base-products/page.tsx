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
  ProductListFrame, ProductListRow, productCardStyle, type ProductListText, type ProductRowData,
} from '@/components/products/ProductListChrome';
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

  const editor = form && (
    <div style={inlineEditorStyle}>
      <div style={inlineEditorTitleStyle}>{form.id == null ? t('add') : t('edit')}</div>
      <label style={formFieldLabelStyle}>{t('name')}</label>
      <input style={formControlStyle} value={form.name} maxLength={150} onChange={(e) => set('name', e.target.value)} />
      <label style={formFieldLabelStyle}>{t('charge_type_code')}</label>
      <input style={formControlStyle} value={form.charge_type_code} onChange={(e) => set('charge_type_code', e.target.value)} />
      <div style={{ fontSize: 12, color: '#666' }}>{t('charge_type_code_help')}</div>
      <label style={formFieldLabelStyle}>{t('type')}</label>
      <select style={formControlStyle} value={form.type} onChange={(e) => set('type', e.target.value as Form['type'])}>
        {TYPES.map((v) => <option key={v} value={v}>{t(`type_${v}`)}</option>)}
      </select>
      {form.type === 'sessions' && (
        <>
          <label style={formFieldLabelStyle}>{t('units')}</label>
          <input style={formControlStyle} type="number" min={1} step={1} value={form.units} onChange={(e) => set('units', e.target.value)} />
        </>
      )}
      <label style={formFieldLabelStyle}>{t('amount')}</label>
      <input style={formControlStyle} type="number" min={0} step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
      <label style={formFieldLabelStyle}>{t('billing_frequency')}</label>
      <select style={formControlStyle} value={form.billing_frequency} onChange={(e) => set('billing_frequency', e.target.value as Form['billing_frequency'])}>
        {FREQUENCIES.map((v) => <option key={v} value={v}>{billingFrequencyLabel(v, tFreq) ?? v}</option>)}
      </select>
      <label style={formFieldLabelStyle}>{t('status')}</label>
      <select style={formControlStyle} value={form.status} onChange={(e) => set('status', e.target.value as Form['status'])}>
        <option value="active">{t('active')}</option>
        <option value="inactive">{t('inactive')}</option>
      </select>
      <label style={formFieldLabelStyle}>{t('enrollment_status')}</label>
      <select style={formControlStyle} value={form.enrollment_status} onChange={(e) => set('enrollment_status', e.target.value as Form['enrollment_status'])}>
        <option value="public">{t('enrollment_public')}</option>
        <option value="staff_only">{t('enrollment_staff_only')}</option>
      </select>
      <label style={formFieldLabelStyle}>{t('tax_behavior')}</label>
      <select style={formControlStyle} value={form.tax_behavior} onChange={(e) => set('tax_behavior', e.target.value as Form['tax_behavior'])}>
        {TAX_BEHAVIORS.map((v) => <option key={v} value={v}>{t(`tax_behavior_${v}`)}</option>)}
      </select>
      <label style={formFieldLabelStyle}>{t('description')}</label>
      <textarea style={formControlStyle} rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
      {form.type === 'sessions' && (
        <>
          <label style={formFieldLabelStyle}>{t('package_information')}</label>
          <textarea style={formControlStyle} rows={2} value={form.package_information} onChange={(e) => set('package_information', e.target.value)} />
        </>
      )}
      <label style={formFieldLabelStyle}>{t('notes')}</label>
      <textarea style={formControlStyle} rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
      <label style={formFieldLabelStyle}>{t('validity_days')}</label>
      <input style={formControlStyle} type="number" min={1} step={1} value={form.validity_days} onChange={(e) => set('validity_days', e.target.value)} />
      <label style={{ ...formFieldLabelStyle, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.mandatory} onChange={(e) => set('mandatory', e.target.checked)} />
        {t('mandatory')}
      </label>
      <label style={{ ...formFieldLabelStyle, display: 'flex', gap: 8, alignItems: 'center' }}>
        <input type="checkbox" checked={form.one_time_purchase} onChange={(e) => set('one_time_purchase', e.target.checked)} />
        {t('one_time_purchase')}
      </label>
      {/* #2009 stage 3 — the template's image, acting on the server at once
          (`POST`/`DELETE /platform/base-products/:id/image`). Its key carries the
          template's id, so the create form offers none. The objects live under
          `cordel/`, which no gym's storage settings gate. */}
      {form.id != null && (
        <div style={{ margin: '12px 0 4px' }}>
          <label style={formFieldLabelStyle}>{t('section_media')}</label>
          <MemberImageField
            target={{
              kind: 'immediate',
              memberId: form.id,
              basePath: '/platform/base-products',
              imageUrl: rows.find((r) => r.id === form.id)?.image_url ?? null,
              stamp: rows.find((r) => r.id === form.id)?.modified_at,
              onChanged: (updated) => {
                setRows((prev) => prev.map((r) => (r.id === form.id ? { ...r, ...(updated as BaseProduct) } : r)));
              },
            }}
            requiresGymStorage={false}
            label={(key) => t(key as any)}
          />
        </div>
      )}
      {error && <div style={formErrorStyle} role="alert">{error}</div>}
      <div style={inlineActionsRowStyle}>
        <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
        <button style={secondaryBtnSmall} disabled={saving} onClick={() => { setForm(null); setError(null); }}>{t('cancel')}</button>
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

      {form?.id === null && editor}

      <ProductListFrame showHeader={rows.length > 0} t={tp as any}>
        {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: form?.id === null ? 12 : 0 }}>
            {rows.map((p) => (
              <div key={p.id} style={productCardStyle}>
                {form?.id === p.id ? (
                  <div style={{ padding: 12 }}>{editor}</div>
                ) : (
                  <ProductListRow
                    item={rowData(p)}
                    isExpanded={false}
                    sessionNote={null}
                    text={listText}
                    onToggle={() => { setForm(formFor(p)); setError(null); }}
                    menuItems={[
                      { label: t('edit'), onClick: () => { setForm(formFor(p)); setError(null); } },
                      { label: t('details'), onClick: () => setDetails(p) },
                      { label: t('delete'), onClick: () => setDeleting(p), danger: true },
                    ]}
                  />
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
