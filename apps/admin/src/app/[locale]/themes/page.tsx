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
import { btnStyle, btnSmall } from '@/components/ui';
import { DEFAULT_TOKENS, FONT_STACKS, type ThemeTokens } from '@/lib/themeTokens';

interface Theme {
  id: string;
  gym_id: string | null;
  name: string;
  status: 'draft' | 'active' | 'deleted';
  is_base: boolean;
  has_logo: boolean;
  logo_updated_at: string | null;
  tokens: ThemeTokens;
  created_at: string;
}

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

export default function GymThemesPage() {
  const t = useTranslations('gym_themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { getToken } = useAuth();
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { toast } = useToast();

  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);

  // Inline editor state
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState(emptyForm);
  const [editTab, setEditTab] = useState<TabKey>('branding');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editLogoFile, setEditLogoFile] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);

  // Clone modal state
  const [cloning, setCloning] = useState<Theme | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneSaving, setCloneSaving] = useState(false);

  // Delete confirm state
  const [deleting, setDeleting] = useState<Theme | null>(null);

  useEffect(() => {
    if (gymLoading) return;
    if (!isAdmin) {
      router.replace(`/${locale}`);
      return;
    }
    load();
  }, [gymLoading, isAdmin]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Theme[]>('/system/themes');
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
    if (expandedId === theme.id) {
      setExpandedId(null);
      return;
    }
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
      await apiFetch(`/system/themes/${theme.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: editForm.name.trim(), tokens: editForm.tokens }),
      });
      if (editLogoFile) {
        const token = await getToken();
        const res = await fetch(`/api/proxy/system/themes/${theme.id}/logo`, {
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

  async function handleActivate(theme: Theme) {
    try {
      await apiFetch(`/system/themes/${theme.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: theme.status === 'active' ? 'draft' : 'active' }),
      });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleLogoRemove(theme: Theme) {
    try {
      await apiFetch(`/system/themes/${theme.id}/logo`, { method: 'DELETE' });
      setEditLogoPreview(null);
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
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
      await apiFetch(`/system/themes/clone/${cloning.id}`, {
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
      await apiFetch(`/system/themes/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      if (err.message?.includes('assigned')) toast(t('error_conflict'));
      else toast(err.message ?? t('error_generic'));
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

  if (gymLoading) return null;

  const systemThemes = themes.filter((th) => th.is_base);
  const myThemes = themes.filter((th) => !th.is_base);

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

  function renderInlineEditor(theme: Theme, readOnly: boolean) {
    if (expandedId !== theme.id) return null;
    return (
      <div style={{ padding: '20px 24px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        {readOnly && (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#888', fontStyle: 'italic' }}>{t('read_only_hint')}</p>
        )}
        {!readOnly && editError && (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c0392b' }}>{editError}</p>
        )}

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #eee', paddingBottom: 8 }}>
          {(['branding', 'typography', 'colors'] as TabKey[]).map((tab) => (
            <button key={tab} type="button" onClick={() => setEditTab(tab)} style={tabStyle(editTab === tab)}>
              {t(`tab_${tab}` as any)}
            </button>
          ))}
        </div>

        {/* Branding */}
        {editTab === 'branding' && (
          <div>
            <FormLabel>{t('label_name')}</FormLabel>
            <FormInput
              value={editForm.name}
              onChange={(e) => !readOnly && setEditForm({ ...editForm, name: e.target.value })}
              placeholder="My Brand"
              disabled={readOnly}
            />

            <FormLabel>{t('label_logo')}</FormLabel>
            <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>{t('logo_hint')}</p>
            {editLogoPreview && (
              <div style={{ marginBottom: 8 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={editLogoPreview} alt="logo preview" style={{ maxHeight: 60, maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4 }} />
              </div>
            )}
            {!readOnly && (
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
            )}
            <input ref={editFileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleEditFileChange} />
          </div>
        )}

        {/* Typography */}
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
                      disabled={readOnly}
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
                      disabled={readOnly}
                      onChange={(e) => setEditForm({
                        ...editForm,
                        tokens: { ...editForm.tokens, typography: { ...editForm.tokens.typography, [lv]: { ...typo, color: e.target.value } } },
                      })}
                      style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: readOnly ? 'default' : 'pointer', padding: 2 }}
                    />
                  </>
                );
              })}
            </div>
          </div>
        )}

        {/* Colors */}
        {editTab === 'colors' && (
          <div>
            {COLOR_FIELDS.map(({ key, labelKey }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t(labelKey as any)}</span>
                <input
                  type="color"
                  value={editForm.tokens.colors[key] as string}
                  disabled={readOnly}
                  onChange={(e) => setEditForm({
                    ...editForm,
                    tokens: { ...editForm.tokens, colors: { ...editForm.tokens.colors, [key]: e.target.value } },
                  })}
                  style={{ width: 48, height: 36, border: '1px solid #ccc', borderRadius: 4, cursor: readOnly ? 'default' : 'pointer', padding: 2 }}
                />
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{t('label_header_sep_height')}</span>
              <input
                type="number"
                min={0}
                max={20}
                disabled={readOnly}
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

        {!readOnly && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={() => handleSave(theme)} disabled={saving} style={btnSmall('#6c63ff')}>
              {saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        )}
        {readOnly && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          </div>
        )}
      </div>
    );
  }

  function renderThemeRow(theme: Theme) {
    const isExpanded = expandedId === theme.id;
    const isBase = theme.is_base;

    const menuItems: ContextMenuItem[] = [
      {
        label: t('clone'),
        onClick: () => openClone(theme),
      },
    ];
    if (!isBase) {
      menuItems.push({
        label: theme.status === 'active' ? t('deactivate') : t('activate'),
        onClick: () => handleActivate(theme),
      });
      menuItems.push({
        label: t('edit'),
        onClick: () => openExpand(theme),
      });
      menuItems.push({
        label: t('delete'),
        onClick: () => setDeleting(theme),
        danger: true,
      });
    }

    return (
      <div key={theme.id} style={{ border: '1px solid #e2e2e6', borderRadius: 8, marginBottom: 10, overflow: 'hidden', background: '#fff' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: 'pointer' }}
          onClick={() => openExpand(theme)}
        >
          {/* Logo */}
          <div style={{ width: 40, flexShrink: 0 }}>
            {theme.has_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl(theme)} alt={theme.name} style={{ height: 28, width: 'auto', borderRadius: 4, objectFit: 'contain' }} />
            ) : (
              <div style={{ width: 36, height: 28, background: theme.tokens?.colors?.headerBackground ?? '#1a1a2e', borderRadius: 4 }} />
            )}
          </div>

          {/* Name + badge */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{theme.name}</span>
            <span style={{
              marginLeft: 8, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
              background: isBase ? '#e0f2fe' : '#f0fdf4',
              color: isBase ? '#0369a1' : '#166534',
            }}>
              {isBase ? t('badge_system') : t('badge_mine')}
            </span>
          </div>

          {/* Status */}
          {!isBase && (
            <StatusBadge status={theme.status} label={tStatus(theme.status)} />
          )}

          {/* Expand chevron */}
          <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>

          {/* Context menu */}
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>

        {isExpanded && renderInlineEditor(theme, isBase)}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : themes.length === 0 ? (
        <p style={{ color: '#888' }}>{t('empty')}</p>
      ) : (
        <>
          {systemThemes.length > 0 && (
            <section style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: '#555', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('section_system')}
              </h2>
              {systemThemes.map(renderThemeRow)}
            </section>
          )}

          {myThemes.length > 0 && (
            <section>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: '#555', marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                {t('section_mine')}
              </h2>
              {myThemes.map(renderThemeRow)}
            </section>
          )}
        </>
      )}

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
