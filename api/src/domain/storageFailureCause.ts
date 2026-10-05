// *Why* a storage-backed save failed — the second half of the diagnostic #824
// started with `stage` (#1042).
//
// `stage` says which step broke (`upload_logo`, `create_theme_folder`, …) and
// the `details` say what S3 answered. Neither says what the administrator is
// supposed to *do*, which is the complaint this ticket is written against: a
// gym owner reading `Theme not found (404)` cannot tell a missing Cloudflare
// bucket from a deleted Theme from a wrong credential, and the one action that
// would fix the first — Initialize bucket — is three clicks away in a context
// menu they have no reason to open.
//
// So every storage failure response also carries a `cause`: one value from the
// closed set below, which the admin turns into a *Why* sentence and a *What to
// do* suggestion, and which gates the `Initialize bucket` button it offers
// beside the error. The rule the ticket's §4 states is the reason the set is
// closed and the reason this module exists at all: the initialization
// suggestion may only appear when the failure is *evidence* that storage was
// never initialized. A cause is therefore diagnosed from what the storage layer
// actually answered, never from the step that was running.
//
// Pure, and mirrored for the browser in
// `apps/admin/src/lib/storageFailureCause.ts` — the admin diagnoses the
// failures that never reach a route (a 401 from the proxy, a 404 from the
// router itself) from their HTTP status, and the two vocabularies have to be
// one vocabulary. A new cause therefore goes in **three** places: this list,
// that mirror, and a `storage_cause_<value>` + `storage_suggestion_<value>` pair
// in `apps/admin/locales/base/{en,es,ca}.json` for **both** theme namespaces —
// the key is interpolated from the wire value and next-intl prints a missing key
// verbatim.

export const STORAGE_FAILURE_CAUSES = [
  /** The deployment has no `CLOUDFLARE_R2_*` configuration at all (503). */
  'not_configured',
  /**
   * The storage structure this write needs does not exist: the gym has no
   * `storage_folder_prefix` (409), or R2 itself answered that the bucket or
   * object is not there. This is the **only** cause that offers Initialize.
   */
  'not_initialized',
  /** The row being written was not found — a deleted Theme, or another gym's. */
  'not_found',
  /** Our own 401/403, or a credential/signature refusal from R2. */
  'access_denied',
  /** The uploaded file itself was refused — type, size or empty body. */
  'invalid_file',
  /** The storage service could not be reached, or did not complete the call. */
  'unreachable',
] as const;

export type StorageFailureCause = (typeof STORAGE_FAILURE_CAUSES)[number];

export function isStorageFailureCause(value: unknown): value is StorageFailureCause {
  return typeof value === 'string' && (STORAGE_FAILURE_CAUSES as readonly string[]).includes(value);
}

/**
 * Whether this cause is evidence that the storage structure was never created,
 * and therefore the one thing that may offer `Initialize bucket` (§3/§4).
 *
 * A function rather than a comparison at each call site so the rule has one
 * definition: suggesting initialization for a permission or network failure
 * sends an administrator to re-run a no-op while the real problem stands, and
 * suggesting it for `not_found` would offer to create folders for a Theme that
 * does not exist.
 */
export function storageCauseSuggestsInitialize(cause: StorageFailureCause | null): boolean {
  return cause === 'not_initialized';
}

/** The S3 error names and codes that mean "the thing you addressed is not there". */
const MISSING_NAMES = ['NoSuchBucket', 'NoSuchKey', 'NotFound', 'NoSuchUpload'];

/** …and the ones that mean "your credentials were refused". */
const DENIED_NAMES = [
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'CredentialsProviderError',
  'ExpiredToken',
  'Unauthorized',
  'Forbidden',
];

/**
 * The cause of a failed S3 call, read from what the SDK answered rather than
 * from the step that was running.
 *
 * Taken from the error's own name/code first and its HTTP status second,
 * because R2 answers `NoSuchBucket` with a 404 but a credential refusal with a
 * 403 *and* sometimes a 400 — the name is the reliable half. Anything
 * unrecognised is `unreachable`: the call did not complete and we cannot say
 * more than that, which is an honest answer and, deliberately, not one that
 * offers to initialize anything.
 */
export function storageCauseFromDetails(
  details: { name?: string | null; code?: string | null; httpStatusCode?: number | null } | null | undefined,
): StorageFailureCause {
  const name = details?.name ?? null;
  const code = details?.code ?? null;
  const status = details?.httpStatusCode ?? null;
  if ((name && MISSING_NAMES.includes(name)) || (code && MISSING_NAMES.includes(code)) || status === 404) {
    return 'not_initialized';
  }
  if ((name && DENIED_NAMES.includes(name)) || (code && DENIED_NAMES.includes(code)) || status === 401 || status === 403) {
    return 'access_denied';
  }
  return 'unreachable';
}
