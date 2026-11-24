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
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { cardSurfaceStyle, primaryBtnStyle, primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, formValueStyle, inlineActionsRowStyle, inlineEditorStyle,
  inlineEditorTitleStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { MemberAvatar } from '@/components/MemberAvatar';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn, listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { FieldTranslationsModal, GlobeButton } from '@/components/exercises/FieldTranslationsModal';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { CardGrid, CardSquareImage } from '@/components/CardGrid';
import { MemberImageField, MemberImagePreview, memberImagePreviewSrc } from '@/components/MemberImageField';
import { MealImageModal } from '@/components/meals/MealImage';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

/**
 * #3328 stage 1 — Cordel → Base Meals, the platform's catalogue of meals.
 * Superadmin-only, like every Cordel catalogue. A meal is a name and a
 * description (English base values, ES/CA through the globe), a slug generated
 * once by the server, and the WebP image pair under `cordel/meals/`. The list
 * has the saved Cards | List toggle; the circular thumbnail opens the shared
 * meal image modal. Creating and editing are inline (#800).
 *
 * #3328 stage 3 (24 Nov review): the list wears the Products list's header band
 * and columns — image + name, description (truncated), created at, created by,
 * status — over the same listChrome grid; a meal has a Status (active/inactive,
 * an inactive meal is no longer offered to nutrition plans); expanding a row
 * shows the edit form's fields, in its order, as values; the slug is shown only
 * in the Details modal.
 */

const STATUSES = ['active', 'inactive'] as const;
type Status = typeof STATUSES[number];

interface ListColumn extends ListGridColumn { labelKey: string; width: number; grow?: number }

// The Products list's shape (#637 / #1011): one grid for the header band and
// the rows, the name pinned on a phone, the status kept beside it.
const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 200, grow: 2, mobile: 'name' },
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

const TRANSLATED = ['es', 'ca'] as const;
type TLoc = typeof TRANSLATED[number];
const LOCALES = ['en', ...TRANSLATED] as const;
type Loc = typeof LOCALES[number];

