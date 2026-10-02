import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { actorSnapshot } from '../domain/nutritionLibrary';

/**
 * #965 / migration 207 — who created and last changed an Exercise.
 *
 * `exercises` has carried `created_by` / `modified_by` since migration 096, both
 * FKs to `gym_memberships`, and that can never answer for a **Base** Exercise: it
 * is a `gym_id IS NULL` row administered from Cordel by a superadmin, who has no
 * membership row to point at. So the platform router snapshots the actor's name
 * and type at write time, exactly as `tax_rates` (126), `themes` (178) and
 * `nutrition_library_items` (196) do.
 *
 * Two rules here are the ticket's and are easy to break later, so they are pinned
 * by scanning the source rather than left to review:
 *
 *  1. **Every** write that moves `modified_at` moves the pair with it. A media
 *     upload that bumped the timestamp alone would attribute itself to whoever
 *     last ran `PUT /:id`, which is worse than the em dash.
 *  2. The gym-facing read **masks** the platform actor. That router serves base
 *     rows too (`GET /exercises/:id`), and a shared catalogue's rows are not the
 *     reading gym's to attribute — the same rule `maskPlatformActors` already
 *     applies to the Nutrition Library.
 */

const API = join(__dirname, '..');
const migration = readFileSync(
  join(API, 'infra', 'migrations', '207_exercises_actor_snapshot.js'), 'utf-8');
const platformRouter = readFileSync(join(API, 'api', 'platform-exercises.ts'), 'utf-8');
const gymRouter = readFileSync(join(API, 'api', 'exercises.ts'), 'utf-8');

const ACTOR_COLUMNS = ['created_by_name', 'created_by_type', 'modified_by_name', 'modified_by_type'];

describe('migration 207', () => {
  it('adds both actor pairs, each column under its own guard', () => {
    for (const column of ACTOR_COLUMNS) {
      expect(migration, `${column} is missing`).toContain(column.replace(/^(created|modified)_/, ''));
    }
    expect(migration).toContain("const ACTOR_PREFIXES = ['created', 'modified'];");
    expect(migration).toMatch(/hasColumn\(TABLE, column\)/);
    // Per column, not per pair — knex batches ADDs into one ALTER but emits one
    // ALTER per DROP, so a pair-level guard strands a half-dropped pair.
    expect(migration).toMatch(/for \(const \{ column, length \} of ACTOR_COLUMNS\)/);
  });

  it('mirrors the ActorType vocabulary in a CHECK beside each column', () => {
    expect(migration).toContain("IN ('staff','superadmin')");
    expect(migration).toContain('chk_exercises_${prefix}_by_type');
    // Both CHECKs go in one ALTER: `ADD CONSTRAINT` rebuilds the table under
    // ALGORITHM=COPY, so two statements would be two rebuilds.
    expect(migration).toMatch(/if \(missingChecks\.length > 0\) \{\s*\n\s*await knex\.raw\(`ALTER TABLE \$\{TABLE\} \$\{missingChecks\.join\(', '\)\}`\);/);
  });

  it('is re-runnable from a partial state, and reversible', () => {
    expect(migration).toContain('exports.down');
    // Down drops the CHECKs before the columns, and the columns in reverse.
    expect(migration.indexOf('DROP CHECK')).toBeLessThan(migration.indexOf('[...ACTOR_COLUMNS].reverse()'));
    expect(migration).toMatch(/constraintExists\(knex, name\)/);
  });

  it('backfills nothing, and says why', () => {
    expect(migration).not.toMatch(/\bUPDATE exercises\b/);
    expect(migration).toContain('requireSuperadmin');
  });
});

describe('the platform router stamps the pair on every write', () => {
  it('on create', () => {
    expect(platformRouter).toContain('created_by_name, created_by_type');
    expect(platformRouter).toContain('actor.name, actor.type');
    expect(platformRouter).toContain("function platformActor(req: { superadminName?: string | null })");
  });

  it('and on every statement that moves modified_at — all five of them', () => {
    const bumps = platformRouter.match(/modified_at\s+=\s+UTC_TIMESTAMP\(\)/g) ?? [];
    // PUT /:id, plus the image upload/delete and the video upload/delete.
    expect(bumps).toHaveLength(5);
    const stamps = platformRouter.match(/modified_by_name\s+=\s+\?,\s*\n?\s*modified_by_type\s+=\s+\?/g) ?? [];
    expect(stamps, 'every modified_at bump carries the actor pair').toHaveLength(bumps.length);
  });

  it('resolving the actor inside the handler, after requireSuperadmin has run', () => {
    expect(platformRouter).not.toMatch(/^const actor = platformActor/m);
    expect((platformRouter.match(/const actor = platformActor\(req\);/g) ?? []).length).toBe(6);
  });
});

describe('the gym-facing read masks the platform actor', () => {
  it('reports no name and no type for a gym_id IS NULL row', () => {
    for (const column of ACTOR_COLUMNS) {
      expect(
        gymRouter,
        `${column} must be masked for a base exercise`,
      ).toMatch(new RegExp(`CASE WHEN e\\.gym_id IS NULL THEN NULL ELSE [^\\n]+ END\\s+AS ${column}`));
    }
  });

  it('keeps the membership join as a gym exercise\'s own actor', () => {
    expect(gymRouter).toContain('LEFT JOIN gym_memberships gm_c ON gm_c.id = e.created_by');
    expect(gymRouter).toContain('LEFT JOIN gym_memberships gm_m ON gm_m.id = e.modified_by');
  });

  it('and never writes the snapshot itself — the FK columns stay its record', () => {
    const writes = gymRouter.match(/INSERT INTO exercises[\s\S]{0,400}?\)`/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write, 'a gym write must not set the platform snapshot').not.toContain('created_by_name');
    }
  });

  it('keeps the shadowing alias after `e.*`, which is what makes it win', () => {
    const select = gymRouter.slice(gymRouter.indexOf('const SELECT = `'), gymRouter.indexOf('FROM exercises e'));
    expect(select.indexOf('SELECT e.*')).toBeLessThan(select.indexOf('AS created_by_name'));
  });
});

describe('actorSnapshot (pure)', () => {
  it('fixes the type to superadmin for a platform write', () => {
    expect(actorSnapshot({ name: 'Ada Lovelace', isSuperadmin: true }))
      .toEqual({ name: 'Ada Lovelace', type: 'superadmin' });
  });

  it('stores a blank name as NULL, so a read renders the em dash rather than an empty string', () => {
    expect(actorSnapshot({ name: '   ', isSuperadmin: true })).toEqual({ name: null, type: 'superadmin' });
    expect(actorSnapshot({ name: null, isSuperadmin: true })).toEqual({ name: null, type: 'superadmin' });
    expect(actorSnapshot({ name: undefined, isSuperadmin: true })).toEqual({ name: null, type: 'superadmin' });
  });
});
