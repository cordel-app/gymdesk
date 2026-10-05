'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall, cardSurfaceStyle, readOnlyStyle } from '@/components/ui';
import { useModuleAccess } from '@/lib/useModuleAccess';
import { PROFILE_ROLE_MAP } from '@/config/permissions';
import {
  EMPTY_VALUE,
  STAFF_PROFILE_SECTIONS,
  StaffProfile,
  formatStaffField,
  toStaffEditFormValues,
} from './staffProfile';
import { inlineActionsRowStyle } from '@/components/formChrome';

/**
 * #798: the columns the Edit form manages are declared once, in
 * `staffProfile.ts`, and the read-only expanded view renders the same list —
 * the two cannot drift apart. What is left here is what the list row carries
 * beyond that field set.
 */
export interface StaffMember extends StaffProfile {
  id: number;
  gym_id: string;
  /** #592: the gym_memberships row (login) this record owns, if any. */
  gym_membership_id: number | null;
  profile_photo_url: string | null;
  direct_manager_id: number | null;
  direct_manager_name: string | null;
  contract_days_remaining: number | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

const PROFILES = [
  'Gym Manager',
  'Personal Trainer',
  'Personal Trainer & Nutritionist',
  'Front Desk',
  'Accountant',
  'Nutritionist',
] as const;

const EMPLOYMENT_STATUSES = ['active', 'inactive'] as const;

const CURRENT_STATUSES = [
  'available',
  'on_vacation',
  'sick_leave',
  'maternity_leave',
  'paternity_leave',
  'training',
  'suspended',
  'other',
] as const;

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

interface ClerkStatus {
  status: 'not_enrolled' | 'invited' | 'active' | 'suspended' | 'error';
  userId: string | null;
}

interface StaffCenterAssignment {
  center_id: number;
  name: string;
  is_default: boolean;
}

const emptyForm = (): Partial<StaffMember> => ({
  first_name: '',
  last_name: '',
  email: '',
  mobile_phone: null,
  date_of_birth: null,
  national_id: null,
  profile: PROFILES[0],
  employment_status: 'active',
  current_status: 'available',
  hire_date: new Date().toISOString().slice(0, 10),
  contract_end_date: null,
  termination_date: null,
  direct_manager_id: null,
  employee_number: null,
  company_email: null,
  company_phone: null,
  personal_phone: null,
  emergency_contact: null,
  emergency_phone: null,
  working_days: 'Mon,Tue,Wed,Thu,Fri',
  work_start_time: null,
  work_end_time: null,
  break_duration_minutes: null,
  notes: null,
});

function contractBadge(days: number | null): React.ReactNode {
  if (days === null) return null;
  if (days < 0) {
    return (
      <span style={{ background: '#fdeaea', color: '#c0392b', borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
        Expired
      </span>
    );
  }
  if (days <= 30) {
    return (
      <span style={{ background: '#fff4e0', color: '#b26a00', borderRadius: 999, padding: '2px 8px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
        Expires in {days} day{days !== 1 ? 's' : ''}
      </span>
    );
  }
  return null;
}

function avatar(member: StaffMember) {
  if (member.profile_photo_url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={member.profile_photo_url} alt={member.first_name} style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }} />;
  }
  const initials = `${member.first_name[0] ?? ''}${member.last_name[0] ?? ''}`.toUpperCase();
  return (
    <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#e0e7ff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: '#4c6ef5', flexShrink: 0 }}>
      {initials}
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <label style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: '1px solid #d0d0d8',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 14,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = { ...inputStyle, background: '#fff' };

const subsectionLabelStyle: React.CSSProperties = {
  margin: '0 0 12px 0',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: '#aaa',
};

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 3 — the row and the header band are laid out from one declaration
 * rather than restating widths at each other (#637's shape). The header had two
 * spacer cells (36px, 40px) standing in for the row's avatar, chevron and `⋮`,
 * which is three cells against two: every title after Name sat off its values.
 *
 * `mobile` says what each column is on a phone. The staff member's name is the
 * row's identity — it carries the employee number under it — and of its two
 * badges the **employment** status is the one that says whether this person
 * works here, so it rides beside the name while Current status (available, on
 * vacation) is read in the expanded profile, for the reason Members keeps one
 * of its two (stage 2). The avatar goes with them: 36px of a 390px row is the
 * difference between a readable name and a truncated one.
 */
interface ListColumn extends ListGridColumn {
  /** Header label, a key in the `staff` namespace. Absent = no title. */
  labelKey?: string;
  /** Selecting the title sorts by this key. Absent = not sortable. */
  sortKey?: string;
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'avatar', width: 36, mobile: 'secondary' },
  { key: 'name', labelKey: 'col_name', sortKey: 'name', width: 160, grow: 2, mobile: 'name' },
  { key: 'hire_date', labelKey: 'col_hire_date', sortKey: 'hire_date', width: 110, mobile: 'secondary' },
  { key: 'contract_end', labelKey: 'col_contract_end', sortKey: 'contract_end_date', width: 160, mobile: 'secondary' },
  { key: 'profile', labelKey: 'col_profile', sortKey: 'profile', width: 180, mobile: 'secondary' },
  { key: 'employment', labelKey: 'col_employment', sortKey: 'employment_status', width: 90, mobile: 'keep' },
  { key: 'current_status', labelKey: 'col_current_status', sortKey: 'current_status', width: 110, grow: 1, mobile: 'secondary' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 12;
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

const listRowStyle = (editing: boolean): React.CSSProperties => ({
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', padding: `12px ${ROW_PADDING_X}px`, gap: LIST_COLUMN_GAP,
  cursor: editing ? 'default' : 'pointer',
});

const colHeaderStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `6px ${ROW_PADDING_X}px`,
  fontSize: 12, color: '#888', fontWeight: 500,
};

export default function StaffPage() {
  const t = useTranslations('staff');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { centers } = useCenter();
  const { toast } = useToast();
  const showCenters = centers.length > 1;

  const [rows, setRows] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [empStatusFilter, setEmpStatusFilter] = useState('');
  const [currentStatusFilter, setCurrentStatusFilter] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  // #798: expanding a card and editing it are two separate interactions.
  // `expandedId` is the strictly read-only view; `editingId` is the form, which
  // is reachable only through ⋮ → Edit (or 'new'). Never both at once.
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | 'new' | null>(null);
  const [form, setForm] = useState<Partial<StaffMember>>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [assignedCenterIds, setAssignedCenterIds] = useState<Set<number>>(new Set());
  const [defaultCenterId, setDefaultCenterId] = useState<number | null>(null);
  /** #798: the expanded card's own centers, with their names, for the read-only view. */
  const [expandedCenters, setExpandedCenters] = useState<StaffCenterAssignment[] | null>(null);

  const [clerkStatus, setClerkStatus] = useState<ClerkStatus | null>(null);
  const [clerkLoading, setClerkLoading] = useState(false);

  const [detailsMember, setDetailsMember] = useState<StaffMember | null>(null);
  const [detailsCenters, setDetailsCenters] = useState<StaffCenterAssignment[]>([]);
  const [deleting, setDeleting] = useState<StaffMember | null>(null);
  const [deactivating, setDeactivating] = useState<StaffMember | null>(null);
  const [revokingAccess, setRevokingAccess] = useState<StaffMember | null>(null);
  const [accessBusy, setAccessBusy] = useState(false);

  const firstNameRef = useRef<HTMLInputElement>(null);
  // #613: read-only roles see every control, disabled — the API rejects their writes.
  const { canWrite, readOnlyTitle } = useModuleAccess('ORGANIZATION');

  // Debounce search
  useEffect(() => {
    const id = setTimeout(() => setSearchQuery(searchInput.trim()), 300);
    return () => clearTimeout(id);
  }, [searchInput]);

  // Redirect non-admins (read-only for others)
  useEffect(() => {
    if (!gymLoading && !activeGym) router.replace(`/${locale}`);
  }, [gymLoading, activeGym]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery) params.set('q', searchQuery);
      if (profileFilter) params.set('profile', profileFilter);
      if (empStatusFilter) params.set('employment_status', empStatusFilter);
      if (currentStatusFilter) params.set('current_status', currentStatusFilter);
      params.set('sort', sortKey);
      params.set('dir', sortDir);
      const data = await apiFetch<StaffMember[]>(`/staff?${params}`);
      setRows(data);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, searchQuery, profileFilter, empStatusFilter, currentStatusFilter, sortKey, sortDir]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!detailsMember) { setDetailsCenters([]); return; }
    apiFetch<StaffCenterAssignment[]>(`/staff/${detailsMember.id}/centers`)
      .then(setDetailsCenters)
      .catch(() => setDetailsCenters([]));
  }, [detailsMember]);

  function openNew() {
    setForm(emptyForm());
    setExpandedId(null);
    setEditingId('new');
    setFormError(null);
    setAssignedCenterIds(centers.length === 1 ? new Set([centers[0].id]) : new Set());
    setDefaultCenterId(centers.length === 1 ? centers[0].id : null);
    setTimeout(() => firstNameRef.current?.focus(), 50);
  }

  function loadClerkStatus(staffId: number) {
    setClerkStatus(null);
    setClerkLoading(true);
    apiFetch<ClerkStatus>(`/staff/${staffId}/clerk-status`)
      .then(setClerkStatus)
      .catch(() => setClerkStatus({ status: 'error', userId: null }))
      .finally(() => setClerkLoading(false));
  }

  /** #798: expanding a card only reads. It never seeds the form and never enables editing. */
  function openExpand(member: StaffMember) {
    if (expandedId === member.id) { setExpandedId(null); setClerkStatus(null); setExpandedCenters(null); return; }
    setEditingId(null);
    setFormError(null);
    setExpandedId(member.id);
    loadClerkStatus(member.id);
    setExpandedCenters(null);
    apiFetch<StaffCenterAssignment[]>(`/staff/${member.id}/centers`)
      .then(setExpandedCenters)
      .catch(() => setExpandedCenters([]));
  }

  /** #798: ⋮ → Edit is the only way into the form. */
  function startEdit(member: StaffMember) {
    setExpandedId(null);
    setExpandedCenters(null);
    setForm(toStaffEditFormValues(member));
    setEditingId(member.id);
    setFormError(null);
    loadClerkStatus(member.id);
    setAssignedCenterIds(new Set());
    setDefaultCenterId(null);
    apiFetch<StaffCenterAssignment[]>(`/staff/${member.id}/centers`)
      .then((assignments) => {
        setAssignedCenterIds(new Set(assignments.map((a) => a.center_id)));
        setDefaultCenterId(assignments.find((a) => a.is_default)?.center_id ?? null);
      })
      .catch(() => { setAssignedCenterIds(new Set()); setDefaultCenterId(null); });
    setTimeout(() => firstNameRef.current?.focus(), 50);
  }

  function cancelEdit() {
    setEditingId(null);
    setFormError(null);
    setClerkStatus(null);
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

  async function handleSave() {
    if (!form.first_name || !form.last_name || !form.email || !form.profile || !form.hire_date) {
      setFormError(t('error_required'));
      return;
    }
    if (showCenters && assignedCenterIds.size > 1 && (defaultCenterId == null || !assignedCenterIds.has(defaultCenterId))) {
      setFormError(t('error_default_not_assigned'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId === 'new') {
        const body: Record<string, unknown> = { ...form };
        if (showCenters) {
          body.center_ids = Array.from(assignedCenterIds);
          body.default_center_id = defaultCenterId;
        }
        const created = await apiFetch<StaffMember & { access?: { status: string; error?: string } }>(
          '/staff', { method: 'POST', body: JSON.stringify(body) },
        );
        // The HR record is saved even when the login could not be set up — say so,
        // the admin can retry from the App access section of the row.
        if (created.access?.status === 'error') {
          toast(t('created_access_error', { error: created.access.error ?? '' }));
        } else {
          toast(t('created'), 'success');
        }
      } else {
        const updated = await apiFetch<StaffMember & { access?: { status: string; error?: string } }>(
          `/staff/${editingId}`, { method: 'PUT', body: JSON.stringify(form) },
        );
        if (showCenters) {
          await apiFetch(`/staff/${editingId}/centers`, {
            method: 'PUT',
            body: JSON.stringify({ center_ids: Array.from(assignedCenterIds), default_center_id: defaultCenterId }),
          });
        }
        // Saving an active record with no login creates one (and may email an invitation).
        if (updated.access?.status === 'error') {
          toast(t('saved_access_error', { error: updated.access.error ?? '' }));
        } else if (updated.access?.status === 'invited') {
          toast(t('saved_invited', { email: form.email ?? '' }), 'success');
        } else {
          toast(t('saved'), 'success');
        }
      }
      setEditingId(null);
      load();
    } catch (err: any) {
      setFormError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(member: StaffMember) {
    try {
      await apiFetch(`/staff/${member.id}/deactivate`, { method: 'PATCH' });
      toast(t('deactivated'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
    setDeactivating(null);
  }

  async function handleGrantAccess(member: StaffMember) {
    setAccessBusy(true);
    try {
      const res = await apiFetch<{ status: string }>(`/staff/${member.id}/access`, { method: 'POST' });
      toast(t(res.status === 'granted' || res.status === 'already_granted' ? 'access_granted_toast' : 'access_invited_toast'), 'success');
      loadClerkStatus(member.id);
      load();
    } catch (err: any) {
      toast(err.message ?? t('access_error'));
    } finally {
      setAccessBusy(false);
    }
  }

  async function handleRevokeAccess(member: StaffMember) {
    setAccessBusy(true);
    try {
      await apiFetch(`/staff/${member.id}/access`, { method: 'DELETE' });
      toast(t('access_revoked_toast'), 'success');
      loadClerkStatus(member.id);
      load();
    } catch (err: any) {
      toast(err.message ?? t('access_error'));
    } finally {
      setAccessBusy(false);
      setRevokingAccess(null);
    }
  }

  async function handleDuplicate(member: StaffMember) {
    try {
      await apiFetch(`/staff/${member.id}/duplicate`, { method: 'POST' });
      toast(t('duplicated'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleDelete(member: StaffMember) {
    try {
      await apiFetch(`/staff/${member.id}`, { method: 'DELETE' });
      toast(t('deleted'), 'success');
      if (expandedId === member.id) { setExpandedId(null); setExpandedCenters(null); }
      if (editingId === member.id) setEditingId(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
    setDeleting(null);
  }

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  }

  function sortArrow(key: string) {
    if (sortKey !== key) return <span style={{ color: '#ccc' }}> ↕</span>;
    return <span> {sortDir === 'asc' ? '↑' : '↓'}</span>;
  }

  function patchForm(patch: Partial<StaffMember>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function toggleWorkingDay(day: string) {
    const current = (form.working_days ?? '').split(',').filter(Boolean);
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day];
    patchForm({ working_days: next.join(',') });
  }

  // ---- Inline editor sections ----

  function renderGeneral() {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {/* Personal information */}
        <div>
          <p style={subsectionLabelStyle}>{t('subsection_personal')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
            <FormRow label={t('label_first_name') + ' *'}>
              <input ref={firstNameRef} style={inputStyle} value={form.first_name ?? ''} onChange={(e) => patchForm({ first_name: e.target.value })} />
            </FormRow>
            <FormRow label={t('label_last_name') + ' *'}>
              <input style={inputStyle} value={form.last_name ?? ''} onChange={(e) => patchForm({ last_name: e.target.value })} />
            </FormRow>
            <FormRow label={t('label_email') + ' *'}>
              <input style={inputStyle} type="email" value={form.email ?? ''} onChange={(e) => patchForm({ email: e.target.value })} />
            </FormRow>
            <FormRow label={t('label_mobile_phone')}>
              <input style={inputStyle} value={form.mobile_phone ?? ''} onChange={(e) => patchForm({ mobile_phone: e.target.value || null })} />
            </FormRow>
            <FormRow label={t('label_date_of_birth')}>
              <input style={inputStyle} type="date" value={form.date_of_birth ?? ''} onChange={(e) => patchForm({ date_of_birth: e.target.value || null })} />
            </FormRow>
            <FormRow label={t('label_national_id')}>
              <input style={inputStyle} value={form.national_id ?? ''} onChange={(e) => patchForm({ national_id: e.target.value || null })} />
            </FormRow>
          </div>
        </div>

        {/* Contact information */}
        <div>
          <p style={subsectionLabelStyle}>{t('subsection_contact')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
            <FormRow label={t('label_company_email')}>
              <input style={inputStyle} type="email" value={form.company_email ?? ''} onChange={(e) => patchForm({ company_email: e.target.value || null })} />
            </FormRow>
            <FormRow label={t('label_company_phone')}>
              <input style={inputStyle} value={form.company_phone ?? ''} onChange={(e) => patchForm({ company_phone: e.target.value || null })} />
            </FormRow>
            <FormRow label={t('label_personal_phone')}>
              <input style={inputStyle} value={form.personal_phone ?? ''} onChange={(e) => patchForm({ personal_phone: e.target.value || null })} />
            </FormRow>
            <FormRow label={t('label_emergency_contact')}>
              <input style={inputStyle} value={form.emergency_contact ?? ''} onChange={(e) => patchForm({ emergency_contact: e.target.value || null })} />
            </FormRow>
            <FormRow label={t('label_emergency_phone')}>
              <input style={inputStyle} value={form.emergency_phone ?? ''} onChange={(e) => patchForm({ emergency_phone: e.target.value || null })} />
            </FormRow>
          </div>
        </div>

        {/* Profile */}
        <div>
          <p style={subsectionLabelStyle}>{t('subsection_profile')}</p>
          <div style={{ color: '#555', fontSize: 14 }}>
            <p style={{ margin: '0 0 8px 0' }}><strong>{t('label_profile')}:</strong> {form.profile}</p>
            <p style={{ margin: 0, color: '#888', fontSize: 13 }}>{t('permissions_note')}</p>
          </div>
        </div>
      </div>
    );
  }

  function renderEmployment() {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        <FormRow label={t('label_profile') + ' *'}>
          <select style={selectStyle} value={form.profile ?? ''} onChange={(e) => patchForm({ profile: e.target.value })}>
            {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {form.profile && PROFILE_ROLE_MAP[form.profile] && (
            <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
              {t('access_role_hint', { role: t(`role_${PROFILE_ROLE_MAP[form.profile]}` as any) })}
            </div>
          )}
        </FormRow>
        <FormRow label={t('label_employment_status')}>
          <select style={selectStyle} value={form.employment_status ?? 'active'} onChange={(e) => patchForm({ employment_status: e.target.value as any })}>
            {EMPLOYMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`employment_status_${s}`)}</option>)}
          </select>
        </FormRow>
        <FormRow label={t('label_current_status')}>
          <select style={selectStyle} value={form.current_status ?? 'available'} onChange={(e) => patchForm({ current_status: e.target.value })}>
            {CURRENT_STATUSES.map((s) => <option key={s} value={s}>{t(`current_status_${s}`)}</option>)}
          </select>
        </FormRow>
        <FormRow label={t('label_hire_date') + ' *'}>
          <input style={inputStyle} type="date" value={form.hire_date ?? ''} onChange={(e) => patchForm({ hire_date: e.target.value })} />
        </FormRow>
        <FormRow label={t('label_contract_end_date')}>
          <input style={inputStyle} type="date" value={form.contract_end_date ?? ''} onChange={(e) => patchForm({ contract_end_date: e.target.value || null })} />
        </FormRow>
        <FormRow label={t('label_termination_date')}>
          <input style={inputStyle} type="date" value={form.termination_date ?? ''} onChange={(e) => patchForm({ termination_date: e.target.value || null })} />
        </FormRow>
        <FormRow label={t('label_employee_number')}>
          <input style={inputStyle} value={form.employee_number ?? ''} onChange={(e) => patchForm({ employee_number: e.target.value || null })} />
        </FormRow>
      </div>
    );
  }


  function renderSchedule() {
    const selectedDays = (form.working_days ?? '').split(',').filter(Boolean);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <FormRow label={t('label_working_days')}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {WEEKDAYS.map((day) => {
              const active = selectedDays.includes(day);
              return (
                <button
                  key={day}
                  onClick={() => toggleWorkingDay(day)}
                  style={{
                    padding: '5px 12px',
                    borderRadius: 20,
                    border: active ? '2px solid #4c6ef5' : '2px solid #d0d0d8',
                    background: active ? '#e0e7ff' : '#fff',
                    color: active ? '#4c6ef5' : '#555',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </FormRow>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16 }}>
          <FormRow label={t('label_work_start_time')}>
            <input style={inputStyle} type="time" value={form.work_start_time ?? ''} onChange={(e) => patchForm({ work_start_time: e.target.value || null })} />
          </FormRow>
          <FormRow label={t('label_work_end_time')}>
            <input style={inputStyle} type="time" value={form.work_end_time ?? ''} onChange={(e) => patchForm({ work_end_time: e.target.value || null })} />
          </FormRow>
          <FormRow label={t('label_break_duration')}>
            <input style={inputStyle} type="number" min={0} step={5} value={form.break_duration_minutes ?? ''} onChange={(e) => patchForm({ break_duration_minutes: e.target.value ? Number(e.target.value) : null })} placeholder="minutes" />
          </FormRow>
        </div>
      </div>
    );
  }


  function renderCenters() {
    if (!showCenters) return null;
    return (
      <div>
        <p style={subsectionLabelStyle}>{t('subsection_centers')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 360 }}>
          <FormRow label={t('label_assigned_centers')}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 160, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6, padding: 10 }}>
              {centers.map((c) => (
                <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                  <input type="checkbox" checked={assignedCenterIds.has(c.id)}
                         onChange={(e) => toggleCenter(c.id, e.target.checked)} />
                  {c.name}
                </label>
              ))}
            </div>
          </FormRow>
          <FormRow label={t('label_default_center')}>
            <select style={selectStyle} value={defaultCenterId ?? ''} onChange={(e) => setDefaultCenterId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">{t('default_center_none')}</option>
              {centers.filter((c) => assignedCenterIds.has(c.id)).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </FormRow>
        </div>
      </div>
    );
  }

  function renderNotes() {
    return (
      <FormRow label={t('label_notes')}>
        <textarea
          style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
          value={form.notes ?? ''}
          onChange={(e) => patchForm({ notes: e.target.value || null })}
          placeholder={t('notes_placeholder')}
        />
      </FormRow>
    );
  }

  function clerkStatusLabel(status: ClerkStatus['status']): string {
    switch (status) {
      case 'not_enrolled': return t('clerk_not_enrolled');
      case 'invited': return t('clerk_invited');
      case 'active': return t('clerk_active');
      case 'suspended': return t('clerk_suspended');
      case 'error': return t('clerk_error');
    }
  }

  function clerkStatusColor(status: ClerkStatus['status']): string {
    switch (status) {
      case 'active': return '#2ecc71';
      case 'suspended': return '#e74c3c';
      case 'invited': return '#3498db';
      default: return '#999';
    }
  }

  function renderClerk() {
    const field = (label: string, value: React.ReactNode) => (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 14 }}>{value}</div>
      </div>
    );
    if (clerkLoading) {
      return <p style={{ fontSize: 14, color: '#888' }}>{t('clerk_loading')}</p>;
    }
    if (!clerkStatus) {
      return <p style={{ fontSize: 14, color: '#888' }}>{t('clerk_loading')}</p>;
    }
    const statusText = clerkStatusLabel(clerkStatus.status);
    const member = typeof editingId === 'number' ? rows.find((r) => r.id === editingId) : undefined;
    const role = form.profile ? PROFILE_ROLE_MAP[form.profile] : undefined;
    const canInvite = clerkStatus.status === 'not_enrolled' || clerkStatus.status === 'error';
    const canResend = clerkStatus.status === 'invited';
    const canRevoke = clerkStatus.status !== 'not_enrolled';
    const dot = (
      <span style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: clerkStatusColor(clerkStatus.status),
        marginRight: 6,
        verticalAlign: 'middle',
      }} />
    );
    return (
      <div>
        {field(t('clerk_status_label'), <span>{dot}{statusText}</span>)}
        {role && field(t('access_role_label'), t(`role_${role}` as any))}
        {clerkStatus.userId && field(t('clerk_user_id_label'), <span style={{ fontFamily: 'monospace', fontSize: 13 }}>{clerkStatus.userId}</span>)}
        <p style={{ fontSize: 12, color: '#888', margin: '0 0 12px 0' }}>{t('access_note')}</p>
        {member && (
          <div style={{ display: 'flex', gap: 8 }}>
            {(canInvite || canResend) && (
              <button type="button" onClick={() => handleGrantAccess(member)} disabled={!canWrite || accessBusy} title={readOnlyTitle} style={readOnlyStyle(btnSmall('#4c6ef5'), !canWrite)}>
                {canResend ? t('access_resend') : t('access_invite')}
              </button>
            )}
            {canRevoke && (
              <button type="button" onClick={() => setRevokingAccess(member)} disabled={!canWrite || accessBusy} title={readOnlyTitle} style={readOnlyStyle(btnSmall('#c0392b'), !canWrite)}>
                {t('access_revoke')}
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ---- Read-only expanded view (#798) ----
  //
  // Expanding a card shows the whole Staff record and nothing writable: no
  // input, select, textarea, checkbox, Save, Cancel or Edit affordance lives
  // below this comment. Editing is ⋮ → Edit, which renders renderInlineEditor().

  function ReadRow({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        <div style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>{label}</div>
        <div style={multiline
          ? { fontSize: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
          : { fontSize: 14, overflowWrap: 'anywhere' }}>{value}</div>
      </div>
    );
  }

  /** Assigned Centers + Default Center. A staff member is allowed zero centers (#440). */
  function renderReadOnlyCenters() {
    if (!showCenters) return null;
    const assignments = expandedCenters;
    const defaultCenter = assignments?.find((c) => c.is_default) ?? null;
    return (
      <div>
        <p style={subsectionLabelStyle}>{t('subsection_centers')}</p>
        {assignments === null ? (
          <p style={{ fontSize: 14, color: '#888', margin: 0 }}>{t('loading')}</p>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
            <ReadRow
              label={t('label_assigned_centers')}
              value={assignments.length > 0 ? assignments.map((c) => c.name).join(', ') : t('centers_none')}
            />
            <ReadRow label={t('label_default_center')} value={defaultCenter?.name ?? EMPTY_VALUE} />
          </div>
        )}
      </div>
    );
  }

  /** App access state only — the invite/resend/revoke actions stay in the Edit form. */
  function renderReadOnlyClerk(member: StaffMember) {
    if (clerkLoading || !clerkStatus) {
      return <p style={{ fontSize: 14, color: '#888', margin: 0 }}>{t('clerk_loading')}</p>;
    }
    const role = PROFILE_ROLE_MAP[member.profile];
    const dot = (
      <span style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: clerkStatusColor(clerkStatus.status),
        marginRight: 6,
        verticalAlign: 'middle',
      }} />
    );
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: '#888', fontWeight: 500 }}>{t('clerk_status_label')}</div>
          <div style={{ fontSize: 14 }}>{dot}{clerkStatusLabel(clerkStatus.status)}</div>
        </div>
        <ReadRow label={t('access_role_label')} value={role ? t(`role_${role}` as any) : EMPTY_VALUE} />
        <ReadRow label={t('clerk_user_id_label')} value={clerkStatus.userId ?? EMPTY_VALUE} />
      </div>
    );
  }

  function renderReadOnlyProfile(member: StaffMember) {
    return (
      <div style={{ borderTop: '1px solid #e8e8ed', padding: 20 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {STAFF_PROFILE_SECTIONS.map((section) => (
            <div key={section.titleKey}>
              <p style={subsectionLabelStyle}>{t(section.titleKey as any)}</p>
              <div style={section.layout === 'grid'
                ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }
                : { display: 'flex', flexDirection: 'column', gap: 16 }}>
                {section.fields.map((field) => (
                  <ReadRow
                    key={field.key}
                    label={t(field.labelKey as any)}
                    value={formatStaffField(member, field, (key) => t(key as any))}
                    multiline={field.format === 'multiline'}
                  />
                ))}
              </div>
            </div>
          ))}

          {renderReadOnlyCenters()}

          <div>
            <p style={subsectionLabelStyle}>{t('section_clerk')}</p>
            {renderReadOnlyClerk(member)}
          </div>
        </div>
      </div>
    );
  }

  function renderInlineEditor() {
    return (
      <div style={{ borderTop: '1px solid #e8e8ed', padding: 20 }}>
        {/* All sections consolidated into a single continuous scrolling view (#440) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          {renderGeneral()}

          <div>
            <p style={subsectionLabelStyle}>{t('section_employment')}</p>
            {renderEmployment()}
          </div>

          {renderCenters()}

          <div>
            <p style={subsectionLabelStyle}>{t('section_schedule')}</p>
            {renderSchedule()}
          </div>

          <div>
            <p style={subsectionLabelStyle}>{t('section_notes')}</p>
            {renderNotes()}
          </div>

          {editingId !== 'new' && (
            <div>
              <p style={subsectionLabelStyle}>{t('section_clerk')}</p>
              {renderClerk()}
            </div>
          )}
        </div>

        {/* Error + actions */}
        {editingId !== 'new' && clerkStatus?.status === 'not_enrolled' && form.employment_status === 'active' && (
          <p style={{ color: '#888', fontSize: 13, marginTop: 16 }}>{t('save_will_invite', { email: form.email ?? '' })}</p>
        )}
        {formError && <p style={{ color: '#c0392b', fontSize: 13, marginTop: 16 }}>{formError}</p>}
        {/*
          * #1028: the shared left-aligned form row, in the app's own
          * `Cancel` → `Save` order — this form was the one that read
          * `[Save] [Cancel]`.
          */}
        <div style={{ ...inlineActionsRowStyle, marginTop: 20 }}>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={handleSave} disabled={!canWrite || saving} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#4c6ef5'), !canWrite)}>
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </div>
    );
  }

  function renderMemberRow(member: StaffMember) {
    const isExpanded = expandedId === member.id;
    const isEditing = editingId === member.id;

    // #798: Edit lives here and nowhere else — the expanded row adds no Edit
    // affordance of any kind.
    const menuItems: ContextMenuItem[] = [
      { label: t('action_edit'), onClick: () => startEdit(member), disabled: !canWrite, title: readOnlyTitle },
      { label: t('action_details'), onClick: () => setDetailsMember(member) },
      { label: t('action_duplicate'), onClick: () => handleDuplicate(member), disabled: !canWrite, title: readOnlyTitle },
    ];
    if (member.employment_status === 'active') {
      menuItems.push({ label: t('action_deactivate'), onClick: () => setDeactivating(member), disabled: !canWrite, title: readOnlyTitle });
    }
    menuItems.push({ label: t('action_delete'), onClick: () => setDeleting(member), danger: true, disabled: !canWrite, title: readOnlyTitle });

    return (
      <div key={member.id} style={{ ...cardSurfaceStyle, marginBottom: 10, overflow: 'hidden' }}>
        <div
          className={LIST_GRID_ROW_CLASS}
          style={listRowStyle(isEditing)}
          onClick={() => { if (!isEditing) openExpand(member); }}
        >
          {/* Avatar */}
          <div className={CELL_CLASS.avatar}>{avatar(member)}</div>

          {/* Name */}
          <div className={CELL_CLASS.name} title={`${member.first_name} ${member.last_name}`} style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {member.first_name} {member.last_name}
            </div>
            {member.employee_number && (
              <div style={{ fontSize: 12, color: '#888' }}>{member.employee_number}</div>
            )}
          </div>

          {/* Hire date */}
          <div className={CELL_CLASS.hire_date} style={{ fontSize: 13, color: '#555' }}>
            {member.hire_date ? new Date(member.hire_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
          </div>

          {/* Contract end */}
          <div className={CELL_CLASS.contract_end} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, minWidth: 0 }}>
            {member.contract_end_date
              ? new Date(member.contract_end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
              : <span style={{ color: '#aaa' }}>—</span>}
            {contractBadge(member.contract_days_remaining !== undefined ? Number(member.contract_days_remaining) : null)}
          </div>

          {/* Profile badge */}
          <div className={CELL_CLASS.profile} style={{ minWidth: 0 }}>
            <span style={{ background: '#f0f4ff', color: '#4c6ef5', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {member.profile}
            </span>
          </div>

          {/* Employment status */}
          <div className={CELL_CLASS.employment}>
            <StatusBadge status={member.employment_status} label={t(`employment_status_${member.employment_status}`)} />
          </div>

          {/* Current status */}
          <div className={CELL_CLASS.current_status}>
            <StatusBadge status={member.current_status === 'available' ? 'active' : 'paused'} label={t(`current_status_${member.current_status}`)} />
          </div>

          {/* Expand chevron */}
          <span className={CELL_CLASS.expand} style={{ fontSize: 14, color: '#aaa', transform: isExpanded || isEditing ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>

          {/* Context menu */}
          <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>

        {isEditing ? renderInlineEditor() : isExpanded ? renderReadOnlyProfile(member) : null}
      </div>
    );
  }

  function renderNewRow() {
    return (
      <div style={{ ...cardSurfaceStyle, border: '2px solid #4c6ef5', marginBottom: 10, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', fontWeight: 600, fontSize: 15, color: '#4c6ef5' }}>
          {t('new_member_title')}
        </div>
        {renderInlineEditor()}
      </div>
    );
  }

  function renderDetailsModal(member: StaffMember) {
    const field = (label: string, value: string | number | null | undefined) => (
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 14 }}>{value ?? '—'}</div>
      </div>
    );
    return (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onClick={() => setDetailsMember(null)}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 32, maxWidth: 520, width: '90%', maxHeight: '85vh', overflowY: 'auto' }}
          onClick={(e) => e.stopPropagation()}>
          <h2 style={{ margin: '0 0 24px 0' }}>{t('details_title')}</h2>
          <hr style={{ border: 'none', borderTop: '1px solid #e8e8ed', marginBottom: 20 }} />
          {field(t('label_first_name'), member.first_name)}
          {field(t('label_last_name'), member.last_name)}
          {field(t('label_profile'), member.profile)}
          {field(t('label_employment_status'), t(`employment_status_${member.employment_status}`))}
          {field(t('label_current_status'), t(`current_status_${member.current_status}`))}
          {field(t('label_hire_date'), member.hire_date)}
          {field(t('label_contract_end_date'), member.contract_end_date)}
          {field(t('label_termination_date'), member.termination_date)}
          {field(t('label_centers'), detailsCenters.length > 0
            ? detailsCenters.map((c) => c.is_default ? `${c.name} (${t('default_center_badge')})` : c.name).join(', ')
            : null)}
          {field(t('label_employee_number'), member.employee_number)}
          <hr style={{ border: 'none', borderTop: '1px solid #e8e8ed', margin: '20px 0' }} />
          {field(t('label_company_email'), member.company_email)}
          {field(t('label_company_phone'), member.company_phone)}
          {field(t('label_personal_phone'), member.personal_phone)}
          <hr style={{ border: 'none', borderTop: '1px solid #e8e8ed', margin: '20px 0' }} />
          {field(t('label_created_at'), member.created_at ? new Date(member.created_at).toLocaleString() : null)}
          {field(t('label_updated_at'), member.updated_at ? new Date(member.updated_at).toLocaleString() : null)}
          <div style={{ marginTop: 24, display: 'flex', gap: 8 }}>
            <ViewAuditLogButton entityType="staff" entityId={member.id} onNavigate={() => setDetailsMember(null)} />
            <button onClick={() => setDetailsMember(null)} style={btnStyle('#888')}>{t('close')}</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button onClick={openNew} disabled={!canWrite} title={readOnlyTitle} style={readOnlyStyle(btnStyle('#4c6ef5'), !canWrite)}>{t('add')}</button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20, alignItems: 'center' }}>
        <input
          style={{ ...inputStyle, width: 220 }}
          placeholder={t('search_placeholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select style={{ ...selectStyle, width: 160 }} value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}>
          <option value="">{t('filter_profile_all')}</option>
          {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select style={{ ...selectStyle, width: 160 }} value={empStatusFilter} onChange={(e) => setEmpStatusFilter(e.target.value)}>
          <option value="">{t('filter_emp_status_all')}</option>
          {EMPLOYMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`employment_status_${s}`)}</option>)}
        </select>
        <select style={{ ...selectStyle, width: 160 }} value={currentStatusFilter} onChange={(e) => setCurrentStatusFilter(e.target.value)}>
          <option value="">{t('filter_cur_status_all')}</option>
          {CURRENT_STATUSES.map((s) => <option key={s} value={s}>{t(`current_status_${s}`)}</option>)}
        </select>
      </div>

      {/* The header band and the cards share LIST_GRID_COLUMNS and scroll
          together, so they cannot fall out of line, and a narrow viewport
          scrolls the list instead of the page (#1011). */}
      <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
        <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
          {/* Column headers */}
          <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
            {LIST_COLUMNS.map((col) => (
              <div
                key={col.key}
                className={CELL_CLASS[col.key]}
                style={col.sortKey ? { cursor: 'pointer' } : undefined}
                onClick={col.sortKey ? () => toggleSort(col.sortKey!) : undefined}
              >
                {col.labelKey ? <>{t(col.labelKey)}{col.sortKey ? sortArrow(col.sortKey) : null}</> : null}
              </div>
            ))}
          </div>

          {/* New row */}
          {editingId === 'new' && renderNewRow()}

          {/* Rows */}
          {loading ? (
            <p style={{ color: '#888' }}>{t('loading')}</p>
          ) : rows.length === 0 ? (
            <p style={{ color: '#888' }}>{t('empty')}</p>
          ) : (
            rows.map((m) => renderMemberRow(m))
          )}
        </div>
      </div>

      {/* Details modal */}
      {detailsMember && renderDetailsModal(detailsMember)}

      {/* Deactivate confirm */}
      <ConfirmDialog
        open={!!deactivating}
        message={deactivating ? t('confirm_deactivate_msg', { name: `${deactivating.first_name} ${deactivating.last_name}` }) : ''}
        confirmLabel={t('action_deactivate')}
        cancelLabel={t('cancel')}
        onConfirm={() => deactivating && handleDeactivate(deactivating)}
        onCancel={() => setDeactivating(null)}
      />

      {/* Revoke app access confirm */}
      <ConfirmDialog
        open={!!revokingAccess}
        message={revokingAccess ? t('access_revoke_confirm', { name: `${revokingAccess.first_name} ${revokingAccess.last_name}` }) : ''}
        confirmLabel={t('access_revoke')}
        cancelLabel={t('cancel')}
        busy={accessBusy}
        onConfirm={() => revokingAccess && handleRevokeAccess(revokingAccess)}
        onCancel={() => setRevokingAccess(null)}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleting}
        message={deleting ? t('confirm_delete_msg', { name: `${deleting.first_name} ${deleting.last_name}` }) : ''}
        confirmLabel={t('action_delete')}
        cancelLabel={t('cancel')}
        onConfirm={() => deleting && handleDelete(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
