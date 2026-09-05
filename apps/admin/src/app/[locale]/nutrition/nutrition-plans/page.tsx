'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle } from '@/components/ui';
import { canWriteModule } from '@/config/permissions';

interface MemberNutritionPlan {
  id: number;
  name: string;
  member_id: number;
  member_name: string;
  template_id: number | null;
  status: 'active' | 'completed' | 'deleted';
  start_date: string | null;
  day_count: number;
  created_at: string;
}

interface MemberOption { id: number; name: string }

function formatDate(iso: string, locale: string) {
  return new Date(iso).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function NutritionPlansPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [rows, setRows] = useState<MemberNutritionPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [memberFilter, setMemberFilter] = useState(searchParams.get('member_id') ?? '');
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [deleting, setDeleting] = useState<MemberNutritionPlan | null>(null);

  const canWrite = isSuperadmin || (activeGym?.role != null && canWriteModule(activeGym.role, 'NUTRITION'));
  useEffect(() => { if (!gymLoading && !canWrite) router.replace(`/${locale}`); }, [gymLoading, canWrite]);

  const load = useCallback(async () => {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (memberFilter) params.set('member_id', memberFilter);
      const data = await apiFetch<MemberNutritionPlan[]>(`/member-nutrition-plans?${params.toString()}`);
      setRows(data);
    } catch (err: any) {
      toast(err.message ?? t('nutrition_plans.error_generic'));
    } finally {
      setLoading(false);
    }
  }, [activeGymId, memberFilter]);

  useEffect(() => { if (!gymLoading) load(); }, [gymLoading, load]);

  useEffect(() => {
    if (!activeGymId || gymLoading) return;
    apiFetch<MemberOption[]>('/members').then(setMemberOptions).catch(() => {});
  }, [activeGymId, gymLoading]);

  async function del() {
    if (!deleting) return;
    try {
      await apiFetch(`/member-nutrition-plans/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('nutrition_plans.error_generic'));
    }
  }

  if (gymLoading || !canWrite) return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0 }}>{t('nutrition_plans.title')}</h1>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <select
            value={memberFilter}
            onChange={(e) => setMemberFilter(e.target.value)}
            style={filterInputStyle}
          >
            <option value="">{t('nutrition_plans.filter_all_members')}</option>
            {memberOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <button onClick={() => router.push(`/${locale}/nutrition/nutrition-plan-templates`)} style={btnStyle()}>
            {t('nutrition_plans.assign_from_template')}
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('nutrition_plans.loading')}</p>
      ) : rows.length === 0 ? (
        <p style={{ color: '#888' }}>{t('nutrition_plans.empty')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((row) => {
            const menuItems = [
              ...(canWrite ? [{ label: t('nutrition_plans.delete'), onClick: () => setDeleting(row), danger: true }] : []),
            ];
            return (
              <div key={row.id} style={cardStyle}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {row.name}
                    </div>
                    <div style={{ fontSize: 13, color: '#666', marginTop: 2 }}>{row.member_name}</div>
                  </div>
                  <StatusBadge status={row.status} label={t(`status.${row.status}`)} />
                  <span style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>
                    {t('nutrition_plans.day_count', { count: row.day_count })}
                  </span>
                  <span style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>
                    {formatDate(row.created_at, locale)}
                  </span>
                  <span onClick={(e) => e.stopPropagation()}>
                    <ContextMenu ariaLabel={t('nutrition_plans.col_actions')} items={menuItems} />
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        message={t('nutrition_plans.confirm_delete')}
        confirmLabel={t('nutrition_plans.delete')}
        cancelLabel={t('nutrition_plans.cancel')}
        onConfirm={del}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

const filterInputStyle: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 6, border: '1px solid #ccc',
  fontSize: 14, background: '#fff', minWidth: 160,
};

const cardStyle: React.CSSProperties = {
  border: '1px solid #e0e0e8', borderRadius: 10, background: '#fff', overflow: 'hidden',
};
