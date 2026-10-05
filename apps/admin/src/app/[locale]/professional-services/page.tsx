'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
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
  status: ServiceStatus;
  created_at: string;
  updated_at: string | null;
}

type EditForm = {
  name: string;
  description: string;
};

type InlineNew = {
  name: string;
  description: string;
  saving: boolean;
  error: string | null;
};

function emptyEditForm(item: ProfessionalService): EditForm {
  return {
    name: item.name,
    description: item.description ?? '',
  };
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
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
  const t = useTranslations('professional_services');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');

  const [items, setItems] = useState<ProfessionalService[]>([]);
  const [loading, setLoading] = useState(true);

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

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
    setInlineNew({ name: '', description: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  function cancelInlineNew() { setInlineNew(null); }

  async function saveInlineNew() {
    if (!inlineNew) return;
    if (!inlineNew.name.trim()) { setInlineNew({ ...inlineNew, error: t('error_name_required') }); return; }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch('/professional-services', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          description: inlineNew.description.trim() || null,
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ────────────────────────────────────────────────────────────────────

  function openEdit(item: ProfessionalService) {
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
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/professional-services/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
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
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={cancelInlineNew} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={primaryBtnSmall()}>
              {inlineNew.saving ? t('saving') : t('create')}
            </button>
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
        {/* Collapsed header */}
        <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={() => toggleExpand(item.id)}>
          <div className={CELL_CLASS.name} title={item.name} style={{ minWidth: 0 }}>
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
          <div className={CELL_CLASS.status}>
            <StatusBadge status={item.status} label={tStatus(item.status)} />
          </div>
          <span className={CELL_CLASS.expand} style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
          </div>
        </div>

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
            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
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
        <button onClick={openInlineNew} title={readOnlyTitle} style={readOnlyStyle(primaryBtnStyle(), !canWrite)} disabled={!canWrite || inlineNew !== null}>{t('add')}</button>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : items.length === 0 && !inlineNew ? (
        <>
          {renderInlineNewRow()}
          <p style={{ color: '#888' }}>{t('empty')}</p>
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
            <ModalField label={t('label_status')} value={tStatus(details.status)} />
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label={t('audit_created_at')} value={fmtDate(details.created_at)} />
              <ModalField label={t('audit_updated_at')} value={fmtDate(details.updated_at)} />
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
