'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteModule } from '@/config/permissions';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import {
  LIST_PADDING_X, listCellStyle, listExpandedStyle, listHeaderCellStyle,
  listHeaderRowStyle, listNameBadgeAccentStyle, listRowDividerStyle, listSurfaceStyle,
} from '@/components/listChrome';
import { btnStyle } from '@/components/ui';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MemberExpandedRow } from './MemberExpandedRow';
import { MemberDetailModal } from './MemberDetailModal';
import { MemberEditForm } from './MemberEditForm';
import {
  emptyMemberEditForm,
  toMemberEditFormValues,
  type MemberEditFormValues,
  type MemberProfile,
} from './memberProfile';
import { validateDocumentId } from '@/lib/documentId';

interface Plan {
  id: number;
  name: string;
  base_price: string;
}

// #797: the Profile half of the row is MemberProfile, the one definition the
// read-only PROFILE section and the Edit form both build on.
interface Member extends MemberProfile {
  id: number;
  email: string;
  fare_id: number | null;
  fare_name: string | null;
  clerk_user_id: string | null;
  invitation_id: string | null;
  account_status: 'active' | 'invited' | 'not_enrolled';
  enrollment_status: string | null;
  payment_status: string | null;
}

const emptyForm = {
  name: '',
  email: '',
  phone: '',
  fare_id: '',
  nif_nie_passport: '',
};

const PAYMENT_STATUSES = ['pending', 'completed', 'failed', 'expired'] as const;
const ENROLLMENT_STATUSES = ['active', 'paused', 'cancelled', 'expired'] as const;

// ─── List columns (#928, the #637/#724 column rule) ──────────────────────────
// The column titles and every collapsed row are laid out from this one
// definition, so a long name or a long email can never push a row's values out
// of line with its header. Every column is a fixed track except the name, which
// is the only one allowed to absorb the leftover width; when the viewport is
// narrower than the sum of the tracks the list scrolls horizontally instead of
// dropping or squeezing columns.
//
// Same columns, same order and same values as the `DataTable` this replaces —
// #928 is presentation only.

