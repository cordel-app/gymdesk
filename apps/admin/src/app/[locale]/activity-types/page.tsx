'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ActivityType {
  id: number;
  gym_id: string;
  name: string;
  description: string | null;
  duration_minutes: number;
  intensity_level: number | null;
  max_capacity: number;
  default_space_id: number | null;
  default_space_name: string | null;
  default_center_id: number | null;
  default_center_name: string | null;
  default_trainer_membership_id: number | null;
  default_trainer_name: string | null;
  color: string | null;
  status: 'active' | 'inactive';
  created_at: string;
  created_by_membership_id: number | null;
  created_by_name: string | null;
  modified_at: string | null;
  modified_by_membership_id: number | null;
  modified_by_name: string | null;
  deleted_at: string | null;
  deleted_by_membership_id: number | null;
  deleted_by_name: string | null;
}

interface ScheduleRule {
  id: number;
  activity_type_id: number;
  type: 'one_off' | 'weekly' | 'monthly';
  start_date: string;
  end_date: string | null;
  weekday: number | null;
  ordinal: 'first' | 'second' | 'third' | 'fourth' | 'fifth' | 'last' | null;
  start_time: string;
  end_time: string;
}

interface Center { id: number; name: string; }
interface Space { id: number; name: string; center_id: number; }
interface Trainer { gym_membership_id: number; name: string; }

const STATUSES = ['active', 'inactive'] as const;
const RULE_TYPES = ['one_off', 'weekly', 'monthly'] as const;
const WEEKDAYS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'last'] as const;

const emptyEditForm = {
  name: '',
  description: '',
  duration_minutes: '',
  max_capacity: '',
  intensity_level: '',
  status: 'active' as ActivityType['status'],
  default_center_id: '',
  default_space_id: '',
  default_trainer_membership_id: '',
  color: '',
};
type EditForm = typeof emptyEditForm;

const emptyRuleForm = {
  type: 'one_off' as ScheduleRule['type'],
  start_date: '',
  end_date: '',
  weekday: '',
  ordinal: '',
  start_time: '',
  end_time: '',
};
type RuleForm = typeof emptyRuleForm;

