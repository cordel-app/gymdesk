import { describe, expect, it } from 'vitest';
import * as admin from '../../../apps/admin/src/app/[locale]/members/draftCountdown';
import * as member from '../../../apps/member/src/lib/draftCountdown';

// #2477 stage 3 — the "Draft expires in" indicator is drawn by both apps from
// the server's `expires_in_seconds`. The two apps share no frontend module, so
// this is what keeps their wording of the countdown identical (§4).
describe('Draft expiry countdown (#2477)', () => {
  const samples = [null, undefined, NaN, -5, 0, 1, 59, 60, 61, 899, 900, 901, 1920, 3599, 3600, 3601, 6300, 7200];

  it('formats the remaining time the same way in Admin and Members', () => {
    for (const s of samples) {
      expect(member.formatDraftRemaining(s as any)).toBe(admin.formatDraftRemaining(s as any));
    }
    expect(member.formatDraftRemaining(6300)).toBe('1h 45m');
    expect(member.formatDraftRemaining(1920)).toBe('32m');
    expect(member.formatDraftRemaining(300)).toBe('5m');
    expect(member.formatDraftRemaining(7200)).toBe('2h');
    expect(member.formatDraftRemaining(0)).toBeNull();
  });

  it('warns and shows the exact time on the same thresholds in both apps', () => {
    for (const s of samples.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))) {
      expect(member.isDraftWarning(s)).toBe(admin.isDraftWarning(s));
      expect(member.showsDraftExactTime(s)).toBe(admin.showsDraftExactTime(s));
    }
    expect(member.isDraftWarning(900)).toBe(true);
    expect(member.isDraftWarning(901)).toBe(false);
    expect(member.showsDraftExactTime(3599)).toBe(true);
    expect(member.showsDraftExactTime(3600)).toBe(false);
  });

  it('counts down from the server value, never below zero', () => {
    expect(member.remainingNow(120, 1_000, 31_000)).toBe(90);
    expect(member.remainingNow(120, 1_000, 500_000)).toBe(0);
    expect(member.remainingNow(120, 1_000, 31_000)).toBe(admin.remainingNow(120, 1_000, 31_000));
  });

  it('reads a Draft the server reports at 0 seconds as expired, and nothing else', () => {
    expect(member.isExpiredDraft({ status: 'draft', expires_in_seconds: 0 })).toBe(true);
    expect(member.isExpiredDraft({ status: 'draft', expires_in_seconds: 60 })).toBe(false);
    expect(member.isExpiredDraft({ status: 'draft', expires_in_seconds: null })).toBe(false);
    expect(member.isExpiredDraft({ status: 'active', expires_in_seconds: 0 })).toBe(false);
    expect(member.isExpiredDraft(null)).toBe(false);
  });
});
