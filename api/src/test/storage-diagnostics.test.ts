// #542: unit tests for the R2 diagnostics helpers in infra/storage.ts.
// Pure functions over process.env and a rejected SDK error — no DB, no HTTP,
// so no createTestGym/cleanupTestGyms/db.end() here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  describeStorageError,
  getMissingStorageConfigKeys,
  getStorageDiagnostics,
  isStorageConfigured,
} from '../infra/storage';

const R2_KEYS = [
  'CLOUDFLARE_R2_ENDPOINT',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_BUCKET',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(R2_KEYS.map((k) => [k, process.env[k]]));
  for (const k of R2_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of R2_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function configureR2(overrides: Partial<Record<(typeof R2_KEYS)[number], string>> = {}) {
  process.env.CLOUDFLARE_R2_ENDPOINT = 'https://account-id.r2.cloudflarestorage.com';
  process.env.CLOUDFLARE_R2_ACCESS_KEY_ID = 'a'.repeat(32);
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = 'b'.repeat(64);
  process.env.CLOUDFLARE_R2_BUCKET = 'gymdesk';
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
}

// ─── getStorageDiagnostics ────────────────────────────────────────────────────

describe('getStorageDiagnostics', () => {
  it('reports the parsed endpoint, bucket and credential lengths when fully configured', () => {
    configureR2();

    expect(getStorageDiagnostics()).toEqual({
      endpointHost: 'account-id.r2.cloudflarestorage.com',
      endpointProtocol: 'https',
      endpointPath: '',
      endpointMalformed: false,
      bucket: 'gymdesk',
      accessKeyIdLength: 32,
      secretAccessKeyLength: 64,
      missingConfig: [],
    });
    expect(isStorageConfigured()).toBe(true);
  });

  it('never returns the access key id or the secret itself — only their lengths', () => {
    configureR2({
      CLOUDFLARE_R2_ACCESS_KEY_ID: 'super-secret-access-key-id',
      CLOUDFLARE_R2_SECRET_ACCESS_KEY: 'super-secret-secret-value',
    });

    const serialized = JSON.stringify(getStorageDiagnostics());
    expect(serialized).not.toContain('super-secret-access-key-id');
    expect(serialized).not.toContain('super-secret-secret-value');
    expect(getStorageDiagnostics().accessKeyIdLength).toBe('super-secret-access-key-id'.length);
    expect(getStorageDiagnostics().secretAccessKeyLength).toBe('super-secret-secret-value'.length);
  });

  it('surfaces a bucket name mistakenly appended to the endpoint as endpointPath', () => {
    configureR2({ CLOUDFLARE_R2_ENDPOINT: 'https://account-id.r2.cloudflarestorage.com/gymdesk' });

    const diagnostics = getStorageDiagnostics();
    expect(diagnostics.endpointPath).toBe('/gymdesk');
    expect(diagnostics.endpointMalformed).toBe(false);
  });

  it('flags an unparseable endpoint instead of throwing', () => {
    configureR2({ CLOUDFLARE_R2_ENDPOINT: 'not-a-url' });

    const diagnostics = getStorageDiagnostics();
    expect(diagnostics.endpointMalformed).toBe(true);
    expect(diagnostics.endpointHost).toBeNull();
    // A malformed value is still *set*, so it is not reported as missing.
    expect(diagnostics.missingConfig).toEqual([]);
  });

  it('lists every unset env var, with zero credential lengths', () => {
    const diagnostics = getStorageDiagnostics();

    expect(diagnostics.missingConfig).toEqual(R2_KEYS.slice());
    expect(diagnostics).toMatchObject({
      endpointHost: null,
      endpointProtocol: null,
      endpointPath: null,
      endpointMalformed: false,
      bucket: null,
      accessKeyIdLength: 0,
      secretAccessKeyLength: 0,
    });
    expect(isStorageConfigured()).toBe(false);
    expect(getMissingStorageConfigKeys()).toEqual(R2_KEYS.slice());
  });

  it('lists only the env vars that are actually missing', () => {
    configureR2();
    delete process.env.CLOUDFLARE_R2_BUCKET;

    expect(getStorageDiagnostics().missingConfig).toEqual(['CLOUDFLARE_R2_BUCKET']);
  });
});

// ─── describeStorageError ─────────────────────────────────────────────────────

describe('describeStorageError', () => {
  it('flattens an @aws-sdk/client-s3 style error, including $metadata', () => {
    configureR2();
    const sdkError = Object.assign(new Error('The specified bucket does not exist'), {
      name: 'NoSuchBucket',
      Code: 'NoSuchBucket',
      $metadata: { httpStatusCode: 404, requestId: 'req-abc-123', attempts: 3 },
    });

    expect(describeStorageError(sdkError, {
      operation: 'initializeGymBucket',
      key: 'gym-1-Acme/Nutrition/',
      bucket: 'gymdesk',
    })).toEqual({
      operation: 'initializeGymBucket',
      message: 'The specified bucket does not exist',
      name: 'NoSuchBucket',
      code: 'NoSuchBucket',
      httpStatusCode: 404,
      requestId: 'req-abc-123',
      attempts: 3,
      key: 'gym-1-Acme/Nutrition/',
      bucket: 'gymdesk',
      causes: [],
    });
  });

  it('walks the cause chain outermost first', () => {
    const root = new Error('getaddrinfo ENOTFOUND account-id.r2.cloudflarestorage.com');
    const middle = Object.assign(new Error('socket hang up'), { cause: root });
    const outer = Object.assign(new Error('Network error'), { cause: middle });

    expect(describeStorageError(outer, { operation: 'uploadGymImage' }).causes).toEqual([
      'socket hang up',
      'getaddrinfo ENOTFOUND account-id.r2.cloudflarestorage.com',
    ]);
  });

  it('does not loop forever on a self-referencing cause chain', () => {
    const looping: any = new Error('loop');
    looping.cause = looping;

    expect(describeStorageError(looping, { operation: 'uploadGymImage' }).causes).toHaveLength(5);
  });

  it('falls back to nulls for a plain Error with no SDK metadata', () => {
    expect(describeStorageError(new Error('boom'), { operation: 'initializeGymBucket' })).toMatchObject({
      operation: 'initializeGymBucket',
      message: 'boom',
      name: 'Error',
      code: null,
      httpStatusCode: null,
      requestId: null,
      attempts: null,
      key: null,
      causes: [],
    });
  });

  it('handles a non-Error rejection without throwing', () => {
    expect(describeStorageError('just a string', { operation: 'uploadGymImage' })).toMatchObject({
      message: 'just a string',
      name: null,
      httpStatusCode: null,
    });
  });

  it('falls back to extendedRequestId when requestId is absent', () => {
    const sdkError = Object.assign(new Error('Access Denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403, extendedRequestId: 'ext-req-9' },
    });

    expect(describeStorageError(sdkError, { operation: 'uploadGymImage' }).requestId).toBe('ext-req-9');
  });
});
