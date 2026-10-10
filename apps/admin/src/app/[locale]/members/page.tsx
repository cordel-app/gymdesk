'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { canWriteFeature, canWriteModule } from '@/config/permissions';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { FilterBar, FilterField, filterControlStyle } from '@/components/FilterBar';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, LIST_PADDING_X, type ListGridColumn, listCellClasses,
  listCellStyle, listExpandedStyle, listHeaderCellStyle, listHeaderRowStyle,
  listNameBadgeAccentStyle, listRowDividerStyle, listScrollerClass, listSurfaceStyle,
} from '@/components/listChrome';
import { btnStyle, primaryBtnStyle } from '@/components/ui';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { MemberExpandedRow } from './MemberExpandedRow';
import { MemberDetailModal } from './MemberDetailModal';
import { MemberEditForm } from './MemberEditForm';
import { MemberImageField } from '@/components/MemberImageField';
import { MemberAvatar } from '@/components/MemberAvatar';
import {
  emptyMemberEditForm,
  toMemberEditFormValues,
  type MemberEditFormValues,
  type MemberProfile,
} from './memberProfile';
import {
  MEMBER_TABS,
  memberTabFromParam,
  type MemberTabId,
} from './memberTabs';
import { Tabs } from '@/components/Tabs';
import { validateDocumentId } from '@/lib/documentId';
import { modalActionsRowStyle } from '@/components/formChrome';

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
  access_rights?: 'granted' | 'to_be_reviewed' | 'revoked';
  access_rights_stored?: 'granted' | 'revoked';
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

