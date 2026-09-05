'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { canWriteModule } from '@/config/permissions';

// ─── Types ────────────────────────────────────────────────────────────────────

type EntityType =
  | 'member'
  | 'membership_plan'
  | 'promotion'
  | 'center'
  | 'space'
  | 'class_package'
  | 'exercise'
  | 'workout_template'
  | 'training_plan_template'
  | 'nutrition_plan_template'
  | 'theme';

const ENTITY_TYPES: EntityType[] = [
  'member',
  'membership_plan',
  'promotion',
  'center',
  'space',
  'class_package',
  'exercise',
  'workout_template',
  'training_plan_template',
  'nutrition_plan_template',
  'theme',
];

interface RecycleBinItem {
  entity_type: EntityType;
  id: number;
  name: string;
  description: string | null;
  created_at: string;
  created_by_name: string | null;
  deleted_by_name: string | null;
  deleted_at: string;
}

interface RecycleBinList {
  items: RecycleBinItem[];
  total: number;
  limit: number;
  offset: number;
}

interface EntityDetail extends Record<string, unknown> {
  id: number;
  name: string;
  description?: string | null;
  status?: string | null;
  lifecycle_status?: string | null;
  enrollment_status?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  stackable?: boolean | number | null;
  capacity?: number | null;
  notes?: string | null;
  opening_time?: string | null;
  closing_time?: string | null;
  number_of_sessions?: number | null;
  price?: string | null;
  validity_days?: number | null;
  phone?: string | null;
  email?: string | null;
  address_line_1?: string | null;
  address_line_2?: string | null;
  city?: string | null;
  country?: string | null;
  video_url?: string | null;
  image_url?: string | null;
  created_at: string;
  created_by_name?: string | null;
  modified_at?: string | null;
  modified_by_name?: string | null;
  deleted_at: string;
  deleted_by_name?: string | null;
}

