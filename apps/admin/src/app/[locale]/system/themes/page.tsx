'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useAuth } from '@clerk/nextjs';
import { useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal } from '@/components/CrudModal';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { COLOR_GROUPS, ThemeColorsEditor, ThemeTypographyEditor } from '@/components/ThemeTokensEditor';
import { btnStyle, btnSmall } from '@/components/ui';
import { DEFAULT_TOKENS, applyTokens, getLiveTokens, tokensEqual, type ThemeTokens } from '@/lib/themeTokens';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Theme {
  id: string;
  gym_id: string | null;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'inactive' | 'deleted';
  type: 'system' | 'custom';
  has_logo: boolean;
  logo_updated_at: string | null;
  logo_contains_gym_name: boolean;
  tokens: ThemeTokens;
  created_at: string;
  modified_at: string | null;
  deleted_at: string | null;
  usage_count: number;
  is_system_default: boolean;
}

interface ThemeDetail extends Theme {
  created_by_name: string | null;
  modified_by_name: string | null;
  deleted_by_name: string | null;
}

const STATUSES = ['draft', 'active', 'inactive', 'deleted'] as const;
const EDITABLE_STATUSES = ['draft', 'active', 'inactive'] as const;

type SectionKey = 'general' | 'colors' | 'typography';

const NEW_ID = 'new';

function emptyEditForm(theme?: Theme) {
  return {
    name: theme?.name ?? '',
    description: theme?.description ?? '',
    status: (theme?.status ?? 'active') as string,
    logoContainsGymName: theme?.logo_contains_gym_name ?? false,
    // Merge with defaults so themes saved before #489 stage 2 (missing the newer
    // semantic color fields) still populate every color picker with a sensible value.
    tokens: {
      ...DEFAULT_TOKENS,
      ...theme?.tokens,
      colors: { ...DEFAULT_TOKENS.colors, ...theme?.tokens?.colors },
    },
  };
}
type EditForm = ReturnType<typeof emptyEditForm>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(value: string | null, locale: string): string {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function badgeStyle(color: string): React.CSSProperties {
  return { display: 'inline-block', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: color + '18', color, border: `1px solid ${color}40` };
}

function ColorSwatch({ color, size = 20, title }: { color: string | undefined; size?: number; title?: string }) {
  return (
    <div
      title={title}
      style={{ width: size, height: size, borderRadius: 4, background: color ?? '#ccc', border: '1px solid rgba(0,0,0,0.12)', flexShrink: 0 }}
    />
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ color: '#888', fontSize: 13.5, width: 180, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5 }}>{value}</span>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', borderRadius: 6,
  border: '1px solid #ccc', fontSize: 15, boxSizing: 'border-box', background: '#fff',
};

