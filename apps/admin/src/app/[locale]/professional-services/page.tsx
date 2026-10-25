'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymDate, type GymFormatSettings } from '@/lib/gymFormat';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { btnSmall, cardSurfaceStyle, primaryBtnSmall, primaryBtnStyle, readOnlyStyle } from '@/components/ui';
import { listNameBadgeStyle } from '@/components/listChrome';
import { inlineActionsRowStyle, secondaryBtnStyle } from '@/components/formChrome';
import { MemberAvatar } from '@/components/MemberAvatar';
import { MemberImageField } from '@/components/MemberImageField';
import { CardGrid, CardSquareImage } from '@/components/CardGrid';
import { ExerciseViewToggle, useExerciseViewMode } from '@/components/exercises/ExerciseViewToggle';
import { cardSectionLabelStyle } from '@/components/formChrome';
import { ImportProfessionalServicesModal } from './ImportProfessionalServicesModal';

// ─── Types ────────────────────────────────────────────────────────────────────

const STATUSES = ['active', 'inactive'] as const;
type ServiceStatus = typeof STATUSES[number];

interface ProfessionalService {
  id: number;
  gym_id: string | null;
  name: string;
  description: string | null;
  is_system: number;
  system_key: string | null;
  max_capacity: number | null;
  image_url?: string | null;
  image_thumbnail_url?: string | null;
  status: ServiceStatus;
  created_at: string;
  modified_at: string | null;
}

type EditForm = {
  name: string;
  description: string;
  max_capacity: string;
};

/** '' → no capacity; otherwise a positive whole number (the API's rule, mirrored for the message only). */
function parseCapacityInput(value: string): { value: number | null } | { error: true } {
  const v = value.trim();
  if (v === '') return { value: null };
  if (!/^\d+$/.test(v) || Number(v) <= 0) return { error: true };
  return { value: Number(v) };
}

type InlineNew = {
  name: string;
  description: string;
  max_capacity: string;
  saving: boolean;
  error: string | null;
};

function emptyEditForm(item: ProfessionalService): EditForm {
  return {
    name: item.name,
    description: item.description ?? '',
    max_capacity: item.max_capacity === null || item.max_capacity === undefined ? '' : String(item.max_capacity),
  };
}