interface ListColumn extends ListGridColumn {
  /** Column title, a key in the `members` namespace. */
  labelKey: string;
  /** Fixed track width in px — also the minimum for the flexible column. */
  width: number;
  /** Set on the one flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

// #1011 stage 2: `mobile` says what each column is on a phone, in the one
// vocabulary `listChrome` declares — the Member's name is the row's identity,
// their standing with the gym is the status that rides beside it, and the rest
// are read in the expanded card (`⋮ → Details` carries the email, the Profile
// tab the document). Payment status is the state of a payment request rather
// than of the Member, so it is the one of the two badges that gives way: two
// of them plus the name leave a phone row with nothing legible in it.
const LIST_COLUMNS: ListColumn[] = [
  // #1376: the profile photo, first; it has no title and stays beside the name on a phone.
  { key: 'avatar', labelKey: 'col_name'/* header is blank */, width: 44, mobile: 'keep' },
  { key: 'name', labelKey: 'col_name', width: 180, grow: 2, mobile: 'name' },
  { key: 'email', labelKey: 'col_email', width: 200, mobile: 'secondary' },
  { key: 'document', labelKey: 'col_document', width: 150, mobile: 'secondary' },
  { key: 'payment_status', labelKey: 'col_payment_status', width: 110, mobile: 'secondary' },
  { key: 'enrollment_status', labelKey: 'col_enrollment_status', width: 110, mobile: 'keep' },
  // Wide enough for the longest translated title ("ACCIONES") next to the
  // chevron and the ⋮ menu the cell also holds.
  { key: 'actions', labelKey: 'col_actions', width: 84, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

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
  const { apiFetch, uploadFetch } = useApiClient();
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
  // #1374 §2: the image picked in the Add modal is held here until the Member
  // exists — the object key needs the id — and uploaded right after the POST.
  const [addImage, setAddImage] = useState<Blob | null>(null);
  // A file whose post-create upload failed: the Member was created, so the
  // modal closes, and the row opens in Edit mode showing the error and a Retry
  // rather than silently dropping either (§2 "do not silently discard").
  const [imageRetry, setImageRetry] = useState<{ file: Blob; error: string } | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<Member | null>(null);
  // #961 — the Member card is five parallel tabs. The selected one is the
  // page's state rather than the row's, so it survives a save, an edit and a
  // re-render of the list, and several expanded Members each keep their own.
  const urlMemberId = Number(searchParams.get('member'));
  const [expandedMemberIds, setExpandedMemberIds] = useState<Set<number>>(
    () => new Set(Number.isInteger(urlMemberId) && urlMemberId > 0 ? [urlMemberId] : []),
  );
  const [memberTabs, setMemberTabs] = useState<Record<number, MemberTabId>>(
    () => (Number.isInteger(urlMemberId) && urlMemberId > 0
      ? { [urlMemberId]: memberTabFromParam(searchParams.get('tab')) }
      : {}),
  );

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
  // #1326: bumped by invite / re-invite / revoke so an open row re-reads its Clerk status.
  const [accountVersion, setAccountVersion] = useState(0);

  useEffect(() => {
    if (editingId === null) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [editingId]);

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'MEMBERS'));
  const canManageTraining = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'TRAINING'));
  const canManagePackages = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'PAYMENTS'));
  // #948 §4: the PERSONAL GOALS section writes through `/member-personal-goals`,
  // which is mounted on NUTRITION — the same module the catalogue is. #1070: and
  // behind `nutrition.personal_goals`, whose own override decides this, so the
  // section offers exactly what that route accepts.
  const canManagePersonalGoals = isSuperadmin
    || (activeGym?.role != null && canWriteFeature(activeGym.role, 'NUTRITION', 'nutrition.personal_goals'));
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

  function syncUrl(updates: {
    centerId?: string; q?: string; nif_nie_passport?: string; payment_status?: string; enrollment_status?: string;
    /** #961: the expanded Member and the work area open on it, so a refresh, a
        back/forward and a pasted link all land on the same tab. */
    member?: string; tab?: string;
  }) {
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
    setAddImage(null);
    setError(null);
    setAssignedCenterIds(centers.length === 1 ? new Set([centers[0].id]) : new Set());
    setDefaultCenterId(centers.length === 1 ? centers[0].id : null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setForm(emptyForm);
    setAddImage(null);
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
      const created = await apiFetch<{ id: number }>('/members', { method: 'POST', body: JSON.stringify(body) });
      const stagedImage = addImage;
      closeModal();
      // #1374 §2: the Member exists now, so the staged image can be uploaded.
      // A failure here is not a failed creation: the row is kept, the list
      // reloads, and the new Member opens in Edit mode with the error and the
      // file still at hand for a Retry.
      let uploadFailure: { file: Blob; error: string } | null = null;
      if (stagedImage) {
        try {
          await uploadFetch(`/members/${created.id}/image`, stagedImage);
        } catch (err: any) {
          uploadFailure = { file: stagedImage, error: err.message ?? t('members.image_error_upload_failed') };
        }
      }
      await load();
      if (uploadFailure) {
        toast(t('members.image_created_upload_failed'));
        try {
          const row = await apiFetch<Member>(`/members/${created.id}`);
          setImageRetry(uploadFailure);
          await startEdit(row);
        } catch {
          // The row is in the list; the error is already on the toast.
        }
      }
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
    // #961: the inline form is the Profile's, so `⋮ → Edit` opens that tab —
    // it must never open behind a tab the Member happens to be left on.
    selectTab(m.id, 'profile');
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
    setImageRetry(null);
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
      setImageRetry(null);
      setProfileVersion((v) => v + 1);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('members.error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  /**
   * #1374: the image control answers with the Member as `GET /:id` shapes it,
   * so the list row — which is what the read-only Profile and the Edit form
   * both read (#800) — is replaced in place rather than re-fetched.
   */
  function replaceMember(updated: unknown) {
    const row = updated as Member;
    if (!row || typeof row.id !== 'number') return;
    setMembers((prev) => prev.map((x) => (x.id === row.id ? { ...x, ...row } : x)));
  }

  // #709: ConfirmDialog, not window.confirm() — like the rest of the admin
  // (confirm() is also auto-cancelled by embedded browsers).
  const [confirming, setConfirming] = useState<{ kind: 'delete' | 'revoke' | 'access_revoke'; id: number } | null>(null);
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
      } else if (kind === 'access_revoke') {
        await apiFetch(`/members/${id}/access/revoke`, { method: 'POST' });
        toast(t('members.toast_access_revoked'), 'success');
      } else {
        await apiFetch(`/members/${id}/revoke-invite`, { method: 'POST' });
        toast(t('members.toast_revoked'), 'success');
        setAccountVersion((v) => v + 1);
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
      setAccountVersion((v) => v + 1);
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  async function handleReinvite(id: number) {
    try {
      await apiFetch(`/members/${id}/reinvite`, { method: 'POST' });
      toast(t('members.toast_reinvited'), 'success');
      setAccountVersion((v) => v + 1);
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  // #1238: informational only — persists the state, gates nothing.
  async function handleGrantAccess(id: number) {
    try {
      await apiFetch(`/members/${id}/access/grant`, { method: 'POST' });
      toast(t('members.toast_access_granted'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('members.error_generic'), 'error');
    }
  }

  function handleRevokeInvite(id: number) {
    setConfirming({ kind: 'revoke', id });
  }

  function toggleExpand(m: Member) {
    const collapsing = expandedMemberIds.has(m.id);
    setExpandedMemberIds((prev) => {
      const next = new Set(prev);
      if (collapsing) next.delete(m.id); else next.add(m.id);
      return next;
    });
    // #961: the URL names the Member whose card is open and the tab it is open
    // on, so a refresh or a pasted link lands back on the same work area. It is
    // written outside the updater, which React may run twice.
    if (collapsing) syncUrl({ member: '', tab: '' });
    else syncUrl({ member: String(m.id), tab: tabFor(m.id) });
  }

  /** The work area open on a Member — Profile until they pick another (#961). */
  function tabFor(memberId: number): MemberTabId {
    return memberTabs[memberId] ?? memberTabFromParam(null);
  }

  function selectTab(memberId: number, tab: MemberTabId) {
    setMemberTabs((prev) => ({ ...prev, [memberId]: tab }));
    syncUrl({ member: String(memberId), tab });
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
    if (canWrite) {
      if (m.access_rights_stored === 'revoked') {
        items.push({ label: t('members.action_grant_access'), onClick: () => guardUnsaved(() => handleGrantAccess(m.id)) });
      } else {
        items.push({ label: t('members.action_revoke_access'), onClick: () => guardUnsaved(() => setConfirming({ kind: 'access_revoke', id: m.id })), danger: true });
      }
    }
    items.push({ label: t('members.delete'), onClick: () => guardUnsaved(() => handleDelete(m.id)), danger: true });

    return items;
  }

  /**
   * One member: the collapsed row, then — while expanded — the recessed body
   * the Edit form and the member's sections sit in.
   *
   * #928: the row is one cell per LIST_COLUMNS entry, in the same order, so a
   * title always sits over its own values. The whole row is the expand control
   * (as on Products and Training Plans), with the ⋮ menu stopping the
   * click so acting on a member never also expands it.
   */
  function renderRow(m: Member) {
    const isExpanded = expandedMemberIds.has(m.id);
    const activeTab = tabFor(m.id);
    const toggle = () => guardUnsaved(() => toggleExpand(m));

    return (
      <div key={m.id} style={listRowDividerStyle}>
        <div
          className={LIST_GRID_ROW_CLASS}
          style={headerRowStyle}
          onClick={toggle}
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
          }}
        >
          <div className={CELL_CLASS.avatar} style={badgeCellStyle}>
            <MemberAvatar name={m.name} imageUrl={m.image_url} stamp={m.modified_at} />
          </div>
          <div className={CELL_CLASS.name} style={nameCellStyle} title={m.name}>
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
          <div className={CELL_CLASS.email} style={cellStyle} title={m.email}>{m.email}</div>
          <div className={CELL_CLASS.document} style={mutedCellStyle}>{m.nif_nie_passport || '—'}</div>
          <div className={CELL_CLASS.payment_status} style={badgeCellStyle}>
            {m.payment_status
              ? <StatusBadge status={m.payment_status} label={t(`members.payment_status_${m.payment_status}`) || m.payment_status} />
              : <span style={noStatusStyle}>{t('members.payment_status_none')}</span>}
          </div>
          <div className={CELL_CLASS.enrollment_status} style={badgeCellStyle}>
            {m.enrollment_status
              ? <StatusBadge status={m.enrollment_status} label={t(`members.enrollment_status_${m.enrollment_status}`) || m.enrollment_status} />
              : <span style={noStatusStyle}>{t('members.enrollment_status_none')}</span>}
          </div>
          <div className={CELL_CLASS.actions} style={actionsCellStyle} onClick={(e) => e.stopPropagation()}>
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
            {/* #961 — the Member's five work areas. The strip is the app's one
                tab component (`components/Tabs.tsx`, promoted out of the
                Nutrition Library's own in this ticket), the tabs themselves are
                MEMBER_TABS, and only the selected one's sections render below:
                the card is a workspace rather than one very long column. */}
            <div style={tabStripWrapStyle}>
              <Tabs
                tabs={MEMBER_TABS}
                active={activeTab}
                onChange={(tab) => selectTab(m.id, tab)}
                label={(key) => t(`members.${key}`)}
                ariaLabel={`${t('members.title')} — ${m.name}`}
              />
            </div>
            {/* The inline Edit form is the Profile's: it writes
                MEMBER_PROFILE_FIELDS and nothing another tab shows, so its
                Save/Cancel pair stays with the fields it commits (#929). A tab
                change never discards it — the draft is the page's state, and
                `⋮ → Edit` brings this tab back. */}
            {activeTab === 'profile' && editingId === m.id && (
              <MemberEditForm
                form={editForm}
                isNewMember={m.is_new_member}
                error={editError}
                saving={editSaving}
                image={{
                  memberId: m.id,
                  imageUrl: m.image_url ?? null,
                  stamp: m.modified_at,
                  onChanged: replaceMember,
                  retry: imageRetry,
                  onRetryConsumed: () => setImageRetry(null),
                }}
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
              tab={activeTab}
              profileVersion={profileVersion}
              accountVersion={accountVersion}
              editing={editingId === m.id}
              canManageTraining={canManageTraining}
              canManagePackages={canManagePackages}
              canManagePersonalGoals={canManagePersonalGoals}
              isAdmin={isAdmin}
              plans={plans}
              statuses={[
                { key: 'header_plan_status', status: m.enrollment_status, label: m.enrollment_status ? t(`members.enrollment_status_${m.enrollment_status}`) : t('members.enrollment_status_none') },
                { key: 'header_payment_status', status: m.payment_status, label: m.payment_status ? t(`members.payment_status_${m.payment_status}`) : t('members.payment_status_none') },
                { key: 'header_access_rights', status: m.access_rights ?? 'granted', label: t(`members.access_rights_${m.access_rights ?? 'granted'}`) },
              ]}
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
        <button onClick={() => guardUnsaved(openAdd)} style={primaryBtnStyle()}>{t('members.add')}</button>
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
          <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
            <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
              <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
                {LIST_COLUMNS.map((col) => (
                  <div key={col.key} className={CELL_CLASS[col.key]} style={cellStyle}>
                    {col.key === 'avatar' ? null : t(`members.${col.labelKey}`)}
                  </div>
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

            {/* #1374 §2: staged, not uploaded — the Member has no id yet. */}
            <label style={labelStyle}>{t('members.label_image')}</label>
            <MemberImageField
              target={{ kind: 'staged', file: addImage, onFile: setAddImage }}
              disabled={saving}
              label={(key) => t(`members.${key}`)}
            />

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

            <div style={{ ...modalActionsRowStyle, marginTop: 20 }}>
              <button onClick={closeModal} style={btnStyle('#aaa')} disabled={saving}>{t('members.cancel')}</button>
              <button onClick={handleAdd} style={primaryBtnStyle()} disabled={saving}>
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
        message={t(confirming?.kind === 'access_revoke' ? 'members.confirm_revoke_access' : confirming?.kind === 'revoke' ? 'members.confirm_revoke' : 'members.confirm_delete')}
        confirmLabel={t(confirming?.kind === 'access_revoke' ? 'members.action_revoke_access' : confirming?.kind === 'revoke' ? 'members.action_revoke' : 'members.delete')}
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
/**
 * #961: the tab strip sits at the top of the expanded body, inset to the same
 * margin the card's sections use. It declares no colour, no type and no border
 * of its own — those are `components/Tabs.tsx`'s, which takes them from the
 * Theme.
 */
const tabStripWrapStyle: React.CSSProperties = { padding: '16px 24px 0' };

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
