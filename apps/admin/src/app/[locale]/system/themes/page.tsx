'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { btnStyle, btnSmall } from '@/components/ui';
import { DEFAULT_TOKENS, FONT_STACKS, type ThemeTokens } from '@/lib/themeTokens';

interface Theme {
  id: string;
  gym_id: string | null;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'deleted';
  type: 'system' | 'custom';
  has_logo: boolean;
  logo_updated_at: string | null;
  tokens: ThemeTokens;
  created_at: string;
  modified_at: string | null;
  usage_count: number;
  is_system_default: boolean;
}

interface ThemeDetail extends Theme {
  created_by_name: string | null;
  modified_by_name: string | null;
}


const STATUSES = ['draft', 'active', 'deleted'] as const;
const TYPO_LEVELS = ['h1', 'h2', 'h3', 'body', 'small'] as const;
const COLOR_FIELDS: { key: keyof ThemeTokens['colors']; labelKey: string }[] = [
  { key: 'appBackground',             labelKey: 'label_app_bg' },
  { key: 'headerBackground',          labelKey: 'label_header_bg' },
  { key: 'headerText',                labelKey: 'label_header_text' },
  { key: 'headerSeparatorColor',      labelKey: 'label_header_sep_color' },
  { key: 'sidebarBackground',         labelKey: 'label_sidebar_bg' },
  { key: 'sidebarText',               labelKey: 'label_sidebar_text' },
  { key: 'sidebarSelectedBackground', labelKey: 'label_sidebar_sel_bg' },
  { key: 'sidebarSelectedText',       labelKey: 'label_sidebar_sel_text' },
];

const emptyForm = {
  name: '',
  description: '',
  tokens: DEFAULT_TOKENS,
};

type TabKey = 'branding' | 'typography' | 'colors';

function formatDate(value: string | null, locale: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ color: '#888', fontSize: 13.5, width: 160, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5 }}>{value}</span>
    </div>
  );
}

