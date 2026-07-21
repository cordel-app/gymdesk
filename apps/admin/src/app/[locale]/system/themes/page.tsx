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
import { ThemeAdvancedSection } from '@/components/ThemeAdvancedSection';
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

type SectionKey = 'branding' | 'typography' | 'colors' | 'advanced';
const ALL_SECTIONS: SectionKey[] = ['branding', 'typography', 'colors', 'advanced'];

const emptyForm = { name: '', description: '', tokens: DEFAULT_TOKENS };

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

function badgeStyle(color: string): React.CSSProperties {
  return { display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: color + '18', color, border: `1px solid ${color}40` };
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

  // Inline expandable editor
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['branding']));
  const [editForm, setEditForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editLogoFile, setEditLogoFile] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  // Inline status saving
  const [statusSaving, setStatusSaving] = useState<string | null>(null);

  // Add modal
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(emptyForm);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addFileInputRef = useRef<HTMLInputElement>(null);
  const [addLogoFile, setAddLogoFile] = useState<File | null>(null);
  const [addLogoPreview, setAddLogoPreview] = useState<string | null>(null);

  const [deleting, setDeleting] = useState<Theme | null>(null);
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

  function logoUrl(theme: Theme) {
    return `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`;
  }

  function openExpand(theme: Theme) {
    if (expandedId === theme.id) { setExpandedId(null); return; }
    setExpandedId(theme.id);
    setOpenSections(new Set<SectionKey>(['branding']));
    setEditForm({ name: theme.name, description: theme.description ?? '', tokens: theme.tokens ?? DEFAULT_TOKENS });
    setEditError(null);
    setEditLogoFile(null);
    setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
  }

  function toggleSection(section: SectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  }

  async function handleStatusChange(theme: Theme, newStatus: string) {
    setStatusSaving(theme.id);
    try {
      await apiFetch(`/platform/themes/${theme.id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setStatusSaving(null);
    }
  }

  async function handleSave() {
    if (!expandedId) return;
    const theme = themes.find((th) => th.id === expandedId);
    if (!theme) return;
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/platform/themes/${expandedId}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editForm.name.trim(), description: editForm.description.trim() || null, tokens: editForm.tokens }),
      });
      if (editLogoFile) await uploadLogo(expandedId);
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function uploadLogo(themeId: string) {
    if (!editLogoFile) return;
    const token = await getToken();
    const res = await fetch(`/api/proxy/platform/themes/${themeId}/logo`, {
      method: 'POST',
      headers: { 'Content-Type': editLogoFile.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: editLogoFile,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(json.error ?? 'Logo upload failed');
    }
  }

  async function handleLogoRemove(themeId: string) {
    try {
      await apiFetch(`/platform/themes/${themeId}/logo`, { method: 'DELETE' });
      setEditLogoPreview(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  function handleEditFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setEditLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setEditLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function handleAdd() {
    if (!addForm.name.trim()) { setAddError(t('error_required')); return; }
    setAddSaving(true);
    setAddError(null);
    try {
      const created = await apiFetch<Theme>('/platform/themes', {
        method: 'POST',
        body: JSON.stringify({ name: addForm.name.trim(), description: addForm.description.trim() || null, tokens: addForm.tokens }),
      });
      if (addLogoFile) {
        const token = await getToken();
        const res = await fetch(`/api/proxy/platform/themes/${created.id}/logo`, {
          method: 'POST',
          headers: { 'Content-Type': addLogoFile.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: addLogoFile,
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? 'Logo upload failed');
        }
      }
      setAddOpen(false);
      load();
    } catch (err: any) {
      setAddError(err.message ?? t('error_generic'));
    } finally {
      setAddSaving(false);
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

  function usageLabel(theme: Theme): string {
    const n = theme.usage_count;
    if (n === 0) return t('usage_unused');
    return n === 1 ? t('usage_org_singular') : t('usage_org_plural').replace('{count}', String(n));
  }

  if (gymLoading || !isSuperadmin) return null;

  const selectStyle: React.CSSProperties = {
    width: '100%', padding: '10px 12px', borderRadius: 6,
    border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
  };

  function renderSection(title: string, key: SectionKey, content: React.ReactNode) {
    const open = openSections.has(key);
    return (
      <div key={key} style={{ borderTop: '1px solid #eee' }}>
        <button
          type="button"
          onClick={() => toggleSection(key)}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#333', textAlign: 'left' }}
        >
          {title}
          <span style={{ fontSize: 12, color: '#aaa', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
        </button>
        {open && <div style={{ paddingBottom: 16 }}>{content}</div>}
      </div>
    );
  }

  function renderInlineEditor(theme: Theme) {
    if (expandedId !== theme.id) return null;
    const advanced = editForm.tokens.advanced ?? {};

    return (
      <div style={{ padding: '0 24px 20px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        {editError && <p style={{ margin: '12px 0 0', fontSize: 13, color: '#c0392b' }}>{editError}</p>}
        <div style={{ marginTop: 12 }}>
          {renderSection(t('section_branding'), 'branding', (
            <div>
              <FormLabel>{t('label_name')}</FormLabel>
              <FormInput value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} placeholder="My Brand" />
              <FormLabel>{t('label_description')}</FormLabel>
              <textarea value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} rows={2} style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
              <FormLabel>{t('label_logo')}</FormLabel>
              <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>{t('logo_hint')}</p>
              {editLogoPreview && (
                <div style={{ marginBottom: 8 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={editLogoPreview} alt="logo preview" style={{ maxHeight: 60, maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4 }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" onClick={() => editFileInputRef.current?.click()} style={btnSmall('#444')}>{t('logo_upload')}</button>
                {editLogoPreview && (
                  <button type="button" onClick={() => { setEditLogoFile(null); setEditLogoPreview(null); if (theme.has_logo) handleLogoRemove(theme.id); }} style={btnSmall('#c0392b')}>{t('logo_clear')}</button>
                )}
              </div>
              <input ref={editFileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleEditFileChange} />
            </div>
          ))}

          {renderSection(t('section_typography'), 'typography', (
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px', gap: '8px 12px', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('tab_typography')}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_font')}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_color')}</span>
              {TYPO_LEVELS.map((lv) => {
                const typo = editForm.tokens.typography[lv];
                return (
                  <>
                    <span key={`${lv}-label`} style={{ fontSize: 13 }}>{lv}</span>
                    <select key={`${lv}-font`} value={typo.fontFamily} onChange={(e) => setEditForm({ ...editForm, tokens: { ...editForm.tokens, typography: { ...editForm.tokens.typography, [lv]: { ...typo, fontFamily: e.target.value } } } })} style={selectStyle}>
                      {FONT_STACKS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <input key={`${lv}-color`} type="color" value={typo.color} onChange={(e) => setEditForm({ ...editForm, tokens: { ...editForm.tokens, typography: { ...editForm.tokens.typography, [lv]: { ...typo, color: e.target.value } } } })} style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', padding: 2 }} />
                  </>
                );
              })}
            </div>
          ))}

          {renderSection(t('section_colors'), 'colors', (
            <div>
              {COLOR_FIELDS.map(({ key, labelKey }) => (
                <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{t(labelKey as any)}</span>
                  <input type="color" value={editForm.tokens.colors[key] as string} onChange={(e) => setEditForm({ ...editForm, tokens: { ...editForm.tokens, colors: { ...editForm.tokens.colors, [key]: e.target.value } } })} style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', padding: 2 }} />
                </div>
              ))}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t('label_header_sep_height')}</span>
                <input type="number" min={0} max={20} value={editForm.tokens.colors.headerSeparatorHeight} onChange={(e) => setEditForm({ ...editForm, tokens: { ...editForm.tokens, colors: { ...editForm.tokens.colors, headerSeparatorHeight: Number(e.target.value) } } })} style={{ width: 80, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 }} />
              </div>
            </div>
          ))}

          {renderSection(t('section_advanced'), 'advanced', (
            <ThemeAdvancedSection
              advanced={advanced}
              onChange={(next) => setEditForm({ ...editForm, tokens: { ...editForm.tokens, advanced: next } })}
              namespace="themes"
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={handleSave} disabled={saving} style={btnSmall('#6c63ff')}>{saving ? t('saving') : t('save_changes')}</button>
        </div>
      </div>
    );
  }

  const columns: Column<Theme>[] = [
    {
      header: t('col_logo'),
      width: 52,
      render: (th) =>
        th.has_logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl(th)} alt={th.name} style={{ height: 32, width: 32, borderRadius: 4, objectFit: 'contain' }} />
        ) : (
          <div style={{ height: 32, width: 32, borderRadius: 4, background: th.tokens?.colors?.headerBackground ?? '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center' }} />
        ),
    },
    {
      header: t('col_name'),
      render: (th) => (
        <div>
          <span style={{ fontWeight: 600 }}>{th.name}</span>
          {th.description && (
            <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>
              {th.description}
            </div>
          )}
        </div>
      ),
    },
    {
      header: t('col_type'),
      width: 140,
      render: (th) => (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          <span style={badgeStyle('#4b45c6')}>{t('badge_system')}</span>
          {th.is_system_default && <span style={badgeStyle('#059669')}>{t('badge_default')}</span>}
        </div>
      ),
    },
    {
      header: '',
      width: 72,
      render: (th) => (
        <div style={{ display: 'flex', gap: 3 }}>
          {([th.tokens?.colors?.sidebarSelectedBackground, th.tokens?.colors?.headerBackground, th.tokens?.colors?.appBackground] as (string | undefined)[]).map((c, i) => (
            <div key={i} title={['Primary', 'Secondary', 'Background'][i]} style={{ width: 18, height: 18, borderRadius: 3, background: c ?? '#ccc', border: '1px solid #ddd' }} />
          ))}
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
      width: 130,
      render: (th) => (
        th.status !== 'deleted' ? (
          <select
            value={th.status}
            disabled={statusSaving === th.id}
            onChange={(e) => handleStatusChange(th, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #ddd', fontSize: 12, cursor: 'pointer', background: '#fff' }}
          >
            {(['draft', 'active'] as const).map((s) => (
              <option key={s} value={s}>{tStatus(s)}</option>
            ))}
          </select>
        ) : (
          <StatusBadge status={th.status} label={tStatus(th.status)} />
        )
      ),
    },
    {
      header: t('col_actions'),
      width: 60,
      render: (th) => {
        const items = [];
        if (th.status !== 'deleted') {
          items.push({ label: t('edit'), onClick: () => openExpand(th) });
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

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter} options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))} allLabel={tStatus('all')} />
          <button onClick={() => { setAddForm(emptyForm); setAddError(null); setAddLogoFile(null); setAddLogoPreview(null); setAddOpen(true); }} style={btnStyle('#6c63ff')}>{t('add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={themes}
        rowKey={(th) => th.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
        expandedRowKeys={expandedId ? new Set([expandedId]) : new Set()}
        renderExpanded={(th) => renderInlineEditor(th)}
        onToggleExpand={(th) => th.status !== 'deleted' && openExpand(th)}
      />

      {/* Add modal */}
      <CrudModal open={addOpen} title={t('modal_add')} error={addError} saving={addSaving} cancelLabel={t('cancel')} saveLabel={addSaving ? t('saving') : t('save_changes')} onCancel={() => setAddOpen(false)} onSave={handleAdd}>
        <FormLabel>{t('label_name')}</FormLabel>
        <FormInput value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="My Brand" autoFocus />
        <FormLabel>{t('label_description')}</FormLabel>
        <textarea value={addForm.description} onChange={(e) => setAddForm({ ...addForm, description: e.target.value })} rows={2} style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }} />
        <FormLabel>{t('label_logo')}</FormLabel>
        {addLogoPreview && (
          <div style={{ marginBottom: 8 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={addLogoPreview} alt="logo preview" style={{ maxHeight: 60, maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4 }} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={() => addFileInputRef.current?.click()} style={btnSmall('#444')}>{t('logo_upload')}</button>
          {addLogoPreview && <button type="button" onClick={() => { setAddLogoFile(null); setAddLogoPreview(null); }} style={btnSmall('#c0392b')}>{t('logo_clear')}</button>}
        </div>
        <input ref={addFileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; setAddLogoFile(f); const r = new FileReader(); r.onload = (ev) => setAddLogoPreview(ev.target?.result as string); r.readAsDataURL(f); }} />
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
