'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { btnStyle, btnSmall } from '@/components/ui';

export interface StaffMember {
  id: number;
  gym_id: string;
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone: string | null;
  profile_photo_url: string | null;
  date_of_birth: string | null;
  national_id: string | null;
  profile: string;
  employment_status: 'active' | 'inactive';
  current_status: string;
  hire_date: string;
  contract_end_date: string | null;
  termination_date: string | null;
  assigned_center_id: number | null;
  assigned_center_name: string | null;
  direct_manager_id: number | null;
  direct_manager_name: string | null;
  employee_number: string | null;
  company_email: string | null;
  company_phone: string | null;
  personal_phone: string | null;
  emergency_contact: string | null;
  emergency_phone: string | null;
  working_days: string | null;
  work_start_time: string | null;
  work_end_time: string | null;
  break_duration_minutes: number | null;
  notes: string | null;
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

const SECTIONS = ['general', 'employment', 'contact', 'schedule', 'permissions', 'notes'] as const;
type Section = (typeof SECTIONS)[number];

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
  assigned_center_id: null,
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

export default function StaffPage() {
  const t = useTranslations('staff');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [profileFilter, setProfileFilter] = useState('');
  const [empStatusFilter, setEmpStatusFilter] = useState('');
  const [currentStatusFilter, setCurrentStatusFilter] = useState('');
  const [sortKey, setSortKey] = useState('name');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const [expandedId, setExpandedId] = useState<number | 'new' | null>(null);
  const [activeSection, setActiveSection] = useState<Section>('general');
  const [form, setForm] = useState<Partial<StaffMember>>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [detailsMember, setDetailsMember] = useState<StaffMember | null>(null);
  const [deleting, setDeleting] = useState<StaffMember | null>(null);
  const [deactivating, setDeactivating] = useState<StaffMember | null>(null);

  const firstNameRef = useRef<HTMLInputElement>(null);
  const isAdmin = activeGym?.role === 'admin';

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

  function openNew() {
    setForm(emptyForm());
    setExpandedId('new');
    setActiveSection('general');
    setFormError(null);
    setTimeout(() => firstNameRef.current?.focus(), 50);
  }

  function openExpand(member: StaffMember) {
    if (expandedId === member.id) { setExpandedId(null); return; }
    setForm({ ...member });
    setExpandedId(member.id);
    setActiveSection('general');
    setFormError(null);
  }

  function cancelEdit() {
    setExpandedId(null);
    setFormError(null);
  }

  async function handleSave() {
    if (!form.first_name || !form.last_name || !form.email || !form.profile || !form.hire_date) {
      setFormError(t('error_required'));
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (expandedId === 'new') {
        await apiFetch('/staff', { method: 'POST', body: JSON.stringify(form) });
        toast(t('created'));
      } else {
        await apiFetch(`/staff/${expandedId}`, { method: 'PUT', body: JSON.stringify(form) });
        toast(t('saved'));
      }
      setExpandedId(null);
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
      toast(t('deactivated'));
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
    setDeactivating(null);
  }

  async function handleDuplicate(member: StaffMember) {
    try {
      await apiFetch(`/staff/${member.id}/duplicate`, { method: 'POST' });
      toast(t('duplicated'));
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleDelete(member: StaffMember) {
    try {
      await apiFetch(`/staff/${member.id}`, { method: 'DELETE' });
      toast(t('deleted'));
      if (expandedId === member.id) setExpandedId(null);
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
    );
  }

  function renderEmployment() {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 16 }}>
        <FormRow label={t('label_profile') + ' *'}>
          <select style={selectStyle} value={form.profile ?? ''} onChange={(e) => patchForm({ profile: e.target.value })}>
            {PROFILES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
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

  function renderContact() {
    return (
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

  function renderPermissions() {
    return (
      <div style={{ color: '#555', fontSize: 14 }}>
        <p style={{ margin: '0 0 8px 0' }}><strong>{t('label_profile')}:</strong> {form.profile}</p>
        <p style={{ margin: 0, color: '#888', fontSize: 13 }}>{t('permissions_note')}</p>
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

  function renderSectionContent() {
    switch (activeSection) {
      case 'general': return renderGeneral();
      case 'employment': return renderEmployment();
      case 'contact': return renderContact();
      case 'schedule': return renderSchedule();
      case 'permissions': return renderPermissions();
      case 'notes': return renderNotes();
    }
  }

  function renderInlineEditor() {
    return (
      <div style={{ borderTop: '1px solid #e8e8ed', padding: 20 }}>
        {/* Section tabs */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 20, borderBottom: '1px solid #e8e8ed', paddingBottom: 12 }}>
          {SECTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setActiveSection(s)}
              style={{
                padding: '6px 14px',
                borderRadius: 6,
                border: 'none',
                background: activeSection === s ? '#4c6ef5' : 'transparent',
                color: activeSection === s ? '#fff' : '#555',
                fontWeight: activeSection === s ? 600 : 400,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {t(`section_${s}`)}
            </button>
          ))}
        </div>

        {/* Section content */}
        {renderSectionContent()}

        {/* Error + actions */}
        {formError && <p style={{ color: '#c0392b', fontSize: 13, marginTop: 16 }}>{formError}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button onClick={handleSave} disabled={saving} style={btnStyle('#4c6ef5')}>
            {saving ? t('saving') : t('save')}
          </button>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
        </div>
      </div>
    );
  }

  function renderMemberRow(member: StaffMember) {
    const isExpanded = expandedId === member.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('action_details'), onClick: () => setDetailsMember(member) },
      { label: t('action_duplicate'), onClick: () => handleDuplicate(member) },
    ];
    if (isAdmin) {
      if (member.employment_status === 'active') {
        menuItems.push({ label: t('action_deactivate'), onClick: () => setDeactivating(member) });
      }
      menuItems.push({ label: t('action_delete'), onClick: () => setDeleting(member), danger: true });
    }

    return (
      <div key={member.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: '#fff' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: 'pointer' }}
          onClick={() => openExpand(member)}
        >
          {/* Avatar */}
          {avatar(member)}

          {/* Name */}
          <div style={{ flex: '0 0 200px', minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {member.first_name} {member.last_name}
            </div>
            {member.employee_number && (
              <div style={{ fontSize: 12, color: '#888' }}>{member.employee_number}</div>
            )}
          </div>

          {/* Hire date */}
          <div style={{ flex: '0 0 110px', fontSize: 13, color: '#555' }}>
            {member.hire_date ? new Date(member.hire_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
          </div>

          {/* Contract end */}
          <div style={{ flex: '0 0 160px', display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            {member.contract_end_date
              ? new Date(member.contract_end_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
              : <span style={{ color: '#aaa' }}>—</span>}
            {contractBadge(member.contract_days_remaining !== undefined ? Number(member.contract_days_remaining) : null)}
          </div>

          {/* Profile badge */}
          <div style={{ flex: '0 0 180px' }}>
            <span style={{ background: '#f0f4ff', color: '#4c6ef5', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>
              {member.profile}
            </span>
          </div>

          {/* Employment status */}
          <div style={{ flex: '0 0 90px' }}>
            <StatusBadge status={member.employment_status} label={t(`employment_status_${member.employment_status}`)} />
          </div>

          {/* Current status */}
          <div style={{ flex: 1 }}>
            <StatusBadge status={member.current_status === 'available' ? 'active' : 'paused'} label={t(`current_status_${member.current_status}`)} />
          </div>

          {/* Expand chevron */}
          <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>

          {/* Context menu */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>

        {isExpanded && renderInlineEditor()}
      </div>
    );
  }

  function renderNewRow() {
    return (
      <div style={{ border: '2px solid #4c6ef5', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: '#fff' }}>
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
          {field(t('label_center'), member.assigned_center_name)}
          {field(t('label_employee_number'), member.employee_number)}
          <hr style={{ border: 'none', borderTop: '1px solid #e8e8ed', margin: '20px 0' }} />
          {field(t('label_company_email'), member.company_email)}
          {field(t('label_company_phone'), member.company_phone)}
          {field(t('label_personal_phone'), member.personal_phone)}
          <hr style={{ border: 'none', borderTop: '1px solid #e8e8ed', margin: '20px 0' }} />
          {field(t('label_created_at'), member.created_at ? new Date(member.created_at).toLocaleString() : null)}
          {field(t('label_updated_at'), member.updated_at ? new Date(member.updated_at).toLocaleString() : null)}
          <div style={{ marginTop: 24 }}>
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
        {isAdmin && (
          <button onClick={openNew} style={btnStyle('#4c6ef5')}>{t('add')}</button>
        )}
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

      {/* Column headers */}
      <div style={{ display: 'flex', gap: 12, padding: '6px 16px', fontSize: 12, color: '#888', fontWeight: 500 }}>
        <div style={{ flex: '0 0 36px' }} />
        <div style={{ flex: '0 0 200px', cursor: 'pointer' }} onClick={() => toggleSort('name')}>
          {t('col_name')}{sortArrow('name')}
        </div>
        <div style={{ flex: '0 0 110px', cursor: 'pointer' }} onClick={() => toggleSort('hire_date')}>
          {t('col_hire_date')}{sortArrow('hire_date')}
        </div>
        <div style={{ flex: '0 0 160px', cursor: 'pointer' }} onClick={() => toggleSort('contract_end_date')}>
          {t('col_contract_end')}{sortArrow('contract_end_date')}
        </div>
        <div style={{ flex: '0 0 180px', cursor: 'pointer' }} onClick={() => toggleSort('profile')}>
          {t('col_profile')}{sortArrow('profile')}
        </div>
        <div style={{ flex: '0 0 90px', cursor: 'pointer' }} onClick={() => toggleSort('employment_status')}>
          {t('col_employment')}{sortArrow('employment_status')}
        </div>
        <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => toggleSort('current_status')}>
          {t('col_current_status')}{sortArrow('current_status')}
        </div>
        <div style={{ flex: '0 0 40px' }} />
      </div>

      {/* New row */}
      {expandedId === 'new' && renderNewRow()}

      {/* Rows */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        rows.map((m) => renderMemberRow(m))
      )}

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