const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: 4, marginTop: 14, fontSize: 13, fontWeight: 600, color: '#555',
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function ThemesPage() {
  const t = useTranslations('themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { getToken } = useAuth();
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { centers, activeCenterId } = useCenter();
  const { toast } = useToast();

  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [hasNewRow, setHasNewRow] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['general']));

  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [editLogoFile, setEditLogoFile] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const [logoRemovePending, setLogoRemovePending] = useState(false);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  // Draft snapshot the current editForm is compared against for the dirty
  // state (#492) — set when entering edit mode, cleared once Save succeeds.
  const origFormRef = useRef<EditForm | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const [deleting, setDeleting] = useState<Theme | null>(null);
  const [detailsTheme, setDetailsTheme] = useState<ThemeDetail | null>(null);
  const [detailsLoading, setDetailsLoading] = useState(false);

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
      setThemes([]);
      toast(err.message ?? t('error_generic'));
    } finally {
      setLoading(false);
    }
  }

  // ─── Logo ──────────────────────────────────────────────────────────────────

  function logoUrl(theme: Theme) {
    return `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`;
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

  // Deferred — the actual DELETE only fires on Save (#492), so editing the
  // logo never mutates the persisted Theme until the user commits the draft.
  function queueLogoRemove() {
    setEditLogoFile(null);
    setEditLogoPreview(null);
    setLogoRemovePending(true);
  }

  function handleEditFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setEditLogoFile(file);
    setLogoRemovePending(false);
    const reader = new FileReader();
    reader.onload = (ev) => setEditLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  // ─── Draft / live preview (#492) ───────────────────────────────────────────

  // The tokens actually painting the app chrome right now, independent of
  // which theme (if any) is being edited — the restore point for Cancel.
  function currentLiveTokens(): ThemeTokens {
    return getLiveTokens(activeGym?.theme?.tokens as ThemeTokens | undefined, centers, activeCenterId);
  }

  function isDirty(): boolean {
    if (editingId === null || !origFormRef.current) return false;
    const orig = origFormRef.current;
    return (
      editForm.name !== orig.name ||
      editForm.description !== orig.description ||
      editForm.status !== orig.status ||
      editForm.logoContainsGymName !== orig.logoContainsGymName ||
      !tokensEqual(editForm.tokens, orig.tokens) ||
      editLogoFile !== null ||
      logoRemovePending
    );
  }

  // Draft-only — never persists. Live preview is applied immediately so the
  // user sees the effect without waiting for Save.
  function updateTokens(next: ThemeTokens) {
    setEditForm((prev) => ({ ...prev, tokens: next }));
    applyTokens(next);
  }

  function guardUnsaved(action: () => void) {
    if (isDirty()) setPendingAction(() => action);
    else action();
  }

  useEffect(() => {
    if (!isDirty()) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editForm, editLogoFile, logoRemovePending, editingId]);

  // ─── Expand / Edit ─────────────────────────────────────────────────────────

  function toggleExpand(id: string) {
    if (editingId === id) return;
    guardUnsaved(() => {
      if (editingId !== null) { applyTokens(currentLiveTokens()); setEditingId(null); }
      setExpandedId((prev) => (prev === id ? null : id));
    });
  }

  function enterEdit(theme: Theme) {
    guardUnsaved(() => {
      setExpandedId(theme.id);
      setEditingId(theme.id);
      const form = emptyEditForm(theme);
      setEditForm(form);
      origFormRef.current = form;
      setEditError(null);
      setEditLogoFile(null);
      setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
      setLogoRemovePending(false);
      setOpenSections(new Set(['general']));
    });
  }

  function cancelEdit() {
    applyTokens(currentLiveTokens());
    const theme = themes.find((th) => th.id === editingId);
    if (editingId === NEW_ID) {
      setHasNewRow(false);
      setExpandedId(null);
    } else if (theme) {
      setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
    }
    setEditingId(null);
    setEditError(null);
    setEditLogoFile(null);
    setLogoRemovePending(false);
  }

  // ─── New Theme (temp row) ──────────────────────────────────────────────────

  function handleNew() {
    if (hasNewRow) return;
    guardUnsaved(() => {
      setHasNewRow(true);
      setExpandedId(NEW_ID);
      setEditingId(NEW_ID);
      const form = emptyEditForm();
      setEditForm(form);
      origFormRef.current = form;
      setEditError(null);
      setLogoRemovePending(false);
      setOpenSections(new Set(['general']));
    });
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  async function handleSave(id: string) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setEditSaving(true);
    setEditError(null);
    try {
      if (id === NEW_ID) {
        await apiFetch('/platform/themes', {
          method: 'POST',
          body: JSON.stringify({
            name: editForm.name.trim(),
            description: editForm.description.trim() || null,
            status: editForm.status,
            logo_contains_gym_name: editForm.logoContainsGymName,
          }),
        });
        setHasNewRow(false);
        setExpandedId(null);
        setEditingId(null);
      } else {
        await apiFetch(`/platform/themes/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: editForm.name.trim(),
            description: editForm.description.trim() || null,
            status: editForm.status,
            logo_contains_gym_name: editForm.logoContainsGymName,
            tokens: editForm.tokens,
          }),
        });
        if (editLogoFile) {
          await uploadLogo(id);
        } else if (logoRemovePending) {
          await apiFetch(`/platform/themes/${id}/logo`, { method: 'DELETE' });
        }
        // Stay on the editor with a clean draft rather than collapsing back
        // to the read-only view — the user may keep iterating (#492).
        origFormRef.current = { ...editForm, name: editForm.name.trim(), description: editForm.description.trim() };
        setEditForm(origFormRef.current);
        setEditLogoFile(null);
        setLogoRemovePending(false);
      }
      load();
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setEditSaving(false);
    }
  }

  // ─── Duplicate ─────────────────────────────────────────────────────────────

  async function handleDuplicate(theme: Theme) {
    try {
      const dup = await apiFetch<Theme>(`/platform/themes/clone/${theme.id}`, {
        method: 'POST',
        body: JSON.stringify({ name: `${theme.name} (copy)` }),
      });
      await load();
      enterEdit(dup);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete() {
    if (!deleting) return;
    try {
      await apiFetch(`/platform/themes/${deleting.id}`, { method: 'DELETE' });
      setDeleting(null);
      load();
    } catch (err: any) {
      setDeleting(null);
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Set system default ────────────────────────────────────────────────────

  async function handleSetSystemDefault(theme: Theme) {
    try {
      await apiFetch(`/platform/themes/${theme.id}/set-system-default`, { method: 'PUT' });
      toast(t('toast_system_default_set'), 'success');
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  // ─── Details ───────────────────────────────────────────────────────────────

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

  // ─── Labels ────────────────────────────────────────────────────────────────

  function usageLabel(theme: Theme): string {
    const n = theme.usage_count;
    if (n === 0) return t('usage_unused');
    return n === 1 ? t('usage_org_singular') : t('usage_org_plural').replace('{count}', String(n));
  }

  // ─── Section helper (edit mode) ────────────────────────────────────────────

  function renderSection(key: SectionKey, title: string, content: React.ReactNode) {
    const open = openSections.has(key);
    return (
      <div style={{ borderTop: '1px solid var(--gd-border, #eee)' }}>
        <button
          type="button"
          onClick={() => setOpenSections((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: 'var(--gd-section-heading-text, #888888)', textAlign: 'left' }}
        >
          {title}
          <span style={{ fontSize: 12, color: '#aaa', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>&#9662;</span>
        </button>
        {open && <div style={{ paddingBottom: 16 }}>{content}</div>}
      </div>
    );
  }

  // ─── Read-only expanded view ────────────────────────────────────────────────

  function renderReadOnly(theme: Theme) {
    const colors = theme.tokens?.colors ?? DEFAULT_TOKENS.colors;
    return (
      <div style={{ padding: '16px 24px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 20 }}>
          {COLOR_GROUPS.filter(({ fields }) => fields.length > 0).map(({ groupKey, fields }) => (
            <div key={groupKey}>
              <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: 'var(--gd-section-heading-text, #888888)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{t(groupKey as any)}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {fields.map(({ key, labelKey }) => (
                  <ColorSwatch key={key} color={colors[key] as string | undefined} title={`${t(labelKey as any)}: ${colors[key] ?? '?'}`} size={22} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ─── Edit form ─────────────────────────────────────────────────────────────

  function renderEditForm(id: string, isNew: boolean) {
    return (
      <div style={{ padding: '0 24px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
        {editError && <p style={{ margin: '12px 0 0', fontSize: 13, color: '#c0392b' }}>{editError}</p>}

        <div style={{ marginTop: 12 }}>
          {renderSection('general', t('section_general'), (
            <div>
              <label style={labelStyle}>{t('label_name')}</label>
              <input
                type="text"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                placeholder={t('label_name')}
                style={{ ...selectStyle, marginBottom: 0 }}
                autoFocus={isNew}
              />

              <label style={labelStyle}>{t('label_status')}</label>
              <select
                value={editForm.status}
                onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                style={selectStyle}
              >
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>{tStatus(s)}</option>
                ))}
              </select>

              {!isNew && (
                <>
                  <label style={labelStyle}>{t('label_description')}</label>
                  <textarea
                    value={editForm.description}
                    onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    rows={2}
                    style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid #ccc', fontSize: 14, boxSizing: 'border-box', resize: 'vertical', fontFamily: 'inherit' }}
                  />

                  <label style={labelStyle}>{t('label_logo')}</label>
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
                      <button type="button" onClick={queueLogoRemove} style={btnSmall('#c0392b')}>
                        {t('logo_clear')}
                      </button>
                    )}
                  </div>
                  <input ref={editFileInputRef} type="file" accept="image/png,image/svg+xml,image/jpeg,image/webp" style={{ display: 'none' }} onChange={handleEditFileChange} />

                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 14, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={editForm.logoContainsGymName}
                      onChange={(e) => setEditForm({ ...editForm, logoContainsGymName: e.target.checked })}
                    />
                    {t('logo_contains_gym_name')}
                  </label>
                </>
              )}
            </div>
          ))}

          {!isNew && renderSection('colors', t('section_colors'), (
            <ThemeColorsEditor tokens={editForm.tokens} onChange={updateTokens} namespace="themes" t={t} />
          ))}

          {!isNew && renderSection('typography', t('section_typography'), (
            <ThemeTypographyEditor tokens={editForm.tokens} onChange={updateTokens} t={t} />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end', borderTop: '1px solid var(--gd-border, #eee)', paddingTop: 16 }}>
          <button onClick={cancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button
            onClick={() => handleSave(id)}
            disabled={editSaving || !isDirty()}
            style={{ ...btnSmall('#6c63ff'), opacity: (editSaving || !isDirty()) ? 0.5 : 1, cursor: (editSaving || !isDirty()) ? 'not-allowed' : 'pointer' }}
          >
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  // ─── Expanded row router ────────────────────────────────────────────────────

  function renderExpanded(theme: Theme) {
    if (editingId === theme.id) return renderEditForm(theme.id, theme.id === NEW_ID);
    return renderReadOnly(theme);
  }

  // ─── Columns ───────────────────────────────────────────────────────────────

  if (gymLoading || !isSuperadmin) return null;

  const newRowTheme: Theme = {
    id: NEW_ID,
    gym_id: null,
    name: t('new_theme_placeholder'),
    description: null,
    status: 'draft',
    type: 'system',
    has_logo: false,
    logo_updated_at: null,
    logo_contains_gym_name: false,
    tokens: DEFAULT_TOKENS,
    created_at: '',
    modified_at: null,
    deleted_at: null,
    usage_count: 0,
    is_system_default: false,
  };

  const tableRows: Theme[] = hasNewRow ? [newRowTheme, ...themes] : themes;

  const columns: Column<Theme>[] = [
    {
      header: t('col_color_preview'),
      width: 80,
      render: (th) => {
        if (th.id === NEW_ID) return null;
        const c = th.tokens?.colors;
        return (
          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            <ColorSwatch color={c?.primaryButton} title={`${t('label_primary_btn')}: ${c?.primaryButton ?? '?'}`} />
            <ColorSwatch color={c?.pageBackground} title={`${t('label_page_bg')}: ${c?.pageBackground ?? '?'}`} />
            <ColorSwatch color={c?.headerBackground} title={`${t('label_header_bg')}: ${c?.headerBackground ?? '?'}`} />
          </div>
        );
      },
    },
    {
      header: t('col_name'),
      render: (th) => (
        <div>
          <span style={{ fontWeight: 600 }}>{th.name}</span>
          {th.is_system_default && (
            <span style={{ ...badgeStyle('#059669'), marginLeft: 8 }}>{t('badge_default')}</span>
          )}
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
      width: 100,
      render: (th) => (th.id !== NEW_ID ? <span style={badgeStyle('#4b45c6')}>{t('badge_system')}</span> : null),
    },
    {
      header: t('col_usage'),
      width: 140,
      render: (th) => (th.id !== NEW_ID ? <span style={{ color: '#555', fontSize: 13.5 }}>{usageLabel(th)}</span> : null),
    },
    {
      header: t('col_status'),
      width: 110,
      render: (th) => (th.id !== NEW_ID ? <StatusBadge status={th.status} label={tStatus(th.status)} /> : null),
    },
    {
      header: t('col_actions'),
      width: 60,
      render: (th) => {
        if (th.id === NEW_ID) return null;
        const items = [];
        items.push({ label: t('action_details'), onClick: () => openDetails(th) });
        if (th.status !== 'deleted') {
          items.push({ label: t('edit'), onClick: () => enterEdit(th) });
          items.push({ label: t('action_duplicate'), onClick: () => handleDuplicate(th) });
        }
        if (th.status === 'active' && !th.is_system_default) {
          items.push({ label: t('action_set_system_default'), onClick: () => handleSetSystemDefault(th) });
        }
        if (th.status !== 'deleted') {
          items.push({ label: t('delete'), onClick: () => setDeleting(th), danger: true });
        }
        return <ContextMenu items={items} ariaLabel={t('col_actions')} />;
      },
    },
  ];

  // ─── Details modal content ─────────────────────────────────────────────────

  function renderDetailsContent() {
    if (detailsLoading) return <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>;
    if (!detailsTheme) return null;
    const c = detailsTheme.tokens?.colors ?? DEFAULT_TOKENS.colors;
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <DetailRow label={t('details_name')} value={detailsTheme.name} />
        <DetailRow
          label={t('details_type')}
          value={
            <div style={{ display: 'flex', gap: 4 }}>
              <span style={badgeStyle('#4b45c6')}>{t('badge_system')}</span>
              {detailsTheme.is_system_default && <span style={badgeStyle('#059669')}>{t('badge_default')}</span>}
            </div>
          }
        />
        <DetailRow label={t('details_status')} value={<StatusBadge status={detailsTheme.status} label={tStatus(detailsTheme.status)} />} />
        <DetailRow label={t('details_usage')} value={usageLabel(detailsTheme)} />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow
          label={t('details_primary_color')}
          value={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ColorSwatch color={c.primaryButton} size={18} /><span style={{ fontSize: 12, color: '#555' }}>{c.primaryButton}</span></div>}
        />
        <DetailRow
          label={t('details_bg_primary')}
          value={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ColorSwatch color={c.pageBackground} size={18} /><span style={{ fontSize: 12, color: '#555' }}>{c.pageBackground}</span></div>}
        />
        <DetailRow
          label={t('details_bg_secondary')}
          value={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ColorSwatch color={c.cardBackground} size={18} /><span style={{ fontSize: 12, color: '#555' }}>{c.cardBackground}</span></div>}
        />
        <DetailRow
          label={t('details_bg_tertiary')}
          value={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ColorSwatch color={c.headerBackground} size={18} /><span style={{ fontSize: 12, color: '#555' }}>{c.headerBackground}</span></div>}
        />
        <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
        <DetailRow label={t('details_created_by')} value={detailsTheme.created_by_name ?? '—'} />
        <DetailRow label={t('details_created_at')} value={formatDate(detailsTheme.created_at, locale)} />
        <DetailRow label={t('details_modified_by')} value={detailsTheme.modified_by_name ?? '—'} />
        <DetailRow label={t('details_modified_at')} value={formatDate(detailsTheme.modified_at, locale)} />
        {detailsTheme.deleted_at && (
          <>
            <DetailRow label={t('details_deleted_by')} value={detailsTheme.deleted_by_name ?? '—'} />
            <DetailRow label={t('details_deleted_at')} value={formatDate(detailsTheme.deleted_at, locale)} />
          </>
        )}
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <div style={{ display: 'flex', gap: 10 }}>
          <StatusFilter value={statusFilter} onChange={setStatusFilter} options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))} allLabel={tStatus('all')} />
          <button onClick={handleNew} disabled={hasNewRow} style={btnStyle('#6c63ff')}>{t('add')}</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={tableRows}
        rowKey={(th) => th.id}
        loading={loading}
        loadingText={t('loading')}
        emptyText={t('empty')}
        expandedRowKeys={expandedId ? new Set([expandedId]) : new Set()}
        renderExpanded={(th) => renderExpanded(th)}
        onToggleExpand={(th) => {
          if (th.id === NEW_ID) return;
          if (th.status !== 'deleted') toggleExpand(th.id);
        }}
      />

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
        {renderDetailsContent()}
      </CrudModal>

      <ConfirmDialog
        open={deleting !== null}
        message={t('confirm_delete')}
        confirmLabel={t('delete')}
        cancelLabel={t('cancel')}
        onConfirm={handleDelete}
        onCancel={() => setDeleting(null)}
      />

      <ConfirmDialog
        open={pendingAction !== null}
        message={t('unsaved_changes')}
        confirmLabel={t('unsaved_discard')}
        cancelLabel={t('cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          cancelEdit();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