export default function ThemesPage() {
  const t = useTranslations('themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { getToken } = useAuth();
  const { apiFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();
  const { toast } = useToast();

  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Theme | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Theme | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>('branding');
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [detailsTheme, setDetailsTheme] = useState<ThemeDetail | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

  useEffect(() => {
    if (gymLoading) return;
    if (!isSuperadmin) { router.replace(`/${locale}`); return; }
    load();
  }, [gymLoading, isSuperadmin]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Theme[]>(`/platform/themes${statusFilter ? `?status=${statusFilter}` : ''}`);
      setThemes(data);
    } catch (err: any) {
      setThemes([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { if (!gymLoading && isSuperadmin) load(); }, [statusFilter]);

  function openAdd() {
    setEditing(null);
    setForm(emptyForm);
    setLogoFile(null);
    setLogoPreview(null);
    setError(null);
    setActiveTab('branding');
    setModalOpen(true);
  }

  function openEdit(theme: Theme) {
    setEditing(theme);
    setForm({ name: theme.name, description: theme.description ?? '', tokens: theme.tokens ?? DEFAULT_TOKENS });
    setLogoFile(null);
    setLogoPreview(theme.has_logo ? logoUrl(theme) : null);
    setError(null);
    setActiveTab('branding');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyForm);
    setLogoFile(null);
    setLogoPreview(null);
    setError(null);
  }

  async function openDetails(theme: Theme) {
    setDetailsLoading(true);
    setDetailsTheme(null);
    try {
      const detail = await apiFetch<ThemeDetail>(`/platform/themes/${theme.id}`);
      setDetailsTheme(detail);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setDetailsLoading(false);
    }
  }

  function logoUrl(theme: Theme) {
    return `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`;
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function uploadLogo(themeId: string) {
    if (!logoFile) return;
    const token = await getToken();
    const res = await fetch(`/api/proxy/platform/themes/${themeId}/logo`, {
      method: 'POST',
      headers: { 'Content-Type': logoFile.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: logoFile,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Logo upload failed');
    }
  }

  async function handleSave() {
    if (!form.name.trim()) { setError(t('error_required')); return; }
    setSaving(true);
    setError(null);
    try {
      let savedId: string;
      if (editing) {
        await apiFetch(`/platform/themes/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({ name: form.name.trim(), description: form.description.trim() || null, tokens: form.tokens }),
        });
        savedId = editing.id;
      } else {
        const created = await apiFetch<Theme>('/platform/themes', {
          method: 'POST',
          body: JSON.stringify({ name: form.name.trim(), description: form.description.trim() || null, tokens: form.tokens }),
        });
        savedId = created.id;
      }
      if (logoFile) await uploadLogo(savedId);
      closeModal();
      load();
    } catch (err: any) {
      setError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(theme: Theme) {
    try {
      await apiFetch(`/platform/themes/${theme.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: theme.status === 'active' ? 'draft' : 'active' }),
      });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/themes/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      if (err.message?.includes('assigned')) toast(t('error_conflict'));
      else toast(err.message ?? t('error_generic'));
    }
  }

  async function handleSetSystemDefault(theme: Theme) {
    try {
      await apiFetch(`/platform/themes/${theme.id}/set-system-default`, { method: 'PUT' });
      toast(t('toast_system_default_set'));
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleLogoRemove() {
    if (!editing) return;
    try {
      await apiFetch(`/platform/themes/${editing.id}/logo`, { method: 'DELETE' });
      setLogoPreview(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  function usageLabel(theme: Theme): string {
    const n = theme.usage_count;
    if (n === 0) return t('usage_unused');
    return n === 1 ? t('usage_org_singular') : t('usage_org_plural').replace('{count}', String(n));
  }

  if (gymLoading || !isSuperadmin) return null;

  const columns: Column<Theme>[] = [
    {
      header: t('col_logo'),
      width: 52,
      render: (th) =>
        th.has_logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl(th)} alt={th.name} style={{ height: 32, width: 32, borderRadius: 4, objectFit: 'contain' }} />
        ) : (
          <div style={{ height: 32, width: 32, borderRadius: 4, background: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#bbb', fontSize: 10 }}>—</span>
          </div>
        ),
    },
    { header: t('col_name'), render: (th) => <span style={{ fontWeight: 600 }}>{th.name}</span> },
    {
      header: t('col_description'),
      render: (th) => (
        <span style={{ color: '#555', fontSize: 13.5, display: 'block', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {th.description ?? '—'}
        </span>
      ),
    },
    {
      header: t('col_type'),
      width: 140,
      render: (th) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span style={badgeStyle('#4b45c6')}>{t('badge_system')}</span>
          {th.is_system_default && (
            <span style={badgeStyle('#059669')}>{t('badge_default')}</span>
          )}
        </div>
      ),
    },
    {
      header: t('col_usage'),
      width: 130,
      render: (th) => <span style={{ color: '#555', fontSize: 13.5 }}>{usageLabel(th)}</span>,
    },
    {
      header: t('col_status'),
      width: 100,
      render: (th) => <StatusBadge status={th.status} label={tStatus(th.status)} />,
    },
    {
      header: t('col_actions'),
      width: 60,
      render: (th) => {
        const items = [];
        if (th.status !== 'deleted') {
          items.push({ label: th.status === 'active' ? t('deactivate') : t('activate'), onClick: () => handleActivate(th) });
          items.push({ label: t('edit'), onClick: () => openEdit(th) });
          if (!th.is_system_default) {
            items.push({ label: t('action_set_system_default'), onClick: () => handleSetSystemDefault(th) });
          }
        }
        items.push({ label: t('action_details'), onClick: () => openDetails(th) });
        if (th.status !== 'deleted') {
          items.push({ label: t('delete'), onClick: () => setDeleting(th), danger: true });
        }
        return <ContextMenu items={items} ariaLabel={t('col_actions')} />;
      },
    },
  ];

  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 6,
    border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '6px 14px', border: 'none', cursor: 'pointer', borderRadius: 4,
    background: active ? '#6c63ff' : 'transparent',
    color: active ? '#fff' : '#555',
    fontWeight: active ? 600 : 400,
    fontSize: 14,
  });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter
            value={statusFilter}
            onChange={setStatusFilter}
            options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
            allLabel={tStatus('all')}
          />
          <button onClick={openAdd} style={btnStyle('#6c63ff')}>{t('add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={themes}
        rowKey={(th) => th.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
      />

      {/* Edit / Create modal */}
      <CrudModal
        open={modalOpen}
        title={editing ? t('modal_edit') : t('modal_add')}
        error={error}
        saving={saving}
        cancelLabel={t('cancel')}
        saveLabel={saving ? t('saving') : t('save_changes')}
        onCancel={closeModal}
        onSave={handleSave}
      >
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #eee', paddingBottom: 8 }}>
          {(['branding', 'typography', 'colors'] as TabKey[]).map((tab) => (
            <button key={tab} type="button" onClick={() => setActiveTab(tab)} style={tabStyle(activeTab === tab)}>
              {t(`tab_${tab}` as any)}
            </button>
          ))}
        </div>

        {/* Branding tab */}
        {activeTab === 'branding' && (
          <div>
            <FormLabel>{t('label_name')}</FormLabel>
            <FormInput
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="My Brand"
              autoFocus
            />

            <FormLabel>{t('label_description')}</FormLabel>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
            />

            <FormLabel>{t('label_logo')}</FormLabel>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>{t('logo_hint')}</p>
            {logoPreview && (
              <div style={{ marginBottom: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={logoPreview} alt="logo preview" style={{ maxHeight: 60, maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4 }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => fileInputRef.current?.click()} style={btnSmall('#444')}>
                {t('logo_upload')}
              </button>
              {(logoPreview || (editing?.has_logo)) && (
                <button
                  type="button"
                  onClick={() => { setLogoFile(null); setLogoPreview(null); if (editing?.has_logo) handleLogoRemove(); }}
                  style={btnSmall('#c0392b')}
                >
                  {t('logo_clear')}
                </button>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleFileChange} />
          </div>
        )}

        {/* Typography tab */}
        {activeTab === 'typography' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px', gap: '8px 12px', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_level')}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_font')}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_color')}</span>
              {TYPO_LEVELS.map((lv) => {
                const typo = form.tokens.typography[lv];
                return (
                  <>
                    <span key={`${lv}-label`} style={{ fontSize: 13 }}>{lv}</span>
                    <select
                      key={`${lv}-font`}
                      value={typo.fontFamily}
                      onChange={(e) => setForm({
                        ...form,
                        tokens: {
                          ...form.tokens,
                          typography: { ...form.tokens.typography, [lv]: { ...typo, fontFamily: e.target.value } },
                        },
                      })}
                      style={selectStyle}
                    >
                      {FONT_STACKS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <input
                      key={`${lv}-color`}
                      type="color"
                      value={typo.color}
                      onChange={(e) => setForm({
                        ...form,
                        tokens: {
                          ...form.tokens,
                          typography: { ...form.tokens.typography, [lv]: { ...typo, color: e.target.value } },
                        },
                      })}
                      style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', padding: 2 }}
                    />
                  </>
                );
              })}
            </div>
          </div>
        )}

        {/* Colors tab */}
        {activeTab === 'colors' && (
          <div>
            {COLOR_FIELDS.map(({ key, labelKey }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t(labelKey as any)}</span>
                <input
                  type="color"
                  value={form.tokens.colors[key] as string}
                  onChange={(e) => setForm({
                    ...form,
                    tokens: { ...form.tokens, colors: { ...form.tokens.colors, [key]: e.target.value } },
                  })}
                  style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', padding: 2 }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{t('label_header_sep_height')}</span>
              <input
                type="number"
                min={0}
                max={20}
                value={form.tokens.colors.headerSeparatorHeight}
                onChange={(e) => setForm({
                  ...form,
                  tokens: { ...form.tokens, colors: { ...form.tokens.colors, headerSeparatorHeight: Number(e.target.value) } },
                })}
                style={{ width: 80, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 }}
              />
            </div>
          </div>
        )}
      </CrudModal>

      {/* Details modal */}
      <CrudModal
        open={detailsTheme !== null || detailsLoading}
        title={t('details_title')}
        error={null}
        saving={false}
        cancelLabel={t('details_close')}
        saveLabel=""
        onCancel={() => setDetailsTheme(null)}
        onSave={() => setDetailsTheme(null)}
        hideSave
      >
        {detailsLoading && <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>}
        {detailsTheme && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DetailRow label={t('details_name')} value={detailsTheme.name} />
            <DetailRow label={t('details_description')} value={detailsTheme.description ?? '—'} />
            <DetailRow
              label={t('details_type')}
              value={
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  <span style={badgeStyle('#4b45c6')}>{t('badge_system')}</span>
                  {detailsTheme.is_system_default && <span style={badgeStyle('#059669')}>{t('badge_default')}</span>}
                </div>
              }
            />
            <DetailRow label={t('details_status')} value={<StatusBadge status={detailsTheme.status} label={tStatus(detailsTheme.status)} />} />
            <DetailRow label={t('details_usage')} value={usageLabel(detailsTheme)} />
            <DetailRow label={t('details_owner')} value={t('owner_cordel')} />
            <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
            <DetailRow label={t('details_created_by')} value={detailsTheme.created_by_name ?? '—'} />
            <DetailRow label={t('details_created_at')} value={formatDate(detailsTheme.created_at, locale)} />
            <DetailRow label={t('details_modified_by')} value={detailsTheme.modified_by_name ?? '—'} />
            {detailsTheme.modified_at && (
              <DetailRow label={t('details_modified_at')} value={formatDate(detailsTheme.modified_at, locale)} />
            )}
          </div>
        )}
      </CrudModal>

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

function badgeStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 600,
    background: color + '18',
    color,
    border: `1px solid ${color}40`,
  };
}
