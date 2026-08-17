'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnSmall, btnStyle } from '@/components/ui';
import { PromotionDetailModal } from './PromotionDetailModal';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Promo {
  id: number;
  name: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  stackable: number;
  lifecycle_status: 'active' | 'inactive';
  created_at: string;
  created_by_name: string | null;
  free_months: number | null;
  paid_months: number | null;
  bonus_months: number | null;
}

interface MembershipPlan { id: number; name: string }
interface GymCharge { id: number; charge_type_name: string; charge_type_code: string; amount: string | null; availability: string }
interface ChargeBenefit { id: number; gym_charge_id: number; action: string; value: string | null; gym_charge_name: string; gym_charge_availability: string }
interface ChargeType { id: number; code: string; name: string; is_gym_charge: number }
interface PeriodBenefit {
  id: number;
  charge_type_id: number;
  charge_type_code: string;
  charge_type_name: string;
  quantity: number;
  frequency_interval: number;
  frequency_unit: 'week' | 'month';
  duration_months: number | null;
  enabled: number;
}
interface IncludedBenefit {
  id: number;
  charge_type_id: number;
  charge_type_code: string;
  charge_type_name: string;
  quantity: number;
}

const LIFECYCLE_STATUSES = ['active', 'inactive'] as const;
const CHARGE_ACTIONS = ['no_benefit', 'waive', 'percentage_discount', 'fixed_discount', 'fixed_price'] as const;
const FREQ_UNITS = ['week', 'month'] as const;
const NEW_ID = 0;

const iso = (v: string) => (v ? v.slice(0, 10) : '');
const truncate = (s: string | null, n = 60) =>
  s ? (s.length > n ? s.slice(0, n) + '…' : s) : '—';

