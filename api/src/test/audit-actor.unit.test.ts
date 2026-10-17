import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  AUDITED_TABLES,
  AUDIT_ACTOR_MAX_LENGTH,
  auditActorField,
  createdAuditValues,
  deletedAuditSet,
  modifiedAuditSet,
  resolveMutationActor,
  resolvePlatformActor,
  resolveRequestActor,
  resolveSystemActor,
  restoredAuditSet,
} from '../domain/auditActor';

describe('resolveMutationActor (#1182 stage 1)', () => {
  it('stores a normal actor as their plain name', () => {
    expect(resolveMutationActor({ actorName: 'Pedro' })).toBe('Pedro');
    expect(resolveMutationActor({ actorName: '  Pedro  ' })).toBe('Pedro');
  });

  it('keeps the real actor and the impersonation context', () => {
    expect(resolveMutationActor({ actorName: 'Oscar', impersonatedActorName: 'Pedro' }))
      .toBe('Oscar (impersonating Pedro)');
  });

  it('still records the impersonation when the target has no name', () => {
    expect(resolveMutationActor({ actorName: 'Oscar', impersonating: true, impersonatedActorName: null }))
      .toBe('Oscar (impersonating)');
  });

  it('never invents an actor', () => {
    expect(resolveMutationActor({ actorName: null })).toBeNull();
    expect(resolveMutationActor({ actorName: '   ' })).toBeNull();
    expect(resolveMutationActor({ actorName: undefined, impersonatedActorName: 'Pedro' })).toBeNull();
  });

  it('fits the column', () => {
    const long = 'x'.repeat(500);
    expect(resolveMutationActor({ actorName: long })!.length).toBe(AUDIT_ACTOR_MAX_LENGTH);
  });

  it('reads a tenant context, impersonating only when the header was honoured', () => {
    expect(resolveRequestActor({ actorName: 'Pedro' })).toBe('Pedro');
    expect(resolveRequestActor({
      actorName: 'Oscar', impersonatedUserId: 'member:7', impersonatedActorName: 'Pedro',
    })).toBe('Oscar (impersonating Pedro)');
  });

  it('names the superadmin on a platform request and the system on a run', () => {
    expect(resolvePlatformActor('Oscar')).toBe('Oscar');
    expect(resolvePlatformActor(null)).toBeNull();
    expect(resolveSystemActor()).toBe('System');
  });
});

describe('audit column helpers', () => {
  it('writes created_by only; the clock stays the database default', () => {
    expect(createdAuditValues('Pedro')).toEqual({ created_by: 'Pedro' });
  });

  it('modify, delete and restore write both halves of their pair from the DB clock', () => {
    expect(modifiedAuditSet('Pedro')).toEqual({ sql: 'modified_at = UTC_TIMESTAMP(), modified_by = ?', params: ['Pedro'] });
    expect(deletedAuditSet('Pedro')).toEqual({ sql: 'deleted_at = UTC_TIMESTAMP(), deleted_by = ?', params: ['Pedro'] });
    const restored = restoredAuditSet('Pedro');
    expect(restored.sql).toContain('deleted_at = NULL');
    expect(restored.sql).toContain('deleted_by = NULL');
    expect(restored.params).toEqual(['Pedro']);
  });

  it('reports one plain-text shape, null when unknown', () => {
    expect(auditActorField('Oscar (impersonating Pedro)')).toBe('Oscar (impersonating Pedro)');
    expect(auditActorField('')).toBeNull();
    expect(auditActorField(undefined)).toBeNull();
  });
});

