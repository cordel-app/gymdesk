/**
 * Turns a failed storage-backed save into an error an administrator can act on
 * (#824).
 *
 * The complaint the ticket is written against is a toast reading `Unauthorized`
 * and nothing else: it names neither the step that failed nor the object it was
 * working on, so there is no way to tell a missing tenant header from a wrong
 * R2 bucket from a rejected key. The API's storage routes answer with `stage`,
 * `path` and the structured `details` of the underlying S3 call; this turns
 * that into the block the ticket specifies:
 *
 * ```text
 * Logo upload failed.
 *
 * Operation: Upload logo
 * Path: gyms/123-QSport/themes/456-CrimsonBase/logo/logo.png
 * Error: Unauthorized (401)
 * Details: Cloudflare storage rejected the request.
 * ```
 *
 * #1042 added the other two lines the ticket after it asked for — *why* it
 * failed and *what you can do* — between the error and the details:
 *
 * ```text
 * Error: Theme storage path was not found (404)
 * Cause: The Cloudflare storage structure this theme needs does not exist yet.
 * What you can do: Initialize this theme's Cloudflare storage and save again.
 * ```
 *
 * Both are optional and both halves of each pair must be present, so a failure
 * nothing could diagnose (`storageFailureCause()` answered `null`) renders
 * exactly the block above rather than an invented explanation — which is also
 * what keeps the `Initialize bucket` button the page offers beside this text
 * off the screen for a failure that initialization would not fix.
 *
 * Pure, and deliberately not a React component: the two Themes pages render it
 * into the error line they already have, and a unit test can assert the text.
 * Every label is passed in already translated — the caller resolves
 * `storage_stage_<stage>` through next-intl, which prints a missing key
 * verbatim, so a new stage needs its key added in
 * `apps/admin/locales/base/{en,es,ca}.json`.
 */

/** The `{ error, stage, path, details }` shape the storage routes answer with. */
export interface StorageErrorBody {
  error?: string;
  stage?: string;
  /**
   * #1042: *why* it failed, from the closed set in
   * `api/src/domain/storageFailureCause.ts`. The route states it where the
   * client could not derive it (a 409 is also a name conflict, a 400 is also a
   * rejected status value); `storageFailureCause()` reads it.
   */
  cause?: string;
  path?: string;
  details?: {
    operation?: string;
    message?: string;
    name?: string | null;
    code?: string | null;
    httpStatusCode?: number | null;
    requestId?: string | null;
    key?: string | null;
    bucket?: string | null;
  } | null;
  missingConfig?: string[];
}

export interface StorageErrorLabels {
  /** Heading, e.g. `Logo upload failed.` */
  title: string;
  /** Label of the operation line, e.g. `Operation`. */
  operation: string;
  path: string;
  error: string;
  details: string;
  /**
   * The operation that failed, in the admin's words. The caller resolves it
   * from the body's `stage` when there is one and otherwise from the request it
   * was making, so a failure with no stage (a 401 before the route ran) is
   * still named.
   */
  operationName: string;
  /**
   * #830: what the `Error:` line says when the failure carries nothing usable —
   * no message, no status, no storage detail. The acceptance criteria require a
   * clear generic sentence rather than an empty line, and it is a label like the
   * rest so the caller resolves it through next-intl. Optional: a caller that
   * omits it gets the block with no `Error:` line, exactly as before.
   */
  fallbackError?: string;
  /**
   * #1042 §8 — the *Why* and *What you can do* half of the block. Both are
   * optional, and both halves of each pair must be present for the line to
   * render: a failure the admin could not diagnose (`storageFailureCause()`
   * answered `null`) keeps the block exactly as #824 defined it, rather than
   * growing an empty `Cause:` line or, worse, a suggestion that does not
   * follow from the error (§4).
   */
  cause?: string;
  /** The diagnosed sentence itself, e.g. *Cloudflare storage is not initialized.* */
  causeName?: string | null;
  /** Label of the suggestion line, e.g. `What you can do`. */
  suggestion?: string;
  /** The suggestion itself, e.g. *Initialize the Cloudflare storage and try again.* */
  suggestionText?: string | null;
}

/** The error an `apiFetch`/`uploadFetch` rejection carries. */
export interface StorageErrorLike {
  message?: string;
  status?: number;
  body?: StorageErrorBody | null;
}

/**
 * `Unauthorized (401)` — the message and the status on one line, either alone
 * when the other is missing. The status matters on its own: a 401 and a 502
 * with the same message are entirely different problems.
 */
function errorLine(err: StorageErrorLike): string {
  const status = err.body?.details?.httpStatusCode ?? err.status ?? null;
  const message = err.body?.error ?? err.message ?? '';
  if (message && status) return `${message} (${status})`;
  if (message) return message;
  return status ? String(status) : '';
}

/**
 * The storage-side particulars, when the API got far enough to have any: the
 * S3 error name and code, the bucket, and the request id Cloudflare support
 * asks for. Nothing secret — `describeStorageError()` on the API side never
 * puts a credential in `details`.
 */
function detailLine(body: StorageErrorBody | null | undefined): string {
  const parts: string[] = [];
  const details = body?.details;
  if (details?.name) parts.push(details.name);
  if (details?.code && details.code !== details.name) parts.push(details.code);
  if (details?.message && details.message !== body?.error) parts.push(details.message);
  if (details?.bucket) parts.push(`bucket: ${details.bucket}`);
  if (details?.requestId) parts.push(`request: ${details.requestId}`);
  if (body?.missingConfig?.length) parts.push(`missing: ${body.missingConfig.join(', ')}`);
  return parts.join(' — ');
}

export function formatStorageError(err: StorageErrorLike, labels: StorageErrorLabels): string {
  const lines = [labels.title, '', `${labels.operation}: ${labels.operationName}`];
  const path = err.body?.path ?? err.body?.details?.key ?? null;
  if (path) lines.push(`${labels.path}: ${path}`);
  const error = errorLine(err) || labels.fallbackError || '';
  if (error) lines.push(`${labels.error}: ${error}`);
  // #1042 §8: what happened (the title and the error) is followed by why and by
  // what to do, and the raw storage particulars come last — they are the
  // "secondary/details section" the ticket asks for, not the headline.
  if (labels.cause && labels.causeName) lines.push(`${labels.cause}: ${labels.causeName}`);
  if (labels.suggestion && labels.suggestionText) lines.push(`${labels.suggestion}: ${labels.suggestionText}`);
  const details = detailLine(err.body);
  if (details) lines.push(`${labels.details}: ${details}`);
  return lines.join('\n');
}

/**
 * The same diagnostic on one line, for a failure reported as a toast (#828).
 *
 * `Toast` renders its message as a single text node, so the block form's
 * newlines would collapse and run the labels together. Derived from
 * `formatStorageError()` rather than assembled a second time: an "Initialize
 * bucket" that fails has to name the same step, path and R2 error as a failed
 * upload does, and a second formatter is how the two would drift.
 */
export function formatStorageErrorLine(err: StorageErrorLike, labels: StorageErrorLabels): string {
  return formatStorageError(err, labels)
    .split('\n')
    .filter((line) => line !== '')
    .join(' · ');
}
