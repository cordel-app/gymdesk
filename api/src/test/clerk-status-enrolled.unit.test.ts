import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clerkStatusLine } from '../../../apps/admin/src/lib/clerkAccountLines';

// #1295 — the Admin Member card passes the whole `GET /members/:id/clerk-status`
// response to `clerkStatusLine()`, which reads `enrolled`; the route did not send it,
// so a linked, active member read "Not enrolled". The linked-member branch calls
// Clerk, so that case is gated here at the source and through the real function
// rather than in the integration test (whose Clerk key is a placeholder).
const route = readFileSync(join(__dirname, '..', 'api', 'members.ts'), 'utf-8');
const clerkStatus = route.slice(route.indexOf("membersRouter.get('/:id/clerk-status'"));
const handler = clerkStatus.slice(0, clerkStatus.indexOf("membersRouter.post('/'"));

describe('#1295 clerk-status reports enrolled', () => {
  it('puts `enrolled` in the object every branch spreads', () => {
    const dates = handler.slice(handler.indexOf('const dates = {'), handler.indexOf('};', handler.indexOf('const dates = {')));
    expect(dates).toContain('enrolled: !!clerk_user_id');
    // every response carries it: all three `res.json` answers spread `dates`
    expect((handler.match(/res\.json\(\{/g) ?? []).length).toBe(3);
    expect((handler.match(/\.\.\.dates/g) ?? []).length).toBe(3);
  });

  it('the card reads a linked member as enrolled, with and without a date', () => {
    expect(clerkStatusLine({ enrolled: true, enrolled_at: null }, 'en').key).toBe('clerk_status_enrolled');
    expect(clerkStatusLine({ enrolled: true, enrolled_at: '2026-10-04T10:00:00Z' }, 'en').key).toBe('clerk_status_enrolled_on');
    expect(clerkStatusLine({ enrolled: false }, 'en').key).toBe('clerk_status_not_enrolled');
  });
});
