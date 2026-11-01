'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass, listNameBadgeStyle,
} from '@/components/listChrome';
import { CrudModal, FormInput } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import {
  cardSectionLabelStyle, formControlStyle, formErrorStyle, formFieldLabelStyle, formHelpTextStyle,
  inlineActionsRowStyle, inlineEditorStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import { MemberAvatar } from '@/components/MemberAvatar';
import { MemberImageField } from '@/components/MemberImageField';
import { CardGrid, CardSquareImage } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDateTime } from '@/lib/gymFormat';
import {
  PS_LOCALES, emptyForm, formErrorKey, formFor, matchesSearch, toPayload, type Form, type Loc, type PsRow,
} from './psModel';

/**
 * #2110 — the one renderer of Professional Services. The gym's own page and
 * Cordel's Base page both render this component; what differs is data and
 * permissions, and that lives in `ProfessionalServicesConfig`, never in a second
 * set of cards, rows, editors or modals.
 */
export interface ProfessionalServicesConfig {
  /** API root: `/professional-services` or `/platform/professional-services`. */
  apiRoot: string;
  /** Base objects live under the platform root, so no gym bucket is needed. */
  requiresGymStorage: boolean;
  /** A gym's service has a per-gym Active/Inactive status and Duplicate; a Base one has neither. */
  hasStatus: boolean;
  /** A Base service needs a name in every language; a gym's own falls back to English. */
  requireAllTranslations: boolean;
  /** A row whose definition cannot be edited or deleted here (a gym's System service). */
  isReadOnlyDefinition: (item: PsRow) => boolean;
  canWrite: boolean;
  readOnlyTitle?: string;
  /** Re-fetch when this changes (the active gym). */
  reloadKey?: string | null;
  title: string;
  addLabel: string;
  emptyLabel: string;
  /** Extra header buttons (the gym page's Import), given the reload function. */
  headerActions?: (reload: () => void) => React.ReactNode;
}

interface ListColumn extends ListGridColumn {
  labelKey?: string;
  width: number;
  grow?: number;
}

