import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isMobileBrowser, openInAppScheme, openInAppUrl } from '../lib/openInApp';
import { appUrlOpenPath } from '../lib/native';

// #1076 follow-up — Clerk's invitation email links to Clerk's own domain, so the
// universal link never fires and the /link page offers the app's scheme instead.

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const base = { native: false, userAgent: IPHONE, scheme: 'com.cordel.fitness', hasTicket: true };

describe('openInAppScheme()', () => {
  it('offers the scheme to a phone browser holding an invitation ticket', () => {
    expect(openInAppScheme(base)).toBe('com.cordel.fitness');
    expect(isMobileBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true);
  });

  it('offers nothing on a desktop, inside the app, without a ticket or without a scheme', () => {
    expect(openInAppScheme({ ...base, userAgent: DESKTOP })).toBeNull();
    expect(openInAppScheme({ ...base, native: true })).toBeNull();
    expect(openInAppScheme({ ...base, hasTicket: false })).toBeNull();
    expect(openInAppScheme({ ...base, scheme: '' })).toBeNull();
    expect(openInAppScheme({ ...base, scheme: undefined })).toBeNull();
  });

  it('refuses a scheme that is not one', () => {
    expect(openInAppScheme({ ...base, scheme: 'javascript:alert(1)//' })).toBeNull();
    expect(openInAppScheme({ ...base, scheme: 'has space' })).toBeNull();
  });
});

describe('openInAppUrl()', () => {
  it('keeps the query and round-trips through the app’s own link rule', () => {
    const url = openInAppUrl('com.cordel.fitness', 'es', '?gym_id=g1&__clerk_ticket=tok');
    expect(url).toBe('com.cordel.fitness://es/link?gym_id=g1&__clerk_ticket=tok');
    expect(appUrlOpenPath(url, 'en')).toBe('/es/link?gym_id=g1&__clerk_ticket=tok');
  });
});

describe('the invitation page', () => {
  const page = readFileSync(join(__dirname, '..', 'app', '[locale]', 'link', 'page.tsx'), 'utf8');

  it('asks before it redeems the single-use ticket', () => {
    const offer = page.indexOf("setPhase('open_in_app')");
    const redeem = page.indexOf('signUp.ticket({ ticket })');
    expect(offer).toBeGreaterThan(-1);
    expect(redeem).toBeGreaterThan(offer);
    expect(page).toContain('setOfferDeclined(true)');
  });
});