function fmtDate(iso: string | null, s: GymFormatSettings) {
  if (!iso) return '—';
  return formatGymDate(iso, s);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 3 — the row and the header band are laid out from one declaration
 * rather than restating widths at each other (#637's shape). The header folded
 * the chevron and the `⋮` into one 68px cell while the row rendered two.
 *
 * `mobile` says what each column is on a phone. The service's name is the row's
 * identity — it carries its description and its `System` pill under it — and its
 * status rides beside it, which is this list's whole width on a phone.
 */
interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `professional_services` namespace. */
  labelKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 180, grow: 2, mobile: 'name' },
  { key: 'status', labelKey: 'col_status', width: 100, mobile: 'keep' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 10;
/** This list's own horizontal inset — a card row. */
const ROW_PADDING_X = 16;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

export default function ProfessionalServicesPage() {
  const gymFmt = useGymFormatSettings();
  const t = useTranslations('professional_services');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');

  const [view, setView] = useExerciseViewMode();
  const [items, setItems] = useState<ProfessionalService[]>([]);
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  const [importOpen, setImportOpen] = useState(false);
  const [details, setDetails] = useState<ProfessionalService | null>(null);
  const [deleting, setDeleting] = useState<ProfessionalService | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!canRead) { router.replace(`/${locale}`); return; }
  }, [gymLoading, canRead]);

  useEffect(() => {
    if (!gymLoading && canRead) load();
  }, [activeGymId, gymLoading]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setItems(await apiFetch<ProfessionalService[]>('/professional-services'));
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Accordion ──────────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // ─── Inline new ─────────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew({ name: '', description: '', max_capacity: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() { setInlineNew(null); }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) { setInlineNew({ ...inlineNew, error: t('error_name_required') }); return; }
    const capacity = parseCapacityInput(inlineNew.max_capacity);
    if ('error' in capacity) { setInlineNew({ ...inlineNew, error: t('error_max_capacity') }); return; }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch('/professional-services', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          description: inlineNew.description.trim() || null,
          max_capacity: capacity.value,
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  function applyImageChange(updated: unknown) {
    const next = updated as ProfessionalService;
    setItems((prev) => prev.map((r) => (r.id === next.id
      ? { ...r, image_url: next.image_url, image_thumbnail_url: next.image_thumbnail_url, modified_at: next.modified_at }
      : r)));
  }

  function openEdit(item: ProfessionalService) {
    // Editing happens in the List view only; Edit from a card switches to it (#2010).
    setView('list');
    setEditingId(item.id);
    setEditForm(emptyEditForm(item));
    setEditError(null);
    setExpanded((prev) => new Set([...prev, item.id]));
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(null);
    setEditError(null);
  }

  async function handleSave(item: ProfessionalService) {
    if (!editForm) return;
    if (!editForm.name.trim()) { setEditError(t('error_name_required')); return; }
    const capacity = parseCapacityInput(editForm.max_capacity);
    if ('error' in capacity) { setEditError(t('error_max_capacity')); return; }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/professional-services/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          max_capacity: capacity.value,
        }),
      });
      cancelEdit();
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Activate / Deactivate / Duplicate ───────────────────────────────────────

  async function handleActivate(item: ProfessionalService) {
    try {
      await apiFetch(`/professional-services/${item.id}/activate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  async function handleDeactivate(item: ProfessionalService) {
    try {
      await apiFetch(`/professional-services/${item.id}/deactivate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  async function handleDuplicate(item: ProfessionalService) {
    try {
      await apiFetch(`/professional-services/${item.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) { toast(err.message ?? t('error_generic')); }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/professional-services/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) { setEditingId(null); setEditForm(null); }
      setExpanded((prev) => { const next = new Set(prev); next.delete(deleting.id); return next; });
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '16px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr', gap: 12, marginBottom: 12 }}>
            <div>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                ref={newNameRef}
                value={inlineNew.name}
                onChange={(e) => setInlineNew({ ...inlineNew, name: e.target.value })}
                placeholder={t('placeholder_name')}
                style={inlineInputStyle}
              />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={inlineNew.description}
                onChange={(e) => setInlineNew({ ...inlineNew, description: e.target.value })}
                placeholder={t('placeholder_description')}
                style={inlineInputStyle}
              />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={inlineLabelStyle}>{t('label_max_capacity')}</label>
            <input
              type="number" min={1} step={1}
              value={inlineNew.max_capacity}
              onChange={(e) => setInlineNew({ ...inlineNew, max_capacity: e.target.value })}
              placeholder={t('placeholder_max_capacity')}
              style={inlineInputStyle}
            />
          </div>
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={inlineActionsRowStyle}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={primaryBtnSmall()}>
              {inlineNew.saving ? t('saving') : t('create')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Card header (Cards view, #2010) ───────────────────────────────────────

  function renderCardHeader(item: ProfessionalService, menuItems: ContextMenuItem[]) {
    const isSystem = Boolean(item.is_system);
    return (
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {item.image_url && (
          <CardSquareImage src={item.image_url} alt={item.name} version={item.modified_at} placeholder={null} />
        )}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {!item.image_url && <MemberAvatar name={item.name} imageUrl={null} size={40} />}
            <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>
              {item.name}
              {isSystem && <span style={listNameBadgeStyle}>{t('system_badge')}</span>}
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
            </div>
          </div>
          <div
            title={item.description ?? undefined}
            style={{ fontSize: 13, color: '#888', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
          >
            {item.description || '—'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <StatusBadge status={item.status} label={tStatus(item.status)} />
            <span style={{ fontSize: 13, color: '#888' }}>
              {t('label_max_capacity')}: {item.max_capacity ?? '—'}
            </span>
          </div>
        </div>
      </div>
    );
  }

  function renderRow(item: ProfessionalService) {
    const isSystem = Boolean(item.is_system);
    const isExpanded = expanded.has(item.id);
    const isEditing = editingId === item.id;

    // #802: Professional Services orders its own menu — Duplicate first,
    // Deactivate second and carrying the destructive style, Details always last.
    // Activate is the same slot but is not destructive, so it stays unstyled.
    // Edit and Delete keep their behaviour and sit between the two fixed ends;
    // a System service hides both, which leaves exactly Duplicate / Deactivate /
    // Details — the menu the ticket describes.
    const menuItems: ContextMenuItem[] = [
      { label: t('duplicate'), onClick: () => handleDuplicate(item), disabled: !canWrite, title: readOnlyTitle },
      item.status === 'active'
        ? { label: t('deactivate'), onClick: () => handleDeactivate(item), danger: true, disabled: !canWrite, title: readOnlyTitle }
        : { label: t('activate'), onClick: () => handleActivate(item), disabled: !canWrite, title: readOnlyTitle },
      ...(!isSystem ? [{ label: t('edit'), onClick: () => openEdit(item), disabled: !canWrite, title: readOnlyTitle }] : []),
      ...(!isSystem ? [{ label: t('delete'), onClick: () => setDeleting(item), danger: true, disabled: !canWrite, title: readOnlyTitle }] : []),
      { label: t('details'), onClick: () => setDetails(item) },
    ];

    return (
      <div key={item.id} style={cardStyle}>
        {view === 'cards' ? renderCardHeader(item, menuItems) : (
        /* Collapsed header */
        <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={() => toggleExpand(item.id)}>
          <div className={CELL_CLASS.name} title={item.name} style={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
            <MemberAvatar name={item.name} imageUrl={item.image_thumbnail_url ?? item.image_url} stamp={item.modified_at} size={36} />
            <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.name}
              {isSystem && (
                <span style={listNameBadgeStyle}>
                  {t('system_badge')}
                </span>
              )}
            </div>
            {item.description && (
              <div style={{ fontSize: 12.5, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                {item.description}
              </div>
            )}
            </div>
          </div>
          <div className={CELL_CLASS.status}>
            <StatusBadge status={item.status} label={tStatus(item.status)} />
          </div>
          <span className={CELL_CLASS.expand} style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
          </div>
        </div>
        )}

        {/* Inline edit (custom services only) */}
        {isEditing && editForm && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <div style={{ marginBottom: 12 }}>
              <label style={inlineLabelStyle}>{t('label_name')} *</label>
              <input
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                autoFocus
                style={inlineInputStyle}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={inlineLabelStyle}>{t('label_description')}</label>
              <input
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                placeholder={t('placeholder_description')}
                style={inlineInputStyle}
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={inlineLabelStyle}>{t('label_max_capacity')}</label>
              <input
                type="number" min={1} step={1}
                value={editForm.max_capacity}
                onChange={(e) => setEditForm({ ...editForm, max_capacity: e.target.value })}
                placeholder={t('placeholder_max_capacity')}
                style={inlineInputStyle}
              />
            </div>
            <div style={{ ...cardSectionLabelStyle, marginBottom: 8 }}>{t('section_media')}</div>
            <div style={{ marginBottom: 12 }}>
              <MemberImageField
                target={{
                  kind: 'immediate',
                  memberId: item.id,
                  basePath: '/professional-services',
                  imageUrl: item.image_url ?? null,
                  stamp: item.modified_at,
                  onChanged: applyImageChange,
                }}
                disabled={!canWrite}
                disabledTitle={readOnlyTitle}
                label={(key) => t(key as any)}
              />
            </div>
            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={inlineActionsRowStyle}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(item)} disabled={editSaving} style={primaryBtnSmall()}>
                {editSaving ? t('saving') : t('save')}
              </button>
            </div>
          </div>
        )}

        {/* Read-only expanded */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <DetailRow label={t('label_description')} value={item.description ?? t('no_description')} />
            <DetailRow label={t('label_max_capacity')} value={item.max_capacity === null || item.max_capacity === undefined ? t('no_max_capacity') : String(item.max_capacity)} />
          </div>
        )}
      </div>
    );
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  if (gymLoading || !canRead) return null;

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {isAdmin && (
            <button onClick={() => setImportOpen(true)} title={readOnlyTitle} style={readOnlyStyle(secondaryBtnStyle, !canWrite)} disabled={!canWrite}>{t('import_services')}</button>
          )}
          <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <ExerciseViewToggle value={view} onChange={setView} />
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : items.length === 0 && !inlineNew ? (
        <>
          {renderInlineNewRow()}
          <p style={{ color: '#888' }}>{t('empty')}</p>
        </>
      ) : view === 'cards' ? (
        <>
          {renderInlineNewRow()}
          <CardGrid>{items.map(renderRow)}</CardGrid>
        </>
      ) : (
        /* The header band and the cards share LIST_GRID_COLUMNS and scroll
           together, so they cannot fall out of line, and a narrow viewport
           scrolls the list instead of the page (#1011). */
        <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
          <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
            {/* Column headers */}
            <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
              {LIST_COLUMNS.map((col) => (
                <div key={col.key} className={CELL_CLASS[col.key]}>
                  {col.labelKey ? t(col.labelKey) : null}
                </div>
              ))}
            </div>

            {/* Inline new */}
            {renderInlineNewRow()}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {items.map(renderRow)}
            </div>
          </div>
        </div>
      )}

      <ImportProfessionalServicesModal
        open={importOpen}
        onCancel={() => setImportOpen(false)}
        onImported={(result) => {
          setImportOpen(false);
          toast(t('import_done', { n: result.imported.length }) + (result.skipped.length > 0 ? ` ${t('import_skipped', { n: result.skipped.length })}` : ''));
          load();
        }}
      />

      {/* Details modal */}
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
            <ModalField label={t('label_name')} value={details.name} />
            <ModalField label={t('label_description')} value={details.description ?? t('no_description')} />
            <ModalField label={t('label_max_capacity')} value={details.max_capacity === null || details.max_capacity === undefined ? t('no_max_capacity') : String(details.max_capacity)} />
            <ModalField label={t('label_status')} value={tStatus(details.status)} />
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('audit_created_at')} value={fmtDate(details.created_at, gymFmt)} />
              <ModalField label={t('audit_updated_at')} value={fmtDate(details.modified_at, gymFmt)} />
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
      <ConfirmDialog
        open={deleting !== null}
        message={(<div><p style={{ margin: '0 0 8px', fontWeight: 600 }}>{t('confirm_delete_title')}</p><p style={{ margin: 0 }}>{t('confirm_delete_body')}</p></div>) as any}
        confirmLabel={t('confirm_delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

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

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };

const rowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `12px ${ROW_PADDING_X}px`,
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', padding: `6px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP,
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

const inlineLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12.5, fontWeight: 600, color: '#555', marginBottom: 4,
};

const inlineInputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const errorStyle: React.CSSProperties = { margin: '8px 0 0', fontSize: 13, color: '#c0392b' };