interface ListColumn {
  key: string;
  /** Column title, a key in the `members` namespace. */
  labelKey: string;
  /** Fixed track width in px — also the minimum for the flexible column. */
  width: number;
  /** Set on the one flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 180, grow: 2 },
  { key: 'email', labelKey: 'col_email', width: 200 },
  { key: 'document', labelKey: 'col_document', width: 150 },
  { key: 'payment_status', labelKey: 'col_payment_status', width: 110 },
  { key: 'enrollment_status', labelKey: 'col_enrollment_status', width: 110 },
  // Wide enough for the longest translated title ("ACCIONES") next to the
  // chevron and the ⋮ menu the cell also holds.
  { key: 'actions', labelKey: 'col_actions', width: 84 },
];

const LIST_COLUMN_GAP = 10;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + LIST_PADDING_X * 2;

export default function MembersPage() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { centers } = useCenter();
  const { toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [centerFilter, setCenterFilter] = useState<string>(searchParams.get('centerId') ?? '');
  const [searchQuery, setSearchQuery] = useState<string>(searchParams.get('q') ?? '');
  const [documentFilter, setDocumentFilter] = useState<string>(searchParams.get('nif_nie_passport') ?? '');
  const [paymentStatusFilter, setPaymentStatusFilter] = useState<string>(searchParams.get('payment_status') ?? '');
  const [enrollmentStatusFilter, setEnrollmentStatusFilter] = useState<string>(searchParams.get('enrollment_status') ?? '');
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<Member | null>(null);
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<number>>(new Set());

  const showCenters = centers.length > 1;
  const [assignedCenterIds, setAssignedCenterIds] = useState<Set<number>>(new Set());
  const [defaultCenterId, setDefaultCenterId] = useState<number | null>(null);

  // Inline editing (Member is edited on the expanded row, not in a modal — #365)
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<MemberEditFormValues>(emptyMemberEditForm);
  const [editError, setEditError] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [editAssignedCenterIds, setEditAssignedCenterIds] = useState<Set<number>>(new Set());
  const [editDefaultCenterId, setEditDefaultCenterId] = useState<number | null>(null);
  // #797: a saved edit may have changed the Member's centers, and the read-only
  // PROFILE section below reads those from the API rather than from this row.
  // Bumping this is how that section re-reads them without remounting (and
  // re-fetching) every other section of the expanded row. It is page-wide, so
  // any other row left expanded repeats its own one-row centers read too —
  // cheaper than threading the edited id through every render.
  const [profileVersion, setProfileVersion] = useState(0);

  useEffect(() => {
    if (editingId === null) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  const canManageTraining = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));
  const canManagePackages = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'PAYMENTS'));
  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const buildParams = useCallback(() => {
    const p = new URLSearchParams();
    if (centerFilter) p.set('centerId', centerFilter);
    if (searchQuery.trim()) p.set('q', searchQuery.trim());
    if (documentFilter.trim()) p.set('nif_nie_passport', documentFilter.trim());
    if (paymentStatusFilter) p.set('payment_status', paymentStatusFilter);
    if (enrollmentStatusFilter) p.set('enrollment_status', enrollmentStatusFilter);
    return p;
  }, [centerFilter, searchQuery, documentFilter, paymentStatusFilter, enrollmentStatusFilter]);

  async function load() {
    if (!activeGymId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = buildParams();
      const [membersData, plansData] = await Promise.all([
        apiFetch<Member[]>(`/members${params.toString() ? `?${params}` : ''}`),
        // #634 §2: only Active + Public Membership Plans are assignable, so
        // only those are offered — by the new-member form's fare picker and by
        // the Assign New Plan editor in the expanded row alike. (The previous
        // `status=active` had no effect: the endpoint's filter is
        // `lifecycle_status`, so every plan came back.)
        apiFetch<Plan[]>('/membership-plans?lifecycle_status=active&enrollment_status=public').catch(() => []),
      ]);
      setMembers(membersData);
      setPlans(plansData);
    } catch (err: any) {
      setMembers([]);
      toast(err.message ?? t('members.error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!gymLoading) load();
  }, [activeGymId, gymLoading, centerFilter, searchQuery, documentFilter, paymentStatusFilter, enrollmentStatusFilter]);

  function syncUrl(updates: { centerId?: string; q?: string; nif_nie_passport?: string; payment_status?: string; enrollment_status?: string }) {
    const p = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) p.set(k, v); else p.delete(k);
    }
    const qs = p.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function handleCenterFilter(v: string) {
    setCenterFilter(v);
    syncUrl({ centerId: v });
  }

  function handleSearch(v: string) {
    setSearchQuery(v);
    syncUrl({ q: v });
  }

  function handleDocumentFilter(v: string) {
    setDocumentFilter(v);
    syncUrl({ nif_nie_passport: v });
  }

  function handlePaymentFilter(v: string) {
    setPaymentStatusFilter(v);
    syncUrl({ payment_status: v });
  }

  function handleEnrollmentFilter(v: string) {
    setEnrollmentStatusFilter(v);
    syncUrl({ enrollment_status: v });
  }

  function openAdd() {
    setForm(emptyForm);
    setError(null);
    setAssignedCenterIds(centers.length === 1 ? new Set([centers[0].id]) : new Set());
    setDefaultCenterId(centers.length === 1 ? centers[0].id : null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setForm(emptyForm);
    setError(null);
    setAssignedCenterIds(new Set());
    setDefaultCenterId(null);
  }

  function toggleCenter(id: number, checked: boolean) {
    const next = new Set(assignedCenterIds);
    if (checked) next.add(id); else next.delete(id);
    setAssignedCenterIds(next);
    if (!checked && defaultCenterId === id) setDefaultCenterId(null);
    if (checked && next.size === 1) setDefaultCenterId(id);
  }

  async function handleAdd() {
    if (!form.name.trim() || !form.email.trim()) {
      setError(t('members.error_required'));
      return;
    }
    if (showCenters) {
      if (assignedCenterIds.size === 0) { setError(t('members.error_no_center')); return; }
      if (defaultCenterId == null || !assignedCenterIds.has(defaultCenterId)) { setError(t('members.error_default_not_assigned')); return; }
    }
    if (!validateDocumentId(form.nif_nie_passport).valid) {
      setError(t('members.error_document_invalid'));
      return;
    }
    setSaving(true);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || null,
        fare_id: form.fare_id ? parseInt(form.fare_id) : null,
        nif_nie_passport: form.nif_nie_passport.trim() || null,
      };
      if (showCenters) {
        body.center_ids = Array.from(assignedCenterIds);
        body.default_center_id = defaultCenterId;
      }
      await apiFetch('/members', { method: 'POST', body: JSON.stringify(body) });
      closeModal();
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'));
    } finally {
      setSaving(false);
    }
  }

  function guardUnsaved(action: () => void) {
    if (editingId !== null) setPendingAction(() => action);
    else action();
  }

  async function startEdit(m: Member) {
    setEditingId(m.id);
    setEditForm(toMemberEditFormValues(m));
    setEditError(null);
    setExpandedMemberIds((prev) => {
      const next = new Set(prev);
      next.add(m.id);
      return next;
    });
    if (showCenters) {
      try {
        const rows = await apiFetch<{ center_id: number; is_default: boolean }[]>(`/members/${m.id}/centers`);
        setEditAssignedCenterIds(new Set(rows.map((r) => r.center_id)));
        setEditDefaultCenterId(rows.find((r) => r.is_default)?.center_id ?? null);
      } catch {
        setEditAssignedCenterIds(new Set());
        setEditDefaultCenterId(null);
      }
    }
  }

  function cancelEdit() {
    setEditingId(null);
    setEditForm(emptyMemberEditForm);
    setEditError(null);
    setEditAssignedCenterIds(new Set());
    setEditDefaultCenterId(null);
  }

  function toggleEditCenter(id: number, checked: boolean) {
    const next = new Set(editAssignedCenterIds);
    if (checked) next.add(id); else next.delete(id);
    setEditAssignedCenterIds(next);
    if (!checked && editDefaultCenterId === id) setEditDefaultCenterId(null);
    if (checked && next.size === 1) setEditDefaultCenterId(id);
  }

  async function saveEdit() {
    if (!editForm.name.trim()) { setEditError(t('members.error_required')); return; }
    if (showCenters) {
      if (editAssignedCenterIds.size === 0) { setEditError(t('members.error_no_center')); return; }
      if (editDefaultCenterId == null || !editAssignedCenterIds.has(editDefaultCenterId)) { setEditError(t('members.error_default_not_assigned')); return; }
    }
    if (!validateDocumentId(editForm.nif_nie_passport).valid) {
      setEditError(t('members.error_document_invalid'));
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const editedId = editingId!;
      const body: Record<string, unknown> = {
        name: editForm.name.trim(),
        phone: editForm.phone.trim() || null,
        date_of_birth: editForm.date_of_birth || null,
        gender: editForm.gender || null,
        address: editForm.address.trim() || null,
        emergency_contact: editForm.emergency_contact.trim() || null,
        notes: editForm.notes.trim() || null,
        nif_nie_passport: editForm.nif_nie_passport.trim() || null,
      };
      await apiFetch(`/members/${editedId}`, { method: 'PUT', body: JSON.stringify(body) });
      if (showCenters) {
        await apiFetch(`/members/${editedId}/centers`, {
          method: 'PUT',
          body: JSON.stringify({ center_ids: Array.from(editAssignedCenterIds), default_center_id: editDefaultCenterId }),
        });
      }
      setEditingId(null);
      setProfileVersion((v) => v + 1);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('members.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // #709: ConfirmDialog, not window.confirm() — like the rest of the admin
  // (confirm() is also auto-cancelled by embedded browsers).
  const [confirming, setConfirming] = useState<{ kind: 'delete' | 'revoke'; id: number } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  function handleDelete(id: number) {
    setConfirming({ kind: 'delete', id });
  }

  async function runConfirmed() {
    if (!confirming) return;
    const { kind, id } = confirming;
    setConfirmBusy(true);
    try {
      if (kind === 'delete') {
        await apiFetch(`/members/${id}`, { method: 'DELETE' });
      } else {
        await apiFetch(`/members/${id}/revoke-invite`, { method: 'POST' });
        toast(t('members.toast_revoked'), 'success');
      }
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    } finally {
      setConfirmBusy(false);
      setConfirming(null);
    }
  }

  async function handleInvite(id: number) {
    try {
      await apiFetch(`/members/${id}/invite`, { method: 'POST' });
      toast(t('members.toast_invited'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  async function handleReinvite(id: number) {
    try {
      await apiFetch(`/members/${id}/reinvite`, { method: 'POST' });
      toast(t('members.toast_reinvited'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  function handleRevokeInvite(id: number) {
    setConfirming({ kind: 'revoke', id });
  }

  function toggleExpand(m: Member) {
    setExpandedMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(m.id)) next.delete(m.id); else next.add(m.id);
      return next;
    });
  }

  function buildActions(m: Member): ContextMenuItem[] {
    const linked = !!m.clerk_user_id;
    const pendingInvite = !linked && !!m.invitation_id;
    const items: ContextMenuItem[] = [];

    if (!linked && !pendingInvite) {
      items.push({ label: t('members.action_invite'), onClick: () => guardUnsaved(() => handleInvite(m.id)) });
    }
    if (pendingInvite) {
      items.push({ label: t('members.action_reinvite'), onClick: () => guardUnsaved(() => handleReinvite(m.id)) });
      items.push({ label: t('members.action_revoke'), onClick: () => guardUnsaved(() => handleRevokeInvite(m.id)) });
    }
    items.push({ label: t('members.edit'), onClick: () => guardUnsaved(() => startEdit(m)) });
    items.push({ label: t('members.action_details'), onClick: () => guardUnsaved(() => setDetailFor(m)) });
    items.push({ label: t('members.delete'), onClick: () => guardUnsaved(() => handleDelete(m.id)), danger: true });

    return items;
  }

  /**
   * One member: the collapsed row, then — while expanded — the recessed body
   * the Edit form and the member's sections sit in.
   *
   * #928: the row is one cell per LIST_COLUMNS entry, in the same order, so a
   * title always sits over its own values. The whole row is the expand control
   * (as on Sellable Items and Training Plans), with the ⋮ menu stopping the
   * click so acting on a member never also expands it.
   */
  function renderRow(m: Member) {
    const isExpanded = expandedMemberIds.has(m.id);
    const toggle = () => guardUnsaved(() => toggleExpand(m));

    return (
      <div key={m.id} style={listRowDividerStyle}>
        <div
          style={headerRowStyle}
          onClick={toggle}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
          }}
        >
          <div style={nameCellStyle}>
            {m.name}
            {/* #927 §2: the calculated New Member status, so a member can be
                identified without expanding them. Read-only, and read from the
                same `is_new_member` the PROFILE section below shows (§5) —
                never from a second calculation in the page. The accent pill
                (#913), because it is the row's attention-worthy metadata
                rather than a quiet statement of what kind of row it is. */}
            {m.is_new_member && (
              <span style={listNameBadgeAccentStyle}>{t('members.new_member_badge')}</span>
            )}
          </div>
          {/* The track is fixed now, so an over-long address ellipsises inside
              its own column; `title` keeps the whole of it reachable. */}
          <div style={cellStyle} title={m.email}>{m.email}</div>
          <div style={mutedCellStyle}>{m.nif_nie_passport || '—'}</div>
          <div style={badgeCellStyle}>
            {m.payment_status
              ? <StatusBadge status={m.payment_status} label={t(`members.payment_status_${m.payment_status}`) || m.payment_status} />
              : <span style={noStatusStyle}>{t('members.payment_status_none')}</span>}
          </div>
          <div style={badgeCellStyle}>
            {m.enrollment_status
              ? <StatusBadge status={m.enrollment_status} label={t(`members.enrollment_status_${m.enrollment_status}`) || m.enrollment_status} />
              : <span style={noStatusStyle}>{t('members.enrollment_status_none')}</span>}
          </div>
          <div style={actionsCellStyle} onClick={(e) => e.stopPropagation()}>
            {/* Decorative: the row itself carries the expanded state and the
                keyboard affordance, so a second control would only be a nested
                button inside it. */}
            <span aria-hidden="true" style={chevronStyle(isExpanded)}>▾</span>
            <ContextMenu
              items={buildActions(m)}
              ariaLabel={`${t('members.col_actions')} — ${m.name}`}
            />
          </div>
        </div>