type InlineNew = {
  name: string;
  duration_minutes: string;
  max_capacity: string;
  saving: boolean;
  error: string | null;
};

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ActivityTypesPage() {
  const t = useTranslations('activity_types');
  const ts = useTranslations('activity_types.schedule');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  const [rows, setRows] = useState<ActivityType[]>([]);
  const [centers, setCenters] = useState<Center[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [rulesMap, setRulesMap] = useState<Map<number, ScheduleRule[]>>(new Map());
  const [loadingRules, setLoadingRules] = useState<Set<number>>(new Set());

  // Edit general fields
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Inline new row
  const [inlineNew, setInlineNew] = useState<InlineNew | null>(null);
  const newNameRef = useRef<HTMLInputElement>(null);

  // Details modal
  const [details, setDetails] = useState<ActivityType | null>(null);

  // Delete confirm
  const [deleting, setDeleting] = useState<ActivityType | null>(null);

  // Schedule rule management
  const [addingRuleFor, setAddingRuleFor] = useState<number | null>(null);
  const [addRuleForm, setAddRuleForm] = useState<RuleForm>(emptyRuleForm);
  const [editingRuleId, setEditingRuleId] = useState<number | null>(null);
  const [editRuleForm, setEditRuleForm] = useState<RuleForm>(emptyRuleForm);
  const [ruleSaving, setRuleSaving] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) { router.replace(`/${locale}`); return; }
  }, [gymLoading, isAdmin]);

  useEffect(() => { if (!gymLoading && isAdmin) load(); }, [activeGymId, gymLoading, statusFilter]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [at, ct, sp, tr] = await Promise.all([
        apiFetch<ActivityType[]>(`/activity-types${statusFilter ? `?status=${statusFilter}` : ''}`),
        apiFetch<Center[]>('/centers'),
        apiFetch<Space[]>('/spaces'),
        apiFetch<Trainer[]>('/trainers'),
      ]);
      setRows(at); setCenters(ct); setSpaces(sp); setTrainers(tr);
      // Clear rules cache on reload
      setRulesMap(new Map());
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Expand / detail fetch ───────────────────────────────────────────────────

  async function toggleExpand(id: number) {
    if (editingId === id) return;
    const next = new Set(expanded);
    if (next.has(id)) {
      next.delete(id);
      setExpanded(next);
      return;
    }
    next.add(id);
    setExpanded(next);
    if (!rulesMap.has(id)) {
      await fetchRules(id);
    }
  }

  async function fetchRules(id: number) {
    setLoadingRules((prev) => new Set([...prev, id]));
    try {
      const detail = await apiFetch<ActivityType & { schedule_rules: ScheduleRule[] }>(`/activity-types/${id}`);
      setRulesMap((prev) => new Map([...prev, [id, detail.schedule_rules ?? []]]));
    } catch {
      setRulesMap((prev) => new Map([...prev, [id, []]]));
    } finally {
      setLoadingRules((prev) => { const s = new Set(prev); s.delete(id); return s; });
    }
  }

  // ─── Inline new ─────────────────────────────────────────────────────────────

  function openInlineNew() {
    setInlineNew({ name: '', duration_minutes: '', max_capacity: '', saving: false, error: null });
    setTimeout(() => newNameRef.current?.focus(), 50);
  }

  async function saveInlineNew() {
    if (!inlineNew || !activeGymId) return;
    if (!inlineNew.name.trim() || !inlineNew.duration_minutes.trim() || !inlineNew.max_capacity.trim()) {
      setInlineNew({ ...inlineNew, error: t('error_required') });
      return;
    }
    setInlineNew({ ...inlineNew, saving: true, error: null });
    try {
      await apiFetch<ActivityType>('/activity-types', {
        method: 'POST',
        body: JSON.stringify({
          name: inlineNew.name.trim(),
          duration_minutes: parseInt(inlineNew.duration_minutes, 10),
          max_capacity: parseInt(inlineNew.max_capacity, 10),
        }),
      });
      setInlineNew(null);
      load();
    } catch (err: any) {
      setInlineNew({ ...inlineNew, saving: false, error: err.message ?? t('error_generic') });
    }
  }

  // ─── Edit ─────────────────────────────────────────────────────────────────

  async function openEdit(row: ActivityType) {
    setEditingId(row.id);
    setEditForm({
      name: row.name,
      description: row.description ?? '',
      duration_minutes: String(row.duration_minutes),
      max_capacity: String(row.max_capacity),
      intensity_level: row.intensity_level ? String(row.intensity_level) : '',
      status: row.status,
      default_center_id: row.default_center_id ? String(row.default_center_id) : '',
      default_space_id: row.default_space_id ? String(row.default_space_id) : '',
      default_trainer_membership_id: row.default_trainer_membership_id ? String(row.default_trainer_membership_id) : '',
      color: row.color ?? '',
    });
    setEditError(null);
    setExpanded((prev) => new Set([...prev, row.id]));
    if (!rulesMap.has(row.id)) await fetchRules(row.id);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditError(null);
  }

  async function handleSave(row: ActivityType) {
    if (!editForm.name.trim() || !editForm.duration_minutes.trim() || !editForm.max_capacity.trim()) {
      setEditError(t('error_required')); return;
    }
    setEditSaving(true); setEditError(null);
    try {
      await apiFetch(`/activity-types/${row.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          duration_minutes: parseInt(editForm.duration_minutes, 10),
          max_capacity: parseInt(editForm.max_capacity, 10),
          intensity_level: editForm.intensity_level ? parseInt(editForm.intensity_level, 10) : null,
          status: editForm.status,
          default_center_id: editForm.default_center_id ? parseInt(editForm.default_center_id, 10) : null,
          default_space_id: editForm.default_space_id ? parseInt(editForm.default_space_id, 10) : null,
          default_trainer_membership_id: editForm.default_trainer_membership_id
            ? parseInt(editForm.default_trainer_membership_id, 10) : null,
          color: editForm.color || null,
        }),
      });
      setEditingId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ───────────────────────────────────────────────────────────────

  async function handleDuplicate(row: ActivityType) {
    try {
      await apiFetch(`/activity-types/${row.id}/duplicate`, { method: 'POST' });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/activity-types/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      if (editingId === deleting.id) setEditingId(null);
      setExpanded((prev) => { const s = new Set(prev); s.delete(deleting.id); return s; });
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Schedule rules ───────────────────────────────────────────────────────────

  function openAddRule(actId: number) {
    setEditingRuleId(null);
    setAddingRuleFor(actId);
    setAddRuleForm(emptyRuleForm);
    setRuleError(null);
  }

  function cancelAddRule() {
    setAddingRuleFor(null);
    setRuleError(null);
  }

  async function saveAddRule(actId: number) {
    setRuleSaving(true); setRuleError(null);
    try {
      await apiFetch(`/activity-types/${actId}/schedule-rules`, {
        method: 'POST',
        body: JSON.stringify({
          type: addRuleForm.type,
          start_date: addRuleForm.start_date,
          end_date: addRuleForm.end_date || null,
          weekday: addRuleForm.weekday !== '' ? parseInt(addRuleForm.weekday, 10) : null,
          ordinal: addRuleForm.ordinal || null,
          start_time: addRuleForm.start_time,
          end_time: addRuleForm.end_time,
        }),
      });
      setAddingRuleFor(null);
      await fetchRules(actId);
    } catch (err: any) {
      setRuleError(err.message ?? t('error_generic'));
    } finally {
      setRuleSaving(false);
    }
  }

  function openEditRule(rule: ScheduleRule) {
    setAddingRuleFor(null);
    setEditingRuleId(rule.id);
    setEditRuleForm({
      type: rule.type,
      start_date: rule.start_date,
      end_date: rule.end_date ?? '',
      weekday: rule.weekday != null ? String(rule.weekday) : '',
      ordinal: rule.ordinal ?? '',
      start_time: rule.start_time,
      end_time: rule.end_time,
    });
    setRuleError(null);
  }

  function cancelEditRule() {
    setEditingRuleId(null);
    setRuleError(null);
  }

  async function saveEditRule(actId: number, ruleId: number) {
    setRuleSaving(true); setRuleError(null);
    try {
      await apiFetch(`/activity-types/${actId}/schedule-rules/${ruleId}`, {
        method: 'PUT',
        body: JSON.stringify({
          type: editRuleForm.type,
          start_date: editRuleForm.start_date,
          end_date: editRuleForm.end_date || null,
          weekday: editRuleForm.weekday !== '' ? parseInt(editRuleForm.weekday, 10) : null,
          ordinal: editRuleForm.ordinal || null,
          start_time: editRuleForm.start_time,
          end_time: editRuleForm.end_time,
        }),
      });
      setEditingRuleId(null);
      await fetchRules(actId);
    } catch (err: any) {
      setRuleError(err.message ?? t('error_generic'));
    } finally {
      setRuleSaving(false);
    }
  }

  async function deleteRule(actId: number, ruleId: number) {
    try {
      await apiFetch(`/activity-types/${actId}/schedule-rules/${ruleId}`, { method: 'DELETE' });
      setRulesMap((prev) => {
        const rules = (prev.get(actId) ?? []).filter((r) => r.id !== ruleId);
        return new Map([...prev, [actId, rules]]);
      });
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function fmtDate(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString();
  }

  function ruleLabel(rule: ScheduleRule) {
    const time = `${rule.start_time}–${rule.end_time}`;
    if (rule.type === 'one_off') return `${rule.start_date}  ${time}`;
    const day = WEEKDAYS.find((w) => w.value === rule.weekday)?.label ?? '—';
    if (rule.type === 'weekly') return `Every ${day}  ${time}  (until ${rule.end_date})`;
    const ord = rule.ordinal ? rule.ordinal.charAt(0).toUpperCase() + rule.ordinal.slice(1) : '';
    return `${ord} ${day} of every month  ${time}  (until ${rule.end_date})`;
  }

  // ─── Schedule rule form ───────────────────────────────────────────────────────

  function renderRuleForm(
    form: RuleForm,
    setForm: (f: RuleForm) => void,
    saveLabel: string,
    onSave: () => void,
    onCancel: () => void,
  ) {
    return (
      <div style={{ background: 'var(--gd-card-bg, #f9f9fb)', border: '1px solid var(--gd-border, #eee)', borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <label style={inlineLabelStyle}>{ts('label_type')}</label>
            <select
              value={form.type}
              onChange={(e) => setForm({ ...form, type: e.target.value as ScheduleRule['type'], end_date: '', weekday: '', ordinal: '' })}
              style={inlineSelectStyle}
            >
              {RULE_TYPES.map((rt) => (
                <option key={rt} value={rt}>{ts(`type_${rt}`)}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={inlineLabelStyle}>{form.type === 'one_off' ? ts('label_date') : ts('label_start_date')}</label>
            <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} style={inlineInputStyle} />
          </div>
          {form.type !== 'one_off' && (
            <div>
              <label style={inlineLabelStyle}>{ts('label_end_date')}</label>
              <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} style={inlineInputStyle} />
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
          {form.type !== 'one_off' && (
            <div>
              <label style={inlineLabelStyle}>{ts('label_weekday')}</label>
              <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: e.target.value })} style={inlineSelectStyle}>
                <option value="">—</option>
                {WEEKDAYS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
              </select>
            </div>
          )}
          {form.type === 'monthly' && (
            <div>
              <label style={inlineLabelStyle}>{ts('label_ordinal')}</label>
              <select value={form.ordinal} onChange={(e) => setForm({ ...form, ordinal: e.target.value })} style={inlineSelectStyle}>
                <option value="">—</option>
                {ORDINALS.map((o) => <option key={o} value={o}>{ts(`ordinal_${o}`)}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={inlineLabelStyle}>{ts('label_start_time')}</label>
            <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} style={inlineInputStyle} />
          </div>
          <div>
            <label style={inlineLabelStyle}>{ts('label_end_time')}</label>
            <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} style={inlineInputStyle} />
          </div>
        </div>
        {ruleError && <p style={errorStyle}>{ruleError}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={btnSmall('#888')}>{ts('cancel')}</button>
          <button onClick={onSave} disabled={ruleSaving} style={btnSmall('#6c63ff')}>
            {ruleSaving ? ts('saving') : saveLabel}
          </button>
        </div>
      </div>
    );
  }

  // ─── Schedule section ─────────────────────────────────────────────────────────

  function renderScheduleSection(row: ActivityType) {
    const rules = rulesMap.get(row.id) ?? [];
    const isLoadingRules = loadingRules.has(row.id);

    return (
      <>
        <SectionHeader title={t('section_schedule')} />
        {isLoadingRules ? (
          <p style={{ fontSize: 13, color: '#888' }}>…</p>
        ) : rules.length === 0 && addingRuleFor !== row.id ? (
          <p style={{ fontSize: 13, color: '#888', fontStyle: 'italic', margin: '4px 0 10px' }}>{ts('no_rules')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {rules.map((rule) =>
              editingRuleId === rule.id ? (
                <div key={rule.id}>
                  {renderRuleForm(
                    editRuleForm,
                    setEditRuleForm,
                    ts('update_rule'),
                    () => saveEditRule(row.id, rule.id),
                    cancelEditRule,
                  )}
                </div>
              ) : (
                <div key={rule.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', background: 'var(--gd-card-bg, #f6f6f9)', borderRadius: 6, fontSize: 13 }}>
                  <span style={{ flex: 1, color: '#333' }}>{ruleLabel(rule)}</span>
                  <button onClick={() => openEditRule(rule)} style={{ ...btnSmall('#555'), padding: '3px 10px', fontSize: 12 }}>{ts('edit_rule')}</button>
                  <button onClick={() => deleteRule(row.id, rule.id)} style={{ ...btnSmall('#c0392b'), padding: '3px 10px', fontSize: 12 }}>{ts('delete_rule')}</button>
                </div>
              ),
            )}
          </div>
        )}
        {addingRuleFor === row.id
          ? renderRuleForm(
              addRuleForm,
              setAddRuleForm,
              ts('save_rule'),
              () => saveAddRule(row.id),
              cancelAddRule,
            )
          : editingRuleId == null && (
              <button
                onClick={() => openAddRule(row.id)}
                style={{ fontSize: 13, color: '#6c63ff', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                + {ts('add_rule')}
              </button>
            )}
      </>
    );
  }

  // ─── Row renderer ─────────────────────────────────────────────────────────────

  function renderRow(row: ActivityType) {
    const isExpanded = expanded.has(row.id);
    const isEditing = editingId === row.id;
    const descText = row.description
      ? row.description.length > 60 ? row.description.slice(0, 60) + '…' : row.description
      : '—';

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetails(row) },
      { label: t('edit'), onClick: () => openEdit(row) },
      { label: t('duplicate'), onClick: () => handleDuplicate(row) },
      { label: t('delete'), onClick: () => setDeleting(row), danger: true },
    ];

    const filteredSpaces = spaces.filter((s) =>
      editForm.default_center_id ? s.center_id === parseInt(editForm.default_center_id, 10) : true,
    );

    return (
      <div key={row.id} style={cardStyle}>
        {/* Collapsed header */}
        <div style={rowStyle} onClick={() => toggleExpand(row.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.color && (
              <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: row.color, marginRight: 8, verticalAlign: 'middle' }} />
            )}
            {row.name}
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {descText}
          </div>
          <div style={{ minWidth: 110, fontSize: 13, color: '#555', flexShrink: 0 }}>
            {row.duration_minutes} min · {row.max_capacity} cap.
          </div>
          <div style={{ minWidth: 120, fontSize: 13, color: '#888', flexShrink: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.default_center_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0 }}>
            <StatusBadge status={row.status} label={tStatus(row.status)} />
          </div>
          <span style={{ fontSize: 14, color: '#aaa', flexShrink: 0, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${row.name}`} />
          </div>
        </div>

        {/* Inline edit form */}
        {isEditing && (
          <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={inlineLabelStyle}>{t('label_name')} *</label>
                <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} autoFocus style={inlineInputStyle} />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_status')}</label>
                <select value={editForm.status} onChange={(e) => setEditForm({ ...editForm, status: e.target.value as ActivityType['status'] })} style={inlineSelectStyle}>
                  {STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
                </select>
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={inlineLabelStyle}>{t('label_description')}</label>
                <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={2} style={{ ...inlineInputStyle, resize: 'vertical' }} />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_duration')} *</label>
                <input type="number" min="1" step="1" value={editForm.duration_minutes} onChange={(e) => setEditForm({ ...editForm, duration_minutes: e.target.value })} style={inlineInputStyle} />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_capacity')} *</label>
                <input type="number" min="1" step="1" value={editForm.max_capacity} onChange={(e) => setEditForm({ ...editForm, max_capacity: e.target.value })} style={inlineInputStyle} />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_intensity')}</label>
                <input type="number" min="1" max="5" step="1" value={editForm.intensity_level} onChange={(e) => setEditForm({ ...editForm, intensity_level: e.target.value })} style={inlineInputStyle} />
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_color')}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="color" value={editForm.color || '#3b82f6'} onChange={(e) => setEditForm({ ...editForm, color: e.target.value })} style={{ width: 36, height: 34, border: 'none', cursor: 'pointer', padding: 0 }} />
                  {editForm.color && <button onClick={() => setEditForm({ ...editForm, color: '' })} style={{ fontSize: 12, color: '#888', background: 'none', border: 'none', cursor: 'pointer' }}>Clear</button>}
                </div>
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_default_center')}</label>
                <select
                  value={editForm.default_center_id}
                  onChange={(e) => setEditForm({ ...editForm, default_center_id: e.target.value, default_space_id: '' })}
                  style={inlineSelectStyle}
                >
                  <option value="">—</option>
                  {centers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_default_space')}</label>
                <select value={editForm.default_space_id} onChange={(e) => setEditForm({ ...editForm, default_space_id: e.target.value })} style={inlineSelectStyle}>
                  <option value="">—</option>
                  {filteredSpaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label style={inlineLabelStyle}>{t('label_default_trainer')}</label>
                <select value={editForm.default_trainer_membership_id} onChange={(e) => setEditForm({ ...editForm, default_trainer_membership_id: e.target.value })} style={inlineSelectStyle}>
                  <option value="">—</option>
                  {trainers.map((tr) => <option key={tr.gym_membership_id} value={tr.gym_membership_id}>{tr.name}</option>)}
                </select>
              </div>
            </div>

            {editError && <p style={errorStyle}>{editError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 16 }}>
              <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
              <button onClick={() => handleSave(row)} disabled={editSaving} style={btnSmall('#6c63ff')}>
                {editSaving ? t('saving') : t('save_changes')}
              </button>
            </div>

            {renderScheduleSection(row)}
          </div>
        )}

        {/* Read-only expanded view */}
        {isExpanded && !isEditing && (
          <div style={{ padding: '0 20px 16px', borderTop: '1px solid var(--gd-border, #eee)' }}>
            <SectionHeader title={t('section_general')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 32px', marginBottom: 8 }}>
              <DetailRow label={t('label_description')} value={row.description ?? '—'} />
              <DetailRow label={t('label_duration')} value={`${row.duration_minutes} min`} />
              <DetailRow label={t('label_capacity')} value={String(row.max_capacity)} />
              <DetailRow label={t('label_intensity')} value={row.intensity_level ? String(row.intensity_level) : '—'} />
              <DetailRow label={t('label_status')} value={tStatus(row.status)} />
              <DetailRow label={t('label_default_center')} value={row.default_center_name ?? '—'} />
              <DetailRow label={t('label_default_space')} value={row.default_space_name ?? '—'} />
              <DetailRow label={t('label_default_trainer')} value={row.default_trainer_name ?? '—'} />
            </div>

            {renderScheduleSection(row)}

            <SectionHeader title={t('section_metadata')} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 32px' }}>
              <DetailRow label={t('meta_created_by')} value={row.created_by_name ?? '—'} />
              <DetailRow label={t('meta_created_at')} value={fmtDate(row.created_at)} />
              <DetailRow label={t('meta_modified_by')} value={row.modified_by_name ?? '—'} />
              <DetailRow label={t('meta_modified_at')} value={fmtDateTime(row.modified_at)} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Inline new row ───────────────────────────────────────────────────────────

  function renderInlineNewRow() {
    if (!inlineNew) return null;
    return (
      <div style={cardStyle}>
        <div style={{ padding: '14px 20px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px', gap: 12, marginBottom: 10 }}>
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
              <label style={inlineLabelStyle}>{t('label_duration')} *</label>
              <input type="number" min="1" step="1" value={inlineNew.duration_minutes} onChange={(e) => setInlineNew({ ...inlineNew, duration_minutes: e.target.value })} style={inlineInputStyle} />
            </div>
            <div>
              <label style={inlineLabelStyle}>{t('label_capacity')} *</label>
              <input type="number" min="1" step="1" value={inlineNew.max_capacity} onChange={(e) => setInlineNew({ ...inlineNew, max_capacity: e.target.value })} style={inlineInputStyle} />
            </div>
          </div>
          {inlineNew.error && <p style={errorStyle}>{inlineNew.error}</p>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setInlineNew(null)} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={saveInlineNew} disabled={inlineNew.saving} style={btnSmall('#6c63ff')}>
              {inlineNew.saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (gymLoading || !isAdmin) return null;

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter} options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))} allLabel={tStatus('all')} />
          <button onClick={openInlineNew} style={btnStyle('#6c63ff')} disabled={inlineNew !== null}>{t('add')}</button>
        </div>
      </div>

      {/* Column headers */}
      {(rows.length > 0 || inlineNew) && (
        <div style={colHeaderStyle}>
          <div style={{ flex: 2 }}>{t('col_name')}</div>
          <div style={{ flex: 3 }}>{t('label_description')}</div>
          <div style={{ minWidth: 110 }}>Duration / Cap.</div>
          <div style={{ minWidth: 120 }}>{t('col_default_center')}</div>
          <div style={{ minWidth: 90 }}>{t('col_status')}</div>
          <div style={{ minWidth: 68 }} />
        </div>
      )}

      {/* Inline new row */}
      {renderInlineNewRow()}

      {/* List */}
      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : rows.length === 0 && !inlineNew ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(renderRow)}
        </div>
      )}

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={details?.name ?? ''}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('cancel')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={detailSectionLabelStyle}>{t('section_general')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <ModalDetail label={t('label_duration')} value={`${details.duration_minutes} min`} />
              <ModalDetail label={t('label_capacity')} value={String(details.max_capacity)} />
              <ModalDetail label={t('label_intensity')} value={details.intensity_level ? String(details.intensity_level) : '—'} />
              <ModalDetail label={t('label_status')} value={tStatus(details.status)} />
              <ModalDetail label={t('label_default_center')} value={details.default_center_name ?? '—'} />
              <ModalDetail label={t('label_default_space')} value={details.default_space_name ?? '—'} />
              <ModalDetail label={t('label_default_trainer')} value={details.default_trainer_name ?? '—'} />
            </div>
            {details.description && (
              <>
                <div style={detailSectionLabelStyle}>{t('label_description')}</div>
                <p style={{ margin: 0, fontSize: 14, whiteSpace: 'pre-wrap', color: '#333' }}>{details.description}</p>
              </>
            )}
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_schedule')}</div>
            {(rulesMap.get(details.id) ?? []).length === 0 ? (
              <p style={{ margin: 0, fontSize: 13, color: '#aaa', fontStyle: 'italic' }}>{ts('no_rules')}</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: '#333' }}>
                {(rulesMap.get(details.id) ?? []).map((r) => <li key={r.id}>{ruleLabel(r)}</li>)}
              </ul>
            )}
            <hr style={{ margin: '4px 0', borderColor: '#eee' }} />
            <div style={detailSectionLabelStyle}>{t('section_metadata')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <ModalDetail label={t('meta_created_by')} value={details.created_by_name ?? '—'} />
              <ModalDetail label={t('meta_created_at')} value={fmtDate(details.created_at)} />
              <ModalDetail label={t('meta_modified_by')} value={details.modified_by_name ?? '—'} />
              <ModalDetail label={t('meta_modified_at')} value={fmtDateTime(details.modified_at)} />
            </div>
          </div>
        )}
      </CrudModal>

      {/* Delete confirm */}
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

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div style={{ borderBottom: '1px solid var(--gd-border, #eee)', margin: '16px 0 8px', paddingBottom: 4 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
      <span style={{ width: 160, flexShrink: 0, color: '#666' }}>{label}</span>
      <span style={{ color: '#111', flex: 1 }}>{value}</span>
    </div>
  );
}

function ModalDetail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={detailLabelStyle}>{label}</span>
      <p style={{ margin: '2px 0 0', fontSize: 14 }}>{value}</p>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  border: '1px solid #e2e2e6', borderRadius: 10, overflow: 'hidden', background: 'var(--gd-card-bg, #ffffff)',
};

const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  display: 'flex', padding: '6px 16px', gap: 10,
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

const inlineSelectStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, boxSizing: 'border-box', background: '#fff',
};

const detailLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
};

const detailSectionLabelStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em',
};

const errorStyle: React.CSSProperties = {
  margin: '8px 0 0', fontSize: 13, color: '#c0392b',
};
