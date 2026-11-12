import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  isAllowedWhileRevoked, isMemberAccessRevoked, memberAccessRevokedBody,
} from '../domain/memberAccessRevocation';
import {
  accessRevokedMessageKey, readAccessRevocation,
} from '../../../apps/member/src/lib/memberAccessRevoked';
import { preferredLocalePath } from '../../../apps/member/src/lib/memberLocale';

// #2681 — a revoked member cannot use the Members App. The API half decides;
// the Members App half only recognises the refusal. In the API suite because CI
// runs `npm test` in `api/` only (#1009).

describe('the API decision', () => {
  it('only the stored `revoked` blocks', () => {
    expect(isMemberAccessRevoked('revoked')).toBe(true);
    expect(isMemberAccessRevoked('granted')).toBe(false);
    expect(isMemberAccessRevoked('to_be_reviewed')).toBe(false);
    expect(isMemberAccessRevoked(null)).toBe(false);
  });

  it('lets a revoked member remove this device push token and nothing else', () => {
    expect(isAllowedWhileRevoked('DELETE', '/me/devices/abc')).toBe(true);
    expect(isAllowedWhileRevoked('GET', '/me/devices/abc')).toBe(false);
    expect(isAllowedWhileRevoked('POST', '/me/devices')).toBe(false);
    expect(isAllowedWhileRevoked('DELETE', '/me/bookings/1')).toBe(false);
    expect(isAllowedWhileRevoked('DELETE', '/me/devices/abc/extra')).toBe(false);
  });

  it('the refusal names the gym and a supported profile language', () => {
    expect(memberAccessRevokedBody('Cordel Gym', 'es')).toMatchObject({
      code: 'member_access_revoked', gym_name: 'Cordel Gym', preferred_locale: 'es',
    });
    expect(memberAccessRevokedBody('', 'xx')).toMatchObject({ gym_name: null, preferred_locale: null });
    expect(memberAccessRevokedBody('Gym', null).preferred_locale).toBeNull();
  });
});

describe('the Members App half', () => {
  it('recognises the refusal and nothing else', () => {
    const body = memberAccessRevokedBody('Cordel Gym', 'ca');
    expect(readAccessRevocation(403, body)).toEqual({ gymName: 'Cordel Gym', preferredLocale: 'ca' });
    expect(readAccessRevocation(403, { code: 'professional_service_required' })).toBeNull();
    expect(readAccessRevocation(401, body)).toBeNull();
    expect(readAccessRevocation(403, null)).toBeNull();
  });

  it('names the gym when known and falls back to a generic sentence', () => {
    expect(accessRevokedMessageKey({ gymName: 'Cordel Gym', preferredLocale: null })).toBe('message');
    expect(accessRevokedMessageKey({ gymName: null, preferredLocale: null })).toBe('message_no_gym');
  });

  it('the screen is moved onto the profile language, and stays put without one', () => {
    expect(preferredLocalePath('/en/calendar', 'en', 'es')).toBe('/es/calendar');
    expect(preferredLocalePath('/en/calendar', 'en', 'ca')).toBe('/ca/calendar');
    expect(preferredLocalePath('/es', 'es', 'es')).toBeNull();
    expect(preferredLocalePath('/es', 'es', null)).toBeNull();
  });

  it('carries the three translations with the gym-name placeholder', () => {
    const MESSAGES: Record<string, string> = {
      en: 'Your access to the Members App has been revoked. Please contact {gymName} for more information.',
      es: 'Tu acceso a la Members App ha sido revocado. Ponte en contacto con {gymName} para obtener más información.',
      ca: "S'ha revocat el teu accés a la Members App. Posa't en contacte amb {gymName} per obtenir més informació.",
    };
    for (const locale of ['en', 'es', 'ca']) {
      const file = join(__dirname, '..', '..', '..', 'apps', 'member', 'locales', 'base', `${locale}.json`);
      const messages = JSON.parse(readFileSync(file, 'utf-8'));
      expect(messages.access_revoked.message).toBe(MESSAGES[locale]);
      expect(messages.access_revoked.message_no_gym).toBeTruthy();
      expect(messages.access_revoked.title).toBeTruthy();
    }
  });
});
