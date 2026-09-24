import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * #417 stage 1: platform-wide Cloudflare R2 integration (S3-compatible).
 * Credentials are deploy-time env vars, not per-gym DB-stored secrets —
 * mirrors the MONEI/Clerk pattern (see payments/index.ts's getPaymentProvider).
 * Every gym gets its own folder prefix inside the single shared bucket.
 */

/**
 * #668: every gym root lives under a single `gyms/` prefix inside the shared
 * bucket, so the bucket root stays free for other platform-level trees. It is
 * part of the object key, not a bucket/endpoint setting — see
 * `buildGymFolderPrefix()`. Gyms initialized before #668 keep the prefix
 * captured in `gyms.storage_folder_prefix` (no migration of existing objects).
 */
const GYM_STORAGE_ROOT = 'gyms';

/**
 * #732: `cordel` — the platform's own root inside the same shared bucket, the
 * sibling of `gyms/` (#668). Platform-level assets belong to no gym, so they
 * cannot hang off `gyms.storage_folder_prefix`; this constant is the whole of
 * their prefix, which is why a Base Theme's folder is
 * `cordel/Themes/<theme_id>-<name>/` — `buildThemeMemberImageKey()` takes the
 * prefix as its first argument and neither knows nor cares which root it came
 * from. Exported so there is one spelling of the platform root in the codebase:
 * a second literal `'cordel'` anywhere is a bug waiting to diverge from this.
 */
export const PLATFORM_STORAGE_ROOT = 'cordel';

/**
 * `Themes` — the branch every theme's own folder hangs off, under the gym root
 * for a Custom Theme and under {@link PLATFORM_STORAGE_ROOT} for a Base Theme
 * (#725, #732). Declared here because it is also one of the gym's top-level
 * folders (#735) and `domain/themeMemberImages.ts` re-exports it as
 * `THEME_STORAGE_FOLDER`, so the string has exactly one spelling.
 */
export const THEMES_FOLDER = 'Themes';

// Folder-marker keys under `gyms/<gym_id>-<gym_name>/` (#417, #668). Parents are
// written as well as leaves so the R2 browser shows the exact tree from the ticket.
const GYM_FOLDERS = [
  'Nutrition/',
  'Nutrition/Images/',
  'Exercises/',
  'Exercises/Images/',
  'Exercises/Videos/',
  'Branding/',
  'Branding/Logo/',
  'Branding/Images/',
  'Members/',
  // #735: the gym-level `Themes/` root only. A Custom Theme's own
  // `Themes/<theme_id>-<name>/Members/` branch is deliberately *not* created
  // here — it cannot exist before the theme does, and `ensureStorageFolders()`
  // writes it at upload time (#725). Appended rather than slotted in, so every
  // folder that existed before keeps the position it was written in.
  `${THEMES_FOLDER}/`,
];

let cachedClient: S3Client | null = null;

function getConfig() {
  return {
    endpoint: process.env.CLOUDFLARE_R2_ENDPOINT,
    accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    bucket: process.env.CLOUDFLARE_R2_BUCKET,
  };
}

/** Whether this deployment has R2 configured at all (platform-wide, not per-gym). */
export function isStorageConfigured(): boolean {
  return getMissingStorageConfigKeys().length === 0;
}

/**
 * Names of the CLOUDFLARE_R2_* env vars that are unset, so 503 responses can
 * tell an admin exactly what's missing instead of a generic "not configured".
 */
export function getMissingStorageConfigKeys(): string[] {
  const { endpoint, accessKeyId, secretAccessKey, bucket } = getConfig();
  const missing: string[] = [];
  if (!endpoint) missing.push('CLOUDFLARE_R2_ENDPOINT');
  if (!accessKeyId) missing.push('CLOUDFLARE_R2_ACCESS_KEY_ID');
  if (!secretAccessKey) missing.push('CLOUDFLARE_R2_SECRET_ACCESS_KEY');
  if (!bucket) missing.push('CLOUDFLARE_R2_BUCKET');
  return missing;
}

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const { endpoint, accessKeyId, secretAccessKey } = getConfig();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Cloudflare R2 storage is not configured for this deployment');
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // #542: aws-sdk-js v3 >= 3.729 defaults both of these to WHEN_SUPPORTED,
    // which makes PutObject send a trailing CRC32 checksum with
    // `content-encoding: aws-chunked`. R2 rejects that combination, so every
    // upload — including the zero-byte folder markers below — fails against a
    // correctly configured bucket. R2 never *requires* a checksum, so pinning
    // both to WHEN_REQUIRED restores the pre-3.729 wire format with no loss.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return cachedClient;
}

