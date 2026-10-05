// Saving a Theme's assets — the logo and the Members App backgrounds —
// declared once for the two screens that edit a Theme (#830).
//
// Custom Themes (`[locale]/themes`) and Base Themes (`[locale]/system/themes`)
// render the same editor (`ThemeSectionEditor`, `ThemeMembersImagesEditor`) and
// hold the same draft: a picked file or a queued removal per asset, committed on
// Save. Until #830 each page also carried its own copy of the Save sequence, and
// the copies had drifted — the Base Themes page called `DELETE` for a logo and
// for a Members slot with no diagnostic at all, so removing one came back as the
// bare `Unauthorized` the diagnostics existed to replace. Both now plan, run and
// report through this module, which is why a new asset or a new failure message
// cannot reach one screen and miss the other.
//
// Two properties are the ticket's, not incidental:
//
//   * **Every asset is attempted.** `runThemeAssetOps()` never stops at the
//     first failure: a rejected `training` upload must not keep `nutrition`
//     from being saved (§Upload Independence), so each operation carries its own
//     try/catch and the caller gets every failure rather than the first one.
//   * **A failed asset stays pending.** `pendingAfterFailures()` says which
//     parts of the draft to keep, so the next Save retries exactly what failed
//     and the successes are not uploaded twice.
//
// Everything here is pure except `runThemeAssetOps()`, which takes its two
// requests as callbacks — the pages pass `uploadFetch`/`apiFetch`, a test passes
// stubs. No next-intl either: the labels arrive already translated, because the
// two screens read the same keys from different namespaces (`gym_themes` and
// `themes`).

import { MEMBER_IMAGE_SLOTS, type MemberImageSlot } from '@/components/ThemeMembersImagesEditor';
import { formatStorageError, type StorageErrorLabels, type StorageErrorLike } from '@/lib/storageErrorMessage';
import { storageCauseSuggestsInitialize, storageFailureCause } from '@/lib/storageFailureCause';

/** One asset operation a Save has to perform. */
export type ThemeAssetOp =
  | { kind: 'logo_upload'; file: Blob }
  | { kind: 'logo_remove' }
  | { kind: 'members_image_upload'; slot: MemberImageSlot; file: Blob }
  | { kind: 'members_image_remove'; slot: MemberImageSlot };

/** The asset half of an editor's draft, as both pages hold it in state. */
export interface ThemeAssetDraft {
  logoFile: Blob | null;
  logoRemovePending: boolean;
  membersImageFiles: Record<MemberImageSlot, Blob | null>;
  membersImageRemovals: Record<MemberImageSlot, boolean>;
}

/**
 * What the draft asks for, in the order it is performed: the logo first, then
 * the slots in the order the editor shows them.
 *
 * A picked file wins over a queued removal for the same asset — picking clears
 * the removal in both editors, so the two are already exclusive; encoding it
 * here as well means a state the UI cannot produce still cannot delete an object
 * the user has just replaced.
 */
export function planThemeAssetOps(draft: ThemeAssetDraft): ThemeAssetOp[] {
  const ops: ThemeAssetOp[] = [];
  if (draft.logoFile) ops.push({ kind: 'logo_upload', file: draft.logoFile });
  else if (draft.logoRemovePending) ops.push({ kind: 'logo_remove' });
  for (const slot of MEMBER_IMAGE_SLOTS) {
    const file = draft.membersImageFiles[slot];
    if (file) ops.push({ kind: 'members_image_upload', slot, file });
    else if (draft.membersImageRemovals[slot]) ops.push({ kind: 'members_image_remove', slot });
  }
  return ops;
}

/**
 * The request one operation makes, under the router root the page owns
 * (`/system/themes` for a Custom Theme, `/platform/themes` for a Base Theme).
 *
 * The root is a parameter for the reason `ExerciseImageField`'s `basePath` is
 * (#806): the shared code names no endpoint and makes no permission decision, so
 * the gym's module permissions and `requireSuperadmin` stay on the pages.
 */
export function themeAssetOpRequest(
  op: ThemeAssetOp,
  basePath: string,
  themeId: string,
): { method: 'POST' | 'DELETE'; path: string; file: Blob | null } {
  switch (op.kind) {
    case 'logo_upload':
      return { method: 'POST', path: `${basePath}/${themeId}/logo`, file: op.file };
    case 'logo_remove':
      return { method: 'DELETE', path: `${basePath}/${themeId}/logo`, file: null };
    case 'members_image_upload':
      return { method: 'POST', path: `${basePath}/${themeId}/members-images/${op.slot}`, file: op.file };
    case 'members_image_remove':
      return { method: 'DELETE', path: `${basePath}/${themeId}/members-images/${op.slot}`, file: null };
  }
}

