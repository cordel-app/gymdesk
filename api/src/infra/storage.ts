import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

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

/** Strip path separators and anything but alphanumerics/-/_ from a gym name. */
export function sanitizeGymFolderName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '');
}

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

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

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
  const { bucket, endpoint } = getConfig();
  const client = getClient();
  const ext = MIME_EXTENSIONS[mime] ?? 'bin';
  const key = `${folderPrefix}/${folder}/${randomUUID()}.${ext}`;
  try {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mime,
    }));
  } catch (err) {
    throw new StorageOperationError(
      describeStorageError(err, { operation: 'uploadGymImage', key, bucket }),
      err,
    );
  }
  return `${endpoint}/${bucket}/${key}`;
}
