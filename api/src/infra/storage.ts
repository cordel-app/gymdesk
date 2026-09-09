import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * #417 stage 1: platform-wide Cloudflare R2 integration (S3-compatible).
 * Credentials are deploy-time env vars, not per-gym DB-stored secrets —
 * mirrors the MONEI/Clerk pattern (see payments/index.ts's getPaymentProvider).
 * Every gym gets its own folder prefix inside the single shared bucket.
 */

// Folder-marker keys under `<gym_id>-<gym_name>/` (#417). Parents are written
// as well as leaves so the R2 browser shows the exact tree from the ticket.
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
  const { endpoint, accessKeyId, secretAccessKey, bucket } = getConfig();
  return !!(endpoint && accessKeyId && secretAccessKey && bucket);
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
  });
  return cachedClient;
}

/** Strip path separators and anything but alphanumerics/-/_ from a gym name. */
export function sanitizeGymFolderName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^A-Za-z0-9_-]/g, '');
}

/** `<gym_id>-<sanitized_gym_name>`, guaranteed to contain no spaces. */
export function buildGymFolderPrefix(gymId: string, gymName: string): string {
  return `${gymId}-${sanitizeGymFolderName(gymName)}`;
}

/**
 * Creates the standard folder structure for a gym inside the shared bucket.
 * R2/S3 has no real directories — a zero-byte object whose key ends in `/`
 * is the conventional "folder marker" most S3-compatible browsers render.
 */
export async function initializeGymBucket(folderPrefix: string): Promise<void> {
  const { bucket } = getConfig();
  const client = getClient();
  const keys = [`${folderPrefix}/`, ...GYM_FOLDERS.map((folder) => `${folderPrefix}/${folder}`)];
  for (const key of keys) {
    await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: '',
    }));
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
  await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: mime,
  }));
  return `${endpoint}/${bucket}/${key}`;
}
