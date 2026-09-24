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
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { CrudModal, FormLabel, FormInput } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ThemeColorsEditor, ThemeTypographyEditor } from '@/components/ThemeTokensEditor';
import { ThemeSection, ThemeBrandingEditor } from '@/components/ThemeSectionEditor';
import {
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_SLOTS,
  ThemeMembersImagesEditor,
  type MemberImageSlot,
  type MembersImages,
} from '@/components/ThemeMembersImagesEditor';
import { btnSmall, cardSurfaceStyle } from '@/components/ui';
import { DEFAULT_TOKENS, applyTokens, getLiveTokens, tokensEqual, type ThemeTokens } from '@/lib/themeTokens';

interface Theme {
  id: string;
  gym_id: string | null;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'inactive' | 'deleted';
  is_base: boolean;
  has_logo: boolean;
  logo_updated_at: string | null;
  /** #713: R2 URL when the logo is stored in the gym's Cloudflare folder. */
  logo_url: string | null;
  logo_contains_gym_name: boolean;
  /** #725: one nullable URL per Members App background slot; six, always. */
  members_images: MembersImages;
  tokens: ThemeTokens;
  created_at: string;
  /** Actor snapshot captured when the theme was cloned into this gym (#712). */
  created_by_name: string | null;
  /** True when this is the theme `gyms.theme_id` currently points at (#712). */
  is_gym_theme: boolean;
  modified_at: string | null;
}

interface AssignmentCenter {
  id: string;
  name: string;
  is_inherited: boolean;
}

interface Assignments {
  is_gym_default: boolean;
  centers: AssignmentCenter[];
}

interface UnassignedCenter {
  id: string;
  name: string;
}

const STATUSES = ['draft', 'active', 'inactive', 'deleted'] as const;

// Assignments first, then Branding → Colors → Typography — the same set for a
// Base Theme and a Custom one (#678); see renderInlineEditor().
type SectionKey = 'branding' | 'members' | 'typography' | 'colors' | 'assignments';
const CENTERS_INITIAL_LIMIT = 10;

const emptyForm = { name: '', description: '', logoContainsGymName: false, tokens: DEFAULT_TOKENS };

/** One entry per Members image slot — the draft's shape for all three maps. */
function bySlot<T>(value: T): Record<MemberImageSlot, T> {
  return Object.fromEntries(MEMBER_IMAGE_SLOTS.map((slot) => [slot, value])) as Record<MemberImageSlot, T>;
}