type SortKey = 'entity_type' | 'name' | 'deleted_at';
const LIMIT = 25;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RecycleBinPage() {
  const t = useTranslations('recycle_bin');
  const tStatus = useTranslations('status');
  const { activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { apiFetch } = useApiClient();
  const { toast } = useToast();

  const activeGymId = activeGym?.id;
  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'SYSTEM'));

  // ─── Filter / sort state ───────────────────────────────────────────────────
  const [entityTypeFilter, setEntityTypeFilter] = useState<EntityType | ''>('');
  const [q, setQ] = useState('');
  const [deletedByFilter, setDeletedByFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('deleted_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  // ─── Data state ────────────────────────────────────────────────────────────
  const [items, setItems] = useState<RecycleBinItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  // ─── Details ───────────────────────────────────────────────────────────────
  const [detailItem, setDetailItem] = useState<RecycleBinItem | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // ─── Recovery ──────────────────────────────────────────────────────────────
  const [recovering, setRecovering] = useState<RecycleBinItem | null>(null);
  const [recoverSaving, setRecoverSaving] = useState(false);

  // ─── Load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (entityTypeFilter) params.set('entity_type', entityTypeFilter);
      if (q.trim()) params.set('q', q.trim());
      if (deletedByFilter.trim()) params.set('deleted_by_name', deletedByFilter.trim());
      if (fromFilter) params.set('from', fromFilter);
      if (toFilter) params.set('to', toFilter);
      params.set('sort', sortKey);
      params.set('dir', sortDir);
      params.set('limit', String(LIMIT));
      params.set('offset', String(offset));
      const res = await apiFetch<RecycleBinList>(`/recycle-bin?${params.toString()}`);
      setItems(res.items);
      setTotal(res.total);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, entityTypeFilter, q, deletedByFilter, fromFilter, toFilter, sortKey, sortDir, offset]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);
  useEffect(() => { setOffset(0); }, [entityTypeFilter, q, deletedByFilter, fromFilter, toFilter, sortKey, sortDir]);

  // ─── Open details ──────────────────────────────────────────────────────────
  async function openDetail(item: RecycleBinItem) {
    setDetailItem(item);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = await apiFetch<EntityDetail>(`/recycle-bin/${item.entity_type}/${item.id}`);
      setDetail(d);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
      setDetailItem(null);
    } finally {
      setDetailLoading(false);
    }
  }

  // ─── Recover ───────────────────────────────────────────────────────────────
  async function handleRecover() {
    if (!recovering) return;
    setRecoverSaving(true);
    try {
      await apiFetch(`/recycle-bin/${recovering.entity_type}/${recovering.id}/recover`, { method: 'POST' });
      toast(t('recover_success'));
      setRecovering(null);
      setDetailItem(null);
      setDetail(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setRecoverSaving(false);
    }
  }

  // ─── Sort toggle ───────────────────────────────────────────────────────────
  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────
  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div style={{ padding: 28, maxWidth: 1100 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 20 }}>{t('title')}</h1>

      {/* ─── Filters ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <select
          value={entityTypeFilter}
          onChange={(e) => setEntityTypeFilter(e.target.value as EntityType | '')}
          style={filterSelectStyle}
        >
          <option value="">{t('filter_all_types')}</option>
          {ENTITY_TYPES.map((et) => (
            <option key={et} value={et}>{t(`entity_${et}`)}</option>
          ))}
        </select>

        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('filter_search')}
          style={filterInputStyle}
        />

        <input
          type="text"
          value={deletedByFilter}
          onChange={(e) => setDeletedByFilter(e.target.value)}
          placeholder={t('filter_deleted_by')}
          style={{ ...filterInputStyle, width: 160 }}
        />

        <input
          type="date"
          value={fromFilter}
          onChange={(e) => setFromFilter(e.target.value)}
          style={{ ...filterInputStyle, width: 140 }}
          title={t('filter_from')}
        />
        <input
          type="date"
          value={toFilter}
          onChange={(e) => setToFilter(e.target.value)}
          style={{ ...filterInputStyle, width: 140 }}
          title={t('filter_to')}
        />

        {(entityTypeFilter || q || deletedByFilter || fromFilter || toFilter) && (
          <button
            onClick={() => { setEntityTypeFilter(''); setQ(''); setDeletedByFilter(''); setFromFilter(''); setToFilter(''); }}
            style={{ padding: '8px 14px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#666' }}
          >
            {t('filter_clear')}
          </button>
        )}
      </div>

      {/* ─── Table ─────────────────────────────────────────────────────────── */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: '2px solid var(--gd-card-border, #eee)' }}>
              <SortHeader label={t('col_entity_type')} sortKey="entity_type" current={sortKey} dir={sortDir} onToggle={toggleSort} />
              <SortHeader label={t('col_name')} sortKey="name" current={sortKey} dir={sortDir} onToggle={toggleSort} />
              <th style={thStyle}>{t('col_description')}</th>
              <th style={thStyle}>{t('col_deleted_by')}</th>
              <SortHeader label={t('col_deleted_at')} sortKey="deleted_at" current={sortKey} dir={sortDir} onToggle={toggleSort} />
              <th style={{ ...thStyle, width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: '24px 16px', color: '#888', textAlign: 'center' }}>{t('loading')}</td></tr>
            )}
            {!loading && items.length === 0 && (
              <tr><td colSpan={6} style={{ padding: '24px 16px', color: '#888', textAlign: 'center' }}>{t('empty')}</td></tr>
            )}
            {!loading && items.map((item) => (
              <tr
                key={`${item.entity_type}-${item.id}`}
                style={{ borderBottom: '1px solid var(--gd-card-border, #f0f0f0)', cursor: 'pointer' }}
                onClick={() => openDetail(item)}
              >
                <td style={tdStyle}>
                  <EntityTypeBadge entityType={item.entity_type} label={t(`entity_${item.entity_type}`)} />
                </td>
                <td style={{ ...tdStyle, maxWidth: 240 }}>
                  <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</div>
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 2, whiteSpace: 'nowrap' }}>
                    {t('details_created_by')}: {item.created_by_name ?? '—'} · {fmtDate(item.created_at)}
                  </div>
                </td>
                <td style={{ ...tdStyle, color: '#888', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.description ?? '—'}
                </td>
                <td style={{ ...tdStyle, color: '#666' }}>{item.deleted_by_name ?? '—'}</td>
                <td style={{ ...tdStyle, color: '#666', whiteSpace: 'nowrap' }}>{fmtDate(item.deleted_at)}</td>
                <td style={tdStyle} onClick={(e) => e.stopPropagation()}>
                  {canWrite && (
                    <button
                      onClick={() => setRecovering(item)}
                      style={{ padding: '4px 12px', border: '1px solid #4b45c6', borderRadius: 5, background: '#fff', color: '#4b45c6', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      {t('action_recover')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ─── Pagination ────────────────────────────────────────────────────── */}
      {total > LIMIT && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, justifyContent: 'flex-end', fontSize: 13, color: '#666' }}>
          <span>{currentPage} / {totalPages}</span>
          <button
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            disabled={offset === 0}
            style={pagerStyle(offset === 0)}
          >←</button>
          <button
            onClick={() => setOffset(offset + LIMIT)}
            disabled={offset + LIMIT >= total}
            style={pagerStyle(offset + LIMIT >= total)}
          >→</button>
        </div>
      )}

      {/* ─── Details modal ─────────────────────────────────────────────────── */}
      <CrudModal
        open={detailItem !== null}
        title={detailItem ? `${t(`entity_${detailItem.entity_type}`)}: ${detailItem.name}` : ''}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        onCancel={() => { setDetailItem(null); setDetail(null); }}
        onSave={() => { setDetailItem(null); setDetail(null); }}
        extraFooter={
          canWrite && detailItem ? (
            <button
              onClick={() => { setRecovering(detailItem); setDetailItem(null); setDetail(null); }}
              style={{ padding: '8px 18px', border: 'none', borderRadius: 6, background: '#4b45c6', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}
            >
              {t('action_recover')}
            </button>
          ) : undefined
        }
      >
        {detailLoading && <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>}
        {!detailLoading && detail && detailItem && (
          <EntityDetailContent entityType={detailItem.entity_type} detail={detail} t={t} tStatus={tStatus} fmtDate={fmtDate} />
        )}
      </CrudModal>

      {/* ─── Recovery confirm ──────────────────────────────────────────────── */}
      <ConfirmDialog
        open={recovering !== null}
        message={`${t('confirm_recover_title')}\n\n${t('confirm_recover_body')}`}
        confirmLabel={recoverSaving ? '…' : t('confirm_recover')}
        cancelLabel={t('cancel')}
        onConfirm={handleRecover}
        onCancel={() => setRecovering(null)}
      />
    </div>
  );
}

// ─── EntityDetailContent ──────────────────────────────────────────────────────

function EntityDetailContent({
  entityType, detail, t, tStatus, fmtDate,
}: {
  entityType: EntityType;
  detail: EntityDetail;
  t: ReturnType<typeof useTranslations>;
  tStatus: ReturnType<typeof useTranslations>;
  fmtDate: (iso: string | null | undefined) => string;
}) {
  const rows: { label: string; value: React.ReactNode }[] = [];

  rows.push({ label: t('details_name'), value: detail.name });

  if (detail.description !== undefined) {
    rows.push({ label: t('details_description'), value: detail.description ?? '—' });
  }

  switch (entityType) {
    case 'member':
      if (detail.email) rows.push({ label: t('details_email'), value: detail.email as string });
      if (detail.phone) rows.push({ label: t('details_phone'), value: detail.phone as string });
      break;
    case 'membership_plan':
      if (detail.lifecycle_status) rows.push({ label: t('details_lifecycle_status'), value: <StatusBadge status={detail.lifecycle_status as string} label={tStatus(detail.lifecycle_status as string)} /> });
      if (detail.enrollment_status) rows.push({ label: t('details_enrollment_status'), value: tStatus(detail.enrollment_status as string) });
      break;

    case 'promotion':
      if (detail.lifecycle_status) rows.push({ label: t('details_lifecycle_status'), value: <StatusBadge status={detail.lifecycle_status as string} label={tStatus(detail.lifecycle_status as string)} /> });
      rows.push({ label: t('details_starts_at'), value: fmtDate(detail.starts_at as string) });
      rows.push({ label: t('details_ends_at'), value: fmtDate(detail.ends_at as string) });
      rows.push({ label: t('details_stackable'), value: detail.stackable ? t('details_yes') : t('details_no') });
      break;

    case 'center':
      if (detail.phone) rows.push({ label: t('details_phone'), value: detail.phone as string });
      if (detail.email) rows.push({ label: t('details_email'), value: detail.email as string });
      {
        const addrParts = [detail.address_line_1, detail.address_line_2, detail.city, detail.country].filter(Boolean);
        if (addrParts.length) rows.push({ label: t('details_address'), value: addrParts.join(', ') });
      }
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      break;

    case 'space':
      if (detail.capacity != null) rows.push({ label: t('details_capacity'), value: String(detail.capacity) });
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      if (detail.opening_time) rows.push({ label: t('details_opening_time'), value: detail.opening_time as string });
      if (detail.closing_time) rows.push({ label: t('details_closing_time'), value: detail.closing_time as string });
      if (detail.notes) rows.push({ label: t('details_notes'), value: detail.notes as string });
      break;

    case 'class_package':
      if (detail.number_of_sessions != null) rows.push({ label: t('details_sessions'), value: String(detail.number_of_sessions) });
      if (detail.price != null) rows.push({ label: t('details_price'), value: String(detail.price) });
      if (detail.validity_days != null) rows.push({ label: t('details_validity_days'), value: String(detail.validity_days) });
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      if (detail.notes) rows.push({ label: t('details_notes'), value: detail.notes as string });
      break;

    case 'exercise':
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      if (detail.video_url) rows.push({ label: t('details_video_url'), value: detail.video_url as string });
      if (detail.image_url) rows.push({ label: t('details_image_url'), value: detail.image_url as string });
      break;

    case 'workout_template':
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      if (detail.notes) rows.push({ label: t('details_notes'), value: detail.notes as string });
      break;

    case 'training_plan_template':
    case 'nutrition_plan_template':
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      break;

    case 'theme':
      if (detail.status) rows.push({ label: t('details_status'), value: <StatusBadge status={detail.status as string} label={tStatus(detail.status as string)} /> });
      break;
  }

  rows.push({ label: '__divider__', value: null });
  rows.push({ label: t('details_created_at'), value: fmtDate(detail.created_at) });
  if (detail.created_by_name !== undefined) rows.push({ label: t('details_created_by'), value: detail.created_by_name ?? '—' });
  if (detail.modified_at) rows.push({ label: t('details_modified_at'), value: fmtDate(detail.modified_at) });
  if (detail.modified_by_name) rows.push({ label: t('details_modified_by'), value: detail.modified_by_name as string });
  rows.push({ label: t('details_deleted_at'), value: fmtDate(detail.deleted_at) });
  if (detail.deleted_by_name !== undefined) rows.push({ label: t('details_deleted_by'), value: detail.deleted_by_name ?? '—' });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((row, i) =>
        row.label === '__divider__' ? (
          <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--gd-card-border, #eee)', margin: '4px 0' }} />
        ) : (
          <DetailRow key={i} label={row.label} value={row.value} />
        )
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SortHeader({
  label, sortKey: key, current, dir, onToggle,
}: {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: 'asc' | 'desc';
  onToggle: (k: SortKey) => void;
}) {
  const active = current === key;
  return (
    <th style={thStyle}>
      <button
        onClick={() => onToggle(key)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, fontWeight: 700, color: active ? '#4b45c6' : '#aaa', letterSpacing: '0.05em', textTransform: 'uppercase' }}
      >
        {label} {active ? (dir === 'asc' ? '↑' : '↓') : ''}
      </button>
    </th>
  );
}

const ENTITY_COLORS: Record<EntityType, string> = {
  member: '#fdf0e8',
  membership_plan: '#e8f4fd',
  promotion: '#fdf3e8',
  center: '#e8fdf0',
  space: '#f3e8fd',
  class_package: '#fdeaea',
  exercise: '#e8f0fd',
  workout_template: '#fdf9e8',
  training_plan_template: '#e8fdfc',
  nutrition_plan_template: '#f0fde8',
  theme: '#fde8f4',
};

const ENTITY_TEXT_COLORS: Record<EntityType, string> = {
  member: '#a8531a',
  membership_plan: '#1a6ea8',
  promotion: '#a8721a',
  center: '#1a8a4a',
  space: '#721aa8',
  class_package: '#a81a1a',
  exercise: '#1a4ea8',
  workout_template: '#8a7a1a',
  training_plan_template: '#1a8a88',
  nutrition_plan_template: '#4a8a1a',
  theme: '#a81a72',
};

function EntityTypeBadge({ entityType, label }: { entityType: EntityType; label: string }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: '0.03em',
      background: ENTITY_COLORS[entityType] ?? '#f0f0f0',
      color: ENTITY_TEXT_COLORS[entityType] ?? '#666',
    }}>
      {label}
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ color: '#888', fontSize: 13, width: 150, flexShrink: 0, paddingTop: 1 }}>{label}</span>
      <span style={{ fontSize: 13, flex: 1, wordBreak: 'break-word' }}>{value ?? '—'}</span>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const filterInputStyle: React.CSSProperties = {
  padding: '8px 11px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14, background: '#fff', minWidth: 200,
};
const filterSelectStyle: React.CSSProperties = {
  padding: '8px 11px', border: '1px solid #ccc', borderRadius: 6, fontSize: 14, background: '#fff',
};
const thStyle: React.CSSProperties = {
  padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#aaa', letterSpacing: '0.05em', textTransform: 'uppercase', whiteSpace: 'nowrap',
};
const tdStyle: React.CSSProperties = {
  padding: '10px 12px', verticalAlign: 'middle',
};
const pagerStyle = (disabled: boolean): React.CSSProperties => ({
  background: '#fff', border: '1px solid #ccc', borderRadius: 6, padding: '4px 12px',
  cursor: disabled ? 'default' : 'pointer', color: disabled ? '#bbb' : '#333', fontSize: 16,
});