/** #1011 — one declaration for the header band and the rows. */
const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 180, grow: 2, mobile: 'name' },
  { key: 'status', labelKey: 'col_status', width: 100, mobile: 'keep' },
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];
const CELL_CLASS = listCellClasses(LIST_COLUMNS);
const LIST_COLUMN_GAP = 10;
const ROW_PADDING_X = 16;
const gridColumns = (cols: ListColumn[]) =>
  cols.map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`)).join(' ');
const minWidth = (cols: ListColumn[]) =>
  cols.reduce((sum, c) => sum + c.width, 0) + LIST_COLUMN_GAP * (cols.length - 1) + ROW_PADDING_X * 2;

export function ProfessionalServicesView(cfg: ProfessionalServicesConfig) {
  const t = useTranslations('professional_services');
  const tStatus = useTranslations('status');
  const fmt = useGymFormatSettings();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const { canWrite, readOnlyTitle } = cfg;

  // A Base service carries no status, so its list has no status column.
  const columns = cfg.hasStatus ? LIST_COLUMNS : LIST_COLUMNS.filter((c) => c.key !== 'status');
  const columnsCss = gridColumns(columns);
  const rowStyle: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: columnsCss, alignItems: 'center', gap: LIST_COLUMN_GAP,
    padding: `12px ${ROW_PADDING_X}px`, cursor: 'pointer', userSelect: 'none',
  };
  const colHeaderStyle: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: columnsCss, alignItems: 'center', gap: LIST_COLUMN_GAP,
    padding: `6px ${ROW_PADDING_X}px`, fontSize: 12, fontWeight: 600, color: '#888',
    textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4,
  };

  const [view, setView] = useExerciseViewMode();
  const [items, setItems] = useState<PsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<PsRow | null>(null);
  const [deleting, setDeleting] = useState<PsRow | null>(null);
  // #2129: the server refuses a delete while records still reference the service.
  const [inUse, setInUse] = useState<{ activities: number; calendar_events: number; product_snapshots: number } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { load(); }, [cfg.reloadKey, cfg.apiRoot]);

  async function load() {
    setLoading(true);
    try {
      setItems(await apiFetch<PsRow[]>(cfg.apiRoot));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  function toggleExpand(id: number) {
    if (form?.id === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function openNew() {
    setForm(emptyForm()); setError(null);
    setTimeout(() => nameRef.current?.focus(), 50);
  }

  function openEdit(item: PsRow) {
    // Editing happens in the List view only; Edit from a card switches to it (#2010).
    setView('list');
    setForm(formFor(item)); setError(null);
    setExpanded((prev) => new Set([...prev, item.id]));
  }

  function cancelEdit() { setForm(null); setError(null); }

  async function save() {
    if (!form) return;
    const key = formErrorKey(form, cfg.requireAllTranslations);
    if (key) { setError(t(key)); return; }
    setSaving(true); setError(null);
    try {
      await apiFetch(form.id == null ? cfg.apiRoot : `${cfg.apiRoot}/${form.id}`, {
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

  async function action(item: PsRow, verb: 'activate' | 'deactivate' | 'duplicate') {
    try {
      await apiFetch(`${cfg.apiRoot}/${item.id}/${verb}`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  const handleActivate = (item: PsRow) => action(item, 'activate');
  const handleDeactivate = (item: PsRow) => action(item, 'deactivate');
  const handleDuplicate = (item: PsRow) => action(item, 'duplicate');

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`${cfg.apiRoot}/${deleting.id}`, { method: 'DELETE' });
      const id = deleting.id;
      setDeleting(null);
      if (form?.id === id) setForm(null);
      setExpanded((prev) => { const next = new Set(prev); next.delete(id); return next; });
      load();
    } catch (err: any) {
      setDeleting(null);
      if (err?.status === 409 && err?.body?.code === 'professional_service_in_use') {
        setInUse(err.body.references);
        return;
      }
      toast(err.message ?? t('error_generic'));
    }
  }

  function applyImageChange(updated: unknown) {
    const next = updated as PsRow;
    setItems((prev) => prev.map((r) => (r.id === next.id
      ? { ...r, image_url: next.image_url, image_thumbnail_url: next.image_thumbnail_url, modified_at: next.modified_at }
      : r)));
  }

  function setText(l: Loc, field: 'name' | 'description', value: string) {
    setForm((f) => f && ({ ...f, texts: { ...f.texts, [l]: { ...f.texts[l], [field]: value } } }));
  }

  const dash = '—';
  const when = (v: string | null | undefined) => (v ? formatGymDateTime(v, fmt) : dash);
  const capacityText = (item: PsRow) => (item.max_capacity == null ? t('no_max_capacity') : String(item.max_capacity));

  // ─── Editor (create and edit share it) ─────────────────────────────────────

  function renderEditor() {
    if (!form) return null;
    const item = form.id == null ? null : items.find((r) => r.id === form.id) ?? null;
    return (
      <div style={inlineEditorStyle}>
        {PS_LOCALES.map((l) => (
          <div key={l}>
            <label style={formFieldLabelStyle}>{t('name_in', { locale: l.toUpperCase() })}{l === 'en' || cfg.requireAllTranslations ? ' *' : ''}</label>
            <input
              ref={l === 'en' ? nameRef : undefined}
              style={formControlStyle} value={form.texts[l].name} maxLength={150}
              placeholder={l === 'en' ? t('placeholder_name') : undefined}
              onChange={(e) => setText(l, 'name', e.target.value)}
            />
            <label style={formFieldLabelStyle}>{t('description_in', { locale: l.toUpperCase() })}</label>
            <textarea
              style={{ ...formControlStyle, minHeight: 64 }} value={form.texts[l].description} maxLength={2000}
              placeholder={l === 'en' ? t('placeholder_description') : undefined}
              onChange={(e) => setText(l, 'description', e.target.value)}
            />
          </div>
        ))}
        <label style={formFieldLabelStyle}>{t('label_max_capacity')}</label>
        <input
          style={formControlStyle} inputMode="numeric" value={form.max_capacity}
          placeholder={t('placeholder_max_capacity')}
          onChange={(e) => setForm({ ...form, max_capacity: e.target.value })}
        />
        <div style={formHelpTextStyle}>{t('max_capacity_help')}</div>
        {item && (
          <>
            <div style={{ ...cardSectionLabelStyle, margin: '12px 0 8px' }}>{t('section_media')}</div>
            <MemberImageField
              target={{
                kind: 'immediate',
                memberId: item.id,
                basePath: cfg.apiRoot,
                imageUrl: item.image_url ?? null,
                stamp: item.modified_at,
                onChanged: applyImageChange,
              }}
              disabled={!canWrite}
              disabledTitle={readOnlyTitle}
              requiresGymStorage={cfg.requiresGymStorage}
              label={(key) => t(key as any)}
            />
          </>
        )}
        {error && <div style={formErrorStyle} role="alert">{error}</div>}
        <div style={inlineActionsRowStyle}>
          <button style={primaryBtnSmall()} disabled={saving} onClick={save}>{saving ? t('saving') : t('save')}</button>
          <button style={secondaryBtnSmall} disabled={saving} onClick={cancelEdit}>{t('cancel')}</button>
        </div>
      </div>
    );
  }

  // ─── Read-only expanded body ───────────────────────────────────────────────

  function renderExpanded(item: PsRow) {
    return (
      <div style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--gd-border, #eee)' }}>
        {PS_LOCALES.map((l) => {
          const name = l === 'en' ? item.name : item.translations?.[l]?.name;
          const description = l === 'en' ? item.description : item.translations?.[l]?.description;
          return (
            <React.Fragment key={l}>
              <DetailRow label={t('name_in', { locale: l.toUpperCase() })} value={name || dash} />
              <DetailRow label={t('description_in', { locale: l.toUpperCase() })} value={description || t('no_description')} />
            </React.Fragment>
          );
        })}
        <DetailRow label={t('label_max_capacity')} value={capacityText(item)} />
        {/* Same order as the editor: texts, capacity, then Media (#2241). */}
        <div style={{ ...cardSectionLabelStyle, margin: '12px 0 8px' }}>{t('section_media')}</div>
        {item.image_url ? (
          <div style={{ width: 160 }}>
            <CardSquareImage src={item.image_url} alt={item.display_name} version={item.modified_at} placeholder={null} />
          </div>
        ) : (
          <div style={{ fontSize: 13, color: '#111' }}>{dash}</div>
        )}
      </div>
    );
  }

  // ─── Card header (Cards view, #2010) ───────────────────────────────────────

  function renderCardHeader(item: PsRow, menuItems: ContextMenuItem[]) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {item.image_url && (
          <CardSquareImage src={item.image_url} alt={item.display_name} version={item.modified_at} placeholder={null} />
        )}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, cursor: 'pointer' }} onClick={() => toggleExpand(item.id)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>
              {item.display_name}
              {Boolean(item.is_system) && cfg.hasStatus && <span style={listNameBadgeStyle}>{t('system_badge')}</span>}
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.display_name}`} />
            </div>
          </div>
          <div
            title={item.display_description ?? undefined}
            style={{ fontSize: 13, color: '#888', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {item.display_description || dash}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            {item.status ? <StatusBadge status={item.status} label={tStatus(item.status)} /> : <span />}
            <span style={{ fontSize: 13, color: '#888' }}>{t('label_max_capacity')}: {item.max_capacity ?? dash}</span>
          </div>
        </div>
      </div>
    );
  }

  function renderRow(item: PsRow) {
    const isSystem = cfg.isReadOnlyDefinition(item);
    const isExpanded = expanded.has(item.id);
    const isEditing = form?.id === item.id;

    // #802: Duplicate first, the Deactivate · Activate slot second (the
    // destructive one carries `danger`), Details always last; Edit and Delete sit
    // between and a read-only definition hides both. A Base service has no
    // status, so it keeps just Edit / Delete / Details.
    const menuItems: ContextMenuItem[] = [
      ...(cfg.hasStatus ? [{ label: t('duplicate'), onClick: () => handleDuplicate(item), disabled: !canWrite, title: readOnlyTitle }] : []),
      ...(cfg.hasStatus ? [item.status === 'active'
        ? { label: t('deactivate'), onClick: () => handleDeactivate(item), danger: true, disabled: !canWrite, title: readOnlyTitle }
        : { label: t('activate'), onClick: () => handleActivate(item), disabled: !canWrite, title: readOnlyTitle }] : []),
      ...(!isSystem ? [{ label: t('edit'), onClick: () => openEdit(item), disabled: !canWrite, title: readOnlyTitle }] : []),
      ...(!isSystem ? [{ label: t('delete'), onClick: () => setDeleting(item), danger: true, disabled: !canWrite, title: readOnlyTitle }] : []),
      { label: t('details'), onClick: () => setDetails(item) },
    ];

    return (
      <div key={item.id} style={{ ...cardSurfaceStyle, overflow: 'hidden' }}>
        {view === 'cards' ? renderCardHeader(item, menuItems) : (
          <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={() => toggleExpand(item.id)}>
            <div className={CELL_CLASS.name} title={item.display_name} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* No image → no thumbnail at all, not an empty placeholder (#2110). */}
              {(item.image_thumbnail_url ?? item.image_url) && (
                <MemberAvatar name={item.display_name} imageUrl={item.image_thumbnail_url ?? item.image_url ?? null} stamp={item.modified_at} size={36} />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.display_name}
                  {Boolean(item.is_system) && cfg.hasStatus && <span style={listNameBadgeStyle}>{t('system_badge')}</span>}
                </div>
                {item.display_description && (
                  <div style={{ fontSize: 12.5, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                    {item.display_description}
                  </div>
                )}
              </div>
            </div>
            {cfg.hasStatus && item.status && (
              <div className={CELL_CLASS.status}>
                <StatusBadge status={item.status} label={tStatus(item.status)} />
              </div>
            )}
            <span className={CELL_CLASS.expand} style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
            <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
              <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.display_name}`} />
            </div>
          </div>
        )}

        {isEditing && <div style={{ padding: 12, borderTop: '1px solid var(--gd-border, #eee)' }}>{renderEditor()}</div>}
        {isExpanded && !isEditing && renderExpanded(item)}
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  const visible = items.filter((s) => matchesSearch(s, q));
  const newEditor = form?.id === null ? <div style={{ marginBottom: 12 }}>{renderEditor()}</div> : null;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{cfg.title}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {cfg.headerActions?.(load)}
          <button onClick={openNew} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite || form?.id === null}>{cfg.addLabel}</button>
        </div>
      </div>

      {/* Search on the left, the Cards | List toggle on the right (the Exercises layout). */}
      <div style={{ marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <FormInput style={{ width: 220 }} placeholder={t('search_placeholder')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('search_placeholder')} />
        <div style={{ marginLeft: 'auto' }}>
          <ExerciseViewToggle value={view} onChange={setView} />
        </div>
      </div>

      {newEditor}

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : visible.length === 0 ? (
        form?.id === null ? null : <p style={{ color: '#888' }}>{cfg.emptyLabel}</p>
      ) : view === 'cards' ? (
        <CardGrid>{visible.map(renderRow)}</CardGrid>
      ) : (
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
          <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: minWidth(columns) }}>
            <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
              {columns.map((col) => (
                <div key={col.key} className={CELL_CLASS[col.key]}>{col.labelKey ? t(col.labelKey) : null}</div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{visible.map(renderRow)}</div>
          </div>
        </div>
      )}

      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('close')}
        saveLabel=""
        extraFooter={<ViewAuditLogButton entityType="professional_service" entityId={details?.id} onNavigate={() => setDetails(null)} />}
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {PS_LOCALES.map((l) => (
              <ModalField
                key={l}
                label={`${t('label_name')} (${l.toUpperCase()})`}
                value={(l === 'en' ? details.name : details.translations?.[l]?.name) || dash}
              />
            ))}
            {PS_LOCALES.map((l) => (
              <ModalField
                key={`d-${l}`}
                label={`${t('label_description')} (${l.toUpperCase()})`}
                value={(l === 'en' ? details.description : details.translations?.[l]?.description) || t('no_description')}
              />
            ))}
            <ModalField label={t('label_max_capacity')} value={capacityText(details)} />
            {details.status && <ModalField label={t('label_status')} value={tStatus(details.status)} />}
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('audit_created_at')} value={when(details.created_at)} />
              <ModalField label={t('created_by')} value={details.created_by ?? dash} />
              <ModalField label={t('audit_updated_at')} value={when(details.modified_at)} />
              <ModalField label={t('modified_by')} value={details.modified_by ?? dash} />
            </div>
          </div>
        )}
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={(<div><p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('confirm_delete_title')}</p><p style={{ margin: 0 }}>{t('confirm_delete_body')}</p></div>) as any}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={inUse !== null}
        message={(<div>
          <p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('delete_blocked_title')}</p>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            <li>{t('delete_blocked_activities', { count: inUse?.activities ?? 0 })}</li>
            <li>{t('delete_blocked_calendar_events', { count: inUse?.calendar_events ?? 0 })}</li>
            <li>{t('delete_blocked_product_snapshots', { count: inUse?.product_snapshots ?? 0 })}</li>
          </ul>
          <p style={{ margin: 0 }}>{t('delete_blocked_hint')}</p>
        </div>) as any}
        confirmLabel={t('close')}
        cancelLabel={t('close')}
        onConfirm={() => setInUse(null)}
        onCancel={() => setInUse(null)}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1, whiteSpace: 'pre-wrap' }}>{value}</span>
    </div>
  );
}

function ModalField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      {label && <span style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>}
      <p style={{ margin: '2px 0 0', fontSize: 14 }}>{value}</p>
    </div>
  );
}
