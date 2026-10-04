import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// #979 — the Admin app's half of reactivating a cancelled event.
//
// The transition itself is the server's (`POST /class-sessions/:id/reactivate`,
// covered by `api/src/test/event-reactivation.test.ts`); what these tests guard
// is where the action is offered, that it is the *only* one a cancelled event
// offers, that it confirms before posting, and that it borrows the panel's
// existing chrome instead of inventing a look.

const SRC = join(__dirname, '..');
const sessionPanel = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'ClassSessionDetailPanel.tsx'), 'utf-8');
const eventPanel = readFileSync(join(SRC, 'app', '[locale]', 'calendar', 'EventDetailsPanel.tsx'), 'utf-8');

const LOCALES_DIR = join(SRC, '..', 'locales', 'base');
const LOCALE_CODES = ['en', 'es', 'ca'] as const;

const NEW_KEYS = [
  'reactivate',
  'reactivating',
  'reactivate_confirm_title',
  'reactivate_confirm_message',
  'reactivate_blocked_slot',
  'reactivate_blocked_not_cancelled',
] as const;

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('Reactivate is the cancelled event’s one action (#979 §1)', () => {
  it('offers it only while the session is cancelled', () => {
    // The Actions block used to be hidden wholesale for a cancelled event,
    // which is why a cancellation was one-way.
    expect(sessionPanel).toMatch(/\{canWrite && \(/);
    expect(sessionPanel).toMatch(/\{isCancelled \? \(/);
  });

  it('offers nothing else there', () => {
    // §1 — completing, moving or re-cancelling all act on a slot nobody holds.
    // The three live in the `: (` arm, so they are unreachable while cancelled.
    const actions = sessionPanel.slice(sessionPanel.indexOf('{isCancelled ? ('));
    const elseArm = actions.indexOf('<>');
    expect(elseArm).toBeGreaterThan(0);
    const cancelledArm = actions.slice(0, elseArm);
    expect(cancelledArm).toContain("t('reactivate')");
    expect(cancelledArm).not.toContain('mark_completed');
    expect(cancelledArm).not.toContain('showCancelConfirm');
    expect(cancelledArm).not.toContain('openChangeTime');
  });

  it('posts to the action route rather than writing a status itself', () => {
    // A `PUT` carrying `status: 'scheduled'` would skip the slot check, the
    // member alert and the audit row the route writes.
    expect(sessionPanel).toMatch(/\/reactivate`, \{ method: 'POST' \}/);
    expect(stripComments(sessionPanel)).not.toMatch(/\bbody:[\s\S]{0,120}'scheduled'/);
  });

  it('confirms before reactivating', () => {
    // §2 — the reactivation happens only after confirmation, and the
    // confirmation is this panel's own inline card (the shape `Mark as
    // completed` and `Cancel event` already use), not a second overlay style.
    expect(sessionPanel).toContain('showReactivateConfirm');
    expect(sessionPanel).toContain("t('reactivate_confirm_title')");
    expect(sessionPanel).toContain("t('reactivate_confirm_message')");
    expect(sessionPanel).toMatch(/showReactivateConfirm \?[\s\S]{0,400}onClick=\{\(\) => \{ setShowReactivateConfirm\(true\)/);
  });

  it('reloads instead of closing, so the panel shows what came back', () => {
    // §8 — the status, the capacity, the enrolled members and the waiting list
    // all have to read as restored straight away. `Cancel event` closes the
    // panel; this one must not.
    const handler = sessionPanel.slice(
      sessionPanel.indexOf('async function handleReactivate'),
      sessionPanel.indexOf('// ── Change time'),
    );
    expect(handler).toContain('await load()');
    expect(handler).toContain('onMutated()');
    expect(handler).not.toContain('onClose()');
  });

  it('re-books nothing from the browser', () => {
    // §4/§11 — the bookings were never cancelled with the event, so there is
    // no second request to make. A page posting to /bookings here would be
    // creating the duplicates the ticket forbids.
    const handler = sessionPanel.slice(
      sessionPanel.indexOf('async function handleReactivate'),
      sessionPanel.indexOf('// ── Change time'),
    );
    expect(handler).not.toContain('/bookings');
  });
});

describe('The action declares no look of its own (#979 §1/§5)', () => {
  it('wears the theme’s primary colours', () => {
    // #912/#954 — a filled primary action takes `primaryActionColors`, never a
    // hex of its own, and reactivating is not destructive so it is not red.
    const block = sessionPanel.slice(sessionPanel.indexOf('{isCancelled ? ('));
    const cancelledArm = block.slice(0, block.indexOf('<>'));
    expect(cancelledArm).toContain('primaryActionColors');
    // Only the error line may be red, and only as text — no action in here
    // paints itself with a background of its own.
    expect(cancelledArm).not.toMatch(/background:\s*'#(dc2626|c0392b|6c63ff)'/);
    expect(cancelledArm).not.toContain('#6c63ff');
  });
});

describe('Failures say what happened (#979 §10)', () => {
  it('names the slot conflict and the already-reactivated case', () => {
    expect(sessionPanel).toContain('SLOT_CONFLICT_CODES');
    expect(sessionPanel).toContain("t('reactivate_blocked_slot')");
    expect(sessionPanel).toContain("code === 'not_cancelled'");
  });

  it('lists exactly the four codes the API answers with', () => {
    for (const code of [
      'slot_fully_occupied', 'slot_not_shareable', 'activity_not_shareable', 'sharing_not_authorized',
    ]) {
      expect(sessionPanel, `SLOT_CONFLICT_CODES is missing ${code}`).toContain(`'${code}'`);
    }
  });
});

describe('A manual calendar entry gets no reactivate action (#979)', () => {
  it('keeps editing its status in its own select', () => {
    // It has no `POST /:id/cancel` either — its status is written by the
    // generic PUT — so the explicit action pairs with the explicit cancel that
    // only sessions have.
    expect(eventPanel).not.toContain('reactivate');
    expect(eventPanel).toContain('STATUSES');
  });
});

describe('Locale coverage for the new strings (#979)', () => {
  it('has every key in every locale', () => {
    // next-intl has no locale fallback and no `defaultValue` option, so a
    // missing key renders as its raw dotted path on screen.
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of NEW_KEYS) {
        const value = messages.calendar?.[key];
        expect(value, `${code}.json is missing calendar.${key}`).toBeTypeOf('string');
        expect((value as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('promises the enrolled members stay enrolled (§2)', () => {
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8'));
    expect(en.calendar.reactivate_confirm_message.toLowerCase()).toContain('enrolled');
    // §3 — Completed has no part in this flow, so the copy must not offer it.
    for (const key of NEW_KEYS) {
      expect(en.calendar[key].toLowerCase()).not.toContain('completed');
    }
  });

  it('interpolates nothing, so no locale can promise a value it is not given', () => {
    for (const code of LOCALE_CODES) {
      const messages = JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf-8'));
      for (const key of NEW_KEYS) {
        expect(messages.calendar[key], `${code}.json: calendar.${key}`).not.toContain('{');
      }
    }
  });
});
