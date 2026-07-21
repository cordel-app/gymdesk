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
  gym_id: string | null;
  name: string;
  status: 'draft' | 'active' | 'deleted';
  is_base: boolean;
  has_logo: boolean;
  logo_updated_at: string | null;
  tokens: ThemeTokens;
  created_at: string;
  modified_at: string | null;
}

interface AssignmentCenter {
  id: string;
  name: string;
  is_inherited: boolean;
}

interface Assignments {
  is_org_default: boolean;
  centers: AssignmentCenter[];
}

interface UnassignedCenter {
  id: string;
  name: string;
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

type TabKey = 'branding' | 'typography' | 'colors' | 'assignments';

const emptyForm = { name: '', tokens: DEFAULT_TOKENS };
const CENTERS_INITIAL_LIMIT = 10;

export default function GymThemesPage() {
  const t = useTranslations('gym_themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { getToken } = useAuth();
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin, loading: gymLoading, refreshGyms } = useGym();
  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
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

  // Assignments state
  const [assignments, setAssignments] = useState<Assignments | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [centersSearch, setCentersSearch] = useState('');
  const [showAllCenters, setShowAllCenters] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  // Assign centers picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerThemeId, setPickerThemeId] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState<UnassignedCenter[]>([]);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());
  const [pickerSaving, setPickerSaving] = useState(false);

  // (no direct create — gym admins create themes by cloning an existing one)

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
    if (!isAdmin) { router.replace(`/${locale}`); return; }
    load();
  }, [gymLoading, isAdmin]);

  useEffect(() => { if (!gymLoading && isAdmin) load(); }, [statusFilter]);

  async function load() {
    setLoading(true);
    try {
      const data = await apiFetch<Theme[]>(`/system/themes${statusFilter ? `?status=${statusFilter}` : ''}`);
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
    setEditTab(theme.is_base ? 'assignments' : 'branding');
    setEditError(null);
    setEditLogoFile(null);
    setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
    setAssignments(null);
    setCentersSearch('');
    setShowAllCenters(false);
  }

  async function loadAssignments(themeId: string) {
    setAssignmentsLoading(true);
    try {
      const data = await apiFetch<Assignments>(`/system/themes/${themeId}/assignments`);
      setAssignments(data);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setAssignmentsLoading(false);
    }
  }

  useEffect(() => {
    if (expandedId && editTab === 'assignments') {
      loadAssignments(expandedId);
    }
  }, [editTab, expandedId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSetDefault(themeId: string) {
    setSettingDefault(true);
    try {
      await apiFetch(`/system/themes/${themeId}/set-default`, { method: 'PUT' });
      await Promise.all([loadAssignments(themeId), refreshGyms()]);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setSettingDefault(false);
    }
  }

  async function handleRestoreInheritance(themeId: string, centerId: string) {
    setRestoringId(centerId);
    try {
      await apiFetch(`/system/themes/${themeId}/centers/${centerId}`, { method: 'DELETE' });
      await loadAssignments(themeId);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setRestoringId(null);
    }
  }

  async function openPicker(themeId: string) {
    setPickerThemeId(themeId);
    setPickerSearch('');
    setPickerSelected(new Set());
    try {
      const data = await apiFetch<UnassignedCenter[]>(`/system/themes/${themeId}/unassigned-centers`);
      setUnassigned(data);
      setPickerOpen(true);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handlePickerAssign() {
    if (!pickerThemeId || pickerSelected.size === 0) return;
    setPickerSaving(true);
    try {
      await apiFetch(`/system/themes/${pickerThemeId}/assign-centers`, {
        method: 'POST',
        body: JSON.stringify({ center_ids: Array.from(pickerSelected) }),
      });
      setPickerOpen(false);
      await loadAssignments(pickerThemeId);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setPickerSaving(false);
    }
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
      await Promise.all([load(), refreshGyms()]);
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
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

  function handleEditFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setEditLogoFile(file);
    const reader = new FileReader();
    reader.onload = (ev) => setEditLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
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
      toast(err.message ?? t('error_generic'));
    }
  }

  if (gymLoading || !isAdmin) return null;

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

  function renderAssignmentsTab(theme: Theme) {
    if (assignmentsLoading || !assignments) {
      return <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>;
    }

    const filteredCenters = assignments.centers.filter((c) =>
      c.name.toLowerCase().includes(centersSearch.toLowerCase()),
    );
    const visibleCenters = showAllCenters ? filteredCenters : filteredCenters.slice(0, CENTERS_INITIAL_LIMIT);

    return (
      <div>
        {/* Org default checkbox */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: '1px solid #eee', marginBottom: 16 }}>
          <input
            type="checkbox"
            id={`org-default-${theme.id}`}
            checked={assignments.is_org_default}
            disabled={assignments.is_org_default || settingDefault}
            onChange={() => !assignments.is_org_default && handleSetDefault(theme.id)}
            style={{ width: 16, height: 16, cursor: assignments.is_org_default ? 'default' : 'pointer' }}
          />
          <label htmlFor={`org-default-${theme.id}`} style={{ fontSize: 14, fontWeight: 500, cursor: assignments.is_org_default ? 'default' : 'pointer' }}>
            {t('assign_org_default')}
          </label>
        </div>

        {/* Centers section */}
        <div style={{ marginBottom: 8 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>{t('assign_centers_title')} ({assignments.centers.length})</p>
          <input
            type="text"
            value={centersSearch}
            onChange={(e) => { setCentersSearch(e.target.value); setShowAllCenters(false); }}
            placeholder={t('assign_centers_search')}
            style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 14, marginBottom: 8, boxSizing: 'border-box' }}
          />

          {filteredCenters.length === 0 ? (
            <p style={{ color: '#888', fontSize: 13 }}>{t('assign_no_centers')}</p>
          ) : (
            <>
              {visibleCenters.map((center) => (
                <div key={center.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: 14 }}>{center.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{
                      fontSize: 12, padding: '2px 8px', borderRadius: 12,
                      background: center.is_inherited ? '#f0f0f0' : '#e8f0fe',
                      color: center.is_inherited ? '#666' : '#1a56db',
                    }}>
                      {center.is_inherited ? t('assign_inherited') : t('assign_assigned')}
                    </span>
                    {!center.is_inherited && (
                      <button
                        onClick={() => handleRestoreInheritance(theme.id, center.id)}
                        disabled={restoringId === center.id}
                        style={btnSmall('#888')}
                      >
                        {t('assign_restore')}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {!showAllCenters && filteredCenters.length > CENTERS_INITIAL_LIMIT && (
                <button
                  onClick={() => setShowAllCenters(true)}
                  style={{ marginTop: 8, background: 'none', border: 'none', color: '#6c63ff', cursor: 'pointer', fontSize: 13, padding: 0 }}
                >
                  {t('assign_centers_show_all').replace('{count}', String(filteredCenters.length))}
                </button>
              )}
            </>
          )}
        </div>

        <div style={{ marginTop: 12 }}>
          <button onClick={() => openPicker(theme.id)} style={btnSmall('#6c63ff')}>{t('assign_centers_btn')}</button>
        </div>
      </div>
    );
  }

  function renderInlineEditor(theme: Theme) {
    if (expandedId !== theme.id) return null;
    const isBase = theme.is_base;

    const tabs: TabKey[] = isBase ? ['assignments'] : ['branding', 'typography', 'colors', 'assignments'];

    return (
      <div style={{ padding: '20px 24px', borderTop: '1px solid #eee', background: '#fafafa' }}>
        {isBase && (
          <p style={{ margin: '0 0 14px', fontSize: 12, color: '#888', fontStyle: 'italic' }}>{t('read_only_hint')}</p>
        )}
        {editError && (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: '#c0392b' }}>{editError}</p>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid #eee', paddingBottom: 8 }}>
          {tabs.map((tab) => (
            <button key={tab} type="button" onClick={() => setEditTab(tab)} style={tabStyle(isBase ? tab === 'assignments' : editTab === tab)}>
              {t(`tab_${tab}` as any)}
            </button>
          ))}
        </div>

        {!isBase && editTab === 'branding' && (
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

        {!isBase && editTab === 'typography' && (
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

        {!isBase && editTab === 'colors' && (
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

        {(editTab === 'assignments' || isBase) && renderAssignmentsTab(theme)}

        {!isBase && editTab !== 'assignments' && (
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
            <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={() => handleSave(theme)} disabled={saving} style={btnSmall('#6c63ff')}>
              {saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        )}

        {(editTab === 'assignments' || isBase) && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          </div>
        )}
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
    if (!isDeleted && !theme.is_base) {
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

          {/* Name + badge */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 15 }}>{theme.name}</span>
            {theme.is_base && (
              <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 10, background: '#f0f0f0', color: '#666', fontWeight: 500 }}>
                {t('badge_system')}
              </span>
            )}
          </div>

          {/* Color swatches */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <div title={t('label_app_bg')} style={{ width: 20, height: 20, borderRadius: 4, background: theme.tokens?.colors?.appBackground ?? '#f5f5f5', border: '1px solid #ddd' }} />
            <div title={t('label_header_bg')} style={{ width: 20, height: 20, borderRadius: 4, background: theme.tokens?.colors?.headerBackground ?? '#1a1a2e', border: '1px solid #ddd' }} />
          </div>

          {/* Status */}
          {!theme.is_base && <StatusBadge status={theme.status} label={tStatus(theme.status)} />}

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

  const basethemes = themes.filter((t) => t.is_base);
  const myThemes = themes.filter((t) => !t.is_base);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <StatusFilter
          value={statusFilter}
          onChange={setStatusFilter}
          options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))}
          allLabel={tStatus('all')}
        />
      </div>

      {loading ? (
        <p style={{ color: '#888' }}>{t('loading')}</p>
      ) : (
        <>
          {basethemes.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('section_system')}</p>
              {basethemes.map(renderThemeRow)}
            </div>
          )}
          {myThemes.length > 0 && (
            <div>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('section_mine')}</p>
              {myThemes.map(renderThemeRow)}
            </div>
          )}
          {themes.length === 0 && <p style={{ color: '#888' }}>{t('empty')}</p>}
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

      {/* Assign centers picker */}
      <CrudModal
        open={pickerOpen}
        title={t('picker_title')}
        error={null}
        saving={pickerSaving}
        cancelLabel={t('picker_cancel')}
        saveLabel={pickerSaving ? t('picker_saving') : t('picker_save')}
        onCancel={() => setPickerOpen(false)}
        onSave={handlePickerAssign}
      >
        <FormInput
          value={pickerSearch}
          onChange={(e) => setPickerSearch(e.target.value)}
          placeholder={t('picker_search')}
          autoFocus
        />
        <div style={{ marginTop: 12, maxHeight: 300, overflowY: 'auto' }}>
          {unassigned.filter((c) => c.name.toLowerCase().includes(pickerSearch.toLowerCase())).length === 0 ? (
            <p style={{ color: '#888', fontSize: 13 }}>{t('picker_empty')}</p>
          ) : (
            unassigned
              .filter((c) => c.name.toLowerCase().includes(pickerSearch.toLowerCase()))
              .map((c) => (
                <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}>
                  <input
                    type="checkbox"
                    checked={pickerSelected.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(pickerSelected);
                      if (e.target.checked) next.add(c.id); else next.delete(c.id);
                      setPickerSelected(next);
                    }}
                    style={{ width: 16, height: 16 }}
                  />
                  <span style={{ fontSize: 14 }}>{c.name}</span>
                </label>
              ))
          )}
        </div>
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
