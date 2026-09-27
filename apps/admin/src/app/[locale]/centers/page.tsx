'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { btnStyle, btnSmall, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import {
  CENTER_PROFILE_SECTIONS,
  CENTER_STATUSES,
  CenterEditFormValues,
  CenterProfile,
  CenterStatus,
  EMPTY_VALUE,
  formatCenterField,
  formatCenterTheme,
  isCenterFormValid,
  toCenterEditFormValues,
  toCenterUpdatePayload,
} from './centerProfile';

/**
 * #800 — the Center row expands into a read-only view of the Center and
 * `⋮ → Edit` expands it into the inline form instead. There is no Edit Center
 * modal any more. The field set both halves render is declared once, in
 * `centerProfile.ts`.
 */
interface Center extends CenterProfile {
  id: number;
  code: string | null;
  theme_name: string | null;
  gym_theme_name: string | null;
  active_member_count: number;
  created_at: string;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_name: string | null;
}

interface Theme { id: string; name: string }

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6,
  border: '1px solid #ddd', fontSize: 14, boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = { ...inputStyle, background: '#fff', cursor: 'pointer' };

const subsectionLabelStyle: React.CSSProperties = {
  margin: '0 0 12px 0',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#aaa',
};

const fieldGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 16,
};

function formatDate(locale: string, iso: string | null | undefined): string {
  if (!iso) return EMPTY_VALUE;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}

