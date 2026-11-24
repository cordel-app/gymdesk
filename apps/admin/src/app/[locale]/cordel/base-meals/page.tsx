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
  formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, inlineEditorStyle,
  inlineEditorTitleStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { FieldTranslationsModal, GlobeButton } from '@/components/exercises/FieldTranslationsModal';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { CardGrid, CardSquareImage } from '@/components/CardGrid';
import { MemberImageField } from '@/components/MemberImageField';
import { MealImageModal, MealThumbnail } from '@/components/meals/MealImage';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';

/**
 * #3328 stage 1 — Cordel → Base Meals, the platform's catalogue of meals.
 * Superadmin-only, like every Cordel catalogue. A meal is a name and a
 * description (English base values, ES/CA through the globe), a slug generated
 * once by the server, and the WebP image pair under `cordel/meals/`. The list
 * has the saved Cards | List toggle; the circular thumbnail opens the shared
 * meal image modal. Creating and editing are inline (#800).
 */

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
  translations: Partial<Record<TLoc, { name: string; description: string | null }>>;
  created_at: string | null;
  created_by: string | null;
  modified_at: string | null;
  modified_by: string | null;
  deleted_at: string | null;
  deleted_by: string | null;
}

type Texts = Record<Loc, { name: string; description: string }>;
interface Form { id: number | null; texts: Texts }

function formFor(m: Meal | null): Form {
  const texts = { en: { name: m?.name ?? '', description: m?.description ?? '' } } as Texts;
  for (const l of TRANSLATED) {
    texts[l] = { name: m?.translations?.[l]?.name ?? '', description: m?.translations?.[l]?.description ?? '' };
  }
  return { id: m?.id ?? null, texts };
}

function payloadOf(form: Form) {
  return {
    name: form.texts.en.name.trim(),
    description: form.texts.en.description.trim() || null,
    translations: Object.fromEntries(TRANSLATED.map((l) => [l, {
      name: form.texts[l].name.trim(),
      description: form.texts[l].description.trim() || null,
    }])),
  };
}

export default function BaseMealsPage() {
  const t = useTranslations('base_meals');
  const tMembers = useTranslations('members');
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
  const [form, setForm] = useState<Form | null>(null);
  const [stagedImage, setStagedImage] = useState<Blob | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<Meal | null>(null);
  const [deleting, setDeleting] = useState<Meal | null>(null);
  const [imageOf, setImageOf] = useState<Meal | null>(null);
  const [openField, setOpenField] = useState<'name' | 'description' | null>(null);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (!gymLoading && isSuperadmin) load();
  }, [gymLoading, isSuperadmin, q]);

  async function load() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set('search', q.trim());
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
    // Editing from a card switches to the list, where the inline editor lives.
    if (m) setView('list');
    setForm(formFor(m));
    setStagedImage(null);
    setError(null);
  }

  function closeForm() { setForm(null); setStagedImage(null); setError(null); }

  function onImageChanged(updated: unknown) {
    const m = updated as Meal;
    setRows((rs) => rs.map((r) => (r.id === m.id ? { ...r, ...m } : r)));
  }

  const menuFor = (m: Meal) => [
    { label: t('edit'), onClick: () => openForm(m) },
    { label: t('details'), onClick: () => setDetails(m) },
    { label: t('delete'), onClick: () => setDeleting(m), danger: true },
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
            <div style={{ fontSize: 13, color: '#666', overflowWrap: 'anywhere' }}>{m.display_description}</div>
          )}
          <div style={{ fontSize: 12.5, color: '#888' }}><code>{m.slug}</code></div>
        </div>
      </div>
    );
  }

  function renderRow(m: Meal) {
    const isEditing = form?.id === m.id;
    return (
      <div key={m.id} style={{ borderTop: '1px solid var(--gd-separator, #eee)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' }}>
          <MealThumbnail meal={m} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontWeight: 600, flexShrink: 0, maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.display_name}>{m.display_name}</span>
            {m.display_description && (
              <span style={{ fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{m.display_description}</span>
            )}
          </div>
          <code style={{ fontSize: 12.5, color: '#888', whiteSpace: 'nowrap' }}>{m.slug}</code>
          <ContextMenu items={menuFor(m)} ariaLabel={m.display_name} />
        </div>
        {isEditing && <div style={{ padding: 12 }}>{editor}</div>}
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('title')}</h1>
        <button style={primaryBtnStyle()} disabled={form?.id === null} onClick={() => openForm(null)}>{t('add')}</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <FormInput style={{ width: 220 }} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('search')} />
        <div style={{ marginLeft: 'auto' }}><ExerciseViewToggle value={view} onChange={setView} /></div>
      </div>

      {form?.id === null && <div style={{ marginBottom: 12 }}>{editor}</div>}

      {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p>
        : view === 'cards' ? <CardGrid>{rows.map(renderCard)}</CardGrid>
          : <div style={cardSurfaceStyle}>{rows.map(renderRow)}</div>}

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