/**
 * The `storage_stage_<value>` this operation is named by when the API's own
 * answer carries no `stage` — an auth or validation refusal never reached the
 * storage code, and a failure nobody can name is the complaint #824 was written
 * against. When the API did name a stage, that one wins (it knows whether it
 * broke resolving the path, creating a folder or uploading).
 */
export function themeAssetOpStage(op: ThemeAssetOp): string {
  switch (op.kind) {
    case 'logo_upload': return 'upload_logo';
    case 'logo_remove': return 'remove_logo';
    case 'members_image_upload': return 'upload_members_image';
    case 'members_image_remove': return 'remove_members_image';
  }
}

/**
 * The `storage_error_title_<value>` heading for this operation, and the slot to
 * interpolate into it when there is one — a Members failure says *which* slot
 * it was, since identical headings would not tell the admin which upload to
 * retry.
 */
export function themeAssetOpTitle(op: ThemeAssetOp): { key: string; slot: MemberImageSlot | null } {
  switch (op.kind) {
    case 'logo_upload': return { key: 'storage_error_title_logo', slot: null };
    case 'logo_remove': return { key: 'storage_error_title_logo_remove', slot: null };
    case 'members_image_upload': return { key: 'storage_error_title_members_image_slot', slot: op.slot };
    case 'members_image_remove': return { key: 'storage_error_title_members_image_remove_slot', slot: op.slot };
  }
}

/** One asset that did not save, with whatever the API said about it. */
export interface ThemeAssetFailure {
  op: ThemeAssetOp;
  error: StorageErrorLike;
}

export interface ThemeAssetSaveResult {
  succeeded: ThemeAssetOp[];
  failures: ThemeAssetFailure[];
}

/** The two requests the pages already have, as this module needs them. */
export interface ThemeAssetIo {
  /** Router root: `/system/themes` or `/platform/themes`. */
  basePath: string;
  themeId: string;
  /** Raw image bytes — `uploadFetch`, which is the only correct binary upload. */
  upload: (path: string, file: Blob) => Promise<unknown>;
  /** `apiFetch(path, { method: 'DELETE' })`. */
  remove: (path: string) => Promise<unknown>;
}

/**
 * Performs every operation and reports all of them.
 *
 * Sequential on purpose: the operations are independent in their *errors*, which
 * is what §Upload Independence asks for, not in their timing — seven parallel
 * uploads would race the same theme row and give the admin an error order that
 * changes between attempts. Nothing is thrown: a caller that wants the old
 * abort-on-first-failure behaviour would have to ask for it, and none does.
 */
export async function runThemeAssetOps(ops: ThemeAssetOp[], io: ThemeAssetIo): Promise<ThemeAssetSaveResult> {
  const succeeded: ThemeAssetOp[] = [];
  const failures: ThemeAssetFailure[] = [];
  for (const op of ops) {
    const req = themeAssetOpRequest(op, io.basePath, io.themeId);
    try {
      if (req.file) await io.upload(req.path, req.file);
      else await io.remove(req.path);
      succeeded.push(op);
    } catch (err: any) {
      failures.push({ op, error: err ?? {} });
    }
  }
  return { succeeded, failures };
}

/**
 * The already-translated strings `formatThemeAssetFailures()` needs. `title()`
 * and `operationName()` are functions because both depend on the operation —
 * the page resolves them through its own namespace, so neither screen can end
 * up with a heading the other lacks.
 */
export interface ThemeAssetLabels
  extends Omit<StorageErrorLabels, 'title' | 'operationName' | 'causeName' | 'suggestionText'> {
  title: (op: ThemeAssetOp) => string;
  operationName: (op: ThemeAssetOp, stage: string) => string;
  /**
   * #1042: the *Why* and *What you can do* sentences for one failure, resolved
   * by the page from its own namespace — a function of the error rather than of
   * the operation, because the cause is what the storage layer answered and not
   * the step that was running. `null` for a failure the admin cannot diagnose,
   * which is what keeps the block free of an invented explanation.
   */
  diagnosis?: (err: StorageErrorLike) => { causeName: string; suggestionText: string } | null;
}

