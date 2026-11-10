// #2567 stage 1 — the PRIVATE Cloudflare R2 client, used exclusively for
// invoices and receipts. It shares nothing with `storage.ts` (the public
// bucket for images): its own credentials, bucket and endpoint, and no public
// URL — a document leaves this module only as bytes, through an authenticated
// API route.
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

function getConfig() {
  return {
    endpoint: process.env.CLOUDFLARE_R2_PRIVATE_ENDPOINT,
    accessKeyId: process.env.CLOUDFLARE_R2_PRIVATE_ACCESS_KEY_ID,
    secretAccessKey: process.env.CLOUDFLARE_R2_PRIVATE_SECRET_ACCESS_KEY,
    bucket: process.env.CLOUDFLARE_R2_PRIVATE_BUCKET,
  };
}

export function getMissingPrivateStorageConfigKeys(): string[] {
  const c = getConfig();
  const missing: string[] = [];
  if (!c.endpoint) missing.push('CLOUDFLARE_R2_PRIVATE_ENDPOINT');
  if (!c.accessKeyId) missing.push('CLOUDFLARE_R2_PRIVATE_ACCESS_KEY_ID');
  if (!c.secretAccessKey) missing.push('CLOUDFLARE_R2_PRIVATE_SECRET_ACCESS_KEY');
  if (!c.bucket) missing.push('CLOUDFLARE_R2_PRIVATE_BUCKET');
  return missing;
}

export function isPrivateStorageConfigured(): boolean {
  return getMissingPrivateStorageConfigKeys().length === 0;
}

let cachedClient: S3Client | null = null;

function getClient(): S3Client {
  if (cachedClient) return cachedClient;
  const { endpoint, accessKeyId, secretAccessKey } = getConfig();
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error('Private Cloudflare R2 storage is not configured for this deployment');
  }
  cachedClient = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    // Same pin as the public client (#542): R2 rejects aws-chunked checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return cachedClient;
}

function requireBucket(): string {
  const { bucket } = getConfig();
  if (!bucket) throw new Error('Private Cloudflare R2 storage is not configured for this deployment');
  return bucket;
}

/** True when an object already exists at `key` (a document is never overwritten). */
export async function privateObjectExists(key: string): Promise<boolean> {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: requireBucket(), Key: key }));
    return true;
  } catch (err: any) {
    if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
    throw err;
  }
}

/**
 * Writes a PDF at an exact key and refuses to replace an existing one: an
 * issued document is never overwritten. Returns the key (there is no URL).
 */
export async function putPrivateDocument(key: string, body: Buffer, contentType = 'application/pdf'): Promise<string> {
  if (await privateObjectExists(key)) {
    throw new Error(`A document already exists at ${key}`);
  }
  await getClient().send(new PutObjectCommand({
    Bucket: requireBucket(), Key: key, Body: body, ContentType: contentType,
  }));
  return key;
}

export async function getPrivateDocument(key: string): Promise<{ body: Buffer; contentType: string | null }> {
  const result = await getClient().send(new GetObjectCommand({ Bucket: requireBucket(), Key: key }));
  const bytes = await (result.Body as any)?.transformToByteArray();
  if (!bytes) throw new Error('Object has no body');
  return { body: Buffer.from(bytes), contentType: result.ContentType ?? null };
}
