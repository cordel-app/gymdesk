import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  STORAGE_FAILURE_CAUSES,
  isStorageFailureCause,
  storageCauseFromDetails,
  storageCauseSuggestsInitialize,
} from '../domain/storageFailureCause';

// #1042: `stage` (#824) says which step of a storage-backed save broke; `cause`
// says why, and is what the admin turns into the *Why* / *What you can do*
// sentences and into the `Initialize bucket` button beside the error.
//
// The rule under test is §4's: the initialization suggestion may only appear
// when the failure is evidence that storage was never initialized. That is why
// the cause is read from what the storage layer answered — the error's own name
// or code first, its HTTP status second — and never from the step that was
// running, which is the same for a missing bucket and a wrong credential.

describe('storageCauseFromDetails() (#1042 §2, §4)', () => {
  it('reads a missing bucket or object as uninitialized storage', () => {
    expect(storageCauseFromDetails({ name: 'NoSuchBucket' })).toBe('not_initialized');
    expect(storageCauseFromDetails({ name: 'NoSuchKey' })).toBe('not_initialized');
    expect(storageCauseFromDetails({ code: 'NotFound' })).toBe('not_initialized');
    // R2 answers `NoSuchBucket` with a 404, but the status alone is enough for
    // an SDK that did not parse a name.
    expect(storageCauseFromDetails({ name: null, code: null, httpStatusCode: 404 })).toBe('not_initialized');
  });

  it('reads a refused credential as access denied', () => {
    expect(storageCauseFromDetails({ name: 'AccessDenied' })).toBe('access_denied');
    expect(storageCauseFromDetails({ name: 'SignatureDoesNotMatch' })).toBe('access_denied');
    expect(storageCauseFromDetails({ code: 'InvalidAccessKeyId' })).toBe('access_denied');
    expect(storageCauseFromDetails({ httpStatusCode: 403 })).toBe('access_denied');
    expect(storageCauseFromDetails({ httpStatusCode: 401 })).toBe('access_denied');
  });

  it('is unreachable for anything it cannot identify — never a guess that offers Initialize', () => {
    expect(storageCauseFromDetails({ name: 'TimeoutError' })).toBe('unreachable');
    expect(storageCauseFromDetails({ name: 'InternalError', httpStatusCode: 500 })).toBe('unreachable');
    expect(storageCauseFromDetails({})).toBe('unreachable');
    expect(storageCauseFromDetails(null)).toBe('unreachable');
    expect(storageCauseSuggestsInitialize(storageCauseFromDetails(null))).toBe(false);
  });

  it('prefers the name over the status, because the two disagree', () => {
    // R2 has answered `AccessDenied` with a 400 as well as a 403; the name is
    // the reliable half, and reading the status first would file a refused
    // credential under "unreachable".
    expect(storageCauseFromDetails({ name: 'AccessDenied', httpStatusCode: 400 })).toBe('access_denied');
    expect(storageCauseFromDetails({ name: 'NoSuchBucket', httpStatusCode: 500 })).toBe('not_initialized');
  });
});

describe('the vocabulary (#1042)', () => {
  it('offers Initialize for exactly one cause', () => {
    expect(STORAGE_FAILURE_CAUSES.filter((c) => storageCauseSuggestsInitialize(c))).toEqual(['not_initialized']);
    expect(storageCauseSuggestsInitialize(null)).toBe(false);
  });

  it('recognises its own members and nothing else', () => {
    for (const cause of STORAGE_FAILURE_CAUSES) expect(isStorageFailureCause(cause)).toBe(true);
    expect(isStorageFailureCause('STORAGE_NOT_INITIALIZED')).toBe(false);
    expect(isStorageFailureCause(undefined)).toBe(false);
  });

  it('is mirrored in the admin, which diagnoses the failures that never reach a route', () => {
    // A new cause goes in three places (the declaration, the mirror, the locale
    // keys); the admin test asserts the keys, this one asserts the mirror.
    const mirror = readFileSync(
      join(__dirname, '..', '..', '..', 'apps', 'admin', 'src', 'lib', 'storageFailureCause.ts'),
      'utf-8',
    );
    const declared = Array.from(
      mirror.slice(mirror.indexOf('export const STORAGE_FAILURE_CAUSES')).matchAll(/^ {2}'([a-z_]+)',$/gm),
    ).map((m) => m[1]);
    expect(declared).toEqual([...STORAGE_FAILURE_CAUSES]);
  });
});

describe('every storage answer of the Theme routers states a cause (#1042 §5)', () => {
  // The admin may derive a cause from an unambiguous status, but 409 and 400
  // are not unambiguous — a 409 is also "a theme with this name already
  // exists" — so a storage route that answered one without saying why would
  // leave the admin unable to tell the two apart. Scanned rather than
  // exercised: these are six handlers across two routers and the property is
  // about all of them.
  const routers = ['gym-themes.ts', 'themes.ts'].map((f) =>
    readFileSync(join(__dirname, '..', 'api', f), 'utf-8'),
  );

  it.each([0, 1])('router %i answers every 502 with a cause read off the storage error', (i) => {
    const src = routers[i];
    const blocks = src.match(/res\.status\(502\)\.json\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toContain('cause: storageCauseFromDetails(details)');
      // #824's two halves are still there: which step, and on what object.
      expect(block).toContain('stage:');
      expect(block).toContain('path:');
    }
  });

  it('a gym with no storage folder is the one cause that offers Initialize', () => {
    expect(routers[0]).toContain("stage: 'resolve_path', cause: 'not_initialized'");
  });

  it('a deployment with no R2 at all is not', () => {
    for (const src of routers) expect(src).toContain("cause: 'not_configured'");
  });
});
