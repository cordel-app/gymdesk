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
  formControlStyle, formErrorStyle, formFieldLabelStyle, formHelpTextStyle, inlineActionsRowStyle,
  inlineEditorStyle, inlineEditorTitleStyle, secondaryBtnSmall, cardSectionLabelStyle,
} from '@/components/formChrome';
import { MemberAvatar } from '@/components/MemberAvatar';
import { MemberImageField } from '@/components/MemberImageField';
import { CardGrid, CardSquareImage } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { formatGymDateTime } from '@/lib/gymFormat';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import {
  BASE_PS_LOCALES, capacityError, emptyForm, formFor, toPayload, type BasePs, type Form, type Loc,
} from './baseProfessionalServiceForm';

/**
 * #1817 — Cordel → Base Professional Services. A superadmin-only catalogue:
 * a name and description in each product language and a Max Capacity (a
 * property of the definition only — nothing books against it yet). Creating and
 * editing are inline; Delete is a soft delete the server refuses while the
 * service is in use.
 */
export default function BaseProfessionalServicesPage() {
  const t = useTranslations('base_professional_services');
  const { apiFetch } = useApiClient();
  const fmt = useGymFormatSettings();
  const locale = useLocale();
  const router = useRouter();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [view, setView] = useExerciseViewMode();
  const [rows, setRows] = useState<BasePs[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<BasePs | null>(null);
  const [deleting, setDeleting] = useState<BasePs | null>(null);

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
      if (q.trim()) params.set('q', q.trim());
      setRows(await apiFetch<BasePs[]>(`/platform/professional-services?${params}`));
    } catch (err: any) {
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!form) return;
    if (BASE_PS_LOCALES.some((l) => !form.texts[l].name.trim())) {
      setError(t('error_required'));
      return;
    }
    if (capacityError(form.max_capacity)) {
      setError(t('error_capacity'));
      return;
    }
    setSaving(true); setError(null);
    try {
      await apiFetch(form.id == null ? '/platform/professional-services' : `/platform/professional-services/${form.id}`, {
        method: form.id == null ? 'POST' : 'PUT',
        body: JSON.stringify(toPayload(form)),
      });
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
      await apiFetch(`/platform/professional-services/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  function applyImageChange(updated: unknown) {
    const next = updated as BasePs;
    setRows((prev) => prev.map((r) => (r.id === next.id
      ? { ...r, image_url: next.image_url, image_thumbnail_url: next.image_thumbnail_url, modified_at: next.modified_at }
      : r)));
  }

  function setText(l: Loc, field: 'name' | 'description', value: string) {
    setForm((f) => f && ({ ...f, texts: { ...f.texts, [l]: { ...f.texts[l], [field]: value } } }));
  }

  if (gymLoading || !isSuperadmin) return null;

  const editor = form && (
    <div style={inlineEditorStyle}>
      <div style={inlineEditorTitleStyle}>{form.id == null ? t('add') : t('edit')}</div>
      {BASE_PS_LOCALES.map((l) => (
        <div key={l}>
          <label style={formFieldLabelStyle}>{t('name_in', { locale: l.toUpperCase() })}</label>
          <input style={formControlStyle} value={form.texts[l].name} maxLength={150} onChange={(e) => setText(l, 'name', e.target.value)} />
          <label style={formFieldLabelStyle}>{t('description_in', { locale: l.toUpperCase() })}</label>
          <textarea style={{ ...formControlStyle, minHeight: 64 }} value={form.texts[l].description} maxLength={2000} onChange={(e) => setText(l, 'description', e.target.value)} />
        </div>
      ))}
      <label style={formFieldLabelStyle}>{t('max_capacity')}</label>
      <input
        style={formControlStyle}
        inputMode="numeric"
        value={form.max_capacity}
        onChange={(e) => setForm({ ...form, max_capacity: e.target.value })}
      />
      <div style={formHelpTextStyle}>{t('max_capacity_help')}</div>
      {form.id != null && (
        <>
          <div style={{ ...cardSectionLabelStyle, margin: '12px 0 8px' }}>{t('section_media')}</div>
          <MemberImageField
            target={{
              kind: 'immediate',
              memberId: form.id,
              basePath: '/platform/professional-services',
              imageUrl: rows.find((r) => r.id === form.id)?.image_url ?? null,
              stamp: rows.find((r) => r.id === form.id)?.modified_at,
              onChanged: applyImageChange,
            }}
            requiresGymStorage={false}
            label={(key) => t(key as any)}
          />
        </>
      )}
      {error && <div style={formErrorStyle} role="alert">{error}</div>}
      <div style={inlineActionsRowStyle}>
        <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{t('save')}</button>
        <button style={secondaryBtnSmall} disabled={saving} onClick={() => { setForm(null); setError(null); }}>{t('cancel')}</button>
      </div>
    </div>
  );

  const dash = '—';
  const rowMenu = (s: BasePs) => (
    <ContextMenu
      items={[
        { label: t('edit'), onClick: () => { setView('list'); setForm(formFor(s)); setError(null); } },
        { label: t('details'), onClick: () => setDetails(s) },
        { label: t('delete'), onClick: () => setDeleting(s), danger: true },
      ]}
    />
  );
  const when = (v: string | null | undefined) => (v ? formatGymDateTime(v, fmt) : dash);

  return (
    <div style={{ padding: 24, maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>{t('title')}</h1>
        <button style={primaryBtnStyle()} disabled={form?.id === null} onClick={() => { setForm(emptyForm()); setError(null); }}>{t('add')}</button>
      </div>

      <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <ExerciseViewToggle value={view} onChange={setView} />
        <FormInput style={{ width: 220 }} placeholder={t('search')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('search')} />
      </div>

      {form?.id === null && editor}

      {view === 'cards' && !loading && rows.length > 0 ? (
        <div style={{ marginTop: form?.id === null ? 12 : 0 }}>
          <CardGrid>
            {rows.map((s) => (
              <div key={s.id} style={{ ...cardSurfaceStyle, overflow: 'hidden' }}>
                {s.image_url && <CardSquareImage src={s.image_url} alt={s.display_name} version={s.modified_at} placeholder={null} />}
                <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {!s.image_url && <MemberAvatar name={s.display_name} imageUrl={null} size={40} />}
                    <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>{s.display_name}</div>
                    {rowMenu(s)}
                  </div>
                  <div style={{ fontSize: 13, color: '#888', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }} title={s.display_description ?? undefined}>
                    {s.display_description ?? dash}
                  </div>
                  <div style={{ fontSize: 13 }}>{t('max_capacity')}: {s.max_capacity ?? dash}</div>
                </div>
              </div>
            ))}
          </CardGrid>
        </div>
      ) : (
      <div style={{ ...cardSurfaceStyle, marginTop: form?.id === null ? 12 : 0 }}>
        {loading ? <p style={{ padding: 16 }}>…</p> : rows.length === 0 ? <p style={{ padding: 16 }}>{t('empty')}</p> : rows.map((s) => (
          form?.id === s.id ? (
            <div key={s.id} style={{ padding: 12, borderTop: '1px solid var(--gd-separator, #eee)' }}>{editor}</div>
          ) : (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderTop: '1px solid var(--gd-separator, #eee)' }}>
              <MemberAvatar name={s.display_name} imageUrl={s.image_thumbnail_url ?? s.image_url} stamp={s.modified_at} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{s.display_name}</div>
                <div style={{ fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.display_description ?? dash}
                </div>
              </div>
              <div style={{ fontSize: 13 }}>{t('max_capacity')}: {s.max_capacity ?? dash}</div>
              {rowMenu(s)}
            </div>
          )
        ))}
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
        extraFooter={details ? <ViewAuditLogButton entityType="professional_service" entityId={details.id} /> : null}
      >
        {details && (
          <div style={{ fontSize: 14 }}>
            <p><strong>{t('max_capacity')}:</strong> {details.max_capacity ?? t('not_configured')}</p>
            <p><strong>EN:</strong> {details.name}{details.description ? ` — ${details.description}` : ''}</p>
            {(['es', 'ca'] as const).map((l) => (
              <p key={l}><strong>{l.toUpperCase()}:</strong> {details.translations[l]?.name ?? dash}
                {details.translations[l]?.description ? ` — ${details.translations[l]?.description}` : ''}</p>
            ))}
            <p><strong>{t('created_at')}:</strong> {when(details.created_at)}</p>
            <p><strong>{t('created_by')}:</strong> {details.created_by ?? dash}</p>
            <p><strong>{t('modified_at')}:</strong> {when(details.modified_at)}</p>
            <p><strong>{t('modified_by')}:</strong> {details.modified_by ?? dash}</p>
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
