// #1325 PR 3d — a Billing Event's assignment is its ProductSet chain's, and
// `domain/billingEventOwnership.ts` is the one place that is spelled.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { eventAssignmentSql, eventsOfAssignmentParams, eventsOfAssignmentSql } from '../domain/billingEventOwnership';

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== 'test' && name !== 'migrations') sources(p, out); }
    else if (/\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe('billingEventOwnership', () => {
  it('reads an event\'s assignment through the latest linked version of its chain', () => {
    const sql = eventAssignmentSql('x');
    expect(sql).toContain('x.product_set_id');
    expect(sql).toContain('p2.root_product_set_id = p1.root_product_set_id');
    expect(sql).toContain('p2.user_membership_id IS NOT NULL');
    expect(sql).toMatch(/ORDER BY p2\.version DESC, p2\.id DESC\s+LIMIT 1/);
  });

  it('binds gym, gym, assignment for the events-of-assignment predicate', () => {
    const sql = eventsOfAssignmentSql();
    expect((sql.match(/\?/g) ?? []).length).toBe(3);
    expect(eventsOfAssignmentParams('g', 7)).toEqual(['g', 'g', 7]);
  });

  it('no production source reads or writes billing_events.user_membership_id', () => {
    const offenders: string[] = [];
    for (const file of sources(join(__dirname, '..'))) {
      const text = readFileSync(file, 'utf8');
      // Any alias a `FROM billing_events <alias>` block gives the ledger.
      for (const m of text.matchAll(/FROM billing_events\s+(?:AS\s+)?([a-z_]+)\b/gi)) {
        const alias = m[1].toLowerCase();
        if (['where', 'join', 'left', 'inner', 'order', 'group', 'limit', 'set'].includes(alias)) continue;
        if (new RegExp(`\\b${alias}\\.user_membership_id\\b`).test(text)) offenders.push(`${file} (${alias})`);
      }
      // An INSERT into the ledger naming the dropped column.
      const m = text.match(/INSERT INTO billing_events\s*\(([^)]*)\)/g) ?? [];
      if (m.some((cols) => /\buser_membership_id\b/.test(cols))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