        {isExpanded && (
          <div style={listExpandedStyle}>
            {editingId === m.id && (
              <MemberEditForm
                form={editForm}
                isNewMember={m.is_new_member}
                error={editError}
                saving={editSaving}
                showCenters={showCenters}
                centers={centers}
                assignedCenterIds={editAssignedCenterIds}
                defaultCenterId={editDefaultCenterId}
                onChange={setEditForm}
                onToggleCenter={toggleEditCenter}
                onDefaultCenterChange={setEditDefaultCenterId}
                onSave={saveEdit}
                onCancel={cancelEdit}
              />
            )}
            <MemberExpandedRow
              memberId={m.id}
              member={m}
              profileVersion={profileVersion}
              editing={editingId === m.id}
              canManageTraining={canManageTraining}
              canManagePackages={canManagePackages}
              isAdmin={isAdmin}
              plans={plans}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t('members.title')}</h1>
        <button onClick={() => guardUnsaved(openAdd)} style={btnStyle('#6c63ff')}>{t('members.add')}</button>
      </div>

      {/* Filters — the same labelled bar every other list wears (#724). The
          same five filters as before, same behaviour; each one now carries its
          label instead of relying on a placeholder. */}
      <FilterBar>
        <FilterField label={t('members.filter_search')} htmlFor="members-filter-search">
          <input
            id="members-filter-search"
            type="search"
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            placeholder={t('members.placeholder_search')}
            style={{ ...filterControlStyle, minWidth: 200 }}
          />
        </FilterField>
        <FilterField label={t('members.filter_document')} htmlFor="members-filter-document">
          <input
            id="members-filter-document"
            type="search"
            value={documentFilter}
            onChange={(e) => handleDocumentFilter(e.target.value)}
            placeholder={t('members.label_document')}
            style={{ ...filterControlStyle, minWidth: 160 }}
          />
        </FilterField>
        {showCenters && (
          <FilterField label={t('members.filter_center')} htmlFor="members-filter-center">
            <select
              id="members-filter-center"
              value={centerFilter}
              onChange={(e) => handleCenterFilter(e.target.value)}
              style={filterControlStyle}
            >
              <option value="">{t('members.all_centers')}</option>
              {centers.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </FilterField>
        )}
        <FilterField label={t('members.filter_payment_status')} htmlFor="members-filter-payment-status">
          <StatusFilter
            id="members-filter-payment-status"
            value={paymentStatusFilter}
            onChange={handlePaymentFilter}
            allLabel={t('members.all_payment_statuses')}
            options={PAYMENT_STATUSES.map((s) => ({ value: s, label: t(`members.payment_status_${s}`) }))}
            style={filterControlStyle}
          />
        </FilterField>
        <FilterField label={t('members.filter_enrollment_status')} htmlFor="members-filter-enrollment-status">
          <StatusFilter
            id="members-filter-enrollment-status"
            value={enrollmentStatusFilter}
            onChange={handleEnrollmentFilter}
            allLabel={t('members.all_enrollment_statuses')}
            options={ENROLLMENT_STATUSES.map((s) => ({ value: s, label: t(`members.enrollment_status_${s}`) }))}
            style={filterControlStyle}
          />
        </FilterField>
      </FilterBar>

      {loading ? (
        <p style={mutedTextStyle}>{t('members.loading')}</p>
      ) : members.length === 0 ? (
        <p style={mutedTextStyle}>{t('members.empty')}</p>
      ) : (
        /* The header band and the rows are one list surface (#724): they share
           LIST_GRID_COLUMNS and scroll together, so they cannot fall out of
           line, and a narrow viewport scrolls the list instead of the page. */
        <div style={listSurfaceStyle}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: LIST_MIN_WIDTH }}>
              <div style={colHeaderStyle}>
                {LIST_COLUMNS.map((col) => (
                  <div key={col.key} style={cellStyle}>{t(`members.${col.labelKey}`)}</div>
                ))}
              </div>

              {members.map(renderRow)}
            </div>
          </div>
        </div>
      )}

