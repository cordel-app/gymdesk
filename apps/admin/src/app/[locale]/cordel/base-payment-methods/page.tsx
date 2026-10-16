'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu } from '@/components/ContextMenu';
import { CrudModal, FormInput, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { cardSurfaceStyle, primaryBtnStyle } from '@/components/ui';

/**
 * #1663 — Cordel → Base Payment Methods. A superadmin-only catalogue: a stable
 * code, a name and description in each product language, and an Active/Inactive
 * status. Delete is a soft delete on the server.
 */

const LOCALES = ['en', 'es', 'ca'] as const;
type Loc = typeof LOCALES[number];
type Translations = Record<Loc, { name: string; description: string }>;

interface Method {
  id: number;
  code: string;
  status: 'active' | 'inactive';
  display_name: string;
  display_description: string | null;
  translations: Partial<Record<Loc, { name: string; description: string | null }>>;
}

interface Form { id: number | null; code: string; status: 'active' | 'inactive'; translations: Translations }

function emptyTranslations(): Translations {
  return { en: { name: '', description: '' }, es: { name: '', description: '' }, ca: { name: '', description: '' } };
}

function formFor(m: Method | null): Form {
  const translations = emptyTranslations();
  if (m) for (const l of LOCALES) {
    translations[l] = { name: m.translations[l]?.name ?? '', description: m.translations[l]?.description ?? '' };
  }
  return { id: m?.id ?? null, code: m?.code ?? '', status: m?.status ?? 'active', translations };
}

export default function BasePaymentMethodsPage() {
  const t = useTranslations('base_payment_methods');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Method[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Method | null>(null);
  const [deleting, setDeleting] = useState<Method | null>(null);

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
      setRows(await apiFetch<Method[]>(`/platform/base-payment-methods?${params}`));
    } catch (err: any) {
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!form) return;
    if (!form.code.trim() || LOCALES.some((l) => !form.translations[l].name.trim())) {
      setError(t('error_required'));
      return;
    }
    setSaving(true); setError(null);
    const translations = Object.fromEntries(LOCALES.map((l) => [l, {
      name: form.translations[l].name.trim(),
      description: form.translations[l].description.trim() || null,
    }]));
    try {
      if (form.id == null) {
        await apiFetch('/platform/base-payment-methods', {
          method: 'POST', body: JSON.stringify({ code: form.code.trim(), status: form.status, translations }),
        });
      } else {
        // The code is the stable identifier: never part of an update.
        await apiFetch(`/platform/base-payment-methods/${form.id}`, {
          method: 'PUT', body: JSON.stringify({ status: form.status, translations }),
        });
      }
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
      await apiFetch(`/platform/base-payment-methods/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  function setTranslation(l: Loc, field: 'name' | 'description', value: string) {
    setForm((f) => f && ({ ...f, translations: { ...f.translations, [l]: { ...f.translations[l], [field]: value } } }));
  }

  if (gymLoading || !isSuperadmin) return null;

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('title')}</h1>
        <button style={primaryBtnStyle()} onClick={() => { setForm(formFor(null)); setError(null); }}>{t('add')}</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <FormInput
          style={{ width: 220 }}
          placeholder={t('search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t('search')}
        />
        <StatusFilter
          value={status}
          onChange={setStatus}
          allLabel={t('all_statuses')}
          options={[{ value: 'active', label: t('active') }, { value: 'inactive', label: t('inactive') }]}
        />
      </div>

      <div style={cardSurfaceStyle}>
        {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : rows.map((m) => (
          <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--gd-separator, #eee)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{m.display_name}</div>
              <div style={{ fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.code}{m.display_description ? ` · ${m.display_description}` : ''}
              </div>
            </div>
            <StatusBadge status={m.status} label={t(m.status)} />
            <ContextMenu
              items={[
                { label: t('edit'), onClick: () => { setForm(formFor(m)); setError(null); } },
                { label: t('details'), onClick: () => setDetails(m) },
                { label: t('delete'), onClick: () => setDeleting(m), danger: true },
              ]}
            />
          </div>
        ))}
      </div>

      <CrudModal
        open={!!form}
        title={form?.id == null ? t('add') : t('edit')}
        error={error}
        saving={saving}
        cancelLabel={t('cancel')}
        saveLabel={t('save')}
        onCancel={() => setForm(null)}
        onSave={save}
      >
        {form && (
          <>
            <FormLabel>{t('code')}</FormLabel>
            <FormInput value={form.code} disabled={form.id != null} onChange={(e) => setForm({ ...form, code: e.target.value })} />
            <FormLabel>{t('status')}</FormLabel>
            <select
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--gd-input-border, #d1d5db)' }}
            >
              <option value="active">{t('active')}</option>
              <option value="inactive">{t('inactive')}</option>
            </select>
            {LOCALES.map((l) => (
              <div key={l}>
                <FormLabel>{t('name_in', { locale: l.toUpperCase() })}</FormLabel>
                <FormInput value={form.translations[l].name} maxLength={120} onChange={(e) => setTranslation(l, 'name', e.target.value)} />
                <FormLabel>{t('description_in', { locale: l.toUpperCase() })}</FormLabel>
                <FormInput value={form.translations[l].description} maxLength={500} onChange={(e) => setTranslation(l, 'description', e.target.value)} />
              </div>
            ))}
          </>
        )}
      </CrudModal>

      <CrudModal
        open={!!details}
        title={details?.display_name ?? ''}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => {}}
        extraFooter={details ? <ViewAuditLogButton entityType="base_payment_method" entityId={details.id} /> : null}
      >
        {details && (
          <div style={{ fontSize: 14 }}>
            <p><strong>{t('col_code')}:</strong> {details.code}</p>
            <p><strong>{t('col_status')}:</strong> {t(details.status)}</p>
            {LOCALES.map((l) => (
              <p key={l}><strong>{l.toUpperCase()}:</strong> {details.translations[l]?.name ?? '—'}
                {details.translations[l]?.description ? ` — ${details.translations[l]?.description}` : ''}</p>
            ))}
          </div>
        )}
      </CrudModal>

      <ConfirmDialog
        open={!!deleting}
        message={t('delete_confirm', { name: deleting?.display_name ?? '' })}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={remove}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