// ─── Diagnostics (#542) ───────────────────────────────────────────────────────
//
// R2 failures reach an admin as a one-line toast, which is not enough to tell
// a wrong endpoint from a wrong bucket from a bad key. The two helpers below
// turn a failure into structured, *non-secret* detail that the 502/503 bodies
// can carry into the UI. Neither ever returns the access key or the secret —
// only their lengths, which is enough to spot a truncated or whitespace-padded
// value without disclosing it.

export interface StorageDiagnostics {
  /** Hostname of CLOUDFLARE_R2_ENDPOINT, or null when unset/unparseable. */
  endpointHost: string | null;
  endpointProtocol: string | null;
  /**
   * Path portion of the endpoint. Must be empty — a non-empty value usually
   * means the bucket name was appended to the endpoint by mistake.
   */
  endpointPath: string | null;
  /** True when CLOUDFLARE_R2_ENDPOINT is set but not a parseable URL. */
  endpointMalformed: boolean;
  bucket: string | null;
  accessKeyIdLength: number;
  secretAccessKeyLength: number;
  missingConfig: string[];
}

/** Non-secret snapshot of the R2 configuration, safe to return to a superadmin. */
export function getStorageDiagnostics(): StorageDiagnostics {
  const { endpoint, accessKeyId, secretAccessKey, bucket } = getConfig();
  let endpointHost: string | null = null;
  let endpointProtocol: string | null = null;
  let endpointPath: string | null = null;
  let endpointMalformed = false;
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      endpointHost = url.host;
      endpointProtocol = url.protocol.replace(':', '');
      endpointPath = url.pathname === '/' ? '' : url.pathname;
    } catch {
      endpointMalformed = true;
    }
  }
  return {
    endpointHost,
    endpointProtocol,
    endpointPath,
    endpointMalformed,
    bucket: bucket ?? null,
    accessKeyIdLength: accessKeyId?.length ?? 0,
    secretAccessKeyLength: secretAccessKey?.length ?? 0,
    missingConfig: getMissingStorageConfigKeys(),
  };
}

export interface StorageErrorDetails {
  /** Which storage call failed, e.g. `initializeGymBucket` or `uploadGymImage`. */
  operation: string;
  message: string;
  /** SDK error class, e.g. `NoSuchBucket`, `SignatureDoesNotMatch`. */
  name: string | null;
  /** S3 error code from the response body, when the SDK parsed one. */
  code: string | null;
  httpStatusCode: number | null;
  requestId: string | null;
  /** Retry attempts the SDK made before giving up. */
  attempts: number | null;
  /** The object key the failing request targeted, when known. */
  key: string | null;
  bucket: string | null;
  /** Underlying cause chain (`err.cause`), outermost first. */
  causes: string[];
}

/**
 * Flattens an @aws-sdk/client-s3 rejection into a serializable shape. The SDK
 * hides most of what matters on `$metadata` and on non-enumerable fields, so
 * `JSON.stringify(err)` and `err.message` alone both lose it.
 */
export function describeStorageError(
  err: unknown,
  context: { operation: string; key?: string | null; bucket?: string | null } = { operation: 'unknown' },
): StorageErrorDetails {
  const e = (err ?? {}) as Record<string, any>;
  const metadata = (e.$metadata ?? {}) as Record<string, any>;
  const causes: string[] = [];
  let cause = e.cause;
  // Bounded so a self-referencing cause chain can't spin forever.
  for (let depth = 0; cause && depth < 5; depth += 1) {
    const causeMessage = (cause as any)?.message ?? String(cause);
    if (causeMessage) causes.push(causeMessage);
    cause = (cause as any)?.cause;
  }
  return {
    operation: context.operation,
    message: e.message ?? (typeof err === 'string' ? err : 'unknown error'),
    name: e.name ?? null,
    code: e.Code ?? e.code ?? null,
    httpStatusCode: metadata.httpStatusCode ?? null,
    requestId: metadata.requestId ?? metadata.extendedRequestId ?? null,
    attempts: metadata.attempts ?? null,
    key: context.key ?? e.Key ?? null,
    bucket: context.bucket ?? getConfig().bucket ?? null,
    causes,
  };
}