// Build a locale date string like "1 Aug 2026"
function fmtDate(d: Date, locale: string) {
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Add N calendar months to a date
function addMonths(d: Date, n: number): Date {
  const result = new Date(d);
  result.setMonth(result.getMonth() + n);
  return result;
}

function subtractDay(d: Date): Date {
  const result = new Date(d);
  result.setDate(result.getDate() - 1);
  return result;
}

function emptyEditForm(promo?: Promo) {
  return {
    name: promo?.name ?? '',
    description: promo?.description ?? '',
    starts_at: promo ? iso(promo.starts_at) : '',
    ends_at: promo ? iso(promo.ends_at) : '',
    stackable: promo ? !!promo.stackable : false,
    lifecycle_status: (promo?.lifecycle_status ?? 'active') as 'active' | 'inactive',
    free_months: promo?.free_months != null ? String(promo.free_months) : '',
    paid_months: promo?.paid_months != null ? String(promo.paid_months) : '',
    bonus_months: promo?.bonus_months != null ? String(promo.bonus_months) : '',
  };
}
type EditForm = ReturnType<typeof emptyEditForm>;

// ─── Component ────────────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const t = useTranslations('promotions');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<Promo[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasNewRow, setHasNewRow] = useState(false);

  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [gymCharges, setGymCharges] = useState<GymCharge[]>([]);
  const [chargeTypes, setChargeTypes] = useState<ChargeType[]>([]);

  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const [cachedPlans, setCachedPlans] = useState<Record<number, number[]>>({});
  const [cachedCb, setCachedCb] = useState<Record<number, ChargeBenefit[]>>({});
  const [cachedPb, setCachedPb] = useState<Record<number, PeriodBenefit[]>>({});
  const [cachedIb, setCachedIb] = useState<Record<number, IncludedBenefit[]>>({});

  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [plansDraft, setPlansDraft] = useState<number[]>([]);
  const [cbDraft, setCbDraft] = useState<Record<number, { action: string; value: string }>>({});
  const [pbDraft, setPbDraft] = useState<PeriodBenefit[]>([]);
  const [ibDraft, setIbDraft] = useState<IncludedBenefit[]>([]);

  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [detailFor, setDetailFor] = useState<Promo | null>(null);
  const [deleting, setDeleting] = useState<Promo | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';

  // Sellable items = charge types that are not gym charges
  const sellableItems = chargeTypes.filter((c) => !c.is_gym_charge);

  useEffect(() => {
    if (!gymLoading && !isAdmin) router.replace(`/${locale}`);
  }, [gymLoading, isAdmin]);

  useEffect(() => {
    if (!gymLoading && isAdmin) loadLookups();
  }, [gymLoading, isAdmin, activeGymId]);

  useEffect(() => {
    if (!gymLoading && isAdmin) load();
  }, [activeGymId, gymLoading, statusFilter, search]);

  async function loadLookups() {
    try {
      const [pl, gc, ct] = await Promise.all([
        apiFetch<MembershipPlan[]>('/membership-plans?lifecycle_status=active'),
        apiFetch<GymCharge[]>('/gym-charges?availability=available'),
        apiFetch<ChargeType[]>('/charge-types'),
      ]);
      setPlans(pl);
      setGymCharges(gc);
      setChargeTypes(ct);
    } catch { /* non-critical */ }
  }

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('lifecycle_status', statusFilter);
      if (search) params.set('q', search);
      const qs = params.toString();
      setRows(await apiFetch<Promo[]>(`/promotions${qs ? `?${qs}` : ''}`));
    } catch (err: any) {
      setRows([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  async function loadSubResources(promoId: number) {
    try {
      const [ap, cb, pb, ib] = await Promise.all([
        apiFetch<{ id: number }[]>(`/promotions/${promoId}/plans`),
        apiFetch<ChargeBenefit[]>(`/promotions/${promoId}/charge-benefits`),
        apiFetch<PeriodBenefit[]>(`/promotions/${promoId}/period-benefits`),
        apiFetch<IncludedBenefit[]>(`/promotions/${promoId}/included-benefits`),
      ]);
      setCachedPlans((prev) => ({ ...prev, [promoId]: ap.map((p) => p.id) }));
      setCachedCb((prev) => ({ ...prev, [promoId]: cb }));
      setCachedPb((prev) => ({ ...prev, [promoId]: pb }));
      setCachedIb((prev) => ({ ...prev, [promoId]: ib }));
      return { ap: ap.map((p) => p.id), cb, pb, ib };
    } catch {
      return { ap: [], cb: [], pb: [], ib: [] };
    }
  }

  // ─── Expand / Edit ──────────────────────────────────────────────────────────

  function toggleExpand(id: number) {
    if (editingId === id) return;
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      if (id !== NEW_ID) loadSubResources(id);
    }
  }

  async function enterEdit(promo: Promo) {
    setExpandedId(promo.id);
    setEditingId(promo.id);
    setEditForm(emptyEditForm(promo));
    setEditError(null);
    const { ap, cb, pb, ib } = await loadSubResources(promo.id);
    setPlansDraft(ap);
    const cbMap: Record<number, { action: string; value: string }> = {};
    for (const c of cb) cbMap[c.gym_charge_id] = { action: c.action, value: c.value ?? '' };
    setCbDraft(cbMap);
    setPbDraft(pb.map((p) => ({ ...p })));
    setIbDraft(ib.map((i) => ({ ...i })));
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  function cancelEdit() {
    if (editingId === NEW_ID) setHasNewRow(false);
    setEditingId(null);
    setExpandedId(null);
    setEditError(null);
  }

  // ─── New Promotion (temp row) ────────────────────────────────────────────────

  function handleNew() {
    if (hasNewRow) return;
    setHasNewRow(true);
    setExpandedId(NEW_ID);
    setEditingId(NEW_ID);
    setEditForm(emptyEditForm());
    setPlansDraft([]);
    setCbDraft({});
    setPbDraft([]);
    setIbDraft([]);
    setEditError(null);
    setTimeout(() => nameInputRef.current?.focus(), 60);
  }

  // ─── Save ────────────────────────────────────────────────────────────────────

  async function handleSave(promoId: number) {
    if (!editForm.name.trim() || !editForm.starts_at || !editForm.ends_at) {
      setEditError(t('error_required'));
      return;
    }
    if (new Date(editForm.starts_at) > new Date(editForm.ends_at)) {
      setEditError(t('error_dates'));
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      const body = {
        name: editForm.name.trim(),
        description: editForm.description.trim() || null,
        starts_at: editForm.starts_at,
        ends_at: editForm.ends_at,
        stackable: editForm.stackable,
        lifecycle_status: editForm.lifecycle_status,
        free_months: editForm.free_months !== '' ? parseInt(editForm.free_months, 10) : null,
        paid_months: editForm.paid_months !== '' ? parseInt(editForm.paid_months, 10) : null,
        bonus_months: editForm.bonus_months !== '' ? parseInt(editForm.bonus_months, 10) : null,
      };

      let id = promoId;
      if (promoId === NEW_ID) {
        const created = await apiFetch<Promo>('/promotions', { method: 'POST', body: JSON.stringify(body) });
        id = created.id;
        setHasNewRow(false);
      } else {
        await apiFetch(`/promotions/${id}`, { method: 'PUT', body: JSON.stringify(body) });
      }

      await apiFetch(`/promotions/${id}/plans`, {
        method: 'PUT',
        body: JSON.stringify({ membership_plan_ids: plansDraft }),
      });

      const cbItems = gymCharges
        .filter((gc) => cbDraft[gc.id]?.action && cbDraft[gc.id].action !== 'no_benefit')
        .map((gc) => ({
          gym_charge_id: gc.id,
          action: cbDraft[gc.id].action,
          value: ['percentage_discount', 'fixed_discount', 'fixed_price'].includes(cbDraft[gc.id].action)
            ? parseFloat(cbDraft[gc.id].value) || 0 : null,
        }));
      await apiFetch(`/promotions/${id}/charge-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items: cbItems }),
      });

      const pbItems = pbDraft.map((pb) => ({
        charge_type_id: pb.charge_type_id,
        quantity: pb.quantity,
        frequency_interval: pb.frequency_interval,
        frequency_unit: pb.frequency_unit,
        duration_months: pb.duration_months ?? null,
        enabled: pb.enabled,
      }));
      await apiFetch(`/promotions/${id}/period-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items: pbItems }),
      });

      const ibItems = ibDraft.map((ib) => ({
        charge_type_id: ib.charge_type_id,
        quantity: ib.quantity,
      }));
      await apiFetch(`/promotions/${id}/included-benefits`, {
        method: 'PUT',
        body: JSON.stringify({ items: ibItems }),
      });

      setEditingId(null);
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ───────────────────────────────────────────────────────────────

  async function handleDuplicate(promo: Promo) {
    try {
      const dup = await apiFetch<Promo>(`/promotions/${promo.id}/duplicate`, { method: 'POST' });
      await load();
      enterEdit(dup);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ──────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/promotions/${deleting.id}`, { method: 'DELETE' });
      if (expandedId === deleting.id) { setExpandedId(null); setEditingId(null); }
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Period benefit draft helpers ─────────────────────────────────────────

  function addPbRow() {
    const firstCt = sellableItems[0];
    if (!firstCt) return;
    setPbDraft((prev) => [
      ...prev,
      { id: -(Date.now()), charge_type_id: firstCt.id, charge_type_code: firstCt.code, charge_type_name: firstCt.name, quantity: 1, frequency_interval: 1, frequency_unit: 'month', duration_months: null, enabled: 1 },
    ]);
  }

  function updatePbRow(idx: number, patch: Partial<PeriodBenefit>) {
    setPbDraft((prev) => prev.map((r, i) => {
      if (i !== idx) return r;
      const next = { ...r, ...patch };
      if (patch.charge_type_id != null) {
        const ct = sellableItems.find((c) => c.id === patch.charge_type_id);
        if (ct) { next.charge_type_code = ct.code; next.charge_type_name = ct.name; }
      }
      return next;
    }));
  }

  // ─── Included benefit draft helpers ───────────────────────────────────────

  function addIbRow() {
    const firstCt = sellableItems[0];
    if (!firstCt) return;
    setIbDraft((prev) => [
      ...prev,
      { id: -(Date.now()), charge_type_id: firstCt.id, charge_type_code: firstCt.code, charge_type_name: firstCt.name, quantity: 1 },
    ]);
  }

  function updateIbRow(idx: number, patch: Partial<IncludedBenefit>) {
    setIbDraft((prev) => prev.map((r, i) => {
      if (i !== idx) return r;
      const next = { ...r, ...patch };
      if (patch.charge_type_id != null) {
        const ct = sellableItems.find((c) => c.id === patch.charge_type_id);
        if (ct) { next.charge_type_code = ct.code; next.charge_type_name = ct.name; }
      }
      return next;
    }));
  }

  // ─── Search debounce ──────────────────────────────────────────────────────

  function handleSearchChange(val: string) {
    setSearchInput(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(val), 300);
  }

  if (gymLoading || !isAdmin) return null;

  // ─── Timeline preview ─────────────────────────────────────────────────────

  function renderTimeline(fm: EditForm) {
    const free = parseInt(fm.free_months, 10) || 0;
    const paid = parseInt(fm.paid_months, 10) || 0;
    const bonus = parseInt(fm.bonus_months, 10) || 0;
    if (free === 0 && paid === 0 && bonus === 0) return null;

    // Hypothetical enrollment = first of current month
    const now = new Date();
    const enrollment = new Date(now.getFullYear(), now.getMonth(), 1);
    const enrollmentStr = fmtDate(enrollment, locale);

    type Row = { period: number; from: Date; to: Date | null; status: string; billing: string };
    const timelineRows: Row[] = [];
    let cursor = new Date(enrollment);
    let period = 1;

    for (let i = 0; i < free; i++) {
      const from = new Date(cursor);
      const next = addMonths(cursor, 1);
      timelineRows.push({ period, from, to: subtractDay(next), status: t('timeline_free'), billing: t('timeline_no_charge') });
      cursor = next;
      period++;
    }
    for (let i = 0; i < paid; i++) {
      const from = new Date(cursor);
      const next = addMonths(cursor, 1);
      timelineRows.push({ period, from, to: subtractDay(next), status: t('timeline_paid_promo'), billing: t('timeline_promo_price') });
      cursor = next;
      period++;
    }
    for (let i = 0; i < bonus; i++) {
      const from = new Date(cursor);
      const next = addMonths(cursor, 1);
      timelineRows.push({ period, from, to: subtractDay(next), status: t('timeline_bonus'), billing: t('timeline_no_charge') });
      cursor = next;
      period++;
    }
    // Regular pricing row
    timelineRows.push({ period, from: cursor, to: null, status: t('timeline_paid_regular'), billing: t('timeline_regular_price') });

    return (
      <div style={subSectionSt}>
        <p style={sectionLabelSt}>{t('section_timeline')}</p>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#666' }}>{t('timeline_example_note', { date: enrollmentStr })}</p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                <th style={thSt}>{t('col_period')}</th>
                <th style={thSt}>{t('col_dates')}</th>
                <th style={thSt}>Status</th>
                <th style={thSt}>{t('col_billing')}</th>
              </tr>
            </thead>
            <tbody>
              {timelineRows.map((row, idx) => {
                const isFree = row.status === t('timeline_free') || row.status === t('timeline_bonus');
                const isRegular = row.status === t('timeline_paid_regular');
                const bg = isFree ? '#f0fdf4' : isRegular ? '#f9fafb' : '#fefce8';
                return (
                  <tr key={idx} style={{ background: bg }}>
                    <td style={tdSt}>{row.to ? row.period : `${row.period}+`}</td>
                    <td style={tdSt}>
                      {row.to
                        ? `${fmtDate(row.from, locale)} – ${fmtDate(row.to, locale)}`
                        : `From ${fmtDate(row.from, locale)}`}
                    </td>
                    <td style={{ ...tdSt, fontWeight: 500 }}>{row.status}</td>
                    <td style={{ ...tdSt, color: isFree ? '#166534' : isRegular ? '#666' : '#854d0e' }}>{row.billing}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#aaa', fontStyle: 'italic' }}>{t('timeline_disclaimer')}</p>
      </div>
    );
  }

  // ─── Render helpers ──────────────────────────────────────────────────────────

  function renderEditSection(promoId: number) {
    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>

        {/* General */}
        <p style={sectionLabelSt}>{t('section_general')}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={inlineLabelSt}>{t('label_name')} *</label>
            <input
              ref={nameInputRef}
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              style={inlineInputSt}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={inlineLabelSt}>{t('label_description')}</label>
            <input
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              style={inlineInputSt}
            />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_starts')} * <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(Promotion Availability)</span></label>
            <input type="date" value={editForm.starts_at} onChange={(e) => setEditForm({ ...editForm, starts_at: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_ends')} * <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(Promotion Availability)</span></label>
            <input type="date" value={editForm.ends_at} onChange={(e) => setEditForm({ ...editForm, ends_at: e.target.value })} style={inlineInputSt} />
          </div>
          <div>
            <label style={inlineLabelSt}>{t('label_lifecycle_status')}</label>
            <select value={editForm.lifecycle_status} onChange={(e) => setEditForm({ ...editForm, lifecycle_status: e.target.value as 'active' | 'inactive' })} style={inlineSelectSt}>
              {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{tStatus(s)}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 12 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={editForm.stackable} onChange={(e) => setEditForm({ ...editForm, stackable: e.target.checked })} />
              {t('label_stackable')}
            </label>
          </div>
        </div>

        {editError && <p style={{ margin: '0 0 8px', fontSize: 13, color: '#c0392b' }}>{editError}</p>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginBottom: 4 }}>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSave(promoId)} disabled={editSaving} style={btnSmall('#6c63ff')}>
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>

        {/* Applicable Plans */}
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_applicable_plans')}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {plans.map((p) => (
              <label key={p.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={plansDraft.includes(p.id)}
                  onChange={(e) => setPlansDraft((prev) => e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id))}
                />
                {p.name}
              </label>
            ))}
            {plans.length === 0 && <p style={hintSt}>{t('no_applicable_plans')}</p>}
          </div>
        </div>

        {/* Billing & Duration */}
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_billing_duration')}</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0 16px' }}>
            <div>
              <label style={inlineLabelSt}>{t('label_free_months')}</label>
              <input type="number" min="0" value={editForm.free_months} onChange={(e) => setEditForm({ ...editForm, free_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_paid_months')}</label>
              <input type="number" min="0" value={editForm.paid_months} onChange={(e) => setEditForm({ ...editForm, paid_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
            <div>
              <label style={inlineLabelSt}>{t('label_bonus_months')}</label>
              <input type="number" min="0" value={editForm.bonus_months} onChange={(e) => setEditForm({ ...editForm, bonus_months: e.target.value })} style={inlineInputSt} placeholder="0" />
            </div>
          </div>
          {renderTimeline(editForm)}
        </div>

        {/* Charge Benefits */}
        {gymCharges.length > 0 && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('section_charge_benefits')}</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '3px 12px', alignItems: 'center', marginBottom: 4 }}>
              <span style={colHeaderSt}>{t('col_charge')}</span>
              <span style={colHeaderSt}>{t('col_action')}</span>
              <span />
              {gymCharges.map((gc) => (
                <div key={gc.id} style={{ display: 'contents' }}>
                  <span style={{ fontSize: 13 }}>{gc.charge_type_name}</span>
                  <select
                    value={cbDraft[gc.id]?.action ?? 'no_benefit'}
                    onChange={(e) => setCbDraft((prev) => ({ ...prev, [gc.id]: { ...prev[gc.id] ?? { value: '' }, action: e.target.value } }))}
                    style={inlineSelectSt}
                  >
                    {CHARGE_ACTIONS.map((a) => (
                      <option key={a} value={a}>{t(`cb_action_${a}` as any)}</option>
                    ))}
                  </select>
                  {['percentage_discount', 'fixed_discount', 'fixed_price'].includes(cbDraft[gc.id]?.action ?? '') ? (
                    <input
                      type="number" min="0" step="0.01"
                      value={cbDraft[gc.id]?.value ?? ''}
                      onChange={(e) => setCbDraft((prev) => ({ ...prev, [gc.id]: { ...prev[gc.id], value: e.target.value } }))}
                      placeholder="0"
                      style={{ width: 70, padding: '6px 8px', borderRadius: 4, border: '1px solid #ccc', fontSize: 12 }}
                    />
                  ) : <span />}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Included Benefits */}
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_included_benefits')}</p>
          {ibDraft.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 28px', gap: '3px 8px', alignItems: 'center', marginBottom: 8 }}>
              <span style={colHeaderSt}>{t('col_sellable_item')}</span>
              <span style={colHeaderSt}>{t('col_quantity')}</span>
              <span />
              {ibDraft.map((ib, idx) => (
                <div key={ib.id} style={{ display: 'contents' }}>
                  <select
                    value={ib.charge_type_id}
                    onChange={(e) => updateIbRow(idx, { charge_type_id: parseInt(e.target.value, 10) })}
                    style={inlineSelectSt}
                  >
                    {sellableItems.map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                  </select>
                  <input type="number" min="1" value={ib.quantity} onChange={(e) => updateIbRow(idx, { quantity: parseInt(e.target.value, 10) || 1 })} style={{ ...inlineSelectSt, width: '100%' }} />
                  <button onClick={() => setIbDraft((prev) => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', fontSize: 14, padding: 0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          {sellableItems.length > 0 && (
            <button onClick={addIbRow} style={btnSmall('#6c63ff')}>{t('add_included_benefit')}</button>
          )}
        </div>

        {/* Period Benefits */}
        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_period_benefits')}</p>
          {pbDraft.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 70px 70px 90px 80px 60px 28px', gap: '3px 8px', alignItems: 'center', marginBottom: 8 }}>
              <span style={colHeaderSt}>{t('col_benefit_type')}</span>
              <span style={colHeaderSt}>{t('col_quantity')}</span>
              <span style={colHeaderSt}>{t('label_frequency_interval')}</span>
              <span style={colHeaderSt}>{t('label_frequency_unit')}</span>
              <span style={colHeaderSt}>{t('col_duration_months')}</span>
              <span style={colHeaderSt}>{t('col_enabled')}</span>
              <span />
              {pbDraft.map((pb, idx) => (
                <div key={pb.id} style={{ display: 'contents' }}>
                  <select
                    value={pb.charge_type_id}
                    onChange={(e) => updatePbRow(idx, { charge_type_id: parseInt(e.target.value, 10) })}
                    style={inlineSelectSt}
                  >
                    {sellableItems.map((ct) => <option key={ct.id} value={ct.id}>{ct.name}</option>)}
                  </select>
                  <input type="number" min="1" value={pb.quantity} onChange={(e) => updatePbRow(idx, { quantity: parseInt(e.target.value, 10) || 1 })} style={{ ...inlineSelectSt, width: '100%' }} />
                  <input type="number" min="1" value={pb.frequency_interval} onChange={(e) => updatePbRow(idx, { frequency_interval: parseInt(e.target.value, 10) || 1 })} style={{ ...inlineSelectSt, width: '100%' }} />
                  <select value={pb.frequency_unit} onChange={(e) => updatePbRow(idx, { frequency_unit: e.target.value as 'week' | 'month' })} style={inlineSelectSt}>
                    {FREQ_UNITS.map((u) => <option key={u} value={u}>{t(`frequency_${u}` as any)}</option>)}
                  </select>
                  <input
                    type="number" min="1"
                    value={pb.duration_months ?? ''}
                    onChange={(e) => updatePbRow(idx, { duration_months: e.target.value ? parseInt(e.target.value, 10) : null })}
                    placeholder="—"
                    style={{ ...inlineSelectSt, width: '100%' }}
                  />
                  <label style={{ display: 'flex', justifyContent: 'center' }}>
                    <input type="checkbox" checked={!!pb.enabled} onChange={(e) => updatePbRow(idx, { enabled: e.target.checked ? 1 : 0 })} />
                  </label>
                  <button onClick={() => setPbDraft((prev) => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#c0392b', fontSize: 14, padding: 0 }}>✕</button>
                </div>
              ))}
            </div>
          )}
          {sellableItems.length > 0 && (
            <button onClick={addPbRow} style={btnSmall('#6c63ff')}>{t('add_period_benefit')}</button>
          )}
        </div>

      </div>
    );
  }

  function renderViewSection(promo: Promo) {
    const ap = cachedPlans[promo.id] ?? [];
    const cb = cachedCb[promo.id] ?? [];
    const pb = cachedPb[promo.id] ?? [];
    const ib = cachedIb[promo.id] ?? [];

    const free = promo.free_months ?? 0;
    const paid = promo.paid_months ?? 0;
    const bonus = promo.bonus_months ?? 0;

    return (
      <div style={{ padding: '16px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>

        {/* Billing & Duration summary */}
        {(free > 0 || paid > 0 || bonus > 0) && (
          <div style={subSectionSt}>
            <p style={sectionLabelSt}>{t('section_billing_duration')}</p>
            <div style={{ display: 'flex', gap: 24, fontSize: 13, flexWrap: 'wrap' }}>
              {free > 0 && <span><strong>{t('label_free_months')}:</strong> {free}</span>}
              {paid > 0 && <span><strong>{t('label_paid_months')}:</strong> {paid}</span>}
              {bonus > 0 && <span><strong>{t('label_bonus_months')}:</strong> {bonus}</span>}
            </div>
          </div>
        )}

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_applicable_plans')}</p>
          {ap.length === 0
            ? <p style={hintSt}>{t('no_applicable_plans')}</p>
            : ap.map((id) => {
                const p = plans.find((pl) => pl.id === id);
                return <p key={id} style={{ margin: '2px 0', fontSize: 13 }}>{p?.name ?? `#${id}`}</p>;
              })}
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_charge_benefits')}</p>
          {cb.filter((c) => c.action !== 'no_benefit').length === 0
            ? <p style={hintSt}>{t('no_charge_benefits')}</p>
            : cb.filter((c) => c.action !== 'no_benefit').map((c) => (
                <div key={c.id} style={{ display: 'flex', gap: 16, fontSize: 13, padding: '3px 0' }}>
                  <span style={{ minWidth: 160, color: '#555' }}>
                    {c.gym_charge_name}
                    {c.gym_charge_availability === 'unavailable' && (
                      <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: '#c0392b', background: '#fdecea', padding: '1px 5px', borderRadius: 3 }}>Unavailable</span>
                    )}
                  </span>
                  <span>{t(`cb_action_${c.action}` as any)}{c.value != null ? ` — ${c.value}` : ''}</span>
                </div>
              ))}
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_included_benefits')}</p>
          {ib.length === 0
            ? <p style={hintSt}>{t('no_included_benefits')}</p>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thSt}>{t('col_sellable_item')}</th>
                    <th style={thSt}>{t('col_quantity')}</th>
                  </tr>
                </thead>
                <tbody>
                  {ib.map((i) => (
                    <tr key={i.id}>
                      <td style={tdSt}>{i.charge_type_name}</td>
                      <td style={tdSt}>{i.quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

        <div style={subSectionSt}>
          <p style={sectionLabelSt}>{t('section_period_benefits')}</p>
          {pb.length === 0
            ? <p style={hintSt}>{t('no_period_benefits')}</p>
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={thSt}>{t('col_benefit_type')}</th>
                    <th style={thSt}>{t('col_quantity')}</th>
                    <th style={thSt}>{t('col_frequency')}</th>
                    <th style={thSt}>{t('col_duration_months')}</th>
                  </tr>
                </thead>
                <tbody>
                  {pb.map((p) => (
                    <tr key={p.id} style={{ opacity: p.enabled ? 1 : 0.45 }}>
                      <td style={tdSt}>{p.charge_type_name}</td>
                      <td style={tdSt}>{p.quantity}</td>
                      <td style={tdSt}>{p.frequency_interval} {t(`frequency_${p.frequency_unit}` as any)}</td>
                      <td style={tdSt}>{p.duration_months ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>

      </div>
    );
  }

  function renderRow(promo: Promo) {
    const isEditing = editingId === promo.id;
    const isExpanded = isEditing || expandedId === promo.id;

    const menuItems: ContextMenuItem[] = [
      { label: t('details'), onClick: () => setDetailFor(promo) },
      { label: t('edit'), onClick: () => enterEdit(promo) },
      { label: t('duplicate'), onClick: () => handleDuplicate(promo) },
      { label: t('delete'), onClick: () => setDeleting(promo), danger: true },
    ];

    return (
      <div key={promo.id} style={cardSt}>
        <div style={rowSt} onClick={() => toggleExpand(promo.id)}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {promo.name}
          </div>
          <div style={{ flex: 3, fontSize: 13, color: '#666', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {truncate(promo.description)}
          </div>
          <div style={{ minWidth: 120, flexShrink: 0, fontSize: 13, color: '#555', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {promo.created_by_name ?? '—'}
          </div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>{iso(promo.created_at)}</div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>{iso(promo.starts_at)}</div>
          <div style={{ minWidth: 90, flexShrink: 0, fontSize: 13, color: '#888' }}>{iso(promo.ends_at)}</div>
          <div style={{ minWidth: 80, flexShrink: 0 }}>
            <StatusBadge status={promo.lifecycle_status} label={tStatus(promo.lifecycle_status)} />
          </div>
          <span style={{ fontSize: 13, color: '#aaa', flexShrink: 0, display: 'inline-block', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <ContextMenu items={menuItems} />
          </div>
        </div>
        {isEditing ? renderEditSection(promo.id) : isExpanded ? renderViewSection(promo) : null}
      </div>
    );
  }

  function renderNewRow() {
    return (
      <div key="new" style={{ ...cardSt, borderColor: '#6c63ff' }}>
        <div style={rowSt}>
          <div style={{ flex: 2, fontWeight: 600, fontSize: 15, color: '#6c63ff' }}>{t('add')}</div>
          <div style={{ flex: 3 }} />
          <div style={{ minWidth: 120, flexShrink: 0 }} />
          <div style={{ minWidth: 90, flexShrink: 0 }} />
          <div style={{ minWidth: 90, flexShrink: 0 }} />
          <div style={{ minWidth: 90, flexShrink: 0 }} />
          <div style={{ minWidth: 80, flexShrink: 0 }} />
          <span style={{ minWidth: 13, flexShrink: 0 }}>▾</span>
          <div style={{ minWidth: 32, flexShrink: 0 }} />
        </div>
        {renderEditSection(NEW_ID)}
      </div>
    );
  }

  function renderHeader() {
    return (
      <div style={{ display: 'flex', padding: '6px 20px', marginBottom: 4, color: '#999', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', gap: 12 }}>
        <span style={{ flex: 2 }}>{t('col_name')}</span>
        <span style={{ flex: 3 }}>{t('col_description')}</span>
        <span style={{ minWidth: 120, flexShrink: 0 }}>{t('col_created_by')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_created_at')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_starts')}</span>
        <span style={{ minWidth: 90, flexShrink: 0 }}>{t('col_ends')}</span>
        <span style={{ minWidth: 80, flexShrink: 0 }}>{t('col_status')}</span>
        <span style={{ minWidth: 13, flexShrink: 0 }} />
        <span style={{ minWidth: 32, flexShrink: 0 }} />
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder={t('search_placeholder')}
            style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, width: 260 }}
          />
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={LIFECYCLE_STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={handleNew} style={btnStyle('#6c63ff')} disabled={hasNewRow}>{t('add')}</button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : (
        <>
          {(rows.length > 0 || hasNewRow) && renderHeader()}
          {hasNewRow && renderNewRow()}
          {rows.length === 0 && !hasNewRow && <p style={{ color: '#888' }}>{t('empty')}</p>}
          {rows.map(renderRow)}
        </>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      {detailFor && (
        <PromotionDetailModal
          promotionId={detailFor.id}
          promotionName={detailFor.name}
          onClose={() => setDetailFor(null)}
        />
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const cardSt: React.CSSProperties = { border: '1px solid var(--gd-border, #e2e2e6)', borderRadius: 8, marginBottom: 8, overflow: 'hidden', background: 'var(--gd-surface, #fff)' };
const rowSt: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '12px 20px', gap: 12, cursor: 'pointer' };
const inlineLabelSt: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' };
const inlineInputSt: React.CSSProperties = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', marginBottom: 12 };
const inlineSelectSt: React.CSSProperties = { width: '100%', padding: '7px 10px', borderRadius: 6, border: '1px solid #ccc', fontSize: 13, boxSizing: 'border-box', background: '#fff', marginBottom: 8 };
const subSectionSt: React.CSSProperties = { paddingTop: 16, marginTop: 16, borderTop: '1px solid var(--gd-border, #eee)' };
const sectionLabelSt: React.CSSProperties = { margin: '0 0 10px', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' };
const hintSt: React.CSSProperties = { color: '#aaa', fontSize: 13, margin: 0 };
const colHeaderSt: React.CSSProperties = { fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em', paddingBottom: 2 };
const thSt: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', color: '#888', fontWeight: 600, borderBottom: '1px solid #eee', fontSize: 12 };
const tdSt: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f5f5f5', fontSize: 13 };