      {/* Add modal (editing a member happens inline on the expanded row — #365) */}
      {modalOpen && (
        <div style={overlayStyle} onClick={closeModal}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: '0 0 20px' }}>{t('members.modal_add')}</h2>

            <label style={labelStyle}>{t('members.label_name')}</label>
            <input style={inputStyle} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('members.placeholder_name')} autoFocus />

            <label style={labelStyle}>{t('members.label_email')}</label>
            <input style={inputStyle} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t('members.placeholder_email')} />

            <label style={labelStyle}>{t('members.label_phone')}</label>
            <input style={inputStyle} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={t('members.placeholder_phone')} />

            <label style={labelStyle}>{t('members.label_document')}</label>
            <input style={inputStyle} value={form.nif_nie_passport} onChange={(e) => setForm({ ...form, nif_nie_passport: e.target.value })} placeholder={t('members.placeholder_document')} />
            <p style={helpTextStyle}>{t('members.help_document')}</p>

            {plans.length > 0 && (
              <>
                <label style={labelStyle}>{t('members.label_fare')}</label>
                <select style={inputStyle} value={form.fare_id} onChange={(e) => setForm({ ...form, fare_id: e.target.value })}>
                  <option value="">{t('members.fare_none')}</option>
                  {plans.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} — {parseFloat(p.base_price).toFixed(2)}</option>
                  ))}
                </select>
              </>
            )}

            {showCenters && (
              <>
                <label style={labelStyle}>{t('members.assigned_centers')}</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6, padding: 10 }}>
                  {centers.map((c) => (
                    <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                      <input type="checkbox" checked={assignedCenterIds.has(c.id)}
                             onChange={(e) => toggleCenter(c.id, e.target.checked)} />
                      {c.name}
                    </label>
                  ))}
                </div>

                <label style={labelStyle}>{t('members.default_center')}</label>
                <select style={inputStyle} value={defaultCenterId ?? ''} onChange={(e) => setDefaultCenterId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{t('members.default_center_none')}</option>
                  {centers.filter((c) => assignedCenterIds.has(c.id)).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </>
            )}

            {error && <p style={{ color: '#c0392b', margin: '8px 0 0', fontSize: 14 }}>{error}</p>}

            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={btnStyle('#aaa')} disabled={saving}>{t('members.cancel')}</button>
              <button onClick={handleAdd} style={btnStyle('#6c63ff')} disabled={saving}>
                {saving ? t('members.saving') : t('members.modal_add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {detailFor && (
        <MemberDetailModal memberId={detailFor.id} memberName={detailFor.name} onClose={() => setDetailFor(null)} />
      )}

      <ConfirmDialog
        open={confirming !== null}
        message={t(confirming?.kind === 'revoke' ? 'members.confirm_revoke' : 'members.confirm_delete')}
        confirmLabel={t(confirming?.kind === 'revoke' ? 'members.action_revoke' : 'members.delete')}
        cancelLabel={t('members.cancel')}
        onConfirm={runConfirmed}
        onCancel={() => setConfirming(null)}
        busy={confirmBusy}
      />

      <ConfirmDialog
        open={pendingAction !== null}
        message={t('members.unsaved_changes')}
        confirmLabel={t('members.unsaved_discard')}
        cancelLabel={t('members.cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          cancelEdit();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

// ─── List styles (#928) ───────────────────────────────────────────────────────
// The surface, the header band, the cell insets and the dividers are the ones
// `DataTable` is built from (`listChrome`, #724), so this list cannot drift
// away from the tables that still use it. What belongs to this page is the
// grid its own columns describe, and nothing else.

/** The grid the column titles and every collapsed row share. */
const listGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center',
  gap: LIST_COLUMN_GAP,
};
const colHeaderStyle: React.CSSProperties = {
  ...listGridStyle, ...listHeaderRowStyle, ...listHeaderCellStyle,
};
const headerRowStyle: React.CSSProperties = {
  ...listGridStyle, ...listCellStyle, cursor: 'pointer', userSelect: 'none',
};
/** Keeps an over-long value inside its track instead of widening the row. */
const cellStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const nameCellStyle: React.CSSProperties = { ...cellStyle, fontWeight: 600, fontSize: 15 };
const mutedCellStyle: React.CSSProperties = { ...cellStyle, fontSize: 13, color: '#555' };
/** Badges size themselves, so this cell only needs to not stretch them. */
const badgeCellStyle: React.CSSProperties = { minWidth: 0, display: 'flex', alignItems: 'center' };
const actionsCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
};
/** A status column with nothing in it yet — the same grey it has always been. */
const noStatusStyle: React.CSSProperties = { color: '#bbb' };
const mutedTextStyle: React.CSSProperties = { color: 'var(--gd-text-muted, #6b7280)' };
function chevronStyle(expanded: boolean): React.CSSProperties {
  return {
    fontSize: 14, color: '#aaa',
    transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s',
  };
}
const overlayStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 };
const modalStyle: React.CSSProperties = { background: '#fff', borderRadius: 12, padding: 32, width: 460, maxWidth: '90vw', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' };
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 14, fontWeight: 500, marginBottom: 4, marginTop: 14, color: '#333' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box' };
const helpTextStyle: React.CSSProperties = { margin: '4px 0 0', fontSize: 12.5, color: '#888' };