/** Error thrown by the storage layer, carrying the key/operation that failed. */
export class StorageOperationError extends Error {
  readonly details: StorageErrorDetails;

  constructor(details: StorageErrorDetails, cause: unknown) {
    super(details.message);
    this.name = 'StorageOperationError';
    this.details = details;
    this.cause = cause;
  }
}

/**
 * Strip path separators and anything but alphanumerics/-/_ from a name that is
 * about to become one folder of an object key. The one sanitizer for the whole
 * tree: the gym folder (#417) and a Custom Theme's own folder (#725) are both
 * built with it, so a name can never introduce a `/`, a space or a character
 * that would have to be escaped in a URL.
 */
export function sanitizeStorageFolderName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '');
}

/** Historical name of {@link sanitizeStorageFolderName}, kept for gym callers. */
export const sanitizeGymFolderName = sanitizeStorageFolderName;

/**
 * `gyms/<gym_id>-<sanitized_gym_name>`, guaranteed to contain no spaces.
 * The `gyms/` root (#668) is part of the key prefix that gets captured in
 * `gyms.storage_folder_prefix` at initialize time, so both the folder markers
 * and every later upload land under it without a second concatenation site.
 */
export function buildGymFolderPrefix(gymId: string, gymName: string): string {
  return `${GYM_STORAGE_ROOT}/${gymId}-${sanitizeGymFolderName(gymName)}`;
}

/**
 * Creates the standard folder structure for a gym inside the shared bucket,
 * under the root `folderPrefix` (`gyms/<gym_id>-<gym_name>` since #668).
 * R2/S3 has no real directories — a zero-byte object whose key ends in `/`
 * is the conventional "folder marker" most S3-compatible browsers render.
 */
export async function initializeGymBucket(folderPrefix: string): Promise<void> {
  const { bucket } = getConfig();
  const client = getClient();
  const keys = [`${folderPrefix}/`, ...GYM_FOLDERS.map((folder) => `${folderPrefix}/${folder}`)];
  for (const key of keys) {
    try {
      await client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: '',
      }));
    } catch (err) {
      // #542: name the exact marker key that failed — the folder tree is
      // written one object at a time, so "which key" narrows a partial failure.
      throw new StorageOperationError(
        describeStorageError(err, { operation: 'initializeGymBucket', key, bucket }),
        err,
      );
    }
  }
}

/**
 * Writes zero-byte folder markers, outermost first, for a branch of the tree
 * that `initializeGymBucket()` did not create — a Custom Theme's own folder and
 * its `Members/` leaf (#725), which cannot exist at gym-initialize time because
 * the theme does not exist yet.
 *
 * Idempotent and non-destructive by construction: every key ends in `/`, so the
 * object it overwrites is always another marker, never a file. Existing markers
 * are simply rewritten with the same empty body, which is what "safely reused"
 * means for a store with no directories.
 */
export async function ensureStorageFolders(keys: string[]): Promise<void> {
  const { bucket } = getConfig();
  const client = getClient();
  for (const key of keys) {
    try {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: '' }));
    } catch (err) {
      throw new StorageOperationError(
        describeStorageError(err, { operation: 'ensureStorageFolders', key, bucket }),
        err,
      );
    }
  }
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  // #713: theme logos allow SVG (`themes.ts`/`gym-themes.ts`' ALLOWED_MIME_TYPES).
  // The image-upload routes don't, so adding it here changes nothing for them.
  'image/svg+xml': 'svg',
};

/**
 * Extension for a validated MIME type — the server never takes the extension
 * from the client (#713): the uploaded file's name plays no part in the key.
 * `bin` for an unmapped type, so an unknown MIME can never produce an
 * extensionless key.
 */
export function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? 'bin';
}

