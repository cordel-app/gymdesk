// A gate, not a point fix (#1009's rule): **no query in this API binds `LIMIT`
// as a parameter.**
//
// `db.query` / `tx.query` are mysql2's `execute()` — a server-side prepared
// statement — and MySQL refuses a bound `LIMIT ?` there. Nothing catches it at
// build time, nothing catches it in a unit test, and the route that carries it
// answers a bare `500` for every call: that is exactly how #1113's booking
// reminder run reached CI, where every pass 500'd and the only visible symptom
// was "no reminders were created".
//
// This is not a new discovery: `training-plan-templates.ts` and
// `gym-training-plans.ts` have carried the reason in a comment since they were
// written — *"limit/offset are validated integers — interpolated because mysql2
// prepared statements don't accept placeholders in LIMIT reliably"* — and every
// paginated route in this API follows it. What was missing is anything that says
// so to the next query, which is what this file is.
//
// A `LIMIT` whose value varies is written into the statement after being
// validated as an integer, which is what `recurring-bookings.ts` already does
// with a value that comes from a request body:
//
//     if (!Number.isInteger(limit) || limit <= 0 || limit > 10000) return res.status(400)…
//     `… ${limit === null ? '' : `LIMIT ${limit}`}`
//
// The validation is the safety argument; interpolating an unvalidated value is
// the thing this gate must never be read as permitting.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const API_SRC = join(__dirname, '..');

/**
 * Every production `.ts` under api/src — the test directory is excluded, because
 * a gate about the queries this API runs has no business policing a file whose
 * job is to assert what they must not contain.
 */
function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'test') continue;
      sourceFiles(full, found);
    } else if (entry.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

/** A file's lines with its comments dropped: a rule about what a query does must
 *  not be broken by prose explaining the rule. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

describe('no query binds LIMIT as a parameter', () => {
  it('finds no `LIMIT ?` anywhere under api/src', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(API_SRC)) {
      const source = code(readFileSync(file, 'utf8'));
      // `LIMIT ?` and `LIMIT ? OFFSET ?`. Deliberately case-**sensitive** and
      // deliberately not followed by a second `?`: every SQL keyword here is
      // upper-case, while `req.query.limit ?? 50` is the shape every paginated
      // route reads its own limit with, and matching that would make this gate
      // fire on the twelve routes that already do the right thing.
      if (/\bLIMIT\s+\?(?!\?)/.test(source)) {
        offenders.push(file.slice(API_SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans a meaningful number of files', () => {
    // A gate that silently stopped finding files would pass for ever.
    expect(sourceFiles(API_SRC).length).toBeGreaterThan(100);
    // And it has to be looking at the routers, not only at leaf helpers.
    const scanned = sourceFiles(API_SRC).map((f) => f.slice(API_SRC.length + 1));
    expect(scanned).toContain('api/billing-events.ts');
    expect(scanned).toContain('domain/bookingReminders.ts');
  });
});