/** One failure as the diagnostic block #824 defined (operation, path, error, details). */
export function formatThemeAssetFailure(failure: ThemeAssetFailure, labels: ThemeAssetLabels): string {
  const stage = failure.error.body?.stage ?? themeAssetOpStage(failure.op);
  const diagnosis = labels.diagnosis?.(failure.error) ?? null;
  return formatStorageError(failure.error, {
    ...labels,
    title: labels.title(failure.op),
    operationName: labels.operationName(failure.op, stage),
    causeName: diagnosis?.causeName ?? null,
    suggestionText: diagnosis?.suggestionText ?? null,
  });
}

/**
 * Every failure of one Save, blank-line separated — the error line of both
 * editors renders it with `white-space: pre-line`.
 *
 * All of them, not the first: a Save that touched four assets and broke on two
 * has to say so, or the admin fixes one and meets the other on the next attempt
 * with no idea it was already failing.
 */
export function formatThemeAssetFailures(failures: ThemeAssetFailure[], labels: ThemeAssetLabels): string {
  return failures.map((failure) => formatThemeAssetFailure(failure, labels)).join('\n\n');
}

/**
 * Which parts of the draft survive a Save: exactly the ones that failed.
 *
 * The page clears the rest, so a successful upload is not sent again by the next
 * Save and a failed one is still queued with its file and its preview intact —
 * which is what makes "retry" mean pressing Save again.
 */
export interface ThemeAssetPending {
  logoUpload: boolean;
  logoRemove: boolean;
  slotUploads: Set<MemberImageSlot>;
  slotRemovals: Set<MemberImageSlot>;
}

export function pendingAfterFailures(failures: ThemeAssetFailure[]): ThemeAssetPending {
  const pending: ThemeAssetPending = {
    logoUpload: false,
    logoRemove: false,
    slotUploads: new Set(),
    slotRemovals: new Set(),
  };
  for (const { op } of failures) {
    if (op.kind === 'logo_upload') pending.logoUpload = true;
    else if (op.kind === 'logo_remove') pending.logoRemove = true;
    else if (op.kind === 'members_image_upload') pending.slotUploads.add(op.slot);
    else pending.slotRemovals.add(op.slot);
  }
  return pending;
}

/** `{ training: File, nutrition: File }` → only the slots in `keep`. */
export function keepBySlot<T>(
  values: Record<MemberImageSlot, T | null>,
  keep: Set<MemberImageSlot>,
): Record<MemberImageSlot, T | null> {
  return Object.fromEntries(
    MEMBER_IMAGE_SLOTS.map((slot) => [slot, keep.has(slot) ? values[slot] : null]),
  ) as Record<MemberImageSlot, T | null>;
}

/** The same for the boolean removal flags. */
export function keepFlagsBySlot(keep: Set<MemberImageSlot>): Record<MemberImageSlot, boolean> {
  return Object.fromEntries(
    MEMBER_IMAGE_SLOTS.map((slot) => [slot, keep.has(slot)]),
  ) as Record<MemberImageSlot, boolean>;
}

/**
 * Whether the logo failed, and which slots did — what the editors mark next to
 * the control that failed, so the admin can see which of seven uploads the
 * message above belongs to without reading the paths.
 */
/**
 * Whether any of this Save's failures is evidence that the Theme's Cloudflare
 * storage was never created — which is the one thing that puts the
 * `Initialize bucket` action beside the error (#1042 §3).
 *
 * Here rather than in each page for `logoAssetFailed()`'s reason: both Theme
 * screens offer the same action from the same evidence, and a second copy is
 * how one of them would come to offer it for a permission failure (§4).
 */
export function initializeSuggestedByFailures(failures: ThemeAssetFailure[]): boolean {
  return failures.some(({ error }) => storageCauseSuggestsInitialize(storageFailureCause(error)));
}

export function logoAssetFailed(failures: ThemeAssetFailure[]): boolean {
  return failures.some(({ op }) => op.kind === 'logo_upload' || op.kind === 'logo_remove');
}

export function failedMembersImageSlots(failures: ThemeAssetFailure[]): Record<MemberImageSlot, boolean> {
  const failed = new Set<MemberImageSlot>();
  for (const { op } of failures) {
    if (op.kind === 'members_image_upload' || op.kind === 'members_image_remove') failed.add(op.slot);
  }
  return keepFlagsBySlot(failed);
}
