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
import { cardSurfaceStyle, primaryBtnStyle, primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, inlineEditorStyle,
  inlineEditorTitleStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { FieldTranslationsModal, GlobeButton } from '@/components/exercises/FieldTranslationsModal';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';
import { MemberImageField, memberImagePreviewSrc } from '@/components/MemberImageField';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

/**
 * #1702 — the section reads "Payment Methods"; creating and editing are inline
 * (no modal), each method carries an image (WebP master + server-made
 * thumbnail under `cordel/payment_method/`), and Details shows the audit fields.
 *
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
  image_url: string | null;
  image_thumbnail_url: string | null;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
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
  const tMembers = useTranslations('members');
  const { apiFetch, uploadFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const locale = useLocale();
  const router = useRouter();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Method[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [stagedImage, setStagedImage] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Method | null>(null);
  const [deleting, setDeleting] = useState<Method | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [imageOf, setImageOf] = useState<Method | null>(null);
  const [openField, setOpenField] = useState<'name' | 'description' | null>(null);

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
    if (!form.code.trim() || !form.translations.en.name.trim()) {
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
        const created = await apiFetch<Method>('/platform/base-payment-methods', {
          method: 'POST', body: JSON.stringify({ code: form.code.trim(), status: form.status, translations }),
        });
        if (stagedImage) {
          try {
            await uploadFetch(`/platform/base-payment-methods/${created.id}/image`, stagedImage);
          } catch (err: any) {
            // The method exists; reopen it in Edit with the failure so nothing is lost.
            await load();
            setForm(formFor({ ...created, translations: Object.fromEntries(LOCALES.map((l) => [l, translations[l]])) } as Method));
            setStagedImage(null);
            setError(err.message ?? t('error_generic'));
            return;
          }
        }
      } else {
        // The code is the stable identifier: never part of an update.
        await apiFetch(`/platform/base-payment-methods/${form.id}`, {
          method: 'PUT', body: JSON.stringify({ status: form.status, translations }),
        });
      }
      setForm(null);
      setStagedImage(null);
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

  function onImageChanged(updated: unknown) {
    const m = updated as Method;
    setRows((rs) => rs.map((r) => (r.id === m.id ? { ...r, ...m } : r)));
  }

  function openForm(m: Method | null) {
    setForm(formFor(m));
    setStagedImage(null);
    setError(null);
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function closeForm() {
    setForm(null);
    setStagedImage(null);
    setError(null);
  }

  const editor = form && (
    <div style={inlineEditorStyle}>
      <div style={inlineEditorTitleStyle}>{form.id == null ? t('add') : t('edit')}</div>
      <label style={formFieldLabelStyle}>{t('label_name')}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input style={{ ...formControlStyle, flex: 1 }} value={form.translations.en.name} maxLength={120} onChange={(e) => setTranslation('en', 'name', e.target.value)} />
        <GlobeButton label={t('translations_open', { field: t('label_name') })} onClick={() => setOpenField('name')} />
      </div>
      <label style={formFieldLabelStyle}>{t('label_description')}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input style={{ ...formControlStyle, flex: 1 }} value={form.translations.en.description} maxLength={500} onChange={(e) => setTranslation('en', 'description', e.target.value)} />
        <GlobeButton label={t('translations_open', { field: t('label_description') })} onClick={() => setOpenField('description')} />
      </div>
      <label style={formFieldLabelStyle}>{t('status')}</label>
      <select
        style={formControlStyle}
        value={form.status}
        onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'inactive' })}
      >
        <option value="active">{t('active')}</option>
        <option value="inactive">{t('inactive')}</option>
      </select>
      <label style={formFieldLabelStyle}>{t('image')}</label>
      {form.id == null ? (
        <MemberImageField
          target={{ kind: 'staged', file: stagedImage, onFile: setStagedImage }}
          requiresGymStorage={false}
          disabled={saving}
          label={(k) => tMembers(k as any)}
        />
      ) : (
        (() => {
          const current = rows.find((r) => r.id === form.id);
          return (
            <MemberImageField
              target={{
                kind: 'immediate',
                memberId: form.id as number,
                basePath: '/platform/base-payment-methods',
                imageUrl: current?.image_url ?? null,
                stamp: current?.modified_at,
                onChanged: onImageChanged,
              }}
              requiresGymStorage={false}
              disabled={saving}
              label={(k) => tMembers(k as any)}
            />
          );
        })()
      )}
      {form.id == null && (<>
      <label style={formFieldLabelStyle}>{t('code')}</label>
      <input style={formControlStyle} value={form.code} disabled={form.id != null} onChange={(e) => setForm({ ...form, code: e.target.value })} />
      </>)}
      <FieldTranslationsModal
        open={openField !== null}
        title={t('translations_title', { field: openField ? t(openField === 'name' ? 'label_name' : 'label_description') : '' })}
        locales={LOCALES.map((l) => ({ code: l, label: l.toUpperCase() }))}
        values={openField ? Object.fromEntries(LOCALES.map((l) => [l, form.translations[l][openField]])) : {}}
        multiline={openField === 'description'}
        saveLabel={t('translations_save')}
        cancelLabel={t('translations_cancel')}
        closeLabel={t('translations_close')}
        emptyLabel={t('translations_empty')}
        onSave={(vals) => {
          const field = openField!;
          setForm((f) => f && ({ ...f, translations: Object.fromEntries(LOCALES.map((l) => [l, { ...f.translations[l], [field]: vals[l] ?? '' }])) as Translations }));
          setOpenField(null);
        }}
        onClose={() => setOpenField(null)}
      />
      {error && <div style={formErrorStyle} role="alert">{error}</div>}
      <div style={inlineActionsRowStyle}>
        <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
        <button style={secondaryBtnSmall} disabled={saving} onClick={closeForm}>{t('cancel')}</button>
      </div>
    </div>
  );

  const dash = '—';
  const when = (v: string | null | undefined) => (v ? formatGymDateTime(v, fmt) : dash);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('title')}</h1>
        <button style={primaryBtnStyle()} disabled={form?.id === null} onClick={() => openForm(null)}>{t('add')}</button>
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

      {form?.id === null && editor}

      <div style={{ ...cardSurfaceStyle, marginTop: form?.id === null ? 12 : 0 }}>
        {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : rows.map((m) => {
          const isEditing = form?.id === m.id;
          const isOpen = expanded.has(m.id) || isEditing;
          const thumb = memberImagePreviewSrc(m.image_thumbnail_url ?? m.image_url, m.modified_at);
          return (
            <div key={m.id} style={{ borderTop: '1px solid var(--gd-separator, #eee)' }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggleExpand(m.id)}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleExpand(m.id); } }}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}
              >
                <button
                  type="button"
                  aria-label={m.image_url ? m.display_name : t('image_none')}
                  disabled={!m.image_url}
                  onClick={(e) => { e.stopPropagation(); if (m.image_url) setImageOf(m); }}
                  style={{ border: 'none', background: 'none', padding: 0, cursor: m.image_url ? 'zoom-in' : 'default', borderRadius: '50%', overflow: 'hidden', flexShrink: 0, width: 40, height: 40 }}
                >
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb} alt="" loading="lazy" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: '50%', display: 'block' }} />
                  ) : (
                    <span style={{ display: 'block', width: 40, height: 40, borderRadius: '50%', background: 'var(--gd-separator, #eee)' }} />
                  )}
                </button>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontWeight: 600, flexShrink: 0, maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.display_name}</span>
                  {m.display_description && (
                    <span style={{ fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{m.display_description}</span>
                  )}
                </div>
                <div style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>{m.created_by ?? dash}</div>
                <div style={{ fontSize: 13, color: '#666', whiteSpace: 'nowrap' }}>{when(m.created_at)}</div>
                <StatusBadge status={m.status} label={t(m.status)} />
                <div onClick={(e) => e.stopPropagation()}>
                  <ContextMenu
                    items={[
                      { label: t('edit'), onClick: () => { setExpanded((p) => new Set(p).add(m.id)); openForm(m); } },
                      { label: t('details'), onClick: () => setDetails(m) },
                      { label: t('delete'), onClick: () => setDeleting(m), danger: true },
                    ]}
                  />
                </div>
              </div>
              {isOpen && (
                <div style={{ padding: 12 }}>
                  {isEditing ? editor : (
                    <div style={{ fontSize: 14 }}>
                      <p style={{ margin: '0 0 4px' }}><strong>{t('label_name')}:</strong> {m.display_name}</p>
                      <p style={{ margin: '0 0 4px' }}><strong>{t('label_description')}:</strong> {m.display_description ?? dash}</p>
                      <p style={{ margin: '0 0 4px' }}><strong>{t('col_status')}:</strong> {t(m.status)}</p>
                      {m.image_url && thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={memberImagePreviewSrc(m.image_url, m.modified_at) ?? thumb} alt={m.display_name} style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, marginTop: 8 }} />
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

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
              <p key={l}><strong>{l.toUpperCase()}:</strong> {details.translations[l]?.name ?? dash}
                {details.translations[l]?.description ? ` — ${details.translations[l]?.description}` : ''}</p>
            ))}
            <p><strong>{t('created_at')}:</strong> {when(details.created_at)}</p>
            <p><strong>{t('created_by')}:</strong> {details.created_by ?? dash}</p>
            <p><strong>{t('modified_at')}:</strong> {when(details.modified_at)}</p>
            <p><strong>{t('modified_by')}:</strong> {details.modified_by ?? dash}</p>
            <p><strong>{t('deleted_at')}:</strong> {when(details.deleted_at)}</p>
            <p><strong>{t('deleted_by')}:</strong> {details.deleted_by ?? dash}</p>
          </div>
        )}
      </CrudModal>

      <ProfessionalServiceImageModal
        target={imageOf ? { name: imageOf.display_name, imageUrl: imageOf.image_url, description: imageOf.display_description, version: imageOf.modified_at } : null}
        onClose={() => setImageOf(null)}
        closeLabel={t('close')}
        noImageLabel={t('image_none')}
        noDescriptionLabel={t('no_description')}
      />

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
