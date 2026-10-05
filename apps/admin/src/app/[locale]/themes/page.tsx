'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useLocale } from 'next-intl';
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
import { ThemeMembersAppEditor } from '@/components/ThemeMembersAppEditor';
import { ThemeSection, ThemeBrandingEditor } from '@/components/ThemeSectionEditor';
import { gymStorageBlock } from '@/lib/gymStorageReadiness';
import { formatStorageError, formatStorageErrorLine, type StorageErrorLike } from '@/lib/storageErrorMessage';
import {
  failedMembersImageSlots,
  formatThemeAssetFailures,
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
import {
  MEMBER_IMAGE_MAX_BYTES,
  MEMBER_IMAGE_SLOTS,
  ThemeMembersImagesEditor,
  type MemberImageSlot,
  type MembersImages,
} from '@/components/ThemeMembersImagesEditor';
import { btnSmall, cardSurfaceStyle, primaryBtnSmall } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn,
  listCellClasses, listScrollerClass,
} from '@/components/listChrome';
import {
  allCentersChecked,
  assignedCenterIds,
  centerKey,
  centerSelectionChanged,
  toggleAllCenters,
  toggleCenter,
  type AssignmentCenter,
} from './centerAssignments';
import { DEFAULT_TOKENS, applyTokens, getLiveTokens, tokensEqual, type ThemeTokens } from '@/lib/themeTokens';
import { formActionsRowStyle } from '@/components/formChrome';

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

interface Assignments {
  is_gym_default: boolean;
  centers: AssignmentCenter[];
}

const STATUSES = ['draft', 'active', 'inactive', 'deleted'] as const;

// Assignments first, then Branding → Colors → Typography — the same set for a
// Base Theme and a Custom one (#678); see renderInlineEditor().
type SectionKey = 'branding' | 'typography' | 'colors' | 'assignments' | 'members_app';

const emptyForm = { name: '', description: '', logoContainsGymName: false, tokens: DEFAULT_TOKENS };

/** One entry per Members image slot — the draft's shape for all three maps. */
function bySlot<T>(value: T): Record<MemberImageSlot, T> {
  return Object.fromEntries(MEMBER_IMAGE_SLOTS.map((slot) => [slot, value])) as Record<MemberImageSlot, T>;
}

// ─── List columns ─────────────────────────────────────────────────────────────

/**
 * #1011 stage 4 — the row is laid out from one declaration rather than from
 * per-cell `flex`/`flexShrink` guesses (#637's shape, which stage 3's eight card
 * lists already adopted). This list carries no header band, so there is nothing
 * for the tracks to fall out of line *with* — adding one would be a desktop
 * change §4 rules out — but the row still needs each cell to say what it is on
 * a phone.
 *
 * The theme's name is the row's identity and its status is the one state worth
 * seeing without tapping. The 56px logo box and the three colour swatches are
 * `secondary` for the reason stage 3 gave up Staff's 36px avatar: on a 390px row
 * they are the difference between a readable name and a truncated one, and both
 * are read in the expanded editor.
 */
interface ListColumn extends ListGridColumn {
  /** Fixed track width in px — also the minimum for a flexible column. */
  width: number;
  /** Set on a flexible column: it becomes minmax(width, growfr). */
  grow?: number;
}

const LIST_COLUMNS: ListColumn[] = [
  { key: 'logo', width: 56, mobile: 'secondary' },
  { key: 'name', width: 160, grow: 1, mobile: 'name' },
  { key: 'swatches', width: 62, mobile: 'secondary' },
  { key: 'status', width: 90, mobile: 'keep' },
  // The chevron is the row's own affordance rather than a value, so it stays.
  { key: 'expand', width: 14, mobile: 'keep' },
  { key: 'actions', width: 44, mobile: 'actions' },
];

/** The mobile class a column's header cell and its row cells share (#1011). */
const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 12;
/** This list's own horizontal inset — a card row. */
const ROW_PADDING_X = 16;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + ROW_PADDING_X * 2;

/** The collapsed row of a theme card, laid out from that declaration. */
const themeRowStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center', gap: LIST_COLUMN_GAP, padding: `12px ${ROW_PADDING_X}px`,
};