function formatDateShort(locale: string, iso: string | null | undefined): string {
  if (!iso) return EMPTY_VALUE;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

export default function CentersPage() {
  const t = useTranslations('centers');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, loading: gymLoading } = useGym();
  const { refreshCenters } = useCenter();
  const { toast } = useToast();

  const { canRead, canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');

  const [centers, setCenters] = useState<Center[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [themes, setThemes] = useState<Theme[]>([]);

  // #800: expanding a card and editing it are two separate interactions.
  // `expandedId` is the strictly read-only view; `editingId` is the inline
  // form, which is reachable only through ⋮ → Edit. Never both at once.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<CenterEditFormValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Details / delete
  const [detailsCenter, setDetailsCenter] = useState<Center | null>(null);
  const [deleting, setDeleting] = useState<Center | null>(null);

  useEffect(() => {
    if (!gymLoading && !canRead) router.replace(`/${locale}`);
  }, [gymLoading, canRead]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      setCenters(await apiFetch<Center[]>(`/centers${statusFilter ? `?status=${statusFilter}` : ''}`));
    } catch (err: any) {
      setCenters([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadThemes() {
    try {
      setThemes(await apiFetch<Theme[]>('/system/themes'));
    } catch { /* non-fatal */ }
  }

  useEffect(() => {
    if (!gymLoading && canRead) { load(); loadThemes(); }
  }, [activeGymId, gymLoading, statusFilter]);

  async function handleAdd() {
    try {
      const row = await apiFetch<Center>('/centers', {
        method: 'POST',
        body: JSON.stringify({ name: t('new_center_name') }),
      });
      await load();
      refreshCenters();
      // The new Center is created empty; drop straight into its inline form.
      startEdit(row);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  /** #800: expanding a card only reads. It never seeds the form and never starts an edit. */
  function openExpand(center: Center) {
    if (expandedId === center.id) { setExpandedId(null); return; }
    setEditingId(null);
    setForm(null);
    setFormError(null);
    setExpandedId(center.id);
  }

  /** #800: ⋮ → Edit is the only way into the form, and it expands the row itself. */
  function startEdit(center: Center) {
    setExpandedId(null);
    setForm(toCenterEditFormValues(center));
    setEditingId(center.id);
    setFormError(null);
  }

  /** Cancel discards the draft without touching the API; the row keeps its persisted values. */
  function cancelEdit() {
    setEditingId(null);
    setForm(null);
    setFormError(null);
  }

  async function handleSaveEdit() {
    if (editingId === null || !form) return;
    if (!isCenterFormValid(form)) { setFormError(t('error_generic')); return; }
    setSaving(true);
    setFormError(null);
    try {
      await apiFetch(`/centers/${editingId}`, {
        method: 'PUT',
        body: JSON.stringify(toCenterUpdatePayload(form)),
      });
      setEditingId(null);
      setForm(null);
      load();
      refreshCenters();
    } catch (err: any) {
      // The form stays open with the user's input so the problem can be fixed.
      setFormError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/centers/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) setExpandedId(null);
      if (editingId === deleting.id) cancelEdit();
      setDeleting(null);
      load();
      refreshCenters();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  function themeLabel(center: Center): string {
    return formatCenterTheme(center, t('theme_inherited_suffix'));
  }

  function patchForm(patch: Partial<CenterEditFormValues>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  // ---------------------------------------------------------------------------
  // Read-only expanded card (#800). Nothing between here and renderInlineEditor
  // writes: no input, select, textarea, checkbox, Save, Cancel or Edit
  // affordance. Editing is ⋮ → Edit, which renders renderInlineEditor().
  // ---------------------------------------------------------------------------

  function ReadRow({ label, value }: { label: string; value: string }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{value}</div>
      </div>
    );
  }

  function renderReadOnlyProfile(center: Center) {
    return (
      <div style={{ borderTop: '1px solid #eee', padding: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CENTER_PROFILE_SECTIONS.map((section) => (
            <div key={section.titleKey}>
              <p style={subsectionLabelStyle}>{t(section.titleKey as any)}</p>
              <div style={fieldGridStyle}>
                {section.fields.map((field) => (
                  <ReadRow
                    key={field.key}
                    label={t(field.labelKey as any)}
                    value={formatCenterField(center, field, (key) => tStatus(key as any), t('theme_inherited_suffix'))}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Inline Edit form (#800) — what the Edit Center modal used to render.
  // ---------------------------------------------------------------------------

  function renderInlineEditor(center: Center) {
    if (!form) return null;
    return (
      <div style={{ borderTop: '1px solid #eee', padding: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {CENTER_PROFILE_SECTIONS.map((section) => {
            const fields = section.fields.filter((f) => f.editable);
            if (fields.length === 0) return null;
            return (
              <div key={section.titleKey}>
                <p style={subsectionLabelStyle}>{t(section.titleKey as any)}</p>
                <div style={fieldGridStyle}>
                  {fields.map((field) => (
                    <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                      <label htmlFor={`center-${center.id}-${field.key}`} style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>
                        {t(field.labelKey as any)}
                      </label>
                      {renderFieldControl(center, field.key)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        {formError && <p style={{ color: '#c0392b', fontSize: 13, marginTop: 16 }}>{formError}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button
            onClick={handleSaveEdit}
            disabled={!canWrite || saving}
            title={readOnlyTitle}
            style={readOnlyStyle(btnStyle(), !canWrite)}
          >
            {saving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  function renderFieldControl(center: Center, key: string) {
    if (!form) return null;
    const id = `center-${center.id}-${key}`;
    switch (key) {
      case 'name':
        return (
          <input
            id={id}
            style={inputStyle}
            value={form.name}
            autoFocus
            onChange={(e) => patchForm({ name: e.target.value })}
          />
        );
      case 'email':
        return (
          <input
            id={id}
            type="email"
            style={inputStyle}
            value={form.email}
            onChange={(e) => patchForm({ email: e.target.value })}
          />
        );
      case 'phone':
        return (
          <input
            id={id}
            style={inputStyle}
            value={form.phone}
            onChange={(e) => patchForm({ phone: e.target.value })}
          />
        );
      case 'address':
        return (
          <input
            id={id}
            style={inputStyle}
            value={form.address}
            onChange={(e) => patchForm({ address: e.target.value })}
          />
        );
      case 'status':
        return (
          <select
            id={id}
            style={selectStyle}
            value={form.status}
            onChange={(e) => patchForm({ status: e.target.value as CenterStatus })}
          >
            {CENTER_STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
          </select>
        );
      case 'theme_id':
        return (
          <select
            id={id}
            style={selectStyle}
            value={form.theme_id}
            onChange={(e) => patchForm({ theme_id: e.target.value })}
          >
            <option value="">
              {center.gym_theme_name ? `${center.gym_theme_name} ${t('theme_inherited_suffix')}` : t('theme_none')}
            </option>
            {themes.map((th) => <option key={th.id} value={th.id}>{th.name}</option>)}
          </select>
        );
      default:
        return null;
    }
  }

  function renderRow(center: Center) {
    const isExpanded = expandedId === center.id;
    const isEditing = editingId === center.id;

    // #800: Edit lives here and nowhere else — the expanded card adds no Edit
    // affordance of any kind, and the item stays gated like every write action.
    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailsCenter(center) },
      { label: t('edit'), onClick: () => startEdit(center), disabled: !canWrite, title: readOnlyTitle },
      {
        label: t('view_members'),
        onClick: () => router.push(`/${locale}/members?centerId=${center.id}`),
      },
      { label: t('delete'), onClick: () => setDeleting(center), danger: true, disabled: !canWrite, title: readOnlyTitle },
    ];

    return (
      <div key={center.id} style={{ ...cardSurfaceStyle, marginBottom: 8, overflow: 'hidden' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: isEditing ? 'default' : 'pointer' }}
          onClick={() => { if (!isEditing) openExpand(center); }}
        >
          <span style={{ fontSize: 13, color: '#aaa', marginRight: 2, transform: isExpanded || isEditing ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block', flexShrink: 0 }}>▶</span>

          {/* Name */}
          <div style={{ flex: 2, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{center.name}</span>
          </div>

          {/* Description */}
          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#aaa' }}>{EMPTY_VALUE}</div>

          {/* Created By */}
          <div style={{ flex: 2, minWidth: 0, fontSize: 13, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {center.created_by_name ?? EMPTY_VALUE}
          </div>

          {/* Created At */}
          <div style={{ minWidth: 110, fontSize: 13, color: '#666', flexShrink: 0 }}>
            {formatDateShort(locale, center.created_at)}
          </div>

          {/* Status badge */}
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={center.status} label={tStatus(center.status)} />
          </div>

          {/* Actions */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${center.name}`} />
          </div>
        </div>

        {isEditing ? renderInlineEditor(center) : isExpanded ? renderReadOnlyProfile(center) : null}
      </div>
    );
  }

  if (gymLoading || !canRead) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={CENTER_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={handleAdd} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#6c63ff'), !canWrite)}>{t('add')}</button>
        </div>
      </div>

      {/* Column header */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 16px 6px 44px', fontSize: 11, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        <div style={{ flex: 2 }}>{t('col_name')}</div>
        <div style={{ flex: 2 }}>{t('col_description')}</div>
        <div style={{ flex: 2 }}>{t('col_created_by')}</div>
        <div style={{ minWidth: 110 }}>{t('col_created_at')}</div>
        <div style={{ minWidth: 90 }}>{t('col_status')}</div>
        <div style={{ minWidth: 36 }} />
      </div>

      {loading ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('loading')}</p>
      ) : centers.length === 0 ? (
        <p style={{ color: '#aaa', padding: 16 }}>{t('empty')}</p>
      ) : (
        centers.map(renderRow)
      )}

      {/* Details modal */}
      {detailsCenter && (
        <CrudModal
          open
          title={t('details_title')}
          cancelLabel={t('cancel')}
          saveLabel=""
          hideSave
          extraFooter={<ViewAuditLogButton entityType="center" entityId={detailsCenter.id} onNavigate={() => setDetailsCenter(null)} />}
          onCancel={() => setDetailsCenter(null)}
          onSave={() => setDetailsCenter(null)}
        >
          <DetailRow label={t('col_name')} value={detailsCenter.name} />
          <DetailRow label={t('label_email')} value={detailsCenter.email} />
          <DetailRow label={t('label_phone')} value={detailsCenter.phone} />
          <DetailRow label={t('label_address')} value={detailsCenter.address} />
          <DetailRow label={t('label_theme')} value={themeLabel(detailsCenter)} />
          <DetailRow label={t('col_status')} value={tStatus(detailsCenter.status)} />
          <div style={{ marginTop: 16, borderTop: '1px solid #eee', paddingTop: 16 }} />
          <DetailRow label={t('created_at')} value={formatDate(locale, detailsCenter.created_at)} />
          <DetailRow label={t('created_by')} value={detailsCenter.created_by_name} />
          <DetailRow label={t('modified_at')} value={formatDate(locale, detailsCenter.modified_at)} />
          <DetailRow label={t('modified_by')} value={detailsCenter.modified_by_name} />
          {detailsCenter.deleted_at && (
            <>
              <DetailRow label={t('deleted_at')} value={formatDate(locale, detailsCenter.deleted_at)} />
              <DetailRow label={t('deleted_by')} value={detailsCenter.deleted_by_name} />
            </>
          )}
        </CrudModal>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 6, fontSize: 14 }}>
      <span style={{ minWidth: 120, color: '#888', fontWeight: 500, flexShrink: 0 }}>{label}</span>
      <span style={{ color: '#333' }}>{value ?? EMPTY_VALUE}</span>
    </div>
  );
}
