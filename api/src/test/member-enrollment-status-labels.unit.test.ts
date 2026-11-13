// #2803 — the Members table's Plan column printed
// `members.enrollment_status_active_cancel_at_period_end` because the status
// #2659 added had no label there (next-intl prints a missing key verbatim).
//
// The column shows `latestEnrollmentStatusSql()`'s value, which is any stored
// assignment status except the two that query excludes. This gate fails when a
// status that can reach the column has no label in one of the admin locales,
// so the next status added to `ASSIGNMENT_STATUSES` cannot repeat the defect.
//
// It lives in the API suite because CI runs `npm test` in `api/` only.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASSIGNMENT_STATUSES } from '../domain/assignmentStatus';
import { latestEnrollmentStatusSql } from '../domain/memberEnrollment';

const REPO = join(__dirname, '..', '..', '..');
const sql = latestEnrollmentStatusSql('m');
/** The statuses the enrollment read can report: all but the ones it excludes. */
const REPORTED = ASSIGNMENT_STATUSES.filter((s) => !sql.includes(`'${s}'`));

describe('#2803 Members table plan status labels', () => {
  it('the enrollment read excludes only Draft and Pending Payment', () => {
    expect(ASSIGNMENT_STATUSES.filter((s) => !REPORTED.includes(s))).toEqual(['draft', 'pending_payment']);
  });

  for (const code of ['en', 'es', 'ca']) {
    it(`every reported status has a label in ${code}`, () => {
      const members = JSON.parse(
        readFileSync(join(REPO, 'apps', 'admin', 'locales', 'base', `${code}.json`), 'utf8'),
      ).members as Record<string, string>;
      for (const status of REPORTED) {
        const label = members[`enrollment_status_${status}`];
        expect(label, `members.enrollment_status_${status} is missing in ${code}`).toBeTruthy();
        expect(label, `${code} shows the internal value for ${status}`).not.toContain('_');
      }
    });
  }
});