export default function GymThemesPage() {
  const t = useTranslations('gym_themes');
  const tStatus = useTranslations('status');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch, uploadFetch } = useApiClient();
  const { activeGym, isSuperadmin, loading: gymLoading, refreshGyms } = useGym();
  const { centers, activeCenterId, refreshCenters } = useCenter();
  const isAdmin = isSuperadmin || activeGym?.role === 'admin';
  const { toast } = useToast();
  // #823: a Custom Theme's logo and Members App images are objects in *this
  // gym's* Cloudflare folder, so both upload controls are unusable until the
  // deployment has R2 credentials and this gym's bucket folders have been
  // initialized. One decision, taken here and handed to the two editors — the
  // API refuses the same two cases with 503/409, and the point of the gating is
  // that the admin is told before picking a file rather than after.
  const storageBlock = gymStorageBlock(activeGym);

  const [themes, setThemes] = useState<Theme[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['assignments']));
  const [editForm, setEditForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  // #828: the Theme whose bucket initialization is in flight, so the menu item
  // cannot be fired twice while R2 is being written to.
  const [initializingBucketId, setInitializingBucketId] = useState<string | null>(null);
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
  // #830: the assets the last Save could not store. Each one is reported in the
  // error block above the sections *and* marked on its own control, and stays
  // queued so pressing Save again retries exactly what failed.
  const [assetFailures, setAssetFailures] = useState<ThemeAssetFailure[]>([]);
  // Draft snapshot the current editForm is compared against for the dirty
  // state (#492) — set when a row is expanded for editing, cleared on Save.
  const origFormRef = useRef<typeof emptyForm | null>(null);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);


  const [assignments, setAssignments] = useState<Assignments | null>(null);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  // #985 — the Center checkbox draft, and the set it is compared against. It
  // leaves the browser on Save like every other field of this card, so Cancel
  // discards it and the unsaved-changes guard covers it.
  const [centerSelection, setCenterSelection] = useState<Set<string> | null>(null);
  const centerBaselineRef = useRef<Set<string> | null>(null);

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
      setAssetFailures([]);
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
      setCenterSelection(null);
      centerBaselineRef.current = null;
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
      // The draft and its baseline both start at what is stored, so an opened
      // section is never dirty and Save stays disabled until a box moves.
      const stored = assignedCenterIds(data.centers);
      centerBaselineRef.current = stored;
      setCenterSelection(stored);
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
      MEMBER_IMAGE_SLOTS.some((slot) => membersImageFiles[slot] !== null || membersImageRemovals[slot]) ||
      // #985: a ticked Center is an unsaved change like any other field's.
      centersDirty()
    );
  }

  function centersDirty(): boolean {
    return centerSelectionChanged(centerBaselineRef.current, centerSelection);
  }

  function pickMembersImage(slot: MemberImageSlot, file: File) {
    // #823: the control is disabled while storage is unavailable, so this cannot
    // normally be reached — but a blocked pick must not become a staged file that
    // Save would then try to upload.
    if (storageBlock) { setEditError(t(`members_image_upload_${storageBlock}`)); return; }
    if (!file.type.startsWith('image/')) { setEditError(t('members_image_error_type')); return; }
    if (file.size > MEMBER_IMAGE_MAX_BYTES) { setEditError(t('members_image_error_size')); return; }
    setEditError(null);
    // #830: the per-asset markers say "see the message above", so they go when
    // that message does — picking a file clears both, not one of the two.
    setAssetFailures([]);
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

  /**
   * #824: every step of Save gets a diagnostic instead of the bare message the
   * API returned — which for a tenant-scoped upload used to be `Unauthorized`
   * and nothing else. `fallbackStage` names the step for a failure that never
   * reached the storage code (an auth or validation refusal carries no
   * `stage`); when the API did name one, that wins, because it knows whether it
   * broke while resolving the path, creating a folder or uploading.
   */
  function storageErrorMessage(err: StorageErrorLike, titleKey: string, fallbackStage: string) {
    const stage = err.body?.stage ?? fallbackStage;
    return formatStorageError(err, {
      title: t(titleKey),
      operation: t('storage_error_operation'),
      path: t('storage_error_path'),
      error: t('storage_error_error'),
      details: t('storage_error_details'),
      operationName: t(`storage_stage_${stage}`),
    });
  }

  /** The same diagnostic on one line, for a failure reported as a toast (#828). */
  function storageErrorLine(err: StorageErrorLike, titleKey: string, fallbackStage: string) {
    const stage = err.body?.stage ?? fallbackStage;
    return formatStorageErrorLine(err, {
      title: t(titleKey),
      operation: t('storage_error_operation'),
      path: t('storage_error_path'),
      error: t('storage_error_error'),
      details: t('storage_error_details'),
      operationName: t(`storage_stage_${stage}`),
    });
  }

  /**
   * #828: writes this Theme's own folder tree (`themes/<id>-<name>/` with its
   * `Logo/` and `Members/` leaves) into the gym's Cloudflare folder. Explicitly
   * repeatable — the markers are zero-byte objects, so a second run just ensures
   * the structure is there and touches no file and no Theme field.
   *
   * It does **not** initialize the gym bucket itself (§5): that is Gym Bucket
   * Initialization's, and until it has run the action is disabled with the
   * reason, exactly as Clone is (#823).
   */
  async function handleInitializeBucket(theme: Theme) {
    if (storageBlock) { toast(t(`initialize_bucket_${storageBlock}`)); return; }
    setInitializingBucketId(theme.id);
    try {
      await apiFetch(`/system/themes/${theme.id}/storage/initialize`, { method: 'POST' });
      toast(t('toast_bucket_initialized'), 'success');
    } catch (err: any) {
      // A toast is one text node, so the diagnostic goes on one line. The
      // fallback stage is the first marker the route writes — a failure that
      // never reached storage carries no stage of its own.
      toast(storageErrorLine(err, 'storage_error_title_initialize_bucket', 'create_theme_folder'));
    } finally {
      setInitializingBucketId(null);
    }
  }

  /**
   * #830: the labels `formatThemeAssetFailures()` needs, resolved through this
   * screen's own namespace. The shared module holds no next-intl, so the two
   * Theme screens read the same keys from `gym_themes` and `themes` and neither
   * can grow a heading the other lacks.
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
  };

  async function handleSaveAll(theme: Theme) {
    if (!editForm.name.trim()) { setEditError(t('error_required')); return; }
    setSaving(true);
    setEditError(null);
    setAssetFailures([]);
    try {
      // #985: a Base Theme's configuration belongs to the platform and this
      // screen renders it read-only, but a gym may still assign it to its own
      // Centers — so Save writes the assignments alone for one of those, and
      // the settings `PUT` (which would 403) is not attempted.
      if (!theme.is_base) {
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
        } catch (err: any) {
          // The configuration is the one step that still aborts: the asset keys
          // are built from the theme's persisted name, so there is nothing to be
          // gained from uploading against a rename that did not happen.
          throw new Error(storageErrorMessage(err, 'storage_error_title_settings', 'save_settings'));
        }
      }

      // #830 — every asset the admin touched is attempted, whatever the others
      // did: a rejected `training` upload must not stop `nutrition` from being
      // saved. The shared runner (#725's one call per touched slot, unchanged)
      // reports all of the failures rather than the first.
      const { failures } = await runThemeAssetOps(
        planThemeAssetOps({
          logoFile: editLogoFile,
          logoRemovePending,
          membersImageFiles,
          membersImageRemovals,
        }),
        {
          basePath: '/system/themes',
          themeId: theme.id,
          upload: (path, file) => uploadFetch(path, file),
          remove: (path) => apiFetch(path, { method: 'DELETE' }),
        },
      );

      // #985 — the Center assignments, persisted by this Save and nothing else.
      // A failure keeps the draft *and* its baseline, so Save is the retry
      // exactly as it is for a failed asset, and the error says which step it
      // was rather than replacing the asset report.
      let centersError: string | null = null;
      if (centersDirty() && centerSelection) {
        const submitted = Array.from(centerSelection);
        try {
          await apiFetch(`/system/themes/${theme.id}/centers`, {
            method: 'PUT',
            body: JSON.stringify({ center_ids: submitted }),
          });
          centerBaselineRef.current = new Set(submitted);
        } catch (err: any) {
          centersError = t('assign_centers_error', { error: err.message ?? t('error_generic') });
        }
      }

      // The configuration saved, so the draft baseline moves regardless; only the
      // assets that failed stay pending, with their files and previews intact.
      const pending = pendingAfterFailures(failures);
      origFormRef.current = { ...editForm, name: editForm.name.trim(), description: editForm.description.trim() };
      setEditForm(origFormRef.current);
      setEditLogoFile(pending.logoUpload ? editLogoFile : null);
      setLogoRemovePending(pending.logoRemove);
      setMembersImageFiles(keepBySlot(membersImageFiles, pending.slotUploads));
      setMembersImageRemovals(keepFlagsBySlot(pending.slotRemovals));
      setAssetFailures(failures);
      setEditError(
        [centersError, failures.length > 0 ? formatThemeAssetFailures(failures, assetLabels) : null]
          .filter(Boolean)
          .join('\n\n') || null,
      );
      await Promise.all([
        load(),
        refreshGyms(),
        refreshCenters(),
        // Re-read the Assignments so the inherited/assigned tags match what was
        // just written — but not when that write failed, since the reload would
        // reseed the draft and throw away the admin's selection.
        centersError ? Promise.resolve() : loadAssignments(theme.id),
      ]);
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
    // #823 — as in `pickMembersImage`: nothing may be staged for an upload the
    // gym's storage cannot accept.
    if (storageBlock) { setEditError(t(`logo_upload_${storageBlock}`)); return; }
    setEditError(null);
    setAssetFailures([]);
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
  }, [editForm, editLogoFile, logoRemovePending, membersImageFiles, membersImageRemovals, centerSelection, expandedId]);

  function openClone(theme: Theme) {
    setCloning(theme);
    setCloneName(`${theme.name} (copy)`);
    setCloneError(null);
  }

  async function handleClone() {
    if (!cloning) return;
    if (!cloneName.trim()) { setCloneError(t('error_required')); return; }
    // #827: a theme cannot be created before the gym's bucket is — the API
    // answers 503/409 and creates nothing, and this is the same decision taken
    // one step earlier so the admin reads the reason instead of a raw failure.
    // The menu item is disabled for the same reason; this covers a modal that
    // was already open when the gym's storage state changed.
    if (storageBlock) { setCloneError(t(`clone_${storageBlock}`)); return; }
    setCloneSaving(true);
    setCloneError(null);
    try {
      await apiFetch(`/system/themes/clone/${cloning.id}`, { method: 'POST', body: JSON.stringify({ name: cloneName.trim() }) });
      setCloning(null);
      // #1041 §17: the clone now copies the source's logo and backgrounds, so
      // it is a multi-step operation whose end deserves saying — and the Save
      // button has read `clone_saving` throughout, which is what stops a second
      // click from starting a second clone.
      toast(t('toast_cloned'), 'success');
      load();
    } catch (err: any) {
      // The clone has a storage half now, so a storage failure gets the same
      // `stage`/`path` diagnostic every other storage-backed save does (#824) —
      // but only one that reached storage: a duplicate name is a 409 with no
      // `stage`, and naming a folder step for it would misdescribe it.
      setCloneError(err.body?.stage
        ? storageErrorMessage(err, 'storage_error_title_clone', 'create_theme_folder')
        : (err.message ?? t('error_generic')));
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

  /**
   * #985 — the Centers as an inline checkbox list: every Center of the gym, the
   * `All Centers` box above them, and nothing that persists on its own. The
   * card's Save writes the set (the modal, its search field and its
   * Assign/Cancel pair are gone, and so is the per-row `Restore Inheritance`
   * button — unticking a box is that action now).
   */
  function renderAssignmentsContent(theme: Theme) {
    const canAssign = theme.status === 'active';
    if (assignmentsLoading || !assignments || !centerSelection) {
      return <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>;
    }
    const centers = assignments.centers;
    const selection = centerSelection;
    const allChecked = allCentersChecked(centers, selection);
    const rowCursor = canAssign ? 'pointer' : 'default';
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
        <div style={{ opacity: canAssign ? 1 : 0.5 }}>
          <p style={{ margin: '0 0 10px', fontWeight: 600, fontSize: 14 }}>{t('assign_centers_title')}</p>
          {centers.length === 0 ? (
            // §7: a message, never an empty checkbox list.
            <p style={{ color: 'var(--gd-text-muted, #6b7280)', fontSize: 13 }}>{t('assign_centers_empty')}</p>
          ) : (
            <>
              {/* `All Centers` is separated from the individual Centers by the
                  same hairline the rest of this card uses. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', marginBottom: 8, borderBottom: '1px solid var(--gd-border, #eee)', cursor: rowCursor }}>
                <input
                  type="checkbox"
                  checked={allChecked}
                  disabled={!canAssign}
                  onChange={(e) => setCenterSelection(toggleAllCenters(centers, e.target.checked))}
                  style={{ width: 16, height: 16, cursor: rowCursor }}
                />
                <span style={{ fontSize: 14, fontWeight: 500 }}>{t('assign_all_centers')}</span>
              </label>
              {centers.map((center) => (
                <label key={centerKey(center.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f0f0f0', cursor: rowCursor }}>
                  <input
                    type="checkbox"
                    checked={selection.has(centerKey(center.id))}
                    disabled={!canAssign}
                    onChange={(e) => setCenterSelection(toggleCenter(selection, center.id, e.target.checked))}
                    style={{ width: 16, height: 16, cursor: rowCursor }}
                  />
                  <span style={{ fontSize: 14, flex: 1, minWidth: 0 }}>{center.name}</span>
                  {/* A Center with no assignment of its own that this theme
                      reaches as the Gym Default: the box stays unticked, because
                      ticking it is what would make the assignment explicit. */}
                  {center.is_inherited && !selection.has(centerKey(center.id)) && (
                    <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 12, background: '#f0f0f0', color: '#666' }}>{t('assign_inherited')}</span>
                  )}
                </label>
              ))}
            </>
          )}
          {!canAssign && (
            <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--gd-text-muted, #6b7280)' }}>{t('assign_centers_inactive_hint')}</p>
          )}
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
        {editError && (
          // #824: `pre-line` because a storage failure is a diagnostic block
          // (operation, path, error, details), not a single sentence.
          <p style={{ margin: '12px 0 0', fontSize: 13, color: '#c0392b', whiteSpace: 'pre-line' }}>{editError}</p>
        )}

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
              storageBlock={storageBlock}
              logoError={logoAssetFailed(assetFailures)}
            />
          ))}

          {renderSection(t('section_colors'), 'colors', (
            <ThemeColorsEditor tokens={editForm.tokens} onChange={updateTokens} namespace="gym_themes" t={t} readOnly={isBase} />
          ))}

          {renderSection(t('section_typography'), 'typography', (
            <ThemeTypographyEditor tokens={editForm.tokens} onChange={updateTokens} t={t} readOnly={isBase} />
          ))}

          {/* #833 — the Members App's own settings, each inheriting from its
              Admin source until this Theme overrides it. The same component
              renders on the Base Themes screen, so both Theme kinds get one
              editor and one inheritance system.

              #1038 — the Members App background images are an `Images`
              subsection *of* this section rather than a top-level Theme section
              of their own: they configure the Members App and nothing else
              configures them. The editor, its previews, its draft and the two
              calls on Save are unchanged — only where it is rendered moved. */}
          {renderSection(t('section_members_app'), 'members_app', (
            <ThemeMembersAppEditor
              tokens={editForm.tokens}
              onChange={updateTokens}
              t={t}
              readOnly={isBase}
              images={(
                <ThemeMembersImagesEditor
                  previews={membersImagePreviews}
                  onPick={pickMembersImage}
                  onRemove={queueMembersImageRemove}
                  t={t}
                  readOnly={isBase}
                  storageBlock={storageBlock}
                  slotErrors={failedMembersImageSlots(assetFailures)}
                />
              )}
            />
          ))}
        </div>

        {/* #985 — a Base Theme now gets the same Save pair: its configuration is
            the platform's and stays read-only, but its Center assignments are
            this gym's and are persisted by this button, since there is no
            Assign action any more. Nothing else about the footer moves. */}
        <div style={formActionsRowStyle}>
          <button onClick={handleCancelEdit} style={btnSmall('#888')}>{t('cancel')}</button>
          <button onClick={() => handleSaveAll(theme)} disabled={saving || !dirty} style={{ ...primaryBtnSmall(), opacity: (saving || !dirty) ? 0.5 : 1, cursor: (saving || !dirty) ? 'not-allowed' : 'pointer' }}>
            {saving ? t('saving') : t('save_changes')}
          </button>
        </div>
      </div>
    );
  }

  function renderThemeRow(theme: Theme) {
    const isExpanded = expandedId === theme.id;
    const isDeleted = theme.status === 'deleted';
    const colors = theme.tokens?.colors;

    const menuItems: ContextMenuItem[] = [
      {
        label: t('clone'),
        onClick: () => openClone(theme),
        // #827: creating a theme writes its folder tree into the gym's own
        // Cloudflare folder, so the action is unavailable — with the reason — for
        // as long as that folder cannot be written to.
        disabled: !!storageBlock,
        title: storageBlock ? t(`clone_${storageBlock}`) : undefined,
      },
    ];
    if (!isDeleted && !theme.is_base) {
      if (theme.status === 'draft' || theme.status === 'inactive') {
        menuItems.push({ label: t('action_activate'), onClick: () => handleStatusChange(theme, 'active') });
      }
      if (theme.status === 'active') {
        menuItems.push({ label: t('action_set_draft'), onClick: () => handleStatusChange(theme, 'draft') });
        menuItems.push({ label: t('action_set_inactive'), onClick: () => handleStatusChange(theme, 'inactive') });
      }
      // #828: the Theme's *own* storage structure, manually and repeatably. A
      // Base Theme is excluded: its objects are the platform's (`cordel/…`) and
      // are initialized from the Base Themes page, not from a gym's.
      menuItems.push({
        label: t('action_initialize_bucket'),
        onClick: () => handleInitializeBucket(theme),
        disabled: !!storageBlock || initializingBucketId === theme.id,
        title: storageBlock ? t(`initialize_bucket_${storageBlock}`) : undefined,
      });
      menuItems.push({ label: t('delete'), onClick: () => setDeleting(theme), danger: true });
    }
    menuItems.push({ label: t('details'), onClick: () => setDetails(theme) });

    return (
      <div key={theme.id} style={{ ...cardSurfaceStyle, marginBottom: 10, overflow: 'hidden' }}>
        <div
          className={LIST_GRID_ROW_CLASS}
          style={{ ...themeRowStyle, cursor: isDeleted ? 'default' : 'pointer' }}
          onClick={() => !isDeleted && openExpand(theme)}
        >
          {/* #1040: one fixed logo box for every row. The image is fitted inside it
              (contain keeps the aspect ratio), so a wide or tall logo can never
              spill into the name or badges, and a row without a logo lines up. */}
          <div className={CELL_CLASS.logo} style={{ height: 28, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {theme.has_logo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl(theme)} alt={theme.name} style={{ maxWidth: '100%', maxHeight: '100%', width: 'auto', height: 'auto', borderRadius: 4, objectFit: 'contain' }} />
            ) : (
              <div style={{ width: 36, height: 28, background: colors?.headerBackground ?? '#1a1a2e', borderRadius: 4 }} />
            )}
          </div>

          <div className={CELL_CLASS.name} title={theme.name} style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              {/* The name is the cell that gives way, so the badges beside it stay
                  legible rather than being pushed out of the row (#1011). */}
              <span style={{ fontWeight: 600, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{theme.name}</span>
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

          <div className={CELL_CLASS.swatches} style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
            {([colors?.sidebarSelectedItemBackground, colors?.headerBackground, colors?.pageBackground] as (string | undefined)[]).map((c, i) => (
              <div key={i} title={['Primary', 'Secondary', 'Background'][i]} style={{ width: 18, height: 18, borderRadius: 3, background: c ?? '#ccc', border: '1px solid #ddd' }} />
            ))}
          </div>

          <span className={CELL_CLASS.status}>
            <StatusBadge status={theme.status} label={tStatus(theme.status)} />
          </span>

          {/* The cell is always rendered, glyph or not: a track dropped from one
              row would slide every cell after it out of line with the others. */}
          <span className={CELL_CLASS.expand} style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            {isDeleted ? null : '▾'}
          </span>

          <div className={CELL_CLASS.actions} onClick={(e) => e.stopPropagation()}>
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
          {/* Each section's cards share LIST_GRID_COLUMNS and scroll together,
              so a narrow viewport scrolls the list instead of the page (#1011). */}
          {basethemes.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('section_system')}</p>
              <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
                <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
                  {basethemes.map(renderThemeRow)}
                </div>
              </div>
            </div>
          )}
          {myThemes.length > 0 && (
            <div>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('section_mine')}</p>
              <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
                <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
                  {myThemes.map(renderThemeRow)}
                </div>
              </div>
            </div>
          )}
          {themes.length === 0 && <p style={{ color: '#888' }}>{t('empty')}</p>}
        </>
      )}

      <CrudModal open={cloning !== null} title={t('clone_title')} error={cloneError} saving={cloneSaving} cancelLabel={t('cancel')} saveLabel={cloneSaving ? t('clone_saving') : t('clone_save')} onCancel={() => setCloning(null)} onSave={handleClone}>
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
