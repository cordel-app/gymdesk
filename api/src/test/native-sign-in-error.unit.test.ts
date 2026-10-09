import { describe, expect, it } from 'vitest';
import { signInErrorDetail } from '../../../apps/member/src/lib/native';

// #1285 — a failed native Google sign-in used to show one notice whatever refused
// it. The line below is what a development build now shows under that notice.
describe('signInErrorDetail', () => {
  it('reads a Clerk error: code and long message', () => {
    expect(signInErrorDetail({ errors: [{ code: 'form_identifier_not_found', longMessage: 'Couldn\'t find your account.' }] }))
      .toBe('form_identifier_not_found: Couldn\'t find your account.');
  });

  it('falls back to the message, then to a plain string, then to a fixed text', () => {
    expect(signInErrorDetail(new Error('boom'))).toBe('boom');
    expect(signInErrorDetail('plugin said no')).toBe('plugin said no');
    expect(signInErrorDetail(undefined)).toBe('unknown error');
    expect(signInErrorDetail({})).toBe('unknown error');
  });

  it('is bounded', () => {
    expect(signInErrorDetail(new Error('x'.repeat(1000))).length).toBe(300);
  });
});
