'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { formatStorageError, formatStorageErrorLine, type StorageErrorLike } from '@/lib/storageErrorMessage';
import { storageCauseSuggestsInitialize, storageFailureCause } from '@/lib/storageFailureCause';
import {
  failedMembersImageSlots,
  formatThemeAssetFailures,
  initializeSuggestedByFailures,
  keepBySlot,
  keepFlagsBySlot,
  logoAssetFailed,
  pendingAfterFailures,
  planThemeAssetOps,
  runThemeAssetOps,
  themeAssetOpTitle,
  type ThemeAssetFailure,
  type ThemeAssetLabels,
} from '@/components/themes/themeAssetSave';
import { useGym } from '@/context/GymContext';
import { useCenter } from '@/context/CenterContext';
import { useToast } from '@/components/Toast';
import { DataTable, Column } from '@/components/DataTable';
import { CrudModal, FormLabel } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { StatusFilter } from '@/components/StatusFilter';
import { ContextMenu } from '@/components/ContextMenu';
import { ThemeColorsEditor, ThemeTypographyEditor } from '@/components/ThemeTokensEditor';
import { ThemeMembersAppEditor } from '@/components/ThemeMembersAppEditor';
import { ThemeSection, ThemeBrandingEditor } from '@/components/ThemeSectionEditor';
import {
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_SLOTS,
  ThemeMembersImagesEditor,
  type MemberImageSlot,
  type MembersImages,
} from '@/components/ThemeMembersImagesEditor';
import { btnSmall, primaryBtnSmall, primaryBtnStyle } from '@/components/ui';
import { DEFAULT_TOKENS, applyTokens, getLiveTokens, tokensEqual, type ThemeTokens } from '@/lib/themeTokens';
import { formActionsRowStyle } from '@/components/formChrome';

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
  /** #732: one nullable URL per Members App background slot; six, always. */
  members_images: MembersImages;
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

// #678 — the same section model as the Custom Themes editor. `Assignments`
// is the one section that has no platform-level counterpart: a theme is
// assigned to a gym's centers, and this screen is above any gym.
type SectionKey = 'branding' | 'colors' | 'typography' | 'members_app';

const NEW_ID = 'new';

/** Six nulls — the Members configuration of a theme that does not exist yet. */
function emptyMembersImages(): MembersImages {
  return Object.fromEntries(MEMBER_IMAGE_SLOTS.map((slot) => [`${slot}_url`, null])) as MembersImages;
}

/** One entry per Members image slot — the draft's shape for all three maps. */
function bySlot<T>(value: T): Record<MemberImageSlot, T> {
  return Object.fromEntries(MEMBER_IMAGE_SLOTS.map((slot) => [slot, value])) as Record<MemberImageSlot, T>;
}

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

// ─── Component ────────────────────────────────────────────────────────────────

