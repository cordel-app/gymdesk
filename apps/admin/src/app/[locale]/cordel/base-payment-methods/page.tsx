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
  formControlStyle, formErrorStyle, formFieldLabelStyle, formValueStyle, inlineActionsRowStyle, inlineEditorStyle,
  inlineEditorTitleStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { MemberAvatar } from '@/components/MemberAvatar';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn, listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { FieldTranslationsModal, GlobeButton } from '@/components/exercises/FieldTranslationsModal';
import { ProfessionalServiceImageModal } from '@/components/professionalServices/ProfessionalServiceImageModal';
import { MemberImageField, MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
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
 *
 * #3372 — the list wears the Products list's shape (the listChrome grid, the
 * header band, #637 / #1011): Image · Name · Description (truncated, whole in
 * its tooltip) · Created At · Created By · Status · Actions, with the search
 * matching name and description. Expanding a row shows the edit form's fields
 * as values (#797); the form's Name, Description and Status keep a bounded
 * width, and the Description is a textarea.
 */

interface ListColumn extends ListGridColumn { labelKey: string; width: number; grow?: number }

// The name is the row's identity on a phone and the status the badge beside
// it; the rest is read in the expanded row.
const LIST_COLUMNS: ListColumn[] = [
  { key: 'image', labelKey: 'image', width: 56, mobile: 'secondary' },
  { key: 'name', labelKey: 'col_name', width: 180, grow: 2, mobile: 'name' },
  { key: 'description', labelKey: 'col_description', width: 220, grow: 3, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'created_at', width: 140, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'created_by', width: 130, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 100, mobile: 'keep' },
  { key: 'actions', labelKey: 'col_actions', width: 64, mobile: 'actions' },
];
const CELL_CLASS = listCellClasses(LIST_COLUMNS);
const LIST_COLUMN_GAP = 10;
const LIST_ROW_PADDING_X = 16;
const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`)).join(' ');
const LIST_MIN_WIDTH = LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1) + LIST_ROW_PADDING_X * 2;

// The form's field widths (#3372): the Products form's 480px field column for
// the name, a wider box for the description, a select sized to its labels.
const NAME_FIELD_MAX_WIDTH = 480;
const DESCRIPTION_FIELD_MAX_WIDTH = 640;
const STATUS_FIELD_MAX_WIDTH = 220;

const LOCALES = ['en', 'es', 'ca'] as const;
type Loc = typeof LOCALES[number];
type Translations = Record<Loc, { name: string; description: string }>;

interface Method {
  id: number;
  code: string;
  slug: string;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, maxWidth: NAME_FIELD_MAX_WIDTH }}>
        <input style={{ ...formControlStyle, flex: 1 }} value={form.translations.en.name} maxLength={120} aria-label={t('label_name')} onChange={(e) => setTranslation('en', 'name', e.target.value)} />
        <GlobeButton label={t('translations_open', { field: t('label_name') })} onClick={() => setOpenField('name')} />
      </div>
      <label style={formFieldLabelStyle}>{t('label_description')}</label>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, maxWidth: DESCRIPTION_FIELD_MAX_WIDTH }}>
        <textarea
          style={{ ...formControlStyle, flex: 1, minHeight: 96, resize: 'vertical', fontFamily: 'inherit' }}
          rows={4}
          value={form.translations.en.description}
          maxLength={500}
          aria-label={t('label_description')}
          onChange={(e) => setTranslation('en', 'description', e.target.value)}
        />
        <GlobeButton label={t('translations_open', { field: t('label_description') })} onClick={() => setOpenField('description')} />
      </div>
      <label style={formFieldLabelStyle}>{t('status')}</label>
      <select
        style={{ ...formControlStyle, width: '100%', maxWidth: STATUS_FIELD_MAX_WIDTH }}
        value={form.status}
        aria-label={t('status')}
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
      <input style={{ ...formControlStyle, width: '100%', maxWidth: NAME_FIELD_MAX_WIDTH }} value={form.code} aria-label={t('code')} onChange={(e) => setForm({ ...form, code: e.target.value })} />
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

  const menuFor = (m: Method) => [
    { kind: 'edit' as const, label: t('edit'), onClick: () => { setExpanded((p) => new Set(p).add(m.id)); openForm(m); } },
    { kind: 'details' as const, label: t('details'), onClick: () => setDetails(m) },
    { kind: 'delete' as const, label: t('delete'), onClick: () => setDeleting(m), danger: true },
  ];

  // The read-only half of the edit form: the same fields, in the same order,
  // with the same labels, each drawn as a value (#797 / #882).
  function readOnlyView(m: Method) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={formFieldLabelStyle}>{t('label_name')}</span>
        <p style={{ ...formValueStyle, maxWidth: NAME_FIELD_MAX_WIDTH }}>{m.display_name}</p>
        <span style={formFieldLabelStyle}>{t('label_description')}</span>
        <p style={{ ...formValueStyle, maxWidth: DESCRIPTION_FIELD_MAX_WIDTH, whiteSpace: 'pre-wrap' }}>{m.display_description || dash}</p>
        <span style={formFieldLabelStyle}>{t('status')}</span>
        <div style={formValueStyle}><StatusBadge status={m.status} label={t(m.status)} /></div>
        <span style={formFieldLabelStyle}>{t('image')}</span>
        <MemberImagePreview src={memberImagePreviewSrc(m.image_url, m.modified_at)} emptyLabel={t('image_none')} />
      </div>
    );
  }

  function renderRow(m: Method) {
    const isEditing = form?.id === m.id;
    const isOpen = expanded.has(m.id) || isEditing;
    const thumb = m.image_thumbnail_url ?? m.image_url;
    return (
      <div key={m.id} style={{ ...cardSurfaceStyle, overflow: 'hidden' }}>
        <div
          className={LIST_GRID_ROW_CLASS}
          style={rowStyle}
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => toggleExpand(m.id)}
          onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleExpand(m.id); } }}
        >
          <div className={CELL_CLASS.image} style={{ minWidth: 0, display: 'flex', alignItems: 'center' }}>
            {thumb ? (
              <span
                role="button"
                tabIndex={0}
                aria-label={m.display_name}
                style={{ cursor: 'zoom-in', display: 'inline-flex' }}
                onClick={(e) => { e.stopPropagation(); setImageOf(m); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setImageOf(m); } }}
              >
                <MemberAvatar name={m.display_name} imageUrl={thumb} stamp={m.modified_at} size={36} />
              </span>
            ) : (
              <MemberAvatar name={m.display_name} imageUrl={null} size={36} />
            )}
          </div>
          <div className={CELL_CLASS.name} style={{ ...cellStyle, fontWeight: 600, fontSize: 15 }} title={m.display_name}>
            {m.display_name}
          </div>
          <div className={CELL_CLASS.description} style={{ ...cellStyle, fontSize: 13, color: '#666' }} title={m.display_description ?? undefined}>
            {m.display_description || dash}
          </div>
          <div className={CELL_CLASS.created_at} style={{ ...cellStyle, fontSize: 13, color: '#888' }}>{when(m.created_at)}</div>
          <div className={CELL_CLASS.created_by} style={{ ...cellStyle, fontSize: 13, color: '#888' }}>{m.created_by ?? dash}</div>
          <div className={CELL_CLASS.status} style={{ minWidth: 0, display: 'flex', alignItems: 'center' }}>
            <StatusBadge status={m.status} label={t(m.status)} />
          </div>
          <div className={CELL_CLASS.actions} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span aria-hidden style={{ fontSize: 14, color: '#aaa', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
            <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
              <ContextMenu items={menuFor(m)} ariaLabel={m.display_name} />
            </div>
          </div>
        </div>
        {isOpen && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            {isEditing ? editor : readOnlyView(m)}
          </div>
        )}
      </div>
    );
  }

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

      {form?.id === null && <div style={{ height: 12 }} />}

      {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : (
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
          <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
            <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
              {LIST_COLUMNS.map((col) => (
                <div key={col.key} className={CELL_CLASS[col.key]} style={cellStyle}>
                  {col.key === 'actions' ? '' : t(col.labelKey)}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{rows.map(renderRow)}</div>
          </div>
        </div>
      )}

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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
            <div>
              <span style={detailLabelStyle}>{t('col_name')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{details.display_name}</p>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('col_code')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}><code>{details.code}</code></p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_slug')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}><code>{details.slug}</code></p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('col_status')}</span>
                <div style={{ marginTop: 4 }}>
                  <StatusBadge status={details.status} label={t(details.status)} />
                </div>
              </div>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('col_description')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap', color: details.display_description ? '#333' : '#aaa' }}>
                {details.display_description ?? dash}
              </p>
            </div>

            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_audit')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('created_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{when(details.created_at)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('created_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.created_by ?? dash}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('modified_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{when(details.modified_at)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('modified_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.modified_by ?? dash}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('deleted_at')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{when(details.deleted_at)}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('deleted_by')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}>{details.deleted_by ?? dash}</p>
              </div>
            </div>
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

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailSectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const listGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS, alignItems: 'center', gap: LIST_COLUMN_GAP,
};

const rowStyle: React.CSSProperties = {
  ...listGridStyle, padding: `12px ${LIST_ROW_PADDING_X}px`, cursor: 'pointer', userSelect: 'none',
};

// The Products list's header band (ProductListChrome): same type, same transparent border.
const colHeaderStyle: React.CSSProperties = {
  ...listGridStyle, padding: `6px ${LIST_ROW_PADDING_X}px`, border: '1px solid transparent',
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4,
};

const cellStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
