import { describe, expect, it } from 'vitest';
import * as admin from '../../../apps/admin/src/lib/clerkAccountLines';
import * as member from '../../../apps/member/src/lib/clerkAccountLines';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// #1234 — Clerk Status / Clerk Invitation lines, one declaration per app.
describe.each([['admin', admin], ['member', member]])('%s clerkAccountLines', (_n, m) => {
  it('enrolled with a date', () => {
    expect(m.clerkStatusLine({ clerk_user_id: 'u', enrolled_at: '2026-10-03T10:00:00Z' }, 'en'))
      .toEqual({ key: 'clerk_status_enrolled_on', date: 'Oct 3, 2026' });
  });
  it('enrolled before the column existed has no date', () => {
    expect(m.clerkStatusLine({ clerk_user_id: 'u', enrolled_at: null }, 'en'))
      .toEqual({ key: 'clerk_status_enrolled', date: null });
  });
  it('not enrolled ignores any stored enrolled_at', () => {
    expect(m.clerkStatusLine({ clerk_user_id: null, enrolled_at: '2026-10-03T10:00:00Z' }, 'en').key)
      .toBe('clerk_status_not_enrolled');
  });
  it('invitation is pending-based, date is history', () => {
    expect(m.clerkInvitationLine({ has_pending_invitation: true, invited_at: '2026-10-01T08:00:00Z' }, 'en'))
      .toEqual({ key: 'clerk_invitation_invited_on', date: 'Oct 1, 2026' });
    expect(m.clerkInvitationLine({ has_pending_invitation: false, invited_at: '2026-10-01T08:00:00Z' }, 'en').key)
      .toBe('clerk_invitation_none');
  });
});

describe('locale keys and writers', () => {
  const keys = ['label_clerk_status', 'label_clerk_invitation', 'clerk_status_enrolled_on', 'clerk_status_enrolled',
    'clerk_status_not_enrolled', 'clerk_invitation_invited_on', 'clerk_invitation_invited', 'clerk_invitation_none'];
  it.each(['en', 'es', 'ca'])('both apps carry the keys in %s', (l) => {
    for (const [app, ns] of [['admin', 'members'], ['member', 'profile']] as const) {
      const j = JSON.parse(readFileSync(join(__dirname, `../../../apps/${app}/locales/base/${l}.json`), 'utf8'));
      for (const k of keys) expect(j[ns][k], `${app}.${ns}.${k}`).toBeTruthy();
    }
  });
  it('invite writers stamp invited_at and the link stamps enrolled_at', () => {
    const src = (f: string) => readFileSync(join(__dirname, '..', 'api', f), 'utf8');
    expect(src('members.ts').match(/invitation_id = \?, invited_at = UTC_TIMESTAMP\(\)/g)?.length).toBe(2);
    expect(src('public-registrations.ts')).toContain('invited_at = UTC_TIMESTAMP()');
    expect(src('me.ts')).toContain('enrolled_at = COALESCE(enrolled_at, UTC_TIMESTAMP())');
    expect(readdirSync(join(__dirname, '../infra/migrations')).some((f) => f.startsWith('239_'))).toBe(true);
  });
});
