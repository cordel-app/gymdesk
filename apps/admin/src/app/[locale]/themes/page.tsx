'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useToast } from '@/components/Toast';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { btnStyle, btnSmall } from '@/components/ui';
import { DEFAULT_TOKENS, FONT_STACKS, type ThemeTokens } from '@/lib/themeTokens';

interface Theme {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'deleted';
  has_logo: boolean;
  logo_updated_at: string | null;
  tokens: ThemeTokens;
  created_at: string;
  modified_at: string | null;
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

type TabKey = 'branding' | 'typography' | 'colors';

const emptyForm = { name: '', tokens: DEFAULT_TOKENS };

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

  // Inline editor state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [editTab, setEditTab] = useState<TabKey>('branding');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editLogoFile, setEditLogoFile] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  // Create modal state
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyForm);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSaving, setCreateSaving] = useState(false);

  // Clone modal state
  const [cloning, setCloning] = useState<Theme | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneSaving, setCloneSaving] = useState(false);

  // Details modal state
  const [details, setDetails] = useState<Theme | null>(null);

  // Delete confirm state
  const [deleting, setDeleting] = useState<Theme | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isSuperadmin) { router.replace(`/${locale}`); return; }
    load();
  }, [gymLoading, isSuperadmin]);

  useEffect(() => { if (!gymLoading && isSuperadmin) load(); }, [statusFilter]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Theme[]>(`/platform/themes${statusFilter ? `?status=${statusFilter}` : ''}`);
      setThemes(data);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  function logoUrl(theme: Theme) {
    return `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`;
  }

  function openExpand(theme: Theme) {
    if (expandedId === theme.id) { setExpandedId(null); return; }
    setExpandedId(theme.id);
    setEditForm({ name: theme.name, tokens: theme.tokens ?? DEFAULT_TOKENS });
    setEditTab('branding');
    setEditError(null);
    setEditLogoFile(null);
    setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
  }

  async function handleSave(theme: Theme) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/platform/themes/${theme.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editForm.name.trim(), tokens: editForm.tokens }),
      });
      if (editLogoFile) {
        const token = await getToken();
        const res = await fetch(`/api/proxy/platform/themes/${theme.id}/logo`, {
          method: 'POST',
          headers: { 'Content-Type': editLogoFile.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: editLogoFile,
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error(json.error ?? 'Logo upload failed');
        }
      }
      setExpandedId(null);
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  async function handleLogoRemove(theme: Theme) {
    try {
      await apiFetch(`/platform/themes/${theme.id}/logo`, { method: 'DELETE' });
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

  async function handleCreate() {
    if (!createForm.name.trim()) { setCreateError(t('error_required')); return; }
    setCreateSaving(true);
    setCreateError(null);
    try {
      await apiFetch('/platform/themes', {
        method: 'POST',
        body: JSON.stringify({ name: createForm.name.trim(), tokens: createForm.tokens }),
      });
      setCreateOpen(false);
      setCreateForm(emptyForm);
      load();
    } catch (err: any) {
      setCreateError(err.message ?? t('error_generic'));
    } finally {
      setCreateSaving(false);
    }
  }

  function openClone(theme: Theme) {
    setCloning(theme);
    setCloneName(`${theme.name} (copy)`);
    setCloneError(null);
  }

  async function handleClone() {
    if (!cloning) return;
    if (!cloneName.trim()) { setCloneError(t('error_required')); return; }
    setCloneSaving(true);
    setCloneError(null);
    try {
      await apiFetch(`/platform/themes/clone/${cloning.id}`, {
        method: 'POST',
        body: JSON.stringify({ name: cloneName.trim() }),
      });
      setCloning(null);
      load();
    } catch (err: any) {
      setCloneError(err.message ?? t('error_generic'));
    } finally {
      setCloneSaving(false);
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

  if (gymLoading || !isSuperadmin) return null;

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

  function renderInlineEditor(theme: Theme) {
    if (expandedId !== theme.id) return null;
    return (
      <div style={{ padding: '20px 24px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        {editError && (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c0392b' }}>{editError}</p>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #eee', paddingBottom: 8 }}>
          {(['branding', 'typography', 'colors'] as TabKey[]).map((tab) => (
            <button key={tab} type="button" onClick={() => setEditTab(tab)} style={tabStyle(editTab === tab)}>
              {t(`tab_${tab}` as any)}
            </button>
          ))}
        </div>

        {editTab === 'branding' && (
          <div>
            <FormLabel>{t('label_name')}</FormLabel>
            <FormInput
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              placeholder="My Brand"
            />
            <FormLabel>{t('label_logo')}</FormLabel>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>{t('logo_hint')}</p>
            {editLogoPreview && (
              <div style={{ marginBottom: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={editLogoPreview} alt="logo preview" style={{ maxHeight: 60, maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4 }} />
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => editFileInputRef.current?.click()} style={btnSmall('#444')}>
                {t('logo_upload')}
              </button>
              {editLogoPreview && (
                <button type="button" onClick={() => { setEditLogoFile(null); setEditLogoPreview(null); if (theme.has_logo) handleLogoRemove(theme); }} style={btnSmall('#c0392b')}>
                  {t('logo_clear')}
                </button>
              )}
            </div>
            <input ref={editFileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleEditFileChange} />
          </div>
        )}

        {editTab === 'typography' && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 100px', gap: '8px 12px', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_level')}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_font')}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#666' }}>{t('typography_color')}</span>
              {TYPO_LEVELS.map((lv) => {
                const typo = editForm.tokens.typography[lv];
                return (
                  <>
                    <span key={`${lv}-label`} style={{ fontSize: 13 }}>{lv}</span>
                    <select
                      key={`${lv}-font`}
                      value={typo.fontFamily}
                      onChange={(e) => setEditForm({
                        ...editForm,
                        tokens: { ...editForm.tokens, typography: { ...editForm.tokens.typography, [lv]: { ...typo, fontFamily: e.target.value } } },
                      })}
                      style={selectStyle}
                    >
                      {FONT_STACKS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    <input
                      key={`${lv}-color`}
                      type="color"
                      value={typo.color}
                      onChange={(e) => setEditForm({
                        ...editForm,
                        tokens: { ...editForm.tokens, typography: { ...editForm.tokens.typography, [lv]: { ...typo, color: e.target.value } } },
                      })}
                      style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', padding: 2 }}
                    />
                  </>
                );
              })}
            </div>
          </div>
        )}

        {editTab === 'colors' && (
          <div>
            {COLOR_FIELDS.map(({ key, labelKey }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t(labelKey as any)}</span>
                <input
                  type="color"
                  value={editForm.tokens.colors[key] as string}
                  onChange={(e) => setEditForm({
                    ...editForm,
                    tokens: { ...editForm.tokens, colors: { ...editForm.tokens.colors, [key]: e.target.value } },
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
                value={editForm.tokens.colors.headerSeparatorHeight}
                onChange={(e) => setEditForm({
                  ...editForm,
                  tokens: { ...editForm.tokens, colors: { ...editForm.tokens.colors, headerSeparatorHeight: Number(e.target.value) } },
                })}
                style={{ width: 80, padding: '6px 10px', border: '1px solid #ccc', borderRadius: 4, fontSize: 14 }}
              />
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSave(theme)} disabled={saving} style={btnSmall('#6c63ff')}>
            {saving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  function renderThemeRow(theme: Theme) {
    const isExpanded = expandedId === theme.id;
    const isDeleted = theme.status === 'deleted';

    const menuItems: ContextMenuItem[] = [
      { label: t('clone'), onClick: () => openClone(theme) },
      { label: t('details'), onClick: () => setDetails(theme) },
    ];
    if (!isDeleted) {
      menuItems.push({ label: t('delete'), onClick: () => setDeleting(theme), danger: true });
    }

    return (
      <div key={theme.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: '#fff' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: isDeleted ? 'default' : 'pointer' }}
          onClick={() => !isDeleted && openExpand(theme)}
        >
          {/* Logo / color swatch */}
          <div style={{ width: 40, flexShrink: 0 }}>
            {theme.has_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl(theme)} alt={theme.name} style={{ height: 28, width: 'auto', borderRadius: 4, objectFit: 'contain' }} />
            ) : (
              <div style={{ width: 36, height: 28, background: theme.tokens?.colors?.headerBackground ?? '#1a1a2e', borderRadius: 4 }} />
            )}
          </div>

          {/* Name */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{theme.name}</span>
          </div>

          {/* Color swatches */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <div title={t('label_app_bg')} style={{ width: 20, height: 20, borderRadius: 4, background: theme.tokens?.colors?.appBackground ?? '#f5f5f5', border: '1px solid #ddd' }} />
            <div title={t('label_header_bg')} style={{ width: 20, height: 20, borderRadius: 4, background: theme.tokens?.colors?.headerBackground ?? '#1a1a2e', border: '1px solid #ddd' }} />
          </div>

          {/* Status */}
          <StatusBadge status={theme.status} label={tStatus(theme.status)} />

          {/* Expand chevron */}
          {!isDeleted && (
            <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          )}

          {/* Context menu */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>

        {isExpanded && renderInlineEditor(theme)}
      </div>
    );
  }

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
          <button onClick={() => { setCreateForm(emptyForm); setCreateError(null); setCreateOpen(true); }} style={btnStyle('#6c63ff')}>
            {t('add')}
          </button>
        </div>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : themes.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        themes.map(renderThemeRow)
      )}

      {/* Create modal */}
      <CrudModal
        open={createOpen}
        title={t('modal_add')}
        error={createError}
        saving={createSaving}
        cancelLabel={t('cancel')}
        saveLabel={createSaving ? t('saving') : t('save_changes')}
        onCancel={() => setCreateOpen(false)}
        onSave={handleCreate}
      >
        <FormLabel>{t('label_name')}</FormLabel>
        <FormInput
          value={createForm.name}
          onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
          placeholder="My Brand"
          autoFocus
        />
      </CrudModal>

      {/* Clone modal */}
      <CrudModal
        open={cloning !== null}
        title={t('clone_title')}
        error={cloneError}
        saving={cloneSaving}
        cancelLabel={t('cancel')}
        saveLabel={cloneSaving ? t('saving') : t('clone_save')}
        onCancel={() => setCloning(null)}
        onSave={handleClone}
      >
        <FormLabel>{t('clone_name_label')}</FormLabel>
        <FormInput
          value={cloneName}
          onChange={(e) => setCloneName(e.target.value)}
          autoFocus
        />
      </CrudModal>

      {/* Details modal */}
      <CrudModal
        open={details !== null}
        title={t('details_title')}
        error={null}
        saving={false}
        hideSave
        cancelLabel={t('details_close')}
        saveLabel=""
        onCancel={() => setDetails(null)}
        onSave={() => setDetails(null)}
      >
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('label_name')}</span>
              <p style={{ margin: '4px 0 0', fontSize: 15 }}>{details.name}</p>
            </div>
            <div>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_created_at')}</span>
              <p style={{ margin: '4px 0 0', fontSize: 15 }}>{new Date(details.created_at).toLocaleString()}</p>
            </div>
            {details.modified_at && (
              <div>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase' }}>{t('details_modified_at')}</span>
                <p style={{ margin: '4px 0 0', fontSize: 15 }}>{new Date(details.modified_at).toLocaleString()}</p>
              </div>
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