interface Meal {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  display_name: string;
  display_description: string | null;
  image_url: string | null;
  image_thumbnail_url: string | null;
  status: Status;
  translations: Partial<Record<TLoc, { name: string; description: string | null }>>;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

type Texts = Record<Loc, { name: string; description: string }>;
interface Form { id: number | null; texts: Texts; status: Status }

function formFor(m: Meal | null): Form {
  const texts = { en: { name: m?.name ?? '', description: m?.description ?? '' } } as Texts;
  for (const l of TRANSLATED) {
    texts[l] = { name: m?.translations?.[l]?.name ?? '', description: m?.translations?.[l]?.description ?? '' };
  }
  return { id: m?.id ?? null, texts, status: m?.status ?? 'active' };
}

function payloadOf(form: Form) {
  return {
    name: form.texts.en.name.trim(),
    description: form.texts.en.description.trim() || null,
    status: form.status,
    translations: Object.fromEntries(TRANSLATED.map((l) => [l, {
      name: form.texts[l].name.trim(),
      description: form.texts[l].description.trim() || null,
    }])),
  };
}

export default function BaseMealsPage() {
  const t = useTranslations('base_meals');
  const tMembers = useTranslations('members');
  const tStatus = useTranslations('status');
  const { apiFetch, uploadFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const locale = useLocale();
  const router = useRouter();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();
  const [view, setView] = useExerciseViewMode();

  const [rows, setRows] = useState<Meal[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [form, setForm] = useState<Form | null>(null);
  const [stagedImage, setStagedImage] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Meal | null>(null);
  const [deleting, setDeleting] = useState<Meal | null>(null);
  const [imageOf, setImageOf] = useState<Meal | null>(null);
  const [openField, setOpenField] = useState<'name' | 'description' | null>(null);
  const [viewTranslations, setViewTranslations] = useState<{ meal: Meal; field: 'name' | 'description' } | null>(null);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (!gymLoading && isSuperadmin) load();
  }, [gymLoading, isSuperadmin, q, statusFilter]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('search', q.trim());
      if (statusFilter) params.set('status', statusFilter);
      setRows(await apiFetch<Meal[]>(`/platform/base-meals?${params}`));
    } catch (err: any) {
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!form) return;
    if (!form.texts.en.name.trim()) { setError(t('error_required')); return; }
    setSaving(true); setError(null);
    try {
      if (form.id == null) {
        const created = await apiFetch<Meal>('/platform/base-meals', { method: 'POST', body: JSON.stringify(payloadOf(form)) });
        if (stagedImage) {
          try {
            await uploadFetch(`/platform/base-meals/${created.id}/image`, stagedImage);
          } catch (err: any) {
            // The meal exists: reopen it in Edit with the failure so nothing is lost.
            await load();
            setForm(formFor(created));
            setStagedImage(null);
            setError(err.message ?? t('error_generic'));
            return;
          }
        }
      } else {
        await apiFetch(`/platform/base-meals/${form.id}`, { method: 'PUT', body: JSON.stringify(payloadOf(form)) });
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
      await apiFetch(`/platform/base-meals/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  if (gymLoading || !isSuperadmin) return null;

  function setText(l: Loc, field: 'name' | 'description', value: string) {
    setForm((f) => f && ({ ...f, texts: { ...f.texts, [l]: { ...f.texts[l], [field]: value } } }));
  }

  function openForm(m: Meal | null) {
    // Editing from a card switches to the list, where the inline editor lives;
    // the row is expanded so Cancel reveals its read-only view.
    if (m) { setView('list'); setExpanded((prev) => new Set(prev).add(m.id)); }
    setForm(formFor(m));
    setStagedImage(null);
    setError(null);
  }

  function closeForm() { setForm(null); setStagedImage(null); setError(null); }

  function onImageChanged(updated: unknown) {
    const m = updated as Meal;
    setRows((rs) => rs.map((r) => (r.id === m.id ? { ...r, ...m } : r)));
  }

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const menuFor = (m: Meal) => [
    { kind: 'edit' as const, label: t('edit'), onClick: () => openForm(m) },
    { kind: 'details' as const, label: t('details'), onClick: () => setDetails(m) },
    { kind: 'delete' as const, label: t('delete'), onClick: () => setDeleting(m), danger: true },
  ];

  const editor = form && (
    <div style={inlineEditorStyle}>
      <div style={inlineEditorTitleStyle}>{form.id == null ? t('new') : t('edit')}</div>
      <label style={formFieldLabelStyle}>{t('label_name')} *</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <input style={{ ...formControlStyle, flex: 1 }} value={form.texts.en.name} maxLength={255} onChange={(e) => setText('en', 'name', e.target.value)} />
        <GlobeButton label={t('translations_open', { field: t('label_name') })} onClick={() => setOpenField('name')} />
      </div>
      <label style={formFieldLabelStyle}>{t('label_description')}</label>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        <textarea style={{ ...formControlStyle, flex: 1, minHeight: 72 }} value={form.texts.en.description} maxLength={1000} onChange={(e) => setText('en', 'description', e.target.value)} />
        <GlobeButton label={t('translations_open', { field: t('label_description') })} onClick={() => setOpenField('description')} />
      </div>
      <label style={formFieldLabelStyle}>{t('image')}</label>
      {form.id == null ? (
        <MemberImageField
          target={{ kind: 'staged', file: stagedImage, onFile: setStagedImage }}
          requiresGymStorage={false}
          disabled={saving}
          label={(k) => tMembers(k as any)}
        />
      ) : (() => {
        const current = rows.find((r) => r.id === form.id);
        return (
          <MemberImageField
            target={{
              kind: 'immediate',
              memberId: form.id as number,
              basePath: '/platform/base-meals',
              imageUrl: current?.image_url ?? null,
              stamp: current?.modified_at,
              onChanged: onImageChanged,
            }}
            requiresGymStorage={false}
            disabled={saving}
            label={(k) => tMembers(k as any)}
          />
        );
      })()}
      <label style={formFieldLabelStyle}>{t('label_status')}</label>
      <select
        style={formControlStyle}
        value={form.status}
        aria-label={t('label_status')}
        onChange={(e) => setForm((f) => f && ({ ...f, status: e.target.value as Status }))}
      >
        {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
      </select>
      <FieldTranslationsModal
        open={openField !== null}
        title={t('translations_title', { field: openField ? t(openField === 'name' ? 'label_name' : 'label_description') : '' })}
        locales={LOCALES.map((l) => ({ code: l, label: l.toUpperCase() }))}
        values={openField ? Object.fromEntries(LOCALES.map((l) => [l, form.texts[l][openField]])) : {}}
        multiline={openField === 'description'}
        saveLabel={t('translations_save')}
        cancelLabel={t('translations_cancel')}
        closeLabel={t('translations_close')}
        emptyLabel={t('translations_empty')}
        onSave={(vals) => {
          const field = openField!;
          setForm((f) => f && ({
            ...f,
            texts: Object.fromEntries(LOCALES.map((l) => [l, { ...f.texts[l], [field]: vals[l] ?? '' }])) as Texts,
          }));
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

  // The read-only half of the edit form: the same fields, in the same order,
  // with the same labels, each drawn as a value (#797 / #882).
  function readOnlyView(m: Meal) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={formFieldLabelStyle}>{t('label_name')}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <p style={{ ...formValueStyle, flex: 1 }}>{m.name}</p>
          <GlobeButton label={t('translations_open', { field: t('label_name') })} onClick={() => setViewTranslations({ meal: m, field: 'name' })} />
        </div>
        <span style={formFieldLabelStyle}>{t('label_description')}</span>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
          <p style={{ ...formValueStyle, flex: 1 }}>{m.description || dash}</p>
          <GlobeButton label={t('translations_open', { field: t('label_description') })} onClick={() => setViewTranslations({ meal: m, field: 'description' })} />
        </div>
        <span style={formFieldLabelStyle}>{t('image')}</span>
        <MemberImagePreview src={memberImagePreviewSrc(m.image_url, m.modified_at)} emptyLabel={t('image_none')} />
        <span style={formFieldLabelStyle}>{t('label_status')}</span>
        <div style={formValueStyle}><StatusBadge status={m.status} label={tStatus(m.status)} /></div>
      </div>
    );
  }

  function renderCard(m: Meal) {
    return (
      <div key={m.id} style={{ ...cardSurfaceStyle, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {m.image_url && (
          <button
            type="button"
            aria-label={m.display_name}
            onClick={() => setImageOf(m)}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'zoom-in', display: 'block', width: '100%' }}
          >
            <CardSquareImage src={m.image_url} alt={m.display_name} version={m.modified_at} placeholder={null} />
          </button>
        )}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>{m.display_name}</div>
            <ContextMenu items={menuFor(m)} ariaLabel={m.display_name} />
          </div>
          {m.display_description && (
            <div style={{ fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.display_description}>{m.display_description}</div>
          )}
          <div><StatusBadge status={m.status} label={tStatus(m.status)} /></div>
        </div>
      </div>
    );
  }

  function renderRow(m: Meal) {
    const isEditing = form?.id === m.id;
    const isExpanded = expanded.has(m.id) || isEditing;
    const thumb = m.image_thumbnail_url ?? m.image_url;
    return (
      <div key={m.id} style={{ ...cardSurfaceStyle, overflow: 'hidden' }}>
        <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={() => toggleExpand(m.id)}>
          <div className={CELL_CLASS.name} style={{ ...cellStyle, fontWeight: 600, fontSize: 15, display: 'flex', alignItems: 'center', gap: 10 }} title={m.display_name}>
            {thumb && (
              <span role="button" tabIndex={0} aria-label={m.display_name} style={{ cursor: 'zoom-in', display: 'inline-flex', flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); setImageOf(m); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setImageOf(m); } }}>
                <MemberAvatar name={m.display_name} imageUrl={thumb} stamp={m.modified_at} size={36} />
              </span>
            )}
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.display_name}</span>
          </div>
          <div className={CELL_CLASS.description} style={{ ...cellStyle, fontSize: 13, color: '#666' }} title={m.display_description ?? undefined}>
            {m.display_description ?? dash}
          </div>
          <div className={CELL_CLASS.created_at} style={{ ...cellStyle, fontSize: 13, color: '#888' }}>{when(m.created_at)}</div>
          <div className={CELL_CLASS.created_by} style={{ ...cellStyle, fontSize: 13, color: '#888' }}>{m.created_by ?? dash}</div>
          <div className={CELL_CLASS.status} style={{ minWidth: 0, display: 'flex', alignItems: 'center' }}>
            <StatusBadge status={m.status} label={tStatus(m.status)} />
          </div>
          <div className={CELL_CLASS.actions} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
            <div onClick={(e) => e.stopPropagation()}>
              <ContextMenu items={menuFor(m)} ariaLabel={m.display_name} />
            </div>
          </div>
        </div>
        {isExpanded && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            {isEditing ? editor : readOnlyView(m)}
          </div>
        )}
      </div>
    );
  }

  const list = (
    <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
      <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
        <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
          {LIST_COLUMNS.map((col) => (
            <div key={col.key} className={CELL_CLASS[col.key]} style={cellStyle}>{t(col.labelKey)}</div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{rows.map(renderRow)}</div>
      </div>
    </div>
  );

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('title')}</h1>
        <button style={primaryBtnStyle()} disabled={form?.id === null} onClick={() => openForm(null)}>{t('add')}</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <FormInput style={{ width: 220 }} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('search')} />
        <StatusFilter
          value={statusFilter}
          onChange={setStatusFilter}
          allLabel={tStatus('all')}
          options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
        />
        <div style={{ marginLeft: 'auto' }}><ExerciseViewToggle value={view} onChange={setView} /></div>
      </div>

      {form?.id === null && <div style={{ marginBottom: 12 }}>{editor}</div>}

      {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p>
        : view === 'cards' ? <CardGrid>{rows.map(renderCard)}</CardGrid>
          : list}

      <CrudModal
        open={!!details}
        title={details?.display_name ?? ''}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => {}}
        extraFooter={details ? <ViewAuditLogButton entityType="base_meal" entityId={details.id} /> : null}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              <div>
                <span style={detailLabelStyle}>{t('col_name')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 15, fontWeight: 500 }}>{details.display_name}</p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('col_status')}</span>
                <p style={{ margin: '2px 0 0' }}><StatusBadge status={details.status} label={tStatus(details.status)} /></p>
              </div>
              <div>
                <span style={detailLabelStyle}>{t('details_slug')}</span>
                <p style={{ margin: '2px 0 0', fontSize: 14 }}><code>{details.slug}</code></p>
              </div>
            </div>
            <div>
              <span style={detailLabelStyle}>{t('col_description')}</span>
              <p style={{ margin: '2px 0 0', fontSize: 14, whiteSpace: 'pre-wrap' }}>{details.display_description ?? dash}</p>
            </div>
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_audit')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              {([
                ['created_at', when(details.created_at)], ['created_by', details.created_by ?? dash],
                ['modified_at', when(details.modified_at)], ['modified_by', details.modified_by ?? dash],
              ] as const).map(([key, value]) => (
                <div key={key}>
                  <span style={detailLabelStyle}>{t(key)}</span>
                  <p style={{ margin: '2px 0 0', fontSize: 14 }}>{value}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </CrudModal>

      <MealImageModal meal={imageOf} onClose={() => setImageOf(null)} />

      {/* The read-only view's globe: the same translations modal, read-only. */}
      <FieldTranslationsModal
        open={viewTranslations !== null}
        title={t('translations_title', { field: viewTranslations ? t(viewTranslations.field === 'name' ? 'label_name' : 'label_description') : '' })}
        locales={LOCALES.map((l) => ({ code: l, label: l.toUpperCase() }))}
        values={viewTranslations ? Object.fromEntries(LOCALES.map((l) => [l, formFor(viewTranslations.meal).texts[l][viewTranslations.field]])) : {}}
        multiline={viewTranslations?.field === 'description'}
        readOnly
        saveLabel={t('translations_save')}
        cancelLabel={t('translations_cancel')}
        closeLabel={t('translations_close')}
        emptyLabel={t('translations_empty')}
        onSave={() => setViewTranslations(null)}
        onClose={() => setViewTranslations(null)}
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