export default function ThemesPage() {
  const t = useTranslations('themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch, uploadFetch } = useApiClient();
  const { activeGym, isSuperadmin, loading: gymLoading } = useGym();
  const { centers, activeCenterId } = useCenter();
  const { toast } = useToast();

  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [hasNewRow, setHasNewRow] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['branding']));

  const [editForm, setEditForm] = useState<EditForm>(emptyEditForm());
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [editLogoFile, setEditLogoFile] = useState<File | null>(null);
  const [editLogoPreview, setEditLogoPreview] = useState<string | null>(null);
  const [logoRemovePending, setLogoRemovePending] = useState(false);
  // #732 — the Members images draft. A picked file and a queued removal are
  // staged here and only leave the browser on Save, so Cancel discards both:
  // the same lifecycle the logo has had since #188, one slot at a time.
  const [membersImageFiles, setMembersImageFiles] = useState<Record<MemberImageSlot, File | null>>(bySlot(null));
  const [membersImagePreviews, setMembersImagePreviews] = useState<Record<MemberImageSlot, string | null>>(bySlot(null));
  const [membersImageRemovals, setMembersImageRemovals] = useState<Record<MemberImageSlot, boolean>>(bySlot(false));
  // #830: the assets the last Save could not store — reported in the error block
  // above the sections and marked on each failing control, and still queued so
  // pressing Save again retries exactly those.
  const [assetFailures, setAssetFailures] = useState<ThemeAssetFailure[]>([]);
  // #1042 §3: whether the last Save's failure is evidence that this Theme's
  // Cloudflare storage was never created — the one thing that puts the
  // `Initialize bucket` action beside the error. Decided from the diagnosed
  // cause and never from the step that failed, so a permission or network
  // refusal does not send the admin to re-run a no-op (§4).
  const [initializeSuggested, setInitializeSuggested] = useState(false);
  // Draft snapshot the current editForm is compared against for the dirty
  // state (#492) — set when entering edit mode, cleared once Save succeeds.
  const origFormRef = useRef<EditForm | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const [deleting, setDeleting] = useState<Theme | null>(null);
  // #828: the Theme whose bucket initialization is in flight, so the menu item
  // cannot be fired twice while R2 is being written to.
  const [initializingBucketId, setInitializingBucketId] = useState<string | null>(null);
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

  /**
   * #824: every step of Save reports which operation failed, on what path and
   * with what the storage layer said, rather than the bare message the API
   * returned. `fallbackStage` names the step for a failure that never reached
   * the storage code and so carries no `stage` of its own.
   */

  /**
   * #1042: the *Why* and *What you can do* half of a storage diagnostic, in
   * this screen's own namespace.
   *
   * `storageFailureCause()` is the single place the two are decided — the
   * route's own `cause` when it stated one, the HTTP status otherwise — and it
   * answers `null` for a failure nothing identifies, which is what keeps an
   * undiagnosed error reading exactly as it did before this ticket. The keys
   * are interpolated from the wire value, so a cause with no key would print
   * verbatim; `storage-save-diagnostics.test.ts` asserts every one of them in
   * every locale.
   */
  function storageDiagnosis(err: StorageErrorLike) {
    const cause = storageFailureCause(err);
    if (!cause) return null;
    return {
      causeName: t(`storage_cause_${cause}` as any),
      suggestionText: t(`storage_suggestion_${cause}` as any),
    };
  }

  function storageErrorMessage(err: StorageErrorLike, titleKey: string, fallbackStage: string) {
    const stage = err.body?.stage ?? fallbackStage;
    const diagnosis = storageDiagnosis(err);
    return formatStorageError(err, {
      title: t(titleKey),
      operation: t('storage_error_operation'),
      path: t('storage_error_path'),
      error: t('storage_error_error'),
      details: t('storage_error_details'),
      operationName: t(`storage_stage_${stage}`),
      cause: t('storage_error_cause'),
      causeName: diagnosis?.causeName ?? null,
      suggestion: t('storage_error_suggestion'),
      suggestionText: diagnosis?.suggestionText ?? null,
    });
  }

  /** The same diagnostic on one line, for a failure reported as a toast (#828). */
  function storageErrorLine(err: StorageErrorLike, titleKey: string, fallbackStage: string) {
    const stage = err.body?.stage ?? fallbackStage;
    const diagnosis = storageDiagnosis(err);
    return formatStorageErrorLine(err, {
      title: t(titleKey),
      operation: t('storage_error_operation'),
      path: t('storage_error_path'),
      error: t('storage_error_error'),
      details: t('storage_error_details'),
      operationName: t(`storage_stage_${stage}`),
      cause: t('storage_error_cause'),
      causeName: diagnosis?.causeName ?? null,
      suggestion: t('storage_error_suggestion'),
      suggestionText: diagnosis?.suggestionText ?? null,
    });
  }

  // ─── Initialize bucket (#828) ──────────────────────────────────────────────

  /**
   * Writes this Base Theme's own folder tree — `cordel/themes/<id>-<name>/` with
   * its `Logo/` and `Members/` leaves — into the platform's Cloudflare folder.
   * Explicitly repeatable: the markers are zero-byte objects, so a second run
   * only ensures the structure exists and touches no file and no Theme field.
   *
   * No storage gating on this screen: a Base Theme's objects live under the
   * platform root, which no gym's bucket settings govern (#823), so the only
   * failure the admin can meet is the deployment having no R2 at all — which the
   * route answers with the 503 the toast then names.
   */
  async function handleInitializeBucket(themeId: string) {
    setInitializingBucketId(themeId);
    try {
      await apiFetch(`/platform/themes/${themeId}/storage/initialize`, { method: 'POST' });
      toast(t('toast_bucket_initialized'), 'success');
    } catch (err: any) {
      toast(storageErrorLine(err, 'storage_error_title_initialize_bucket', 'create_theme_folder'));
    } finally {
      setInitializingBucketId(null);
    }
  }

  /**
   * #830: the labels the shared asset-save reports a failure with, resolved
   * through this screen's namespace. The uploads themselves (raw image bytes
   * through `uploadFetch`, whose `Content-Type` is what the server validates the
   * signature against — #824) and the removals now go through
   * `runThemeAssetOps()`, which both Theme screens share: the two copies of this
   * sequence had drifted, and a Base Theme's logo and Members removals were the
   * half that had no diagnostic at all.
   */
  const assetLabels: ThemeAssetLabels = {
    operation: t('storage_error_operation'),
    path: t('storage_error_path'),
    error: t('storage_error_error'),
    details: t('storage_error_details'),
    fallbackError: t('storage_error_fallback'),
    title: (op) => {
      const { key, slot } = themeAssetOpTitle(op);
      return slot ? t(key as any, { slot: t(`members_image_${slot}`) }) : t(key as any);
    },
    operationName: (_op, stage) => t(`storage_stage_${stage}` as any),
    cause: t('storage_error_cause'),
    suggestion: t('storage_error_suggestion'),
    diagnosis: storageDiagnosis,
  };

  // Deferred — the actual DELETE only fires on Save (#492), so editing the
  // logo never mutates the persisted Theme until the user commits the draft.
  function queueLogoRemove() {
    setEditLogoFile(null);
    setEditLogoPreview(null);
    setLogoRemovePending(true);
  }

  function handleLogoPick(file: File) {
    setEditError(null);
    setAssetFailures([]);
    setInitializeSuggested(false);
    setEditLogoFile(file);
    setLogoRemovePending(false);
    const reader = new FileReader();
    reader.onload = (ev) => setEditLogoPreview(ev.target?.result as string);
    reader.readAsDataURL(file);
  }

  // ─── Members App images (#732) ─────────────────────────────────────────────

  function pickMembersImage(slot: MemberImageSlot, file: File) {
    if (!file.type.startsWith('image/')) { setEditError(t('members_image_error_type')); return; }
    if (file.size > MEMBER_IMAGE_MAX_BYTES) { setEditError(t('members_image_error_size')); return; }
    setEditError(null);
    // #830: the per-asset markers point at that message, so they go with it.
    setAssetFailures([]);
    setInitializeSuggested(false);
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

  /** The persisted URLs of a theme's six slots, as the draft starts out. */
  function previewsFor(theme?: Theme): Record<MemberImageSlot, string | null> {
    return Object.fromEntries(
      MEMBER_IMAGE_SLOTS.map((slot) => [slot, theme?.members_images?.[`${slot}_url`] ?? null]),
    ) as Record<MemberImageSlot, string | null>;
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
      logoRemovePending ||
      MEMBER_IMAGE_SLOTS.some((slot) => membersImageFiles[slot] !== null || membersImageRemovals[slot])
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
  }, [editForm, editLogoFile, logoRemovePending, membersImageFiles, membersImageRemovals, editingId]);

  // ─── Expand / Edit ─────────────────────────────────────────────────────────

  // #678 — expanding a row opens the structured editor straight away, the same
  // model as the Custom Themes screen: no separate read-only expanded view and
  // no second "enter edit" step. The row menu's Edit entry lands here too.
  function toggleExpand(theme: Theme) {
    guardUnsaved(() => {
      if (expandedId === theme.id) { closeEditor(); return; }
      openEditor(theme);
    });
  }

  function openEditor(theme: Theme) {
    setExpandedId(theme.id);
    setEditingId(theme.id);
    const form = emptyEditForm(theme);
    setEditForm(form);
    origFormRef.current = form;
    setEditError(null);
    setAssetFailures([]);
    setInitializeSuggested(false);
    setEditLogoFile(null);
    setEditLogoPreview(theme.has_logo ? logoUrl(theme) : null);
    setLogoRemovePending(false);
    setMembersImageFiles(bySlot(null));
    setMembersImageRemovals(bySlot(false));
    setMembersImagePreviews(previewsFor(theme));
    setOpenSections(new Set(['branding']));
  }

  function enterEdit(theme: Theme) {
    guardUnsaved(() => openEditor(theme));
  }

  // Cancel collapses the card back down — the draft (and its live preview) is
  // discarded, exactly as on the Custom Themes screen.
  function closeEditor() {
    applyTokens(currentLiveTokens());
    if (editingId === NEW_ID) setHasNewRow(false);
    setExpandedId(null);
    setEditingId(null);
    setEditError(null);
    setAssetFailures([]);
    setInitializeSuggested(false);
    setEditLogoFile(null);
    setEditLogoPreview(null);
    setLogoRemovePending(false);
    setMembersImageFiles(bySlot(null));
    setMembersImagePreviews(bySlot(null));
    setMembersImageRemovals(bySlot(false));
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
      setMembersImageFiles(bySlot(null));
      setMembersImagePreviews(bySlot(null));
      setMembersImageRemovals(bySlot(false));
      setOpenSections(new Set<SectionKey>(['branding']));
    });
  }

  // ─── Save ──────────────────────────────────────────────────────────────────

  async function handleSave(id: string) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setEditSaving(true);
    setEditError(null);
    setAssetFailures([]);
    setInitializeSuggested(false);
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
        try {
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
        } catch (err: any) {
          // The configuration is the one step that still aborts the Save: the
          // asset keys are built from the theme's persisted name, so there is
          // nothing to be gained from uploading against a rename that did not
          // happen. #830 gave it the diagnostic the Custom Themes screen had.
          setInitializeSuggested(storageCauseSuggestsInitialize(storageFailureCause(err)));
          throw new Error(storageErrorMessage(err, 'storage_error_title_settings', 'save_settings'));
        }
        // #830 — every asset the admin touched is attempted, whatever the
        // others did, and every failure is reported rather than just the first.
        // #732's "one call per slot the admin actually touched" is unchanged: a
        // picked file still wins over a queued removal for the same slot.
        const { failures } = await runThemeAssetOps(
          planThemeAssetOps({
            logoFile: editLogoFile,
            logoRemovePending,
            membersImageFiles,
            membersImageRemovals,
          }),
          {
            basePath: '/platform/themes',
            themeId: id,
            upload: (path, file) => uploadFetch(path, file),
            remove: (path) => apiFetch(path, { method: 'DELETE' }),
          },
        );

        // Stay on the editor with a clean draft rather than collapsing back
        // to the read-only view — the user may keep iterating (#492). Only the
        // assets that failed stay queued, with their files and previews intact,
        // so pressing Save again retries exactly those.
        const pending = pendingAfterFailures(failures);
        origFormRef.current = { ...editForm, name: editForm.name.trim(), description: editForm.description.trim() };
        setEditForm(origFormRef.current);
        setEditLogoFile(pending.logoUpload ? editLogoFile : null);
        setLogoRemovePending(pending.logoRemove);
        setMembersImageFiles(keepBySlot(membersImageFiles, pending.slotUploads));
        setMembersImageRemovals(keepFlagsBySlot(pending.slotRemovals));
        setAssetFailures(failures);
        setInitializeSuggested(initializeSuggestedByFailures(failures));
        setEditError(failures.length > 0 ? formatThemeAssetFailures(failures, assetLabels) : null);
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

  // ─── Section helper ────────────────────────────────────────────────────────

  function renderSection(key: SectionKey, title: string, content: React.ReactNode) {
    return (
      <ThemeSection
        title={title}
        open={openSections.has(key)}
        onToggle={() => setOpenSections((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; })}
      >
        {content}
      </ThemeSection>
    );
  }

  // ─── Edit form ─────────────────────────────────────────────────────────────

  function renderEditForm(id: string, isNew: boolean) {
    return (
      <div style={{ padding: '0 24px 20px', borderTop: '1px solid var(--gd-border, #eee)' }}>
        {editError && (
          // #824: `pre-line` because a storage failure is a diagnostic block
          // (operation, path, error, details), not a single sentence.
          // #1042 §3: and when the diagnosis is that this Theme's Cloudflare
          // storage was never created, the fix is offered right here rather
          // than left in a context menu — the same `Initialize bucket` action
          // the `⋮` menu runs, not a second workflow.
          <div style={{ marginTop: 12 }}>
            <p style={{ margin: 0, fontSize: 13, color: '#c0392b', whiteSpace: 'pre-line' }}>{editError}</p>
            {initializeSuggested && (
              <button
                type="button"
                onClick={() => handleInitializeBucket(id)}
                disabled={initializingBucketId === id}
                style={{ ...primaryBtnSmall(), marginTop: 10, opacity: initializingBucketId === id ? 0.5 : 1, cursor: initializingBucketId === id ? 'not-allowed' : 'pointer' }}
              >
                {t('action_initialize_bucket')}
              </button>
            )}
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {renderSection('branding', t('section_branding'), (
            <ThemeBrandingEditor
              values={{ name: editForm.name, description: editForm.description, logoContainsGymName: editForm.logoContainsGymName }}
              onChange={(next) => setEditForm({ ...editForm, ...next })}
              t={t}
              logoPreview={editLogoPreview}
              onLogoPick={handleLogoPick}
              onLogoRemove={queueLogoRemove}
              // A theme that does not exist yet has no id to upload a logo to;
              // the logo controls appear once it has been created (unchanged).
              showLogo={!isNew}
              logoError={logoAssetFailed(assetFailures)}
              autoFocusName={isNew}
            >
              {/* Status is platform-only: on the Custom Themes screen a theme's
                  status is driven from its row menu, not from the editor. */}
              <FormLabel>{t('label_status')}</FormLabel>
              <select
                value={editForm.status}
                onChange={(e) => setEditForm({ ...editForm, status: e.target.value })}
                style={selectStyle}
              >
                {EDITABLE_STATUSES.map((s) => (
                  <option key={s} value={s}>{tStatus(s)}</option>
                ))}
              </select>
            </ThemeBrandingEditor>
          ))}

          {!isNew && renderSection('colors', t('section_colors'), (
            <ThemeColorsEditor tokens={editForm.tokens} onChange={updateTokens} namespace="themes" t={t} />
          ))}

          {!isNew && renderSection('typography', t('section_typography'), (
            <ThemeTypographyEditor tokens={editForm.tokens} onChange={updateTokens} t={t} />
          ))}

          {/* #833 — the same Members App editor the Custom Themes screen
              renders: one set of settings, one inheritance system, both Theme
              kinds.

              #1038 — this Base Theme's Members App backgrounds (#732) are the
              `Images` subsection inside it now, rather than a top-level section
              of their own. Still hidden on a theme that does not exist yet, for
              the logo's reason: there is no id to upload to until it has been
              created. */}
          {!isNew && renderSection('members_app', t('section_members_app'), (
            <ThemeMembersAppEditor
              tokens={editForm.tokens}
              onChange={updateTokens}
              t={t}
              images={(
                <ThemeMembersImagesEditor
                  previews={membersImagePreviews}
                  onPick={pickMembersImage}
                  onRemove={queueMembersImageRemove}
                  t={t}
                  slotErrors={failedMembersImageSlots(assetFailures)}
                />
              )}
            />
          ))}
        </div>

        <div style={{ ...formActionsRowStyle, marginTop: 20 }}>
          <button onClick={closeEditor} style={btnSmall('#888')}>{t('cancel')}</button>
          <button
            onClick={() => handleSave(id)}
            disabled={editSaving || !isDirty()}
            style={{ ...primaryBtnSmall(), opacity: (editSaving || !isDirty()) ? 0.5 : 1, cursor: (editSaving || !isDirty()) ? 'not-allowed' : 'pointer' }}
          >
            {editSaving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  // ─── Expanded row ───────────────────────────────────────────────────────────

  function renderExpanded(theme: Theme) {
    return renderEditForm(theme.id, theme.id === NEW_ID);
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
    members_images: emptyMembersImages(),
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
      mobile: 'secondary',
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
      mobile: 'name',
      title: (th) => (th.id === NEW_ID ? undefined : th.name),
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
      mobile: 'secondary',
      render: (th) => (th.id !== NEW_ID ? <span style={badgeStyle('#4b45c6')}>{t('badge_system')}</span> : null),
    },
    {
      header: t('col_usage'),
      width: 140,
      mobile: 'secondary',
      render: (th) => (th.id !== NEW_ID ? <span style={{ color: '#555', fontSize: 13.5 }}>{usageLabel(th)}</span> : null),
    },
    {
      header: t('col_status'),
      width: 110,
      mobile: 'keep',
      render: (th) => (th.id !== NEW_ID ? <StatusBadge status={th.status} label={tStatus(th.status)} /> : null),
    },
    {
      header: t('col_actions'),
      width: 60,
      mobile: 'actions',
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
          // #828: the Base Theme's own storage structure, manually and
          // repeatably — `cordel/themes/<id>-<name>/` with its two leaves.
          items.push({
            label: t('action_initialize_bucket'),
            onClick: () => handleInitializeBucket(th.id),
            disabled: initializingBucketId === th.id,
          });
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
          <button onClick={handleNew} disabled={hasNewRow} style={primaryBtnStyle()}>{t('add')}</button>
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
          if (th.status !== 'deleted') toggleExpand(th);
        }}
      />

      <CrudModal
        open={detailsTheme !== null || detailsLoading}
        title={t('details_title')}
        error={null}
        saving={false}
        cancelLabel={t('details_close')}
        saveLabel=""
        extraFooter={<ViewAuditLogButton entityType="theme" entityId={detailsTheme?.id} scope="platform" onNavigate={() => setDetailsTheme(null)} />}
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
          closeEditor();
          action();
        }}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}
