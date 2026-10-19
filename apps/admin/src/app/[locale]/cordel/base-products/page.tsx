'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal, FormInput } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { cardSurfaceStyle, primaryBtnStyle, primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, inlineEditorStyle,
  inlineEditorTitleStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

/**
 * #1822 — Cordel → Base Products. Superadmin-only templates for the Products a
 * newly created gym starts with (`base_products`, no `gym_id`). Editing or
 * deleting one affects only gyms created afterwards; Products already
 * generated are the gym's own. The validation is the API's.
 */

const TYPES = ['fee', 'sessions'] as const;
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
  };
}

export default function BaseProductsPage() {
  const t = useTranslations('base_products');
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
        {FREQUENCIES.map((v) => <option key={v} value={v}>{t(`frequency_${v}`)}</option>)}
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

      <div style={{ ...cardSurfaceStyle, marginTop: form?.id === null ? 12 : 0 }}>
        {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : rows.map((p) => (
          form?.id === p.id ? (
            <div key={p.id} style={{ padding: 12, borderTop: '1px solid var(--gd-separator, #eee)' }}>{editor}</div>
          ) : (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--gd-separator, #eee)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 13, color: '#666' }}>
                  {t(`type_${p.type}`)} · {price(p)} · {t(`frequency_${p.billing_frequency}`)}
                  {p.charge_type_code ? ` · ${p.charge_type_code}` : ''}
                </div>
              </div>
              <StatusBadge status={p.status} label={t(p.status)} />
              <ContextMenu
                items={[
                  { label: t('edit'), onClick: () => { setForm(formFor(p)); setError(null); } },
                  { label: t('details'), onClick: () => setDetails(p) },
                  { label: t('delete'), onClick: () => setDeleting(p), danger: true },
                ]}
              />
            </div>
          )
        ))}
      </div>

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
            <p><strong>{t('billing_frequency')}:</strong> {t(`frequency_${details.billing_frequency}`)}</p>
            <p><strong>{t('status')}:</strong> {t(details.status)}</p>
            <p><strong>{t('enrollment_status')}:</strong> {t(details.enrollment_status === 'public' ? 'enrollment_public' : 'enrollment_staff_only')}</p>
            <p><strong>{t('validity_days')}:</strong> {details.validity_days ?? dash}</p>
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
