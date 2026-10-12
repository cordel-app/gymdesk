import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolvePlatformActor } from '../domain/auditActor';

/**
 * #965 / #1182 stage 2 — who created, last changed and deleted an Exercise.
 *
 * `exercises` carries three plain-text snapshot columns, `created_by`,
 * `modified_by` and `deleted_by` (migrations 264–265). A Base Exercise's actor is
 * a superadmin, who has no `gym_memberships` row, which is why the name is
 * snapshotted rather than joined. Two rules are pinned by scanning the source:
 *
 *  1. **Every** write that moves `modified_at` moves `modified_by` with it, and
 *     the soft delete records `deleted_by`.
 *  2. The gym-facing read **masks** the platform actor. That router serves base
 *     rows too (`GET /exercises/:id`), and a shared catalogue's rows are not the
 *     reading gym's to attribute.
 */

const API = join(__dirname, '..');
const platformRouter = readFileSync(join(API, 'api', 'platform-exercises.ts'), 'utf-8');
const gymRouter = readFileSync(join(API, 'api', 'exercises.ts'), 'utf-8');

const ACTOR_COLUMNS = ['created_by', 'modified_by', 'deleted_by'];

describe('the platform router stamps the actor on every write', () => {
  it('on create', () => {
    expect(platformRouter).toMatch(/created_by\)\s*\n\s*VALUES \(NULL/);
    expect(platformRouter).toContain('function platformActor(req: { superadminName?: string | null })');
  });

  it('and on every statement that moves modified_at', () => {
    const bumps = platformRouter.match(/modified_at\s+=\s+UTC_TIMESTAMP\(\)/g) ?? [];
    // Only PUT /:id: since #1420 the media writes are the one shared factory's.
    expect(bumps).toHaveLength(1);
    const stamps = platformRouter.match(/modified_by\s+=\s+\?/g) ?? [];
    expect(stamps, 'every modified_at bump carries the actor').toHaveLength(bumps.length);
  });

  it('and the shared media writer stamps it too, for both scopes (#1420)', () => {
    const media = readFileSync(join(API, 'api', 'exercise-gender-media.ts'), 'utf-8');
    expect(media).toMatch(/modified_at = UTC_TIMESTAMP\(\), modified_by = \?/);
    expect(media).toContain("scope === 'platform'");
    expect(media).toContain('resolvePlatformActor(');
  });

  it('and the soft delete records who deleted it', () => {
    expect(platformRouter).toMatch(/deleted_at = UTC_TIMESTAMP\(\), deleted_by = \?/);
  });

  it('resolving the actor inside the handler, after requireSuperadmin has run', () => {
    expect(platformRouter).not.toMatch(/^const actor = platformActor/m);
    expect((platformRouter.match(/const actor = platformActor\(req\);/g) ?? []).length).toBe(2);
  });
});

describe('the gym-facing read masks the platform actor', () => {
  it('reports no actor for a gym_id IS NULL row', () => {
    for (const column of ACTOR_COLUMNS) {
      expect(
        gymRouter,
        `${column} must be masked for a base exercise`,
      ).toMatch(new RegExp(`CASE WHEN e\\.gym_id IS NULL THEN NULL ELSE [^\\n]+ END\\s+AS ${column}`));
    }
  });

  it('writes the plain-text actor and no longer joins memberships or writes FK columns', () => {
    expect(gymRouter).not.toContain('LEFT JOIN gym_memberships gm_c');
    expect(gymRouter).not.toMatch(/_by_membership_id|_by_name|_by_type/);
    const writes = gymRouter.match(/INSERT INTO exercises[\s\S]{0,400}?\)`/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write).toContain('created_by');
  });

  it('keeps the shadowing alias after `e.*`, which is what makes it win', () => {
    const select = gymRouter.slice(gymRouter.indexOf('const selectFor ='), gymRouter.indexOf('FROM exercises e'));
    expect(select).toContain('SELECT e.*');
    expect(select.indexOf('SELECT e.*')).toBeLessThan(select.indexOf('AS created_by'));
  });
});

describe('resolvePlatformActor (pure)', () => {
  it('is the superadmin\'s own name', () => {
    expect(resolvePlatformActor('Ada Lovelace')).toBe('Ada Lovelace');
  });

  it('stores a blank name as NULL, so a read renders the em dash rather than an empty string', () => {
    expect(resolvePlatformActor('   ')).toBeNull();
    expect(resolvePlatformActor(null)).toBeNull();
    expect(resolvePlatformActor(undefined)).toBeNull();
  });
});
