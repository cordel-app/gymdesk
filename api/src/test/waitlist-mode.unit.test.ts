// #980 stage 2 — the Waitlist vocabulary and what each of its values means.
//
// Pure: no DB, no HTTP. These are the decisions `PUT /class-sessions/:id`
// delegates rather than taking for itself, so they are asserted here directly
// and the integration suite beside them (`class-session-waitlist.test.ts`)
// only has to prove the route asks.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  WAITLIST_MODES,
  effectiveWaitlistMode,
  isWaitlistMode,
  parseWaitlistModeInput,
  waitlistModeClosesQueue,
} from '../domain/waitlistMode';
import { SESSION_AUDITED_FIELDS } from '../domain/calendarEventChanges';

describe('the three modes', () => {
  it('is exactly disabled, open and closed', () => {
    expect([...WAITLIST_MODES]).toEqual(['disabled', 'open', 'closed']);
  });

  it('recognizes only those three', () => {
    for (const mode of WAITLIST_MODES) expect(isWaitlistMode(mode)).toBe(true);
    for (const other of ['enabled', 'paused', 'OPEN', '', null, undefined, 1, {}]) {
      expect(isWaitlistMode(other)).toBe(false);
    }
  });
});

describe('parseWaitlistModeInput', () => {
  it('accepts each mode', () => {
    for (const mode of WAITLIST_MODES) {
      expect(parseWaitlistModeInput(mode)).toEqual({ mode });
    }
  });

  it('reads null and the empty string as "follow the Activity Type"', () => {
    expect(parseWaitlistModeInput(null)).toEqual({ mode: null });
    expect(parseWaitlistModeInput('')).toEqual({ mode: null });
    expect(parseWaitlistModeInput(undefined)).toEqual({ mode: null });
  });

  it('refuses anything else rather than coercing it', () => {
    // `closed` and `disabled` are opposite promises to a member holding a
    // place in the queue, so a near-miss is a 400 and never a guess.
    for (const bad of ['enabled', 'Disabled', 'none', 0, 1, true, {}, []]) {
      const result = parseWaitlistModeInput(bad);
      expect('error' in result, `expected ${JSON.stringify(bad)} to be refused`).toBe(true);
    }
  });

  it('names the accepted set in the error, including null', () => {
    const result = parseWaitlistModeInput('enabled');
    expect('error' in result && result.error).toContain('disabled, open, closed');
    expect('error' in result && result.error).toContain('null');
  });
});

describe('waitlistModeClosesQueue — the one place the distinction lives', () => {
  it('is disabled alone', () => {
    expect(waitlistModeClosesQueue('disabled')).toBe(true);
    expect(waitlistModeClosesQueue('open')).toBe(false);
    // The load-bearing one: `closed` stops new joins and keeps everybody's
    // place. Making it empty the queue would take forty members' positions
    // away on a setting a gym reaches for precisely to avoid that.
    expect(waitlistModeClosesQueue('closed')).toBe(false);
  });

  it('is false for an absent field and for inheriting', () => {
    expect(waitlistModeClosesQueue(undefined)).toBe(false);
    expect(waitlistModeClosesQueue(null)).toBe(false);
  });
});

describe('effectiveWaitlistMode', () => {
  it("prefers the occurrence's own setting", () => {
    expect(effectiveWaitlistMode('closed', 'open')).toBe('closed');
    expect(effectiveWaitlistMode('disabled', 'open')).toBe('disabled');
  });

  it("falls back to the Activity Type's", () => {
    expect(effectiveWaitlistMode(null, 'open')).toBe('open');
    expect(effectiveWaitlistMode(undefined, 'closed')).toBe('closed');
  });

  it('answers disabled when neither side has one', () => {
    expect(effectiveWaitlistMode(null, null)).toBe('disabled');
  });
});

describe('the audit field list', () => {
  it('carries waitlist_mode, so a change to it is logged previous → new (§11)', () => {
    expect([...SESSION_AUDITED_FIELDS]).toContain('waitlist_mode');
  });
});

describe('the three declarations agree', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf-8');

  it('the browser mirror offers the same modes', () => {
    const mirror = read('../../../apps/admin/src/lib/waitlistModes.ts');
    const match = mirror.match(/export const WAITLIST_MODES = \[([^\]]+)\]/);
    expect(match, 'apps/admin/src/lib/waitlistModes.ts must declare WAITLIST_MODES').toBeTruthy();
    const mirrored = match![1].split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean);
    expect(mirrored).toEqual([...WAITLIST_MODES]);
  });

  it('the CHECK beside the column permits the same modes, and NULL', () => {
    // Migration 154 is where the SQL half lives; a mode added to the module
    // and not to the CHECK fails every write of it.
    const migration = read('../infra/migrations/154_waitlist_mode.js');
    for (const mode of WAITLIST_MODES) expect(migration).toContain(`'${mode}'`);
    expect(migration).toContain('waitlist_mode IS NULL OR waitlist_mode IN');
  });

  it('the notification types the stage raises are in the CHECK as well as the union', () => {
    // CLAUDE.md's two-places rule: a type in the union but not the CHECK fails
    // its INSERT with errno 3819, invisibly, because the alert is
    // fire-and-forget.
    const union = read('../infra/notifications.ts');
    const migration = read('../infra/migrations/217_waitlist_notification_types.js');
    for (const type of ['waitlist_closed', 'waitlist_removed', 'waitlist_joined']) {
      expect(union, `${type} missing from NotificationType`).toContain(`'${type}'`);
      expect(migration, `${type} missing from the CHECK`).toContain(`'${type}'`);
    }
  });

  it('the Members App can word both new alerts in every locale', () => {
    for (const code of ['en', 'es', 'ca']) {
      const messages = JSON.parse(read(`../../../apps/member/locales/base/${code}.json`));
      for (const type of ['waitlist_closed', 'waitlist_removed']) {
        for (const key of [`type_${type}`, `detail_${type}`]) {
          const value = messages.notifications?.[key];
          expect(value, `${code}.json is missing notifications.${key}`).toBeTypeOf('string');
          expect((value as string).length).toBeGreaterThan(0);
        }
      }
      // They are two different promises and must not read the same.
      expect(messages.notifications.detail_waitlist_closed)
        .not.toBe(messages.notifications.detail_waitlist_removed);
    }
  });

  it("the Admin panel can word the setting and its confirmation in every locale", () => {
    for (const code of ['en', 'es', 'ca']) {
      const messages = JSON.parse(read(`../../../apps/admin/locales/base/${code}.json`));
      const keys = [
        'event_waitlist', 'waitlist_inherited',
        ...WAITLIST_MODES.flatMap((m) => [`waitlist_mode_${m}`, `waitlist_mode_hint_${m}`]),
        'waitlist_disable_confirm_title', 'waitlist_disable_confirm_message',
        'waitlist_disable_confirm_count', 'waitlist_disable_confirm_action',
      ];
      for (const key of keys) {
        const value = messages.calendar?.[key];
        expect(value, `${code}.json is missing calendar.${key}`).toBeTypeOf('string');
      }
    }
  });
});
