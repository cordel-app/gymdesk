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

  it('registers no table before its migration exists', () => {
    expect(AUDITED_TABLES).toEqual([]);
  });
});