/** `Branding/Logo` — the gym folder (#417) a Custom Theme logo belongs in (#713). */
export const BRANDING_LOGO_FOLDER = 'Branding/Logo';

/**
 * #713: the one key a gym's Custom Theme logo is stored under —
 * `<folderPrefix>/Branding/Logo/logo.<ext>`. The name is fixed, so a gym holds
 * one branding logo at a time; only the extension varies, which is why
 * replacing a logo has to delete the previous key when the type changed.
 */
export function buildGymLogoKey(folderPrefix: string, mime: string): string {
  return `${folderPrefix}/${BRANDING_LOGO_FOLDER}/logo.${extensionForMime(mime)}`;
}

/**
 * Public URL of a stored object: endpoint + bucket + key, the composition
 * `uploadGymImage()` has returned since #417 stage 2 (no presigned/CDN URL).
 * Null for a missing key, and null when the deployment has no R2
 * endpoint/bucket configured — so a caller can't hand out a half-built URL.
 */
export function buildStorageObjectUrl(key: string | null | undefined): string | null {
  const { bucket, endpoint } = getConfig();
  if (!key || !endpoint || !bucket) return null;
  return `${endpoint}/${bucket}/${key}`;
}

/**
 * Writes `body` at an exact key and returns its public URL. Used where the key
 * is part of the contract rather than generated — the Custom Theme logo (#713).
 */
export async function uploadStorageObject(key: string, mime: string, body: Buffer): Promise<string> {
  const { bucket, endpoint } = getConfig();
  const client = getClient();
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mime,
    }));
  } catch (err) {
    throw new StorageOperationError(
      describeStorageError(err, { operation: 'uploadStorageObject', key, bucket }),
      err,
    );
  }
  return `${endpoint}/${bucket}/${key}`;
}

/**
 * Reads one object back. #713 uses it to serve an R2-backed theme logo through
 * the public `GET /themes/:id/logo` endpoint: the Payment app loads that URL
 * under `img-src 'self'` (its nginx proxies `/themes/` for exactly that
 * reason), and CSP still matches a redirect's host — so the endpoint returns
 * the bytes rather than pointing the browser at the bucket. Clients that can
 * reach R2 directly use the `logo_url` on the theme-shaped responses instead.
 */
export async function getStorageObject(key: string): Promise<{ body: Buffer; contentType: string | null }> {
  const { bucket } = getConfig();
  const client = getClient();
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await (result.Body as any)?.transformToByteArray();
    if (!bytes) throw new Error('Object has no body');
    return { body: Buffer.from(bytes), contentType: result.ContentType ?? null };
  } catch (err) {
    throw new StorageOperationError(
      describeStorageError(err, { operation: 'getStorageObject', key, bucket }),
      err,
    );
  }
}

/**
 * Removes one object. #713 needs this so replacing a logo with a different file
 * type doesn't leave the previous `logo.<old ext>` behind as an orphan, and so
 * clearing a logo removes the file and not just the row's reference to it.
 */
export async function deleteStorageObject(key: string): Promise<void> {
  const { bucket } = getConfig();
  const client = getClient();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    throw new StorageOperationError(
      describeStorageError(err, { operation: 'deleteStorageObject', key, bucket }),
      err,
    );
  }
}

/**
 * #417 stage 2: uploads an image into a gym's folder and returns its public
 * URL. Per the issue thread's confirmed resolution, the URL is built from
 * the endpoint + bucket + key rather than requesting a presigned/CDN URL —
 * consistent with how `initializeGymBucket()`'s folder keys are addressed.
 */
export async function uploadGymImage(
  folderPrefix: string,
  folder: string,
  mime: string,
  body: Buffer,
): Promise<string> {
  const key = `${folderPrefix}/${folder}/${randomUUID()}.${extensionForMime(mime)}`;
  try {
    return await uploadStorageObject(key, mime, body);
  } catch (err) {
    // Keep the operation name callers (and #542's diagnostics) have always seen
    // for this route, even though the PutObject now goes through the helper.
    if (err instanceof StorageOperationError) {
      throw new StorageOperationError({ ...err.details, operation: 'uploadGymImage' }, err.cause);
    }
    throw err;
  }
}