export default function GymThemesPage() {
  const t = useTranslations('gym_themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { getToken } = useAuth();
  const { apiFetch } = useApiClient();
  const { activeGym, isSuperadmin, loading: gymLoading, refreshGyms } = useGym();
  const { centers, activeCenterId, refreshCenters } = useCenter();
  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { toast } = useToast();

  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['assignments']));
  const [editForm, setEditForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editLogoFile, setEditLogoFile] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const [logoRemovePending, setLogoRemovePending] = useState(false);
  // #725 — the Members images draft. Files and removals are staged here and
  // only leave the browser on Save, so Cancel discards both (the logo's
  // lifecycle, one slot at a time).
  const [membersImageFiles, setMembersImageFiles] = useState<Record<MemberImageSlot, File | null>>(bySlot(null));
  const [membersImagePreviews, setMembersImagePreviews] = useState<Record<MemberImageSlot, string | null>>(bySlot(null));
  const [membersImageRemovals, setMembersImageRemovals] = useState<Record<MemberImageSlot, boolean>>(bySlot(false));
  // Draft snapshot the current editForm is compared against for the dirty
  // state (#492) — set when a row is expanded for editing, cleared on Save.
  const origFormRef = useRef<typeof emptyForm | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);


  const [assignments, setAssignments] = useState<Assignments | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [centersSearch, setCentersSearch] = useState('');
  const [showAllCenters, setShowAllCenters] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerThemeId, setPickerThemeId] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState<UnassignedCenter[]>([]);
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerSelected, setPickerSelected] = useState<Set<string>>(new Set());
  const [pickerSaving, setPickerSaving] = useState(false);

  const [cloning, setCloning] = useState<Theme | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloneSaving, setCloneSaving] = useState(false);

  const [details, setDetails] = useState<Theme | null>(null);
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

  // #713: the gym's Cloudflare copy when the theme has one (uploads land there),
  // the API route for a logo that is still a blob.
  function logoUrl(theme: Theme) {
    return theme.logo_url
      ?? `/api/proxy/themes/${theme.id}/logo${theme.logo_updated_at ? `?v=${encodeURIComponent(theme.logo_updated_at)}` : ''}`;
  }

  function openExpand(theme: Theme) {
    guardUnsaved(() => {
      if (expandedId === theme.id) { applyTokens(currentLiveTokens()); setExpandedId(null); return; }
      setExpandedId(theme.id);
      setOpenSections(new Set<SectionKey>(['assignments']));
      // Merge with defaults so themes saved before #489 stage 2 (missing the newer
      // semantic color fields) still populate every color picker with a sensible value.
      const tokens: ThemeTokens = {
        ...DEFAULT_TOKENS,
        ...theme.tokens,
        colors: { ...DEFAULT_TOKENS.colors, ...theme.tokens?.colors },
      };
      const form = { name: theme.name, description: theme.description ?? '', logoContainsGymName: theme.logo_contains_gym_name, tokens };
      setEditForm(form);
      origFormRef.current = form;
      setEditError(null);
      setEditLogoFile(null);
      setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
      setLogoRemovePending(false);
      setMembersImageFiles(bySlot(null));
      setMembersImageRemovals(bySlot(false));
      setMembersImagePreviews(
        Object.fromEntries(
          MEMBER_IMAGE_SLOTS.map((slot) => [slot, theme.members_images?.[`${slot}_url`] ?? null]),
        ) as Record<MemberImageSlot, string | null>,
      );
      setAssignments(null);
      setCentersSearch('');
      setShowAllCenters(false);
    });
  }

  function toggleSection(section: SectionKey) {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
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
    if (expandedId && openSections.has('assignments')) {
      loadAssignments(expandedId);
    }
  }, [openSections, expandedId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleStatusChange(theme: Theme, newStatus: string) {
    try {
      await apiFetch(`/system/themes/${theme.id}`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
      load();
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    }
  }

  async function handleSetDefault(themeId: string) {
    setSettingDefault(true);
    try {
      await apiFetch(`/system/themes/${themeId}/set-default`, { method: 'PUT' });
      await Promise.all([loadAssignments(themeId), refreshGyms(), refreshCenters()]);
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
      await Promise.all([loadAssignments(themeId), refreshGyms(), refreshCenters()]);
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
      await Promise.all([loadAssignments(pickerThemeId), refreshGyms(), refreshCenters()]);
    } catch (err: any) {
      toast(err.message ?? t('error_generic'));
    } finally {
      setPickerSaving(false);
    }
  }

  // The tokens actually painting the app chrome right now, independent of
  // which theme (if any) is being edited — the restore point for Cancel.
  function currentLiveTokens(): ThemeTokens {
    return getLiveTokens(activeGym?.theme?.tokens as ThemeTokens | undefined, centers, activeCenterId);
  }

  function isDirty(): boolean {
    if (!expandedId || !origFormRef.current) return false;
    const orig = origFormRef.current;
    return (
      editForm.name !== orig.name ||
      editForm.description !== orig.description ||
      editForm.logoContainsGymName !== orig.logoContainsGymName ||
      !tokensEqual(editForm.tokens, orig.tokens) ||
      editLogoFile !== null ||
      logoRemovePending ||
      MEMBER_IMAGE_SLOTS.some((slot) => membersImageFiles[slot] !== null || membersImageRemovals[slot])
    );
  }

  function pickMembersImage(slot: MemberImageSlot, file: File) {
    if (!file.type.startsWith('image/')) { setEditError(t('members_image_error_type')); return; }
    if (file.size > MEMBER_IMAGE_MAX_BYTES) { setEditError(t('members_image_error_size')); return; }
    setEditError(null);
    setMembersImageFiles((prev) => ({ ...prev, [slot]: file }));
    setMembersImageRemovals((prev) => ({ ...prev, [slot]: false }));
    const reader = new FileReader();
    reader.onload = (ev) => setMembersImagePreviews((prev) => ({ ...prev, [slot]: ev.target?.result as string }));
    reader.readAsDataURL(file);
  }

  function queueMembersImageRemove(slot: MemberImageSlot) {
    setMembersImageFiles((prev) => ({ ...prev, [slot]: null }));
    setMembersImagePreviews((prev) => ({ ...prev, [slot]: null }));
    setMembersImageRemovals((prev) => ({ ...prev, [slot]: true }));
  }

  // Draft-only — never persists. Live preview is applied immediately so the
  // user sees the effect without waiting for Save (#492).
  function updateTokens(next: ThemeTokens) {
    setEditForm((prev) => ({ ...prev, tokens: next }));
    applyTokens(next);
  }

  async function handleSaveAll(theme: Theme) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setSaving(true);
    setEditError(null);
    try {
      await apiFetch(`/system/themes/${theme.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          name: editForm.name.trim(),
          description: editForm.description.trim() || null,
          logo_contains_gym_name: editForm.logoContainsGymName,
          tokens: editForm.tokens,
        }),
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
      } else if (logoRemovePending) {
        await apiFetch(`/system/themes/${theme.id}/logo`, { method: 'DELETE' });
      }
      // #725 — one call per slot the admin actually touched. A picked file wins
      // over a queued removal for the same slot (picking clears the removal),
      // so the two branches are exclusive.
      for (const slot of MEMBER_IMAGE_SLOTS) {
        const file = membersImageFiles[slot];
        if (file) {
          const token = await getToken();
          const res = await fetch(`/api/proxy/system/themes/${theme.id}/members-images/${slot}`, {
            method: 'POST',
            headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: file,
          });
          if (!res.ok) {
            const json = await res.json().catch(() => ({}));
            throw new Error(json.error ?? t('members_image_error_upload'));
          }
        } else if (membersImageRemovals[slot]) {
          await apiFetch(`/system/themes/${theme.id}/members-images/${slot}`, { method: 'DELETE' });
        }
      }
      origFormRef.current = { ...editForm, name: editForm.name.trim(), description: editForm.description.trim() };
      setEditForm(origFormRef.current);
      setEditLogoFile(null);
      setLogoRemovePending(false);
      setMembersImageFiles(bySlot(null));
      setMembersImageRemovals(bySlot(false));
      await Promise.all([load(), refreshGyms(), refreshCenters()]);
    } catch (err: any) {
      setEditError(err.message ?? t('error_generic'));
    } finally {
      setSaving(false);
    }
  }

  function handleCancelEdit() {
    applyTokens(currentLiveTokens());
    setExpandedId(null);
  }

  function queueLogoRemove() {
    setEditLogoFile(null);
    setEditLogoPreview(null);
    setLogoRemovePending(true);
  }

  function handleLogoPick(file: File) {
    setEditLogoFile(file);
    setLogoRemovePending(false);
    const reader = new FileReader();
    reader.onload = (ev) => setEditLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
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
  }, [editForm, editLogoFile, logoRemovePending, membersImageFiles, membersImageRemovals, expandedId]);

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
      await apiFetch(`/system/themes/clone/${cloning.id}`, { method: 'POST', body: JSON.stringify({ name: cloneName.trim() }) });
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

  function renderSection(title: string, key: SectionKey, content: React.ReactNode) {
    return (
      <ThemeSection key={key} title={title} open={openSections.has(key)} onToggle={() => toggleSection(key)}>
        {content}
      </ThemeSection>
    );
  }

  function renderAssignmentsContent(theme: Theme) {
    const canAssign = theme.status === 'active';
    if (assignmentsLoading || !assignments) {
      return <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>;
    }
    const filteredCenters = assignments.centers.filter((c) => c.name.toLowerCase().includes(centersSearch.toLowerCase()));
    const visibleCenters = showAllCenters ? filteredCenters : filteredCenters.slice(0, CENTERS_INITIAL_LIMIT);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: '1px solid var(--gd-border, #eee)', marginBottom: 16, opacity: canAssign ? 1 : 0.5 }}>
          <input
            type="checkbox"
            id={`gym-default-${theme.id}`}
            checked={assignments.is_gym_default}
            disabled={assignments.is_gym_default || settingDefault || !canAssign}
            onChange={() => canAssign && !assignments.is_gym_default && handleSetDefault(theme.id)}
            style={{ width: 16, height: 16, cursor: (assignments.is_gym_default || !canAssign) ? 'default' : 'pointer' }}
          />
          <label htmlFor={`gym-default-${theme.id}`} style={{ fontSize: 14, fontWeight: 500, cursor: (assignments.is_gym_default || !canAssign) ? 'default' : 'pointer' }}>{t('assign_gym_default')}</label>
        </div>
        <div style={{ marginBottom: 8 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>{t('assign_centers_title')} ({assignments.centers.length})</p>
          <input type="text" value={centersSearch} onChange={(e) => { setCentersSearch(e.target.value); setShowAllCenters(false); }} placeholder={t('assign_centers_search')} style={{ width: '100%', padding: '8px 12px', borderRadius: 6, border: '1px solid #ddd', fontSize: 14, marginBottom: 8, boxSizing: 'border-box' }} />
          {filteredCenters.length === 0 ? (
            <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 13 }}>{t('assign_no_centers')}</p>
          ) : (
            <>
              {visibleCenters.map((center) => (
                <div key={center.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f0f0f0' }}>
                  <span style={{ fontSize: 14 }}>{center.name}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 12, background: center.is_inherited ? '#f0f0f0' : '#e8f0fe', color: center.is_inherited ? '#666' : '#1a56db' }}>
                      {center.is_inherited ? t('assign_inherited') : t('assign_assigned')}
                    </span>
                    {!center.is_inherited && (
                      <button onClick={() => handleRestoreInheritance(theme.id, center.id)} disabled={restoringId === center.id} style={btnSmall('#888')}>{t('assign_restore')}</button>
                    )}
                  </div>
                </div>
              ))}
              {!showAllCenters && filteredCenters.length > CENTERS_INITIAL_LIMIT && (
                <button onClick={() => setShowAllCenters(true)} style={{ marginTop: 8, background: 'none', border: 'none', color: '#6c63ff', cursor: 'pointer', fontSize: 13, padding: 0 }}>
                  {t('assign_centers_show_all').replace('{count}', String(filteredCenters.length))}
                </button>
              )}
            </>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <button
            onClick={() => openPicker(theme.id)}
            disabled={!canAssign}
            title={canAssign ? undefined : tStatus('active')}
            style={{ ...btnSmall('#6c63ff'), opacity: canAssign ? 1 : 0.5, cursor: canAssign ? 'pointer' : 'not-allowed' }}
          >
            {t('assign_centers_btn')}
          </button>
        </div>
      </div>
    );
  }

  function renderInlineEditor(theme: Theme) {
    if (expandedId !== theme.id) return null;
    const isBase = theme.is_base;
    // #678 — a Base Theme exposes the same sections as a Custom one; what
    // differs is that its configuration is read-only here (it belongs to the
    // platform, and `PUT /system/themes/:id` only accepts this gym's themes).
    const dirty = isDirty();

    return (
      <div style={{ padding: '0 24px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
        {isBase && <p style={{ margin: '12px 0 0', fontSize: 12, color: '#888', fontStyle: 'italic' }}>{t('read_only_hint')}</p>}
        {editError && <p style={{ margin: '12px 0 0', fontSize: 13, color: '#c0392b' }}>{editError}</p>}

        <div style={{ marginTop: 12 }}>
          {renderSection(t('section_assignments'), 'assignments', renderAssignmentsContent(theme))}

          {renderSection(t('section_branding'), 'branding', (
            <ThemeBrandingEditor
              values={{ name: editForm.name, description: editForm.description, logoContainsGymName: editForm.logoContainsGymName }}
              onChange={(next) => setEditForm({ ...editForm, ...next })}
              t={t}
              logoPreview={editLogoPreview}
              onLogoPick={handleLogoPick}
              onLogoRemove={queueLogoRemove}
              readOnly={isBase}
            />
          ))}

          {renderSection(t('section_members_images'), 'members', (
            <ThemeMembersImagesEditor
              previews={membersImagePreviews}
              onPick={pickMembersImage}
              onRemove={queueMembersImageRemove}
              t={t}
              readOnly={isBase}
            />
          ))}

          {renderSection(t('section_colors'), 'colors', (
            <ThemeColorsEditor tokens={editForm.tokens} onChange={updateTokens} namespace="gym_themes" t={t} readOnly={isBase} />
          ))}

          {renderSection(t('section_typography'), 'typography', (
            <ThemeTypographyEditor tokens={editForm.tokens} onChange={updateTokens} t={t} readOnly={isBase} />
          ))}
        </div>

        {isBase ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
            <button onClick={() => setExpandedId(null)} style={btnSmall('#888')}>{t('cancel')}</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end', borderTop: '1px solid var(--gd-border, #eee)', paddingTop: 16 }}>
            <button onClick={handleCancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
            <button onClick={() => handleSaveAll(theme)} disabled={saving || !dirty} style={{ ...btnSmall('#6c63ff'), opacity: (saving || !dirty) ? 0.5 : 1, cursor: (saving || !dirty) ? 'not-allowed' : 'pointer' }}>
              {saving ? t('saving') : t('save_changes')}
            </button>
          </div>
        )}
      </div>
    );
  }

  function renderThemeRow(theme: Theme) {
    const isExpanded = expandedId === theme.id;
    const isDeleted = theme.status === 'deleted';
    const colors = theme.tokens?.colors;

    const menuItems: ContextMenuItem[] = [
      { label: t('clone'), onClick: () => openClone(theme) },
    ];
    if (!isDeleted && !theme.is_base) {
      if (theme.status === 'draft' || theme.status === 'inactive') {
        menuItems.push({ label: t('action_activate'), onClick: () => handleStatusChange(theme, 'active') });
      }
      if (theme.status === 'active') {
        menuItems.push({ label: t('action_set_draft'), onClick: () => handleStatusChange(theme, 'draft') });
        menuItems.push({ label: t('action_set_inactive'), onClick: () => handleStatusChange(theme, 'inactive') });
      }
      menuItems.push({ label: t('delete'), onClick: () => setDeleting(theme), danger: true });
    }
    menuItems.push({ label: t('details'), onClick: () => setDetails(theme) });

    return (
      <div key={theme.id} style={{ ...cardSurfaceStyle, marginBottom: 10, overflow: 'hidden' }}>
        <div
          style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', gap: 12, cursor: isDeleted ? 'default' : 'pointer' }}
          onClick={() => !isDeleted && openExpand(theme)}
        >
          <div style={{ width: 40, flexShrink: 0 }}>
            {theme.has_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl(theme)} alt={theme.name} style={{ height: 28, width: 'auto', borderRadius: 4, objectFit: 'contain' }} />
            ) : (
              <div style={{ width: 36, height: 28, background: colors?.headerBackground ?? '#1a1a2e', borderRadius: 4 }} />
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>{theme.name}</span>
              {theme.is_base && (
                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 10, background: '#f0f0f0', color: '#666', fontWeight: 500 }}>{t('badge_system')}</span>
              )}
              {/* #712 — driven by gyms.theme_id (API `is_gym_theme`), never by the theme's name. */}
              {theme.is_gym_theme && (
                <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 10, background: '#e8f0fe', color: '#1a56db', fontWeight: 500 }}>★ {t('badge_gym_theme')}</span>
              )}
            </div>
            {theme.description && (
              <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                {theme.description}
              </div>
            )}
            {/* Creator + creation date, visible without expanding the editor (#712).
                Base Themes are platform-seeded, so they carry no gym-side creator. */}
            {!theme.is_base && (
              <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                {t('meta_created_by')}: {theme.created_by_name ?? '—'} · {t('meta_created_at')}: {formatDate(theme.created_at)}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            {([colors?.sidebarSelectedItemBackground, colors?.headerBackground, colors?.pageBackground] as (string | undefined)[]).map((c, i) => (
              <div key={i} title={['Primary', 'Secondary', 'Background'][i]} style={{ width: 18, height: 18, borderRadius: 3, background: c ?? '#ccc', border: '1px solid #ddd' }} />
            ))}
          </div>

          <StatusBadge status={theme.status} label={tStatus(theme.status)} />

          {!isDeleted && (
            <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
          )}

          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} />
          </div>
        </div>

        {isExpanded && renderInlineEditor(theme)}
      </div>
    );
  }

  const basethemes = themes.filter((th) => th.is_base);
  const myThemes = themes.filter((th) => !th.is_base);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>{t('title')}</h1>
        <StatusFilter value={statusFilter} onChange={setStatusFilter} options={STATUSES.map((s) => ({ value: s, label: tStatus(s) }))} allLabel={tStatus('all')} />
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

      <CrudModal open={cloning !== null} title={t('clone_title')} error={cloneError} saving={cloneSaving} cancelLabel={t('cancel')} saveLabel={cloneSaving ? t('saving') : t('clone_save')} onCancel={() => setCloning(null)} onSave={handleClone}>
        <FormLabel>{t('clone_name_label')}</FormLabel>
        <FormInput value={cloneName} onChange={(e) => setCloneName(e.target.value)} autoFocus />
      </CrudModal>

      <CrudModal open={details !== null} title={t('details_title')} error={null} saving={false} hideSave cancelLabel={t('details_close')} saveLabel="" extraFooter={<ViewAuditLogButton entityType="theme" entityId={details?.id} onNavigate={() => setDetails(null)} />} onCancel={() => setDetails(null)} onSave={() => setDetails(null)}>
        {details && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <DetailRow label={t('label_name')} value={details.name} />
            <DetailRow label={t('label_description')} value={details.description ?? '—'} />
            <DetailRow label={t('details_type')} value={details.is_base ? t('badge_system') : t('badge_mine')} />
            <DetailRow label={t('col_status')} value={<StatusBadge status={details.status} label={tStatus(details.status)} />} />
            <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '4px 0' }} />
            <DetailRow label={t('details_created_by')} value={details.is_base ? '—' : (details.created_by_name ?? '—')} />
            <DetailRow label={t('details_created_at')} value={formatDate(details.created_at)} />
            {details.modified_at && <DetailRow label={t('details_modified_at')} value={formatDate(details.modified_at)} />}
          </div>
        )}
      </CrudModal>

      <CrudModal open={pickerOpen} title={t('picker_title')} error={null} saving={pickerSaving} cancelLabel={t('picker_cancel')} saveLabel={pickerSaving ? t('picker_saving') : t('picker_save')} onCancel={() => setPickerOpen(false)} onSave={handlePickerAssign}>
        <FormInput value={pickerSearch} onChange={(e) => setPickerSearch(e.target.value)} placeholder={t('picker_search')} autoFocus />
        <div style={{ marginTop: 12, maxHeight: 300, overflowY: 'auto' }}>
          {unassigned.filter((c) => c.name.toLowerCase().includes(pickerSearch.toLowerCase())).length === 0 ? (
            <p style={{ color: '#888', fontSize: 13 }}>{t('picker_empty')}</p>
          ) : (
            unassigned.filter((c) => c.name.toLowerCase().includes(pickerSearch.toLowerCase())).map((c) => (
              <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', cursor: 'pointer', borderBottom: '1px solid #f0f0f0' }}>
                <input type="checkbox" checked={pickerSelected.has(c.id)} onChange={(e) => { const next = new Set(pickerSelected); if (e.target.checked) next.add(c.id); else next.delete(c.id); setPickerSelected(next); }} style={{ width: 16, height: 16 }} />
                <span style={{ fontSize: 14 }}>{c.name}</span>
              </label>
            ))
          )}
        </div>
      </CrudModal>

      <ConfirmDialog open={deleting !== null} message={t('confirm_delete')} confirmLabel={t('delete')} cancelLabel={t('cancel')} onConfirm={handleDelete} onCancel={() => setDeleting(null)} />

      <ConfirmDialog
        open={pendingAction !== null}
        message={t('unsaved_changes')}
        confirmLabel={t('unsaved_discard')}
        cancelLabel={t('cancel')}
        onConfirm={() => {
          const action = pendingAction!;
          setPendingAction(null);
          handleCancelEdit();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <span style={{ color: '#888', fontSize: 13.5, width: 140, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 13.5 }}>{value}</span>
    </div>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
