// #1113 — the rules of the pre-event training reminder, and the alerts §1 takes
// away. No DB and no HTTP: `api/src/domain/bookingReminders.ts` is pure, and
// everything else here is asserted on source, because the two alerts §1 removes
// were raised **fire-and-forget** — a `.then()` that silently stopped running
// would make an HTTP assertion pass for the wrong reason, which is exactly how
// this kind of regression hides (CLAUDE.md's note on `sendNotification`).
//
// The Members App half is asserted here too, for #1009's reason: CI runs
// `npm test` in `api/` only.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BOOKING_REMINDER_LEAD_MINUTES,
  BOOKING_REMINDER_MAX_PER_RUN,
  BOOKING_REMINDER_TYPE,
  groupRemindersByGym,
  reminderCandidatesParams,
  reminderCandidatesSql,
  reminderNotificationRow,
  type ReminderCandidate,
} from '../domain/bookingReminders';

const ROOT = join(__dirname, '..', '..', '..');
const API_SRC = join(__dirname, '..');
const MEMBER_SRC = join(ROOT, 'apps', 'member', 'src');
const MEMBER_LOCALES = join(ROOT, 'apps', 'member', 'locales', 'base');

const DOMAIN = readFileSync(join(API_SRC, 'domain', 'bookingReminders.ts'), 'utf8');
const ROUTER = readFileSync(join(API_SRC, 'api', 'booking-reminders.ts'), 'utf8');
const NOTIFICATIONS = readFileSync(join(API_SRC, 'infra', 'notifications.ts'), 'utf8');
const ME = readFileSync(join(API_SRC, 'api', 'me.ts'), 'utf8');
const STAFF_BOOKINGS = readFileSync(join(API_SRC, 'api', 'bookings.ts'), 'utf8');
const APP = readFileSync(join(API_SRC, 'app.ts'), 'utf8');
const MIGRATION = readFileSync(
  join(API_SRC, 'infra', 'migrations', '226_booking_reminder_notification_type.js'),
  'utf8',
);
const WORKFLOW = readFileSync(
  join(ROOT, '.github', 'workflows', 'booking-reminder-run.yml'),
  'utf8',
);
const ALERTS_PAGE = readFileSync(
  join(MEMBER_SRC, 'app', '[locale]', 'notifications', 'page.tsx'),
  'utf8',
);

const LOCALES = ['en', 'es', 'ca'] as const;

/** A source file's lines with its (long) comments dropped: a rule about what the
 *  code does must not be satisfied or broken by prose about it. */
