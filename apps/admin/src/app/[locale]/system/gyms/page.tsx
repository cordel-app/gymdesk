'use client';

import { useEffect, useState } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { btnStyle, btnSmall } from '@/components/ui';
interface GymTheme {
  id: string;
  name: string;
}

interface Gym {
  id: string;
  name: string;
  slug: string;
  plan: string;
  theme: GymTheme | null;
  created_at: string;
}

const emptyForm = { name: '', slug: '', plan: 'free', theme_id: '' };

export default function SystemGymsPage() {
  const t = useTranslations('system_gyms');
  const { apiFetch } = useApiClient();
  const { isSuperadmin, setActiveGymId, refreshGyms, loading: gymLoading } = useGym();
  const router = useRouter();
  const locale = useLocale();
  const { toast } = useToast();

  const [gyms, setGyms] = useState<Gym[]>([]);
  const [themes, setThemes] = useState<GymTheme[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Gym | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Wait for Clerk metadata to arrive before deciding — otherwise the initial
    // render (isSuperadmin=false) would redirect a legitimate superadmin away.
    if (gymLoading) return;
    if (!isSuperadmin) {
      router.replace(`/${locale}`);
      return;
    }
    load();
  }, [gymLoading, isSuperadmin]);

  async function load() {
    setLoading(true);
    try {
      const [gymsData, themesData] = await Promise.all([
        apiFetch<Gym[]>('/platform/gyms'),
        apiFetch<GymTheme[]>('/platform/themes?status=active').catch(() => []),
      ]);
      setGyms(gymsData);
      setThemes(themesData);
    } catch (err: any) {
      setGyms([]);
      toast(err.message ?? t('error_load'));
    } finally {
      setLoading(false);
    }
  }

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setModalOpen(true);
  }

  function openEdit(g: Gym) {
    setEditing(g);
    setForm({ name: g.name, slug: g.slug, plan: g.plan, theme_id: g.theme?.id ?? '' });
    setError(null);
    setModalOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim() || (!editing && !form.slug.trim())) {
      setError(t('error_required'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        // PATCH: only send editable fields (slug/plan aren't touched here).
        await apiFetch(`/platform/gyms/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: form.name.trim(), theme_id: form.theme_id || null }),
        });
      } else {
        await apiFetch('/platform/gyms', {
          method: 'POST',
          body: JSON.stringify({
            name: form.name.trim(),
            slug: form.slug.trim(),
            plan: form.plan,
            theme_id: form.theme_id || null,
          }),
        });
      }
      setModalOpen(false);
      setEditing(null);
      setForm(emptyForm);
      await load();
      // Refresh the global gym list so the theme picker's change lands in
      // GymContext immediately (chrome themes update live via ThemeProvider).
      await refreshGyms();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  function handleManage(gymId: string) {
    setActiveGymId(gymId);
    router.push(`/${locale}/members`);
  }

  const columns: Column<Gym>[] = [
    { header: t('col_name'), render: (g) => g.name },
    { header: t('col_slug'), render: (g) => <code style={{ fontSize: 13 }}>{g.slug}</code> },
    { header: t('col_plan'), width: 90, render: (g) => g.plan },
    {
      header: t('col_theme'),
      width: 130,
      render: (g) => g.theme ? g.theme.name : '—',
    },
    { header: t('col_created'), width: 130, render: (g) => new Date(g.created_at).toLocaleDateString() },
    {
      header: t('col_actions'),
      width: 200,
      render: (g) => (
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => handleManage(g.id)} style={btnSmall('#444')}>{t('manage')}</button>
          <button onClick={() => openEdit(g)} style={btnSmall()}>{t('edit')}</button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <button onClick={openAdd} style={btnStyle()}>{t('create')}</button>
      </div>

      <DataTable
        columns={columns}
        rows={gyms}
        rowKey={(g) => g.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
      />

      <CrudModal
        open={modalOpen}
        title={editing ? t('modal_edit') : t('modal_title')}
        error={error}
        saving={saving}
        cancelLabel={t('cancel')}
        saveLabel={saving ? t('saving') : editing ? t('save_changes') : t('save')}
        onCancel={() => { setModalOpen(false); setEditing(null); setForm(emptyForm); setError(null); }}
        onSave={handleSave}
      >
        <FormLabel>{t('label_name')}</FormLabel>
        <FormInput
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder="My Gym"
          autoFocus
        />

        {!editing && (
          <>
            <FormLabel>{t('label_slug')}</FormLabel>
            <FormInput
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
              placeholder="my-gym"
            />

            <FormLabel>{t('label_plan')}</FormLabel>
            <select
              value={form.plan}
              onChange={(e) => setForm({ ...form, plan: e.target.value })}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}
            >
              <option value="free">{t('plan_free')}</option>
              <option value="pro">{t('plan_pro')}</option>
            </select>
          </>
        )}

        <FormLabel>{t('label_theme')}</FormLabel>
        <select
          value={form.theme_id}
          onChange={(e) => setForm({ ...form, theme_id: e.target.value })}
          style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff' }}
        >
          <option value="">{t('theme_none')}</option>
          {themes.map((th) => (
            <option key={th.id} value={th.id}>{th.name}</option>
          ))}
        </select>
      </CrudModal>
    </div>
  );
}
