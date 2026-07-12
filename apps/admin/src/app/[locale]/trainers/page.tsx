'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { btnStyle, btnSmall } from '@/components/ui';

interface Trainer {
  gym_membership_id: number;
  user_id: string;
  specialities: { id: number; name: string }[];
}
interface Speciality { id: number; name: string }

export default function TrainersPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch } = useApiClient();
  const { activeGymId, activeGym, loading: gymLoading, isSuperadmin } = useGym();
  const { toast } = useToast();

  const [trainers, setTrainers] = useState<Trainer[]>([]);
  const [specialities, setSpecialities] = useState<Speciality[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Trainer | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  useEffect(() => { if (!gymLoading && !isAdmin) router.replace(`/${locale}`); }, [gymLoading, isAdmin]);

  async function load() {
    if (!activeGymId) { setLoading(false); return; }
    setLoading(true);
    try {
      const [ts, ss] = await Promise.all([
        apiFetch<Trainer[]>('/trainers'),
        apiFetch<Speciality[]>('/specialities'),
      ]);
      setTrainers(ts); setSpecialities(ss);
    } catch (err: any) { toast(err.message ?? t('trainers.error_generic')); }
    finally { setLoading(false); }
  }
  useEffect(() => { if (!gymLoading) load(); }, [activeGymId, gymLoading]);

  function openEdit(tr: Trainer) {
    setEditing(tr);
    setSelected(new Set(tr.specialities.map((s) => s.id)));
    setError(null);
  }

  async function save() {
    if (!editing) return;
    setSaving(true); setError(null);
    try {
      await apiFetch(`/trainers/${editing.gym_membership_id}/specialities`,
        { method: 'PUT', body: JSON.stringify({ speciality_ids: Array.from(selected) }) });
      setEditing(null); load();
    } catch (err: any) { setError(err.message ?? t('trainers.error_generic')); }
    finally { setSaving(false); }
  }

  if (gymLoading || !isAdmin) return null;

  const columns: Column<Trainer>[] = [
    { header: t('trainers.col_id'), render: (r) => r.user_id.slice(0, 12) + '…' },
    { header: t('trainers.col_specialities'),
      render: (r) => r.specialities.length === 0 ? '—' : r.specialities.map((s) => s.name).join(', ') },
    {
      header: t('trainers.col_actions'), width: 140,
      render: (r) => <button onClick={() => openEdit(r)} style={btnSmall('#6c63ff')}>{t('trainers.assign')}</button>,
    },
  ];

  return (
    <div>
      <h1 style={{ margin: '0 0 24px' }}>{t('trainers.title')}</h1>
      <DataTable columns={columns} rows={trainers} rowKey={(r) => r.gym_membership_id} loading={loading}
                 loadingText={t('trainers.loading')} emptyText={t('trainers.empty')} />

      <CrudModal
        open={editing !== null}
        title={t('trainers.modal_assign')}
        error={error} saving={saving}
        cancelLabel={t('trainers.cancel')}
        saveLabel={saving ? t('trainers.saving') : t('trainers.save_changes')}
        onCancel={() => setEditing(null)}
        onSave={save}
      >
        <FormLabel>{t('trainers.label_specialities')}</FormLabel>
        {specialities.length === 0 ? (
          <p style={{ color: '#666', margin: 0, fontSize: 14 }}>{t('trainers.no_specialities')}</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 240, overflowY: 'auto' }}>
            {specialities.map((s) => (
              <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
                <input type="checkbox" checked={selected.has(s.id)}
                       onChange={(e) => {
                         const next = new Set(selected);
                         if (e.target.checked) next.add(s.id); else next.delete(s.id);
                         setSelected(next);
                       }} />
                {s.name}
              </label>
            ))}
          </div>
        )}
      </CrudModal>
    </div>
  );
}