function code(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const ME_BOOK_ROUTE = code(
  ME.slice(ME.indexOf("meRouter.post('/bookings'"), ME.indexOf("meRouter.get('/class-packages'")),
);
const ME_CANCEL_ROUTE = code(
  ME.slice(
    ME.indexOf("meRouter.delete('/bookings/:id'"),
    ME.indexOf("meRouter.post('/shared-training-requests'"),
  ),
);

function candidate(over: Partial<ReminderCandidate> = {}): ReminderCandidate {
  return {
    gym_id: 'gym-a',
    member_id: 7,
    calendar_event_id: 41,
    title: 'Morning Spin',
    starts_at: '2026-10-06T09:00:00.000Z',
    ...over,
  };
}

// ─── What a reminder is ───────────────────────────────────────────────────────

describe('the reminder is one declaration (#1113 §2)', () => {
  it('is a third reminder type rather than a reuse of the two that exist', () => {
    expect(BOOKING_REMINDER_TYPE).toBe('booking_reminder_2h');
    // 087's two have never been written and say something else ("tomorrow",
    // "starting soon"); writing this one under either would word the alert
    // wrongly. They stay declared and unwritten.
    expect(NOTIFICATIONS).toContain("| 'booking_reminder_24h'");
    expect(NOTIFICATIONS).toContain("| 'booking_reminder_1h'");
    expect(code(NOTIFICATIONS)).toContain("| 'booking_reminder_2h'");
  });

  it('is in the CHECK as well as the union, and the CHECK stays a superset', () => {
    // CLAUDE.md: a new type goes in two places. The union is the narrower list.
    const unionBlock = code(NOTIFICATIONS).slice(
      code(NOTIFICATIONS).indexOf('export type NotificationType'),
      code(NOTIFICATIONS).indexOf("| 'booking_reminder_2h';") + "| 'booking_reminder_2h';".length,
    );
    const union = [...unionBlock.matchAll(/\|\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
    const checkList = MIGRATION.slice(
      MIGRATION.indexOf('const NOTIFICATION_TYPES'),
      MIGRATION.indexOf('];', MIGRATION.indexOf('const NOTIFICATION_TYPES')),
    );
    const allowed = [...checkList.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(union).toContain(BOOKING_REMINDER_TYPE);
    expect(allowed).toContain(BOOKING_REMINDER_TYPE);
    for (const type of union) expect(allowed).toContain(type);
  });

  it('declares the lead time as a constant rather than reading the environment', () => {
    // The member reads "in 2 hours" in their own language, so a deployment that
    // could move the lead would make that sentence false.
    expect(BOOKING_REMINDER_LEAD_MINUTES).toBe(120);
    expect(code(DOMAIN)).not.toContain('process.env');
  });

  it('keeps the decision half pure', () => {
    for (const forbidden of ['infra/db', 'express', 'useTranslations', "t('"]) {
      expect(code(DOMAIN)).not.toContain(forbidden);
    }
  });
});

// ─── §3: who is owed one ──────────────────────────────────────────────────────

describe('the candidate query (#1113 §3)', () => {
  const sql = reminderCandidatesSql();

  it('takes an active booking on a scheduled, live occurrence', () => {
    expect(sql).toContain("ceb.status = 'booked'");
    expect(sql).toContain("ce.status = 'scheduled'");
    expect(sql).toContain('ce.deleted_at IS NULL');
    expect(sql).toContain('m.deleted_at IS NULL');
    // A waitlisted member holds a place in a queue, not a training.
    expect(sql).not.toContain("'waitlisted'");
  });

  it('compares the window in SQL, against UTC_TIMESTAMP()', () => {
    // `starts_at` is a UTC DATETIME by this codebase's convention, so no value
    // crosses a timezone conversion on its way to a comparison.
    expect(sql).toContain('ce.starts_at > UTC_TIMESTAMP()');
    expect(sql).toContain('ce.starts_at <= UTC_TIMESTAMP() + INTERVAL ? MINUTE');
    expect(reminderCandidatesParams()).toEqual([
      BOOKING_REMINDER_LEAD_MINUTES,
      BOOKING_REMINDER_MAX_PER_RUN,
    ]);
  });

  it('asks for events starting WITHIN the lead time, not exactly at it', () => {
    // A late pass must cost punctuality, never the alert: a window of
    // "115 to 120 minutes" would drop every member whose event fell between two
    // passes. There is no lower bound but "not already started".
    expect(sql).not.toMatch(/starts_at\s*>=?\s*UTC_TIMESTAMP\(\)\s*\+/);
  });

  it('dedupes against the alert row itself, with no second record of it', () => {
    // §5, and #647 stage 4's device. A `reminder_sent_at` column would be a
    // second copy of the same fact, and the two can disagree.
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('FROM member_notifications mn');
    expect(sql).toContain(`mn.type = '${BOOKING_REMINDER_TYPE}'`);
    expect(sql).toContain('mn.entity_id = ce.id');
    expect(sql).toContain('mn.member_id = ceb.member_id');
    for (const source of [code(DOMAIN), code(ROUTER), code(MIGRATION)]) {
      expect(source).not.toContain('reminder_sent_at');
      expect(source).not.toContain('reminded_at');
    }
    expect(code(MIGRATION)).not.toContain('calendar_event_bookings');
  });

  it('bounds one pass', () => {
    expect(sql).toContain('LIMIT ?');
    expect(BOOKING_REMINDER_MAX_PER_RUN).toBeGreaterThan(0);
  });

  it('takes the title from the occurrence, with no join to activity_types', () => {
    // #981's rule: the occurrence's own value. `calendar_events.title` is NOT
    // NULL and is the activity's name for a scheduled session, so a LEFT/INNER
    // join question does not arise and a manual entry has a name too.
    expect(sql).toContain('ce.title');
    expect(sql).not.toContain('activity_types');
  });
});

// ─── The rows it becomes ──────────────────────────────────────────────────────

describe('the notification row (#1113 §2)', () => {
  it('names the occurrence as the entity, so the alert can be tapped through', () => {
    const row = reminderNotificationRow(candidate());
    expect(row).toEqual({
      memberId: 7,
      type: 'booking_reminder_2h',
      entityType: 'session',
      entityId: 41,
      payload: { title: 'Morning Spin', starts_at: '2026-10-06T09:00:00.000Z' },
    });
  });

  it('carries no sentence — the copy is the Members App’s locale keys', () => {
    const payload = reminderNotificationRow(candidate()).payload;
    expect(Object.keys(payload).sort()).toEqual(['starts_at', 'title']);
    expect(JSON.stringify(payload)).not.toMatch(/2 hours|2 horas|2 hores/);
  });

  it('serialises a driver Date to an ISO string', () => {
    const row = reminderNotificationRow(
      candidate({ starts_at: new Date('2026-10-06T09:00:00.000Z') }),
    );
    expect(row.payload.starts_at).toBe('2026-10-06T09:00:00.000Z');
  });

  it('coerces the ids mysql2 may hand back as strings', () => {
    const row = reminderNotificationRow(
      candidate({ member_id: '7' as unknown as number, calendar_event_id: '41' as unknown as number }),
    );
    expect(row.memberId).toBe(7);
    expect(row.entityId).toBe(41);
  });

  it('groups by gym, because one insert writes one gym’s rows', () => {
    const grouped = groupRemindersByGym([
      candidate({ gym_id: 'gym-a', member_id: 1 }),
      candidate({ gym_id: 'gym-b', member_id: 2 }),
      candidate({ gym_id: 'gym-a', member_id: 3 }),
    ]);
    expect([...grouped.keys()]).toEqual(['gym-a', 'gym-b']);
    expect(grouped.get('gym-a')!.map((r) => r.memberId)).toEqual([1, 3]);
    expect(grouped.get('gym-b')!.map((r) => r.memberId)).toEqual([2]);
  });

  it('answers an empty map for an empty pass', () => {
    expect(groupRemindersByGym([]).size).toBe(0);
  });
});

// ─── The runner ───────────────────────────────────────────────────────────────

describe('the run is scheduled from outside and guards nothing it should not', () => {
  it('is authenticated by its own internal secret', () => {
    // promotion-lifecycle.ts' rule: a job with its own workflow gets a secret
    // with it. This one runs several times an hour on a schedule of its own.
    expect(code(ROUTER)).toContain('process.env.BOOKING_REMINDERS_INTERNAL_SECRET');
    expect(code(ROUTER)).not.toContain('BILLING_INTERNAL_SECRET');
    expect(code(ROUTER)).not.toContain('RECURRING_BOOKINGS_INTERNAL_SECRET');
    expect(code(ROUTER)).toContain("res.status(401).json({ error: 'Unauthorized' })");
  });

  it('is mounted outside tenantContext and behind the internal-run limiter', () => {
    expect(code(APP)).toContain(
      "app.use('/booking-reminders', internalRunLimiter as any, bookingRemindersRouter);",
    );
    expect(code(APP)).not.toMatch(/'\/booking-reminders'[^\n]*tenantContext/);
  });

  it('claims no run slot — a date-keyed guard would silence every pass but one', () => {
    // #780's guard is "one completed run per UTC date", which is the opposite of
    // what a two-hour reminder needs.
    for (const name of ['claimRun', 'finishRun', 'run_log', 'STALE_RUN_MINUTES']) {
      expect(code(ROUTER)).not.toContain(name);
    }
  });

  it('awaits its inserts, so a lost row is reported rather than swallowed', () => {
    // recordNotifications (not sendNotification): the run reports what it wrote
    // and the written row is also the dedupe, so a silently lost insert would
    // mean the same alert attempted on every pass.
    expect(code(ROUTER)).toContain('await recordNotifications(');
    expect(code(ROUTER)).not.toContain('sendNotification(');
    expect(code(ROUTER)).not.toContain('sendBulkNotification(');
  });

  it('lets one gym’s failure cost that gym only', () => {
    expect(code(ROUTER)).toContain('failures.push(');
  });

  it('records no audit row and checks no feature flag', () => {
    expect(code(ROUTER)).not.toContain('recordAudit');
    expect(code(ROUTER)).not.toContain('requireFeatureEnabled');
  });
});

describe('the workflow that fires it', () => {
  it('runs several times an hour rather than nightly', () => {
    const crons = [...WORKFLOW.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
    expect(crons).toEqual(['*/15 * * * *']);
  });

  it('calls the path the relay allows, through API_BASE_URL', () => {
    expect(WORKFLOW).toContain('"$API_BASE_URL/booking-reminders/run"');
    expect(WORKFLOW).toContain('X-Internal-Secret: $BOOKING_REMINDERS_INTERNAL_SECRET');
    // No hardcoded host: one workflow serves dev and pro (#784).
    for (const host of ['api.vdicube.com', 'api.cordel.tech', 'admin.vdicube.com', 'admin.cordel.tech']) {
      expect(WORKFLOW).not.toContain(host);
    }
  });

  it('reads the counters the run reports (#778)', () => {
    for (const counter of ['.candidates', '.created', '.gyms', '.failures', '.capped']) {
      expect(WORKFLOW).toContain(counter);
    }
    expect(code(ROUTER)).toContain('candidates: candidates.length');
    expect(code(ROUTER)).toContain('created,');
    expect(code(ROUTER)).toContain('capped:');
  });

  it('does not let two passes overlap', () => {
    expect(WORKFLOW).toContain('concurrency:');
    expect(WORKFLOW).toContain('cancel-in-progress: false');
  });
});

// ─── §1/§4/§7: the alerts a member's own action no longer raises ──────────────

describe('a member’s own action raises no alert (#1113 §1, §4, §7)', () => {
  it('POST /me/bookings raises nothing at all', () => {
    expect(ME_BOOK_ROUTE).not.toContain('booking_confirmed');
    expect(ME_BOOK_ROUTE).not.toContain('waitlist_joined');
    expect(ME_BOOK_ROUTE).not.toContain('sendNotification');
  });

  it('DELETE /me/bookings/:id tells the canceller nothing, and still promotes', () => {
    // Cancelling and leaving a waiting list are the same route, and it alerts
    // only the member it moves *up* — which is not their own action.
    expect(ME_CANCEL_ROUTE).toContain("'promoted_from_waitlist'");
    expect(ME_CANCEL_ROUTE).not.toContain('event_cancelled');
    expect(ME_CANCEL_ROUTE).not.toContain('waitlist_removed');
  });

  it('removes the alert where it is generated, not in the Alerts page (§4)', () => {
    // The page still renders every type it is given; nothing filters by type.
    expect(code(ALERTS_PAGE)).not.toContain("!== 'booking_confirmed'");
    expect(code(ALERTS_PAGE)).not.toContain('HIDDEN_TYPES');
  });

  it('leaves the staff-side alerts exactly where they were', () => {
    // §4's distinction is who acted: somebody else putting a member on, or
    // taking them off, a waiting list is news (#980 stage 2).
    expect(code(STAFF_BOOKINGS)).toContain("'waitlist_joined'");
    expect(code(STAFF_BOOKINGS)).toContain("'waitlist_removed'");
    expect(code(STAFF_BOOKINGS)).toContain("'promoted_from_waitlist'");
  });

  it('keeps the two retired types available to the surfaces that read them', () => {
    // `booking_confirmed` rows already written stay readable, and the Alerts
    // page still has copy for them — nothing is deleted or backfilled.
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(join(MEMBER_LOCALES, `${locale}.json`), 'utf8'));
      expect(messages.notifications.type_booking_confirmed).toBeTruthy();
      expect(messages.notifications.type_waitlist_joined).toBeTruthy();
    }
  });
});

// ─── The Members App half ─────────────────────────────────────────────────────

describe('what the member reads', () => {
  it('words the reminder in all three locales, as a heading and a sentence', () => {
    for (const locale of LOCALES) {
      const messages = JSON.parse(readFileSync(join(MEMBER_LOCALES, `${locale}.json`), 'utf8'));
      const n = messages.notifications;
      expect(typeof n[`type_${BOOKING_REMINDER_TYPE}`]).toBe('string');
      expect(n[`type_${BOOKING_REMINDER_TYPE}`].length).toBeGreaterThan(0);
      expect(typeof n[`detail_${BOOKING_REMINDER_TYPE}`]).toBe('string');
      // §2: the sentence is what carries the two hours.
      expect(n[`detail_${BOOKING_REMINDER_TYPE}`]).toMatch(/2 ?(hours|horas|hores)/);
    }
  });

  it('shows the detail line, which is what DETAIL_TYPES is for', () => {
    const detailTypes = code(ALERTS_PAGE).slice(
      code(ALERTS_PAGE).indexOf('const DETAIL_TYPES'),
      code(ALERTS_PAGE).indexOf('];', code(ALERTS_PAGE).indexOf('const DETAIL_TYPES')),
    );
    expect(detailTypes).toContain(BOOKING_REMINDER_TYPE);
  });

  it('spells no copy in the page — every alert word is a locale key', () => {
    expect(code(ALERTS_PAGE)).toContain('t(`detail_${n.type}`');
    expect(code(ALERTS_PAGE)).not.toMatch(/Training reminder|Recordatorio de entreno/);
  });
});