describe('gate: audited tables', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === 'test' || f === 'migrations' ? [] : sources(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }

  it('every INSERT into a registered table names created_by', () => {
    const offenders: string[] = [];
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf-8');
      for (const table of AUDITED_TABLES) {
        const re = new RegExp(`INSERT\\s+(?:IGNORE\\s+)?INTO\\s+${table}\\b([\\s\\S]*?)(?:VALUES|SELECT)`, 'gi');
        for (const m of text.matchAll(re)) {
          if (!/\bcreated_by\b/.test(m[1])) offenders.push(`${file}: ${table}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * A statement that changes a row's business content records who did it. A
   * purely technical write (a counter, a cache column, a re-ordering) is
   * declared here with the reason, never skipped silently.
   */
  const TECHNICAL_UPDATES: Array<{ file: string; table: string; why: string }> = [
    { file: 'api/me.ts', table: 'members', why: 'POST /me/link: the member linking their own Clerk account (clerk_user_id, invitation_id, enrolled_at), not a content edit' },
    { file: 'api/member-image-storage.ts', table: 'members', why: 'image_url re-point after a rename; the PUT that triggered it already recorded modified_by' },
    { file: 'api/plan-image-storage.ts', table: 'membership_plans', why: 'image_url re-point after a rename; the PUT that triggered it already recorded modified_by' },
    { file: 'api/payment-method-image-storage.ts', table: 'base_payment_methods', why: 'image references re-point after a rename; the PUT that triggered it already recorded modified_by' },
    { file: 'api/staff.ts', table: 'staff', why: 'gym_membership_id link/unlink bookkeeping when app access is granted or revoked' },
    { file: 'api/themes.ts', table: 'themes', why: "clearing half of set-system-default; stamping it would touch every Base Theme's modified_at (the setting half records the actor)" },
    { file: 'api/training-plan-creation.ts', table: 'members', why: 'member_training_plan_id pointer, written with the assigned plan (stage 3 table)' },
    { file: 'api/service-consumption.ts', table: 'professional_service_consumptions', why: 'a ledger row is never edited: returned_at/returned_by is the return stamp of the append-only row' },
    { file: 'api/me-products.ts', table: 'payment_requests', why: 'billing_event_id link written right after the same transaction inserted the request and its event (both carry created_by)' },
    { file: 'api/payment-page.ts', table: 'payment_requests', why: 'page_token = NULL when the hosted page is opened: token consumption, not a change; the settle UPDATEs record modified_by' },
    { file: 'api/product-set-bridge.ts', table: 'billing_events', why: 'linkInitialPaymentToSet re-keys product_set_id/schedule_id/period_start on the first payment event inside the commit that already records the actor' },
    { file: 'infra/clerk-account-links.ts', table: 'members', why: 'clerk_user_id = NULL on a Clerk account unlink: a cleanup path with no request actor' },
    { file: 'api/product-sets.ts', table: 'product_sets', why: 'root_product_set_id, last_activity_at and status moves of a version; product_sets keeps only created_by (a version is replaced, never edited)' },
    { file: 'api/product-set-bridge.ts', table: 'product_sets', why: 'user_membership_id pointer relink between the version and the assignment projection' },
    { file: 'api/product-set-projection.ts', table: 'product_sets', why: 'user_membership_id link written by the projection' },
    { file: 'api/product-set-checkout.ts', table: 'product_sets', why: 'payment_request_id link of the checkout' },
    { file: 'api/recurring-purchase-draft.ts', table: 'product_sets', why: 'ends_at carried onto the Draft just created in the same transaction (created_by is recorded by createDraft)' },
    { file: 'api/product-set-draft-router.ts', table: 'product_sets', why: 'last_activity_at refresh of a Draft (its edits are recorded on the assignment projection)' },
    { file: 'api/assignment-draft-set.ts', table: 'product_sets', why: 'mirrors starts_at/ends_at and the assignment link of a Draft from its assignment row' },
    { file: 'api/gym-training-plans.ts', table: 'member_training_plans', why: 'status/valid_to when the new-plan flow expires existing plans; the actor is recorded on training_plans.modified_by in the same transaction' },
    { file: 'domain/exerciseDescriptionTranslations.ts', table: 'exercises', why: 'copies short_description onto a copy created in the same transaction, which already carries created_by' },
    { file: 'api/nutrition-goal-image-storage.ts', table: 'nutrition_goals', why: 'moves the image references onto the keys a rename builds, inside the rename PUT that records modified_by' },
    { file: 'api/member-training-plans.ts', table: 'member_training_plans', why: 'PATCH status/valid_from/valid_to transition; the status_change audit row records the actor' },
  ];

  it('every business UPDATE of a registered table names modified_by or deleted_by', () => {
    const offenders: string[] = [];
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf-8');
      for (const table of AUDITED_TABLES) {
        const re = new RegExp(`\\bUPDATE\\s+${table}\\b([\\s\\S]*?)\\bWHERE\\b`, 'gi');
        for (const m of text.matchAll(re)) {
          if (/\bmodified_by\b|\bdeleted_by\b/.test(m[1])) continue;
          const short = file.slice(join(__dirname, '..').length + 1);
          if (TECHNICAL_UPDATES.some((e) => e.file === short && e.table === table)) continue;
          offenders.push(`${short}: ${table}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it('every registered table has its three text columns in a migration', () => {
    const migrations = readdirSync(join(__dirname, '..', 'infra', 'migrations'))
      .filter((f) => /^26[4-8]_/.test(f))
      .map((f) => readFileSync(join(__dirname, '..', 'infra', 'migrations', f), 'utf-8'))
      .join('\n');
    // Created with the columns from the start (professional_service_* ledgers, #1227)
    // or renamed in place (feature_flags): no list entry in the migrations.
    const bornConformant = ['professional_service_adjustments', 'professional_service_consumptions', 'feature_flags', 'base_payment_methods'];
    for (const table of AUDITED_TABLES) {
      if (bornConformant.includes(table)) continue;
      expect(migrations).toContain(`'${table}'`);
    }
  });
});
